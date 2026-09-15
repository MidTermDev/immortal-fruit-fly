import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Contracts & addresses" };

export default function Page() {
  const ex = CFG.explorer;
  return (
    <DocsShell current="/docs/contracts/">
      <h1>Contracts &amp; addresses</h1>
      <p className="lede">Everything is on BNB Smart Chain (chain ID 56). Sources are verified on Sourcify as exact matches.</p>
      <table className="data"><thead><tr><th>Contract</th><th>Address</th></tr></thead><tbody>
        <tr><td><code>$FLY</code> token (Immortal Fruit Flies)</td><td><a href={`${ex}/token/${CFG.token}`}>{CFG.token}</a></td></tr>
        <tr><td><code>FlyBrain</code> v2, the genesis fly (live)</td><td><a href={`${ex}/address/${CFG.brain}`}>{CFG.brain}</a> · <a href={CFG.links.sourcify + CFG.brain}>source</a></td></tr>
        <tr><td>Circuit table v2 (SSTORE2 data contract)</td><td><a href={`${ex}/address/${CFG.circuitPtr}`}>{CFG.circuitPtr}</a></td></tr>
        <tr><td><code>FlyBrain</code> v1 (first fly, retired)</td><td><a href={`${ex}/address/${CFG.brainV1}`}>{CFG.brainV1}</a> · <a href={CFG.links.sourcify + CFG.brainV1}>source</a></td></tr>
        <tr><td>Keeper / deployer</td><td><a href={`${ex}/address/${CFG.deployer}`}>{CFG.deployer}</a></td></tr>
      </tbody></table>
      <div className="callout"><b>v1 → v2.</b> The first fly dropped pending synaptic input at the end of each tick, so a bump could not survive between ticks. v2 keeps it in storage, has a Yul inner loop (about 2.3× cheaper), and parameters calibrated across several trajectories. v1 stays on-chain as the first organism; its lineage is a fossil.</div>
      <h2>$FLY</h2>
      <p>A BEP-20 with 1,000,000,000 supply, 18 decimals and a 1% transfer tax; ownership renounced; EIP-2612 permit. It has no burn function, so the fly “burns” by transferring to <code>0x000000000000000000000000000000000000dEaD</code>. <code>FlyBrain.totalBurned()</code> counts what the fly has eaten.</p>
      <h2>FlyBrain interface</h2>
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
