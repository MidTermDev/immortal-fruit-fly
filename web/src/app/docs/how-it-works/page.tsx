import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import params from "@/data/params.json";
export const metadata: Metadata = { title: "How the brain runs on-chain" };

export default function Page() {
  const p = params as any;
  return (
    <DocsShell current="/docs/how-it-works/">
      <h1>How the brain runs on-chain</h1>
      <p className="lede">Integer leaky-integrate-and-fire neurons, synchronous spikes, deterministic noise, packed storage. Everything the EVM can do exactly, and nothing it cannot.</p>

      <h2>The neuron model</h2>
      <p>Each of the 155 neurons has a membrane potential <code>v</code> (an int16 in storage, int32 while computing). Every simulation step, for every neuron:</p>
      <pre><code>{`v -= v * LEAK / 1024                     // leak toward 0
v += pendingInput[i]                     // spikes that arrived last step
v += noise(step, i) * NOISE / 128        // deterministic background noise
v += bias[i] * G_BIAS                    // the engram
if (stimulus active) v += stimI[i]       // injected current
if (v < V_MIN) v = V_MIN
if (v >= THRESH) { v = RESET; spike }    // fire
`}</code></pre>
      <p>Spikes fired at step <em>t</em> arrive at their targets at <em>t + 1</em>: for every synapse of a spiking neuron, <code>pendingInput[post] += weight × gain[preType] / 16</code>. Weight is the FlyWire synapse count between the two cells (clipped to 255). Gain is one signed number per presynaptic cell type, negative for Δ7, which FlyWire predicts to be glutamatergic and which is inhibitory in this circuit.</p>
      <p>The same recipe as every whole-brain demo (Shiu et al. 2024: leaky integrate-and-fire, weight proportional to synapse count, sign from neurotransmitter), reduced to integers so the EVM computes it exactly.</p>

      <h2>Parameters of the live fly (v2)</h2>
      <table className="data"><thead><tr><th>Parameter</th><th>Value</th><th>Meaning</th></tr></thead><tbody>
        <tr><td>leak</td><td>{p.leak}/1024</td><td>fraction of potential lost per step</td></tr>
        <tr><td>thresh / reset / vMin</td><td>{p.thresh} / {p.reset} / {p.vMin}</td><td>spike threshold, post-spike potential, floor</td></tr>
        <tr><td>gains [EPG, EPGt, PEG, PEN_a, PEN_b, Δ7]</td><td>[{p.gains.join(", ")}]</td><td>synaptic gain per presynaptic type</td></tr>
        <tr><td>noise</td><td>{p.noise}</td><td>amplitude of keccak-derived background noise</td></tr>
        <tr><td>stimGain / stimTTL</td><td>{p.stimGain} / {p.stimTTL}</td><td>current per unit stimulus strength; steps a stimulus lasts</td></tr>
        <tr><td>gBias</td><td>{p.gBias}</td><td>engram gain</td></tr>
        <tr><td>walkThreshold</td><td>{p.walkThreshold}</td><td>minimum bump strength per step to walk</td></tr>
        <tr><td>maxSteps</td><td>{p.maxSteps}</td><td>max steps per tick</td></tr>
      </tbody></table>
      <p>These were found by a search over 12,000 candidates scored on four trajectories: does a cue create a bump at the right wedge, does the bump persist for 128 free steps, does left PEN drive rotate it, does it survive, does a Δ7 shock collapse it. The calibration script and its report are in <code>sim/</code>.</p>

      <h2>Noise without an oracle</h2>
      <p>Real neurons are noisy. A contract must be deterministic. So noise is <code>keccak256(stepNumber)</code>, re-hashed every 32 neurons, one signed byte per neuron. No block hash, no timestamp. Anyone can replay the brain&apos;s entire life from its events and get the same bits.</p>

      <h2>The engram</h2>
      <p>At the end of every tick, a neuron that fired in at least one eighth of the steps gains one unit of bias; a neuron that never fired loses one. Bias is bounded at ±24 and multiplied by <code>gBias</code> into the membrane potential. It is slow, permanent, and survives death. It is the fly&apos;s memory of its habits.</p>

      <h2>Heading and walking</h2>
      <p>Each EPG spike contributes a unit vector at its wedge&apos;s angle. The sum over a tick is the population vector (<code>headX, headY</code>). If its magnitude exceeds <code>walkThreshold × steps</code>, the fly moves <code>STRIDE/256</code> cells per step in that direction. The wedge with the most spikes increments the heading histogram.</p>

      <h2>Storage layout</h2>
      <ul>
        <li>Circuit table: one SSTORE2 data contract (bytecode, 15,065 bytes): version, N, S, cell types, wedges, hemisphere sides, CSR offsets, (post, weight) synapse pairs, and 155 FlyWire root IDs as uint64. keccak256 is an immutable in FlyBrain.</li>
        <li>Membrane potentials: 16 × int16 per word (10 words). Pending input: 8 × int32 per word (20 words). Engram: 32 × int8 per word (5 words). Heading histogram: 16 × uint16 in one word.</li>
        <li>Lineage: dynamic array of structs. Caretakers: mapping address → (fed, ticks, stimuli).</li>
      </ul>

      <h2>Gas</h2>
      <p>The inner loop is hand-written Yul. Measured on the live circuit: about 25k gas per step for the 155 neurons, plus roughly 70 gas per synapse event. A 32-step tick with an active bump costs 4.4–7M gas; a strong turn stimulus (many PEN and EPG spikes) up to 12M. BSC&apos;s 0.05 gwei makes that 0.0002–0.0006 BNB per tick.</p>

      <h2>Determinism, tested</h2>
      <p><code>test/Differential.t.sol</code> deploys the contract in Foundry, replays the exact transactions sent to the v1 mainnet fly, and asserts the spike counts, heading vectors and positions recorded in the mainnet events. The Python and TypeScript simulators pass the same replay.</p>
    </DocsShell>
  );
}
