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
        <tr><td><code>$FLY</code> token (Immortal Fruit Flies)</td><td><a href={`${ex}/token/${CFG.token}`}>{CFG.token}</a></td></tr>
        <tr><td><code>FlyWorld</code>, the whole-brain fly&apos;s arena (food, checkpoints, lineage)</td><td><a href={`${ex}/address/${CFG.world}`}>{CFG.world}</a> · <a href={CFG.links.sourcify + CFG.world}>source</a></td></tr>
        <tr><td><code>FlyArcade</code>, the log of the whole brain playing games (brain hash per decision)</td><td><a href={`${ex}/address/${CFG.arcade}`}>{CFG.arcade}</a></td></tr>
        <tr><td><code>FlyBrain</code> v2, the on-chain compass core (live)</td><td><a href={`${ex}/address/${CFG.brain}`}>{CFG.brain}</a> · <a href={CFG.links.sourcify + CFG.brain}>source</a></td></tr>
        <tr><td>Circuit table v2 (SSTORE2 data contract)</td><td><a href={`${ex}/address/${CFG.circuitPtr}`}>{CFG.circuitPtr}</a></td></tr>
        <tr><td><code>FlyBrain</code> v1 (first fly, retired)</td><td><a href={`${ex}/address/${CFG.brainV1}`}>{CFG.brainV1}</a> · <a href={CFG.links.sourcify + CFG.brainV1}>source</a></td></tr>
        <tr><td>Keeper / deployer</td><td><a href={`${ex}/address/${CFG.deployer}`}>{CFG.deployer}</a></td></tr>
      </tbody></table>
      <div className="callout"><b>v1 → v2.</b> The first fly dropped pending synaptic input at the end of each tick, so a bump could not survive between ticks. v2 keeps it in storage, has a Yul inner loop (about 2.3× cheaper), and parameters calibrated across several trajectories. v1 stays on-chain as the first organism; its lineage is a fossil.</div>
      <h2>$FLY</h2>
      <p>A BEP-20 with 1,000,000,000 supply, 18 decimals and a 1% transfer tax; ownership renounced; EIP-2612 permit. It has no burn function, so the fly “burns” by transferring to <code>0x000000000000000000000000000000000000dEaD</code>. <code>FlyBrain.totalBurned()</code> counts what the fly has eaten.</p>
      <h2>FlyWorld interface</h2>
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

      <h2>FlyArcade interface</h2>
      <p>A record of the whole brain playing a game. Only the operator can post sessions and decisions. FlyArcade holds no funds and has no feeding function; it records reports without verifying the game or neural computation.</p>
      <pre><code>{`function sessionCount() view returns (uint256);
function sessions(uint256) view returns (string game, uint64 startBlock, uint64 endBlock, uint32 decisions, uint32 kills, bytes32 finalHash);

event SessionStarted(uint256 indexed id, string game, bytes32 brainHash, uint64 brainStep);
event Decision(uint256 indexed session, uint32 indexed n, bytes32 brainHash, uint64 brainStep,
    int16 turn, bool fire, uint32 spikes, uint16 kills, uint16 health, uint32 gameTic);
event SessionEnded(uint256 indexed id, uint32 decisions, uint32 kills, bytes32 finalHash);`}</code></pre>
      <p>The DOOM runner periodically logs accumulated turning (positive means left), whether it fired during the interval, and reported game statistics. Kills can reset between episodes. The spike counter is cumulative and wraps at 2³²; it is not a count for that decision alone.</p>
      <p>Brain hashes cover the model&apos;s membrane potentials, synaptic current, delay ring, and step. They are sampled by the queued writer after the action report; the runner currently saves its video and report locally, without publishing replay snapshots or a live video endpoint. An end block records a closed session; an open session alone does not prove the runner is still active.</p>

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
forge test -vv        # 19 tests incl. the mainnet replay`}</code></pre>
    </DocsShell>
  );
}
