import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Contracts & addresses" };

export default function Page() {
  const ex = CFG.explorer;
  return (
    <DocsShell current="/docs/contracts/">
      <h1>Contracts &amp; addresses</h1>
      <p className="lede">Everything is on BNB Smart Chain (chain ID 56). Sources are verified on BscScan and on Sourcify as exact matches.</p>
      <table className="data"><thead><tr><th>Contract</th><th>Address</th></tr></thead><tbody>
        <tr><td><code>FlyRegistry</code>, the organism: ERC-721 “Immortal Fruit Flies” (FLYS), identity, brain state, memory, lineage, history</td><td><a href={`${ex}/address/${CFG.registry}#code`}>{CFG.registry}</a> · <a href={CFG.market.collection}>Element</a></td></tr>
        <tr><td><code>FlyCore</code>, every fly&apos;s on-chain compass core (155 FlyWire neurons in the EVM, keyed by token id; pebbles anchor here)</td><td><a href={`${ex}/address/${CFG.core}#code`}>{CFG.core}</a></td></tr>
        <tr><td><code>LifeFund</code>, keep a fly alive for a little BNB: credits seconds of life, the operator&apos;s keeper feeds the fly from the fund&apos;s $FLY</td><td><a href={`${ex}/address/${CFG.lifeFund}#code`}>{CFG.lifeFund}</a></td></tr>
        <tr><td>Arena body (streams the live fly)</td><td><a href={`${ex}/address/${CFG.bodies.arena}`}>{CFG.bodies.arena}</a></td></tr>
        <tr><td>DOOM body</td><td><a href={`${ex}/address/${CFG.bodies.doom}`}>{CFG.bodies.doom}</a></td></tr>
        <tr><td><code>$FLY</code> token</td><td><a href={`${ex}/token/${CFG.token}`}>{CFG.token}</a></td></tr>
        <tr><td><code>FlyWorld</code>, fly #1&apos;s arena before the registry (read-only now)</td><td><a href={`${ex}/address/${CFG.world}`}>{CFG.world}</a> · <a href={CFG.links.sourcify + CFG.world}>source</a></td></tr>
        <tr><td><code>FlyArcade</code>, fly #1&apos;s DOOM session 5 (read-only now)</td><td><a href={`${ex}/address/${CFG.arcade}`}>{CFG.arcade}</a></td></tr>
        <tr><td><code>FlyBrain</code> v2, the on-chain compass core (live)</td><td><a href={`${ex}/address/${CFG.brain}`}>{CFG.brain}</a> · <a href={CFG.links.sourcify + CFG.brain}>source</a></td></tr>
        <tr><td>Circuit table v2 (SSTORE2 data contract)</td><td><a href={`${ex}/address/${CFG.circuitPtr}`}>{CFG.circuitPtr}</a></td></tr>
        <tr><td><code>FlyBrain</code> v1 (first fly, retired)</td><td><a href={`${ex}/address/${CFG.brainV1}`}>{CFG.brainV1}</a> · <a href={CFG.links.sourcify + CFG.brainV1}>source</a></td></tr>
        <tr><td>Keeper / deployer</td><td><a href={`${ex}/address/${CFG.deployer}`}>{CFG.deployer}</a></td></tr>
      </tbody></table>
      <div className="callout"><b>v1 → v2.</b> The first fly dropped pending synaptic input at the end of each tick, so a bump could not survive between ticks. v2 keeps it in storage, has a Yul inner loop (about 2.3× cheaper), and parameters calibrated across several trajectories. v1 stays on-chain as the first organism; its lineage is a fossil.</div>
      <h2>FlyRegistry interface</h2>
      <p>One contract is the permanent layer. A fly is a token; everything about it lives here or is anchored here. Bodies (an arena, a game, a robot) register, get assigned a fly, accept it, and are then the only address that can write its brain state, and only forward.</p>
      <pre><code>{`struct Fly { bytes32 connectome; uint32 model; uint32 generation; uint32 deaths; uint256 parentA; uint256 parentB;
             bytes32 stateRoot; bytes32 memoryRoot; string stateURI; uint64 brainStep; uint64 energy;
             uint64 bornBlock; uint64 lastCommitBlock; address body; address pendingBody; bool alive; }

function mint(string name) returns (uint256 id);               // anyone; burns MINT_PRICE (1 FLY); fresh genesis brain; max 10,000
function feed(uint256 id, uint64 seconds_);                    // anyone; burns seconds × FEED_PER_SECOND (1 FLY/s)
function resurrect(uint256 id, uint64 seconds_);               // anyone; only when dead; burns RESURRECT_PRICE (1,000) + food; generation + 1
function breed(uint256 a, uint256 b, bytes32 childMemoryRoot, string name) returns (uint256 id); // owner of both, both alive; burns 5,000
function registerBody(string name, string uri);                // anyone; a body announces itself (the arena puts its live-stream URL here)
function assign(uint256 id, address body);                     // the owner, or the body currently running it
function accept(uint256 id); function release(uint256 id);     // the body
function commit(uint256 id, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, string metadataURI, uint64 brainStep, uint64 energy, bytes32 historyRoot); // the body; step must advance
function interaction(uint256 id, bytes32 kind, string data);   // the body: ate, jumped, doom decision, met #n …
function died(uint256 id, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, string metadataURI, uint64 brainStep, string cause); // the body
function attest(uint256 id, uint64 brainStep, bytes32 stateRoot); // anyone who replayed it
function setMetadata(uint256 id, string uri);                   // curator, only while no body runs the fly (portraits)

event Minted(uint256 indexed id, address indexed to, string name, uint256 parentA, uint256 parentB);
event Fed(uint256 indexed id, address indexed by, uint64 seconds_, uint256 tokensBurned);
event Resurrected(uint256 indexed id, address indexed by, uint32 generation, uint64 energy, uint256 tokensBurned);
event Assigned / Accepted / Released (uint256 indexed id, address indexed body …);
event Commit(uint256 indexed id, address indexed body, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, uint64 brainStep, uint64 energy, bytes32 historyRoot);
event Interaction(uint256 indexed id, address indexed body, bytes32 indexed kind, string data);
event Died(uint256 indexed id, address indexed body, uint32 generation, bytes32 stateRoot, bytes32 memoryRoot, string stateURI, uint64 brainStep, string cause);
event Attested(uint256 indexed id, address indexed attestor, uint64 brainStep, bytes32 stateRoot, bool matches);`}</code></pre>
      <p>Rules the contract enforces: a fly has at most one body; only that body commits, and only forward; a dead fly cannot be committed and <b>cannot be transferred or sold</b> until resurrected; breeding needs two living flies; supply stops at 10,000. Snapshots are pinned to IPFS and named by their sha256, which is the <code>stateRoot</code>, so any body can fetch, verify and continue a fly. ERC-2981 royalty: 2.5% to the operator on secondary sales. Nothing is upgradeable; the curator can only set dormant flies&apos; portraits and the collection&apos;s branding.</p>
      <h2>LifeFund</h2>
      <p>Feeding is the organism&apos;s metabolism and stays as it is: one $FLY burned per second of life. But most people should not have to hold $FLY to keep a fly alive, so a second contract, <a href={`${ex}/address/${CFG.lifeFund}#code`}><code>LifeFund</code></a> (verified), takes BNB instead. Anyone calls <code>sponsor(id)</code> with BNB for any fly; the fly is credited with <code>quote(msg.value)</code> seconds of life at the published rate (<code>secondsPerWeiE18</code>, set so that 0.01 BNB is 86,400 s: a day). The operator&apos;s keeper then calls <code>keep(id, seconds)</code> whenever the fly is running in a body and getting hungry, which spends the credit and feeds the registry from the $FLY the fund holds. The keeper may also <code>grant(id, seconds)</code> free life, at most <code>freeSecondsPerDay</code> (7,200 s, two hours) per fly per day. The BNB goes to the treasury, the operator refills the fund&apos;s $FLY, and nothing in the contract can touch anyone&apos;s fly: it can only feed.</p>
      <pre><code>{`function sponsor(uint256 id) payable;                         // anyone, for any fly; credit[id] += quote(msg.value); the BNB goes to the treasury
function quote(uint256 wei_) view returns (uint256 seconds_);  // wei × secondsPerWeiE18 / 1e18
function keep(uint256 id, uint64 seconds_);                    // keeper: credit[id] -= seconds; registry.feed(id, seconds) from the fund's $FLY
function grant(uint256 id, uint64 seconds_);                   // keeper: a free top-up, capped at freeSecondsPerDay per fly per day

function credit(uint256 id) view returns (uint256);            // sponsored seconds not yet fed (never expire)
function sponsoredTotal(uint256 id) view returns (uint256);    // wei ever sent for the fly
function fedTotal(uint256 id) view returns (uint256);          // seconds the fund has ever fed it, sponsored and free
function freeLeftToday(uint256 id) view returns (uint256);     // free seconds the operator can still grant it today
function stockSeconds() view returns (uint256);                // the fund's $FLY, in seconds of life it can still pay for

event Sponsored(uint256 indexed id, address indexed by, uint256 wei_, uint256 seconds_, uint256 credit);
event Kept(uint256 indexed id, uint64 seconds_, uint256 creditLeft);
event Granted(uint256 indexed id, uint64 seconds_);`}</code></pre>
      <table className="data"><tbody>
        <tr><td>Rate</td><td>0.01 BNB ≈ 24 h of life (<code>secondsPerWeiE18</code> = 8,640,000); the owner can change it, and every page quotes the live rate</td></tr>
        <tr><td>Minimum</td><td>anything that buys at least one second (<code>TooLittle</code> otherwise); the site suggests 0.001 BNB or more</td></tr>
        <tr><td>Free allowance</td><td><code>freeSecondsPerDay</code> = 7,200 s per fly per day, granted by the keeper</td></tr>
        <tr><td>Keeper</td><td>the operator&apos;s keeper wallet; feeds a sponsored fly only while it runs in a body (a fly that is not running does not age)</td></tr>
      </tbody></table>
      <h2>Constants of the registry</h2>
      <table className="data"><tbody>
        <tr><td>MINT_PRICE</td><td>1 FLY</td></tr><tr><td>FEED_PER_SECOND</td><td>1 FLY</td></tr><tr><td>RESURRECT_PRICE</td><td>1,000 FLY (+ at least 60 s of food)</td></tr><tr><td>BREED_PRICE</td><td>5,000 FLY</td></tr><tr><td>GENESIS_ENERGY</td><td>3,600 s</td></tr><tr><td>MAX_SUPPLY</td><td>10,000</td></tr><tr><td>CONNECTOME</td><td>sha256 of the FlyWire 783 connectome build (see <code>brain/identity.json</code>)</td></tr><tr><td>MODEL</td><td>2 (Shiu et al. 2024 parameters, <code>brain/sim.py</code>)</td></tr>
      </tbody></table>
      <h2>$FLY</h2>
      <p>A BEP-20 with 1,000,000,000 supply, 18 decimals and a 1% transfer tax; ownership renounced; EIP-2612 permit. It has no burn function, so the fly “burns” by transferring to <code>0x000000000000000000000000000000000000dEaD</code>. <code>FlyBrain.totalBurned()</code> counts what the fly has eaten.</p>
      <h2>FlyWorld interface (historical)</h2>
      <pre><code>{`function placeFood(int32 x, int32 y, uint256 amount) external returns (uint256 id); // burns $FLY; 1 $FLY = 1 s of life, min 60
function resurrect(uint256 extraFood) external;                                      // only when dead; burns 50,000 $FLY + extraFood
function checkpoint(uint64 step, uint64 ageMs, bytes32 stateHash, int32 x, int32 y, uint64 energy, uint64 spikes, string snapshotURI); // operator
function reportDeath(uint64 ageMs, bytes32 stateHash, string snapshotURI);                                                             // operator
function foods(uint256) view returns (address by, int32 x, int32 y, uint64 seconds_, uint64 blockNumber);
function alive() view returns (bool); function generation() view returns (uint32); function lastHash() view returns (bytes32);

event FoodPlaced(uint256 indexed id, address indexed by, int32 x, int32 y, uint64 seconds_, uint256 tokensBurned);
event Checkpoint(uint64 step, uint64 ageMs, bytes32 stateHash, int32 x, int32 y, uint64 energy, uint64 spikes, uint32 generation, string snapshotURI);
event Died(uint32 indexed generation, uint64 ageMs, bytes32 stateHash, string snapshotURI);
event Resurrected(uint32 indexed generation, address indexed by, uint256 tokensBurned, uint64 energy);`}</code></pre>
      <p>The operator (the deployer address) can only post attestations about the off-chain simulation; it cannot move anyone&apos;s tokens or change prices. The arena is 240 × 240 body lengths; coordinates outside ±120 revert. Each checkpoint&apos;s <code>snapshotURI</code> points to a downloadable snapshot of every membrane potential and synaptic current, and also tells the website where the live stream is.</p>

      <h2>FlyBrain interface (the on-chain core)</h2>
      <pre><code>{`function tick(uint16 steps) external;                       // anyone, gas only
function feed(uint256 amount) external;                     // burns $FLY, +energy
function stimulate(uint8 channel, uint8 param, uint8 strength, uint16 steps) external;
function resurrect(uint256 extraFood) external;             // only when dead
// permit variants: feedWithPermit, stimulateWithPermit, resurrectWithPermit

function brainState() external view returns (int16[] v, int8[] bias, uint16[16] headingHist,
    int32[] pendingInput, uint64 step, uint64 energy, bool alive, uint32 generation,
    int64 posX, int64 posY, int32 headX, int32 headY);
function activeStimulus() external view returns (uint8 channel, uint8 param, uint16 strength, uint64 untilStep, bool active);
function lineage(uint256 i) external view returns (uint64 bornBlock, uint64 diedBlock, uint64 steps, uint64 spikes, bytes32 brainStateHash);
function neuron(uint256 i) external view returns (uint64 rootId, uint8 cellType, uint8 wedge, uint8 side, uint16 outDegree);
function synapsesOf(uint256 i) external view returns (uint8[] post, uint8[] weight);
function circuitData() external view returns (bytes);        // the raw table
function brainStateHash() external view returns (bytes32);

event Ticked(address indexed by, uint64 fromStep, uint16 steps, uint32 spikes, int32 headX, int32 headY, int64 posX, int64 posY, uint64 energyLeft);
event Fed(address indexed by, uint256 tokensBurned, uint64 energyAdded, uint64 energy);
event Stimulated(address indexed by, uint8 channel, uint8 param, uint16 strength, uint64 untilStep, uint256 tokensBurned);
event Died(uint32 indexed generation, uint64 bornBlock, uint64 diedBlock, uint64 lifeSteps, uint64 lifeSpikes, bytes32 brainStateHash);
event Resurrected(uint32 indexed generation, address indexed by, uint256 tokensBurned, uint64 energy);`}</code></pre>
      <p>Channels: <code>1</code> cue (param = wedge 0–15), <code>2</code> turn left, <code>3</code> turn right, <code>4</code> shock. Strength 1–255; price is <code>STIM_PRICE × strength</code>. A stimulus lasts <code>STIM_TTL</code> = 64 steps.</p>
      <h2>Constants of the live fly</h2>
      <table className="data"><tbody>
        <tr><td>TOKENS_PER_STEP</td><td>1 FLY</td></tr><tr><td>STIM_PRICE</td><td>100 FLY per unit strength</td></tr><tr><td>RESURRECT_PRICE</td><td>100,000 FLY</td></tr><tr><td>MAX_STEPS</td><td>64 per tick</td></tr><tr><td>Genesis energy</td><td>1,000,000 steps</td></tr>
      </tbody></table>
      <h2>No owner</h2>
      <p>FlyBrain has no owner, no admin function, no upgrade path, no pause. Every parameter is an <code>immutable</code>. The only way to change the fly is to deploy a new one.</p>
      <h2>Build and test</h2>
      <pre><code>{`git clone ${CFG.links.github}
cd immortal-fruit-fly/contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test -vv        # 28 tests incl. the mainnet replay and the immortality loop (die in the arena, wake in DOOM)`}</code></pre>
    </DocsShell>
  );
}
