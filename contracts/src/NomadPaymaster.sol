// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// The ERC-4337 v0.7 user operation, as the EntryPoint passes it.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// The EntryPoint functions this paymaster uses (its deposit and stake are held there).
interface IEntryPointDeposits {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function balanceOf(address account) external view returns (uint256);
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}

/**
 * NomadPaymaster: pays the gas of Nomad accounts and agents on Robinhood Chain, from a deposit the treasury keeps in
 * the EntryPoint (v0.7). It pays only for user operations that Nomad's server signed, and the server signs only for an
 * account with credits to cover the cost (charged from those credits, with a margin, so the treasury is repaid).
 *
 * Kept deliberately small, as an unstaked paymaster must be (ERC-7562): validation reads no storage and returns no
 * context. What bounds the risk if the signing key ever leaked: every signature expires within minutes (validUntil),
 * each operation costs at most maxCostPerOp, and the deposit itself is kept small. Money only ever leaves to the
 * treasury: deposits and stake can be withdrawn to no other address. Fixed at deployment: the EntryPoint, the
 * signer, the treasury and maxCostPerOp. To change the signer, the owner withdraws the deposit and a new paymaster
 * is deployed. Owner: Nomad's Safe (two-step transfer; renouncing is disabled).
 *
 * paymasterAndData = paymaster (20 bytes) | verification gas (16) | postOp gas (16) | abi.encode(validUntil, validAfter)
 * (64) | signature (65). The signature is an EIP-191 signature of getHash(userOp, validUntil, validAfter), the same
 * layout as the eth-infinitism VerifyingPaymaster, so standard tooling can produce it.
 */
contract NomadPaymaster is Ownable2Step {
    uint256 private constant VALIDATION_GAS_OFFSET = 20;
    uint256 private constant DATA_OFFSET = 52;
    uint256 private constant SIGNATURE_OFFSET = DATA_OFFSET + 64;

    IEntryPointDeposits public immutable entryPoint;
    address public immutable verifyingSigner;
    address payable public immutable treasury;
    uint256 public immutable maxCostPerOp;

    error NotEntryPoint();
    error NotTreasury();
    error BadSignatureLength();
    error TooExpensive(uint256 maxCost, uint256 limit);
    error ZeroAddress();
    error RenounceDisabled();

    constructor(address entryPoint_, address verifyingSigner_, address payable treasury_, uint256 maxCostPerOp_, address owner_) Ownable(owner_) {
        if (entryPoint_ == address(0) || verifyingSigner_ == address(0) || treasury_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        entryPoint = IEntryPointDeposits(entryPoint_);
        verifyingSigner = verifyingSigner_;
        treasury = treasury_;
        maxCostPerOp = maxCostPerOp_;
    }

    /// The hash Nomad's server signs: every field of the operation except the signatures, plus this chain and paymaster.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[VALIDATION_GAS_OFFSET:DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData) public pure returns (uint48 validUntil, uint48 validAfter, bytes calldata signature) {
        (validUntil, validAfter) = abi.decode(paymasterAndData[DATA_OFFSET:SIGNATURE_OFFSET], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    /// Called by the EntryPoint. A wrong signature is reported, not reverted, as ERC-4337 asks.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost) external view returns (bytes memory context, uint256 validationData) {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        if (maxCost > maxCostPerOp) revert TooExpensive(maxCost, maxCostPerOp);
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) = parsePaymasterAndData(userOp.paymasterAndData);
        if (signature.length != 65) revert BadSignatureLength();
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        bool failed = err != ECDSA.RecoverError.NoError || signer != verifyingSigner;
        return ("", (failed ? 1 : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208));
    }

    /// Never called: this paymaster returns no context.
    function postOp(uint8, bytes calldata, uint256, uint256) external view {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
    }

    /// Anyone may top up the deposit (the treasury does, from its Safe).
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// The deposit goes back to the treasury only.
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        if (to != treasury) revert NotTreasury();
        entryPoint.withdrawTo(to, amount);
    }

    /// A stake is optional (some bundlers give staked paymasters more room); it returns to the treasury only.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        if (to != treasury) revert NotTreasury();
        entryPoint.withdrawStake(to);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
