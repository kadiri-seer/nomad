// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title NomadAgents
 * @notice Minted Nomad agents on Robinhood Chain. Anyone can mint an agent: a token that records the SHA-256 of its
 * .nomad package, its name and where to get the package, for a mint fee in $NOMAD. The agent's owner can set a
 * price in $NOMAD for others to get a copy; Nomad keeps a platform share of each copy sale.
 *
 * Fees are paid straight from the payer to where they go: part burned (sent to the dead address), the rest to
 * Nomad's treasury, and a copy's price to the agent's owner. This contract never holds tokens or ETH, so there is
 * nothing in it to withdraw or lose.
 *
 * The owner (Nomad's Safe) can change the fees only within limits fixed when the contract was deployed, open or
 * close minting, and change the treasury address. It cannot change, move or remove anyone's agent, or take tokens.
 */
contract NomadAgents is ERC721, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Where burned $NOMAD goes. Tokens sent here can never be moved again.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS = 10_000;
    /// @notice The platform share of a copy sale can never be set above 20%.
    uint256 public constant MAX_PLATFORM_BPS = 2_000;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_URI_BYTES = 256;

    /// @notice $NOMAD, the token every fee and price is paid in.
    IERC20 public immutable nomad;
    /// @notice The highest mint fee that can ever be set, fixed at deployment.
    uint256 public immutable maxMintFee;

    address public treasury;
    uint256 public mintFee;
    /// @notice Share of the mint fee that is burned; the rest goes to the treasury.
    uint256 public mintBurnBps;
    /// @notice Share of a copy's price kept by Nomad; the rest goes to the agent's owner.
    uint256 public platformBps;
    /// @notice Share of Nomad's platform share that is burned; the rest goes to the treasury.
    uint256 public platformBurnBps;
    bool public mintingOpen;

    struct Agent {
        address creator;
        uint64 mintedAt;
        bytes32 packageHash;
        uint256 price;
        uint256 copies;
        string name;
        string uri;
    }

    uint256 public totalMinted;
    /// @notice $NOMAD burned through this contract, from mint fees and platform shares.
    uint256 public totalBurned;
    /// @notice $NOMAD sent to the treasury through this contract.
    uint256 public totalToTreasury;
    /// @notice $NOMAD paid to agent owners for copies.
    uint256 public totalToCreators;

    mapping(uint256 => Agent) private _agents;
    /// @notice The agent minted for a package hash (0 when none). One package can be minted once.
    mapping(bytes32 => uint256) public agentOfPackage;
    /// @notice Whether an address has got a copy of an agent.
    mapping(uint256 => mapping(address => bool)) public hasCopy;

    event Minted(uint256 indexed id, address indexed creator, bytes32 indexed packageHash, string name, string uri, uint256 price, uint256 fee, uint256 burned);
    event PriceSet(uint256 indexed id, uint256 price);
    event UriSet(uint256 indexed id, string uri);
    event Copied(uint256 indexed id, address indexed buyer, address indexed owner, uint256 price, uint256 toOwner, uint256 toTreasury, uint256 burned);
    event MintFeeSet(uint256 fee, uint256 burnBps);
    event PlatformSet(uint256 platformBps, uint256 burnBps);
    event TreasurySet(address treasury);
    event MintingOpenSet(bool open);

    error MintingClosed();
    error BadName();
    error BadUri();
    error BadHash();
    error AlreadyMinted(uint256 id);
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error NotAgentOwner();
    error AlreadyHasCopy();
    error OverLimit();
    error ZeroAddress();
    error CannotRenounce();

    constructor(
        IERC20 nomad_,
        address owner_,
        address treasury_,
        uint256 maxMintFee_,
        uint256 mintFee_,
        uint256 mintBurnBps_,
        uint256 platformBps_,
        uint256 platformBurnBps_
    ) ERC721("Nomad Agents", "NOMADAGENT") Ownable(owner_) {
        if (address(nomad_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (mintFee_ > maxMintFee_ || mintBurnBps_ > BPS || platformBps_ > MAX_PLATFORM_BPS || platformBurnBps_ > BPS) revert OverLimit();
        nomad = nomad_;
        maxMintFee = maxMintFee_;
        treasury = treasury_;
        mintFee = mintFee_;
        mintBurnBps = mintBurnBps_;
        platformBps = platformBps_;
        platformBurnBps = platformBurnBps_;
        emit TreasurySet(treasury_);
        emit MintFeeSet(mintFee_, mintBurnBps_);
        emit PlatformSet(platformBps_, platformBurnBps_);
    }

    // ---------------------------------------------------------------- minting and copies

    /**
     * @notice Mint an agent. Pays the mint fee in $NOMAD (approve this contract first).
     * @param name The agent's name, 1 to 64 bytes.
     * @param packageHash The SHA-256 of the agent's .nomad file.
     * @param uri Where to get the package (a link), up to 256 bytes; may be empty.
     * @param price The $NOMAD price for others to get a copy (0 for free).
     * @param maxFee The most you agree to pay, so a fee change cannot surprise you.
     */
    function mint(string calldata name, bytes32 packageHash, string calldata uri, uint256 price, uint256 maxFee) external returns (uint256 id) {
        if (!mintingOpen) revert MintingClosed();
        if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_BYTES) revert BadName();
        if (bytes(uri).length > MAX_URI_BYTES) revert BadUri();
        if (packageHash == bytes32(0)) revert BadHash();
        if (agentOfPackage[packageHash] != 0) revert AlreadyMinted(agentOfPackage[packageHash]);
        uint256 fee = mintFee;
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);

        id = ++totalMinted;
        agentOfPackage[packageHash] = id;
        _agents[id] = Agent({creator: msg.sender, mintedAt: uint64(block.timestamp), packageHash: packageHash, price: price, copies: 0, name: name, uri: uri});
        uint256 burned = (fee * mintBurnBps) / BPS;
        totalBurned += burned;
        totalToTreasury += fee - burned;
        _mint(msg.sender, id);
        emit Minted(id, msg.sender, packageHash, name, uri, price, fee, burned);

        if (burned > 0) nomad.safeTransferFrom(msg.sender, BURN, burned);
        if (fee - burned > 0) nomad.safeTransferFrom(msg.sender, treasury, fee - burned);
    }

    /// @notice The agent's owner sets the price of a copy (0 for free).
    function setPrice(uint256 id, uint256 price) external {
        if (ownerOf(id) != msg.sender) revert NotAgentOwner();
        _agents[id].price = price;
        emit PriceSet(id, price);
    }

    /// @notice The agent's owner updates where to get the package. The package hash never changes.
    function setUri(uint256 id, string calldata uri) external {
        if (ownerOf(id) != msg.sender) revert NotAgentOwner();
        if (bytes(uri).length > MAX_URI_BYTES) revert BadUri();
        _agents[id].uri = uri;
        emit UriSet(id, uri);
    }

    /**
     * @notice Get a copy of an agent: pays its price in $NOMAD (approve this contract first) and records that you
     * have it. The owner gets the price minus Nomad's platform share.
     * @param maxPrice The most you agree to pay, so a price change cannot surprise you.
     */
    function getCopy(uint256 id, uint256 maxPrice) external {
        address owner_ = ownerOf(id);
        if (owner_ == msg.sender || hasCopy[id][msg.sender]) revert AlreadyHasCopy();
        Agent storage a = _agents[id];
        uint256 price = a.price;
        if (price > maxPrice) revert PriceAboveMax(price, maxPrice);

        hasCopy[id][msg.sender] = true;
        a.copies += 1;
        uint256 platform = (price * platformBps) / BPS;
        uint256 burned = (platform * platformBurnBps) / BPS;
        uint256 toTreasury = platform - burned;
        uint256 toOwner = price - platform;
        totalBurned += burned;
        totalToTreasury += toTreasury;
        totalToCreators += toOwner;
        emit Copied(id, msg.sender, owner_, price, toOwner, toTreasury, burned);

        if (toOwner > 0) nomad.safeTransferFrom(msg.sender, owner_, toOwner);
        if (burned > 0) nomad.safeTransferFrom(msg.sender, BURN, burned);
        if (toTreasury > 0) nomad.safeTransferFrom(msg.sender, treasury, toTreasury);
    }

    // ---------------------------------------------------------------- reading

    function agent(uint256 id) external view returns (Agent memory) {
        _requireOwned(id);
        return _agents[id];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return _agents[id].uri;
    }

    // ---------------------------------------------------------------- Nomad's settings, within fixed limits

    function setMintFee(uint256 fee, uint256 burnBps) external onlyOwner {
        if (fee > maxMintFee || burnBps > BPS) revert OverLimit();
        mintFee = fee;
        mintBurnBps = burnBps;
        emit MintFeeSet(fee, burnBps);
    }

    function setPlatform(uint256 platformBps_, uint256 burnBps) external onlyOwner {
        if (platformBps_ > MAX_PLATFORM_BPS || burnBps > BPS) revert OverLimit();
        platformBps = platformBps_;
        platformBurnBps = burnBps;
        emit PlatformSet(platformBps_, burnBps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setMintingOpen(bool open) external onlyOwner {
        mintingOpen = open;
        emit MintingOpenSet(open);
    }

    /// @notice Ownership cannot be given up: the fees would then be frozen for good.
    function renounceOwnership() public pure override {
        revert CannotRenounce();
    }
}
