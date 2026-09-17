// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title FlyRegistry — the permanent layer for immortal fruit flies on BNB Smart Chain
///
/// @notice Every fly is an ERC-721 token whose record holds the five things that make an
///         organism persistent: identity (which connectome and model it runs, its parents),
///         brain state (a commitment to every membrane potential, synaptic drive and refractory
///         clock, with the bytes on IPFS), memory (the plastic weights it has learned), lineage
///         (births, deaths, resurrections, breeding) and interaction history (events from every
///         body it has lived in).
///
///         A BODY is any program that instantiates a fly from its last committed state, runs the
///         published deterministic model, and commits new state as it goes: an arena, a game, a
///         robot. A fly has at most one body at a time; only that body may commit or report its
///         death. When it dies it becomes dormant; anyone may resurrect it by burning $FLY, and
///         its owner (or its last body) hands it to a body again. The brain outlives every body.
///
///         Everything that creates or sustains life burns $FLY (sent to 0x…dEaD). There is no
///         owner key: the only privileged role is a curator who may set presentation metadata
///         (collection page, portrait of a fly that has no body) and nothing else.
contract FlyRegistryV3 is ERC721, IERC2981 {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct Fly {
        bytes32 connectome; // sha256 of the connectome file the fly runs (identity)
        uint32 model; // simulator version (identity)
        uint32 generation; // lives lived (resurrections)
        uint32 deaths;
        uint256 parentA; // 0 for genesis flies
        uint256 parentB;
        bytes32 stateRoot; // sha256 of the complete brain state at the last commit
        bytes32 memoryRoot; // sha256 of the plastic weights at the last commit
        string stateURI; // where the state bytes are (ipfs://…)
        uint64 brainStep; // model step of the last commit
        uint64 energy; // seconds of life, as of the last commit plus feeds since
        uint64 bornBlock;
        uint64 lastCommitBlock;
        address body; // operator running it now; address(0) = dormant
        address pendingBody; // assigned, not yet accepted
        bool alive;
    }

    struct Body {
        string name;
        string uri;
        uint64 registeredBlock;
        uint32 flies; // currently hosted
    }

    IERC20 public immutable token;
    address public immutable curator;
    bytes32 public immutable CONNECTOME; // FlyWire 783 build every genesis fly runs
    uint32 public immutable MODEL;
    bytes32 public immutable GENESIS_STATE; // sha256 of the canonical resting brain
    uint256 public immutable MINT_PRICE;      // $FLY burned to mint
    uint256 public immutable BREED_PRICE;     // $FLY burned to breed
    /// Life is paid in BNB, not burned in $FLY (v3): wei per second of life, and the flat resurrection fee. The curator
    /// adjusts both as BNB moves; the keeper (the operator's feeder) pays nothing, so the operator can keep flies alive.
    uint256 public lifeWeiPerSecond;
    uint256 public resurrectWei;
    address public keeper;
    /// One-time migration from the previous registry: the curator recreates every fly for its owner, then closes it.
    bool public migrationOpen = true;
    address public immutable previousRegistry;
    uint64 public immutable GENESIS_ENERGY; // seconds of life a fly is born with
    uint256 public immutable MAX_SUPPLY; // genesis mints and children together
    address public immutable treasury; // royalty receiver (ERC-2981)
    uint96 public immutable ROYALTY_BPS;

    uint256 public totalMinted;
    uint256 public totalBurned;
    mapping(uint256 => Fly) private _flies;
    mapping(uint256 => string) public flyName;
    mapping(uint256 => string) private _metadataURI;
    mapping(address => Body) public bodies;
    mapping(address => bool) public isBody;
    string public baseURI;
    string private _contractURI;

    event Minted(uint256 indexed id, address indexed to, string name, uint256 parentA, uint256 parentB);
    event BodyRegistered(address indexed body, string name, string uri);
    event Assigned(uint256 indexed id, address indexed body, address indexed by);
    event Accepted(uint256 indexed id, address indexed body);
    event Released(uint256 indexed id, address indexed body);
    event Commit(uint256 indexed id, address indexed body, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, uint64 brainStep, uint64 energy, bytes32 historyRoot);
    event Interaction(uint256 indexed id, address indexed body, bytes32 indexed kind, string data);
    event Died(uint256 indexed id, address indexed body, uint32 generation, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, uint64 brainStep, string cause);
    event Resurrected(uint256 indexed id, address indexed by, uint32 generation, uint64 energy, uint256 paidWei);
    event Fed(uint256 indexed id, address indexed by, uint64 seconds_, uint256 paidWei);
    event LifePriceSet(uint256 lifeWeiPerSecond, uint256 resurrectWei);
    event Migrated(uint256 indexed id, address indexed to, address previousRegistry);
    event Attested(uint256 indexed id, address indexed attestor, uint64 brainStep, bytes32 stateRoot, bool matches);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906, so marketplaces refresh

    error NotBody();
    error NotOwnerOrBody();
    error NotCurator();
    error NotRegistered();
    error NotPending();
    error Dead();
    error NotDead();
    error HasBody();
    error StepMustAdvance();
    error TooLittle();
    error DifferentSpecies();
    error NoSuchFly();
    error DeadCannotTransfer();
    error SoldOut();
    error ParentsMustBeAlive();
    error MigrationClosed();

    constructor(
        IERC20 token_,
        bytes32 connectome,
        uint32 model,
        bytes32 genesisState,
        uint256 mintPrice,
        uint256 breedPrice,
        uint256 lifeWeiPerSecond_,
        uint256 resurrectWei_,
        address previousRegistry_,
        uint64 genesisEnergy,
        uint256 maxSupply,
        uint96 royaltyBps,
        string memory baseURI_,
        string memory contractURI_
    ) ERC721("Immortal Fruit Flies", "FLYS") {
        MAX_SUPPLY = maxSupply;
        treasury = msg.sender;
        ROYALTY_BPS = royaltyBps;
        token = token_;
        curator = msg.sender;
        CONNECTOME = connectome;
        MODEL = model;
        GENESIS_STATE = genesisState;
        MINT_PRICE = mintPrice;
        BREED_PRICE = breedPrice;
        lifeWeiPerSecond = lifeWeiPerSecond_;
        resurrectWei = resurrectWei_;
        keeper = msg.sender;
        previousRegistry = previousRegistry_;
        GENESIS_ENERGY = genesisEnergy;
        baseURI = baseURI_;
        _contractURI = contractURI_;
    }

    // ------------------------------------------------------------------ views

    function fly(uint256 id) external view returns (Fly memory) {
        _requireOwned(id);
        return _flies[id];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        if (bytes(_metadataURI[id]).length > 0) return _metadataURI[id];
        return string.concat(baseURI, id.toString());
    }

    /// @notice Collection-level metadata (OpenSea contractURI).
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    // ------------------------------------------------------------------ life

    /// @notice A new genesis fly: fresh brain, empty memory, GENESIS_ENERGY seconds of life. Burns MINT_PRICE.
    function mint(string calldata name) external returns (uint256 id) {
        id = _create(msg.sender, name, 0, 0, bytes32(0));
        _burn_(msg.sender, MINT_PRICE);
        emit Minted(id, msg.sender, name, 0, 0);
    }

    /// @notice A child of two flies you own: fresh brain, memory = the published deterministic crossover of the
    ///         parents' memories (computed off-chain; anyone can check childMemoryRoot against the parents' roots).
    function breed(uint256 a, uint256 b, bytes32 childMemoryRoot, string calldata name) external returns (uint256 id) {
        if (a == b) revert DifferentSpecies();
        if (!_isAuthorized(_ownerOf(a), msg.sender, a) || !_isAuthorized(_ownerOf(b), msg.sender, b)) revert NotOwnerOrBody();
        if (!_flies[a].alive || !_flies[b].alive) revert ParentsMustBeAlive();
        id = _create(msg.sender, name, a, b, childMemoryRoot);
        _burn_(msg.sender, BREED_PRICE);
        emit Minted(id, msg.sender, name, a, b);
    }

    /// @notice What `seconds_` of life costs in wei (0 for the keeper).
    function lifeCost(uint64 seconds_) public view returns (uint256) { return uint256(seconds_) * lifeWeiPerSecond; }

    /// @notice Give a fly `seconds_` more life for a little BNB (msg.value >= lifeCost; the keeper pays nothing).
    ///         Its body applies it at the next poll. Nothing is burned: the BNB goes to the treasury.
    function feed(uint256 id, uint64 seconds_) external payable {
        Fly storage f = _flies[id];
        _requireOwned(id);
        if (!f.alive) revert Dead();
        if (seconds_ == 0) revert TooLittle();
        uint256 cost = _charge(lifeCost(seconds_));
        f.energy += seconds_;
        emit Fed(id, msg.sender, seconds_, cost);
        emit MetadataUpdate(id);
    }

    /// @notice Wake a dead fly with `seconds_` of life. The same brain continues from its last committed state
    ///         once a body is assigned and instantiates it. Costs resurrectWei + lifeCost(seconds_) in BNB (keeper: nothing).
    function resurrect(uint256 id, uint64 seconds_) external payable {
        Fly storage f = _flies[id];
        _requireOwned(id);
        if (f.alive) revert NotDead();
        if (seconds_ < 60) revert TooLittle();
        uint256 cost = _charge(resurrectWei + lifeCost(seconds_));
        f.alive = true;
        f.generation += 1;
        f.energy = seconds_;
        emit Resurrected(id, msg.sender, f.generation, seconds_, cost);
        emit MetadataUpdate(id);
    }

    /// @dev BNB for life: the keeper pays nothing; anyone else must send at least `cost`, and the whole value goes to the treasury.
    function _charge(uint256 cost) private returns (uint256 paid) {
        if (msg.sender == keeper) cost = 0;
        if (msg.value < cost) revert TooLittle();
        paid = msg.value;
        if (paid > 0) {
            (bool ok,) = treasury.call{value: paid}("");
            if (!ok) revert TooLittle();
        }
    }

    // ------------------------------------------------------------------ operator (prices, keeper, migration)

    function setLifePrice(uint256 lifeWeiPerSecond_, uint256 resurrectWei_) external {
        if (msg.sender != curator) revert NotCurator();
        lifeWeiPerSecond = lifeWeiPerSecond_;
        resurrectWei = resurrectWei_;
        emit LifePriceSet(lifeWeiPerSecond_, resurrectWei_);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != curator) revert NotCurator();
        keeper = keeper_;
    }

    /// @notice Migration from the previous registry: recreate fly `id` (the next id in order) for `to` with its record.
    ///         Curator only, only while the migration is open; `closeMigration` ends it for ever.
    function migrate(address to, string calldata name, Fly calldata r) external returns (uint256 id) {
        if (msg.sender != curator) revert NotCurator();
        if (!migrationOpen) revert MigrationClosed();
        if (totalMinted >= MAX_SUPPLY) revert SoldOut();
        id = ++totalMinted;
        Fly storage f = _flies[id];
        f.connectome = r.connectome; f.model = r.model; f.generation = r.generation; f.deaths = r.deaths;
        f.parentA = r.parentA; f.parentB = r.parentB; f.stateRoot = r.stateRoot; f.memoryRoot = r.memoryRoot; f.stateURI = r.stateURI;
        f.brainStep = r.brainStep; f.energy = r.energy; f.bornBlock = r.bornBlock; f.lastCommitBlock = r.lastCommitBlock;
        f.alive = r.alive;   // bodies are not carried over: every body re-registers and is re-assigned on the new registry
        flyName[id] = name;
        _mint(to, id);       // _mint, not _safeMint: a dead fly or a contract owner must not block the migration
        emit Minted(id, to, name, r.parentA, r.parentB);
        emit Migrated(id, to, previousRegistry);
    }

    function closeMigration() external {
        if (msg.sender != curator) revert NotCurator();
        migrationOpen = false;
    }

    // ------------------------------------------------------------------ bodies

    /// @notice Declare an operator that can host flies: an arena, a game, a robot.
    function registerBody(string calldata name, string calldata uri) external {
        bodies[msg.sender] = Body({name: name, uri: uri, registeredBlock: uint64(block.number), flies: bodies[msg.sender].flies});
        isBody[msg.sender] = true;
        emit BodyRegistered(msg.sender, name, uri);
    }

    /// @notice Hand a fly to a body. The owner, or the body currently running it, may do this.
    function assign(uint256 id, address body) external {
        Fly storage f = _flies[id];
        address owner = _requireOwned(id);
        if (!(_isAuthorized(owner, msg.sender, id) || (f.body != address(0) && msg.sender == f.body))) revert NotOwnerOrBody();
        if (!isBody[body]) revert NotRegistered();
        if (!f.alive) revert Dead();
        f.pendingBody = body;
        emit Assigned(id, body, msg.sender);
    }

    /// @notice The assigned body takes custody. It must instantiate the fly from `stateURI` before committing.
    function accept(uint256 id) external {
        Fly storage f = _flies[id];
        _requireOwned(id);
        if (f.pendingBody != msg.sender) revert NotPending();
        if (f.body != address(0)) bodies[f.body].flies -= 1;
        f.body = msg.sender;
        f.pendingBody = address(0);
        bodies[msg.sender].flies += 1;
        emit Accepted(id, msg.sender);
    }

    /// @notice A body hands a living fly back (dormant but alive; it can be assigned again).
    function release(uint256 id) external {
        Fly storage f = _flies[id];
        if (f.body != msg.sender) revert NotBody();
        bodies[msg.sender].flies -= 1;
        f.body = address(0);
        emit Released(id, msg.sender);
    }

    /// @notice A checkpoint: the complete brain state and memory, where the bytes are, and the interval's history.
    function commit(uint256 id, bytes32 stateRoot, bytes32 memoryRoot, string calldata stateURI, string calldata metadataURI, uint64 brainStep, uint64 energy, bytes32 historyRoot) external {
        Fly storage f = _flies[id];
        if (f.body != msg.sender) revert NotBody();
        if (!f.alive) revert Dead();
        if (brainStep <= f.brainStep) revert StepMustAdvance();
        f.stateRoot = stateRoot;
        f.memoryRoot = memoryRoot;
        f.stateURI = stateURI;
        f.brainStep = brainStep;
        f.energy = energy;
        f.lastCommitBlock = uint64(block.number);
        if (bytes(metadataURI).length > 0) _metadataURI[id] = metadataURI;
        emit Commit(id, msg.sender, stateRoot, memoryRoot, stateURI, brainStep, energy, historyRoot);
        emit MetadataUpdate(id);
    }

    /// @notice Something that happened to the fly, from the body running it: the interaction history.
    function interaction(uint256 id, bytes32 kind, string calldata data) external {
        if (_flies[id].body != msg.sender) revert NotBody();
        emit Interaction(id, msg.sender, kind, data);
    }

    /// @notice The fly ran out of energy (or was killed). Its final state is committed; it becomes dormant.
    function died(uint256 id, bytes32 stateRoot, bytes32 memoryRoot, string calldata stateURI, string calldata metadataURI, uint64 brainStep, string calldata cause) external {
        Fly storage f = _flies[id];
        if (f.body != msg.sender) revert NotBody();
        if (!f.alive) revert Dead();
        f.stateRoot = stateRoot;
        f.memoryRoot = memoryRoot;
        f.stateURI = stateURI;
        if (brainStep > f.brainStep) f.brainStep = brainStep;
        f.energy = 0;
        f.alive = false;
        f.deaths += 1;
        f.lastCommitBlock = uint64(block.number);
        bodies[msg.sender].flies -= 1;
        f.body = address(0);
        f.pendingBody = address(0);
        if (bytes(metadataURI).length > 0) _metadataURI[id] = metadataURI;
        emit Died(id, msg.sender, f.generation, stateRoot, memoryRoot, stateURI, f.brainStep, cause);
        emit MetadataUpdate(id);
    }

    /// @notice Anyone who re-ran the model from the previous commit can say whether they got the same root.
    function attest(uint256 id, uint64 brainStep, bytes32 stateRoot) external {
        _requireOwned(id);
        Fly storage f = _flies[id];
        emit Attested(id, msg.sender, brainStep, stateRoot, brainStep == f.brainStep && stateRoot == f.stateRoot);
    }

    // ------------------------------------------------------------------ presentation only

    /// @notice The curator may set a fly's portrait/metadata only while no body is running it; a body sets it in commits.
    function setMetadata(uint256 id, string calldata uri) external {
        if (msg.sender != curator) revert NotCurator();
        if (_flies[id].body != address(0)) revert HasBody();
        _requireOwned(id);
        _metadataURI[id] = uri;
        emit MetadataUpdate(id);
    }

    function setCollection(string calldata baseURI_, string calldata contractURI_) external {
        if (msg.sender != curator) revert NotCurator();
        baseURI = baseURI_;
        _contractURI = contractURI_;
    }

    // ------------------------------------------------------------------ internals

    function _create(address to, string calldata name, uint256 a, uint256 b, bytes32 memoryRoot) private returns (uint256 id) {
        if (totalMinted >= MAX_SUPPLY) revert SoldOut();
        id = ++totalMinted;
        Fly storage f = _flies[id];
        f.connectome = CONNECTOME;
        f.model = MODEL;
        f.parentA = a;
        f.parentB = b;
        f.stateRoot = GENESIS_STATE;
        f.memoryRoot = memoryRoot;
        f.energy = GENESIS_ENERGY;
        f.bornBlock = uint64(block.number);
        f.alive = true;
        flyName[id] = name;
        _safeMint(to, id);
    }

    function _burn_(address from, uint256 amount) private {
        totalBurned += amount;
        token.safeTransferFrom(from, DEAD, amount);
    }

    /// @dev A dead fly cannot change hands: resurrect it first. Minting and (never used) burning are unaffected.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && !_flies[tokenId].alive) revert DeadCannotTransfer();
        return super._update(to, tokenId, auth);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (treasury, (salePrice * ROYALTY_BPS) / 10_000);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == 0x49064906 || interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId); // ERC-4906, ERC-2981
    }
}
