// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The parts of NomadAgents its owner can call.
interface INomadAgentsAdmin {
    function mintFee() external view returns (uint256);
    function maxMintFee() external view returns (uint256);
    function setMintFee(uint256 fee, uint256 burnBps) external;
    function setPlatform(uint256 platformBps, uint256 burnBps) external;
    function setTreasury(address treasury) external;
    function setMintingOpen(bool open) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

/**
 * @title NomadFeeKeeper
 * @notice Owns NomadAgents so the agent mint fee can follow a dollar price. A keeper (Nomad's server key) may only
 * move the fee: within bounds the owner sets, by at most 25% per change, at most once every 5 minutes, always with
 * the burn share the owner set. Everything else (treasury, platform share, minting, the bounds, the keeper, and
 * NomadAgents' ownership itself) stays with the owner, who can take NomadAgents back at any time.
 */
contract NomadFeeKeeper {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_STEP_BPS = 2_500;
    uint256 public constant MIN_INTERVAL = 5 minutes;

    INomadAgentsAdmin public immutable agents;
    address public owner;
    address public pendingOwner;
    address public keeper;
    /// The share of each mint fee burned, set by the owner (2,000 = 20%).
    uint256 public burnBps;
    /// The fee the keeper may set, in $NOMAD base units: never below minFee or above maxFee.
    uint256 public minFee;
    uint256 public maxFee;
    uint256 public lastUpdate;

    event FeeUpdated(uint256 fee, uint256 burnBps, address by);
    event BoundsSet(uint256 minFee, uint256 maxFee, uint256 burnBps);
    event KeeperSet(address keeper);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotKeeper();
    error TooSoon();
    error OutOfBounds();
    error StepTooLarge();
    error BadSettings();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address agents_, address owner_, address keeper_, uint256 burnBps_, uint256 minFee_, uint256 maxFee_) {
        if (agents_ == address(0) || owner_ == address(0)) revert BadSettings();
        agents = INomadAgentsAdmin(agents_);
        owner = owner_;
        keeper = keeper_;
        _setBounds(minFee_, maxFee_, burnBps_);
        emit OwnershipTransferred(address(0), owner_);
        emit KeeperSet(keeper_);
    }

    /// The keeper's only power: a new fee within the bounds, at most 25% from the current one, at most every 5 minutes.
    function updateFee(uint256 fee) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (block.timestamp < lastUpdate + MIN_INTERVAL) revert TooSoon();
        if (fee < minFee || fee > maxFee) revert OutOfBounds();
        uint256 current = agents.mintFee();
        uint256 diff = fee > current ? fee - current : current - fee;
        if (diff * BPS > current * MAX_STEP_BPS) revert StepTooLarge();
        lastUpdate = block.timestamp;
        agents.setMintFee(fee, burnBps);
        emit FeeUpdated(fee, burnBps, msg.sender);
    }

    /// Completes the hand-over of NomadAgents to this contract (after its owner called transferOwnership to it).
    function acceptAgentsOwnership() external {
        if (msg.sender != owner && msg.sender != keeper) revert NotKeeper();
        agents.acceptOwnership();
    }

    // The owner: everything else.

    function setFee(uint256 fee, uint256 burnBps_) external onlyOwner {
        if (burnBps_ > BPS) revert BadSettings();
        burnBps = burnBps_;
        lastUpdate = block.timestamp;
        agents.setMintFee(fee, burnBps_);
        emit FeeUpdated(fee, burnBps_, msg.sender);
    }

    function setBounds(uint256 minFee_, uint256 maxFee_, uint256 burnBps_) external onlyOwner {
        _setBounds(minFee_, maxFee_, burnBps_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setPlatform(uint256 platformBps, uint256 burnBps_) external onlyOwner {
        agents.setPlatform(platformBps, burnBps_);
    }

    function setTreasury(address treasury) external onlyOwner {
        agents.setTreasury(treasury);
    }

    function setMintingOpen(bool open) external onlyOwner {
        agents.setMintingOpen(open);
    }

    /// Hands NomadAgents back (the new owner then calls acceptOwnership on NomadAgents).
    function returnAgents(address newOwner) external onlyOwner {
        agents.transferOwnership(newOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _setBounds(uint256 minFee_, uint256 maxFee_, uint256 burnBps_) internal {
        if (minFee_ == 0 || minFee_ > maxFee_ || maxFee_ > agents.maxMintFee() || burnBps_ > BPS) revert BadSettings();
        minFee = minFee_;
        maxFee = maxFee_;
        burnBps = burnBps_;
        emit BoundsSet(minFee_, maxFee_, burnBps_);
    }
}
