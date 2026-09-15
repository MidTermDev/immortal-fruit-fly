import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import params from "@/data/params.json";
export const metadata: Metadata = { title: "How the brain runs on-chain" };

export default function Page() {
  const p = params as any;
  return (
    <DocsShell current="/docs/how-it-works/">
      <h1>How it works</h1>
      <p className="lede">Two brains. The whole connectome runs on a server in the published whole-brain model, embodied in a world, and is anchored to BNB Smart Chain by hashes and fed by burns. A 155-neuron core runs entirely inside a contract. This page covers both.</p>

      <h2>Part 1 · The whole brain</h2>
      <h3>The model</h3>
      <p>All 139,248 neurons of FlyWire release 783 and the 2,700,429 connections with at least five synapses (34.2 M synapses in total), as leaky integrate-and-fire units with the parameters of Shiu et al. 2024 (<i>Nature</i> 634:210), the model every whole-brain demo of the last year uses: resting and reset potential −52 mV, threshold −45 mV, membrane time constant 20 ms, synaptic time constant 5 ms, refractory period 2.2 ms, synaptic delay 1.8 ms, and 0.275 mV of drive per synapse, negative when the presynaptic neuron is predicted GABAergic or glutamatergic. Time step 0.1 ms. Sensory neurons are driven as Poisson spike sources.</p>
      <p>The kernel is event-driven and compiled (Numba): only neurons that spike touch their outgoing synapses. On 16 CPU cores the whole brain runs at 1.0–1.2× real time. The random stream is hashed from the step number and the neuron index, so a run is reproducible bit for bit from any snapshot.</p>
      <h3>Senses</h3>
      <table className="data"><thead><tr><th>Sense</th><th>Real neurons driven</th><th>Driven by</th></tr></thead><tbody>
        <tr><td>Smell</td><td>ORNs of the fruit-responsive glomeruli DM1, DM4, VA2, DM2, VM2, DP1m (Or42b, Or59b, Or92a, Or22a, Or43b …), split by antenna; all other ORNs at 2 Hz</td><td>Gaussian odor plumes of the food items (σ 30 body lengths). Bilateral contrast is sharpened before the antennae (gain 8, clipped) because a smooth plume is far gentler than the filaments and head-casting a real fly uses.</td></tr>
        <tr><td>Sight</td><td>R1–R6 photoreceptors, 8,452 cells, by eye</td><td>Uniform dim light (3 Hz). A lamp gradient is implemented but off for now: it competes with the odor for steering.</td></tr>
        <tr><td>Looming</td><td>LC4 (104) and LPLC2 (210) visual projection neurons, by side</td><td>A predator approaching from an edge: LC4 by angular expansion rate, LPLC2 by angular size (Ache et al. 2019).</td></tr>
        <tr><td>Taste</td><td>213 labellar gustatory neurons</td><td>80 Hz while standing on food.</td></tr>
      </tbody></table>
      <h3>Motor</h3>
      <ul>
        <li><strong>Turning.</strong> DNa02 and DNa01, left minus right, plus the 26-per-side DNa descending population. DNa02 activation drives an ipsilateral turn (Rayshubskiy et al. 2025); turning is distributed across many DNs (Braun et al. 2024). Each neuron&apos;s rate is compared to its own slowly adapting baseline (τ 8 s), because the reconstruction has strong fixed left–right asymmetries; rates are integrated over 300 ms.</li>
        <li><strong>Walking.</strong> Speed follows the surge-and-cast program measured in walking flies by Álvarez-Salvado et al. 2018: rising odor → surge (4.5 body lengths/s, straight), falling odor → cast (slow, sustained turning in the direction the DNs favour), otherwise walk at 3. DNp09 adds forward drive; MDN subtracts (backward walking).</li>
        <li><strong>Jumping.</strong> A spike in DNp01, the giant fiber, is an escape jump of 12 body lengths away from the predator.</li>
        <li><strong>Restarts.</strong> The server saves a local snapshot every minute and on shutdown, and restores the full world state, so a restart costs at most a minute of the fly&apos;s life.</li>
      </ul>
      <div className="callout"><b>What is and is not the connectome.</b> The neurons, their wiring, their transmitters and the whole-brain dynamics are the connectome. The mapping from world to sensory rates, the contrast sharpening, the adaptive baselines and the surge-and-cast speed rule are the embodiment layer, chosen from the literature and documented here. Without a sharpening step the fly does not chemotax: bilateral olfactory differences in the real animal are small, and both antennae project to both antennal lobes, so single descending neurons carry the gradient only when one antenna is nearly silent. We measured this before choosing the readout.</div>
      <h3>Metabolism and the chain</h3>
      <p>One simulated second costs one second of energy. Eating restores it. Every ten minutes the server hashes the complete brain state (every membrane potential, synaptic drive, delayed input and refractory clock), saves a snapshot that also carries the full world state and the brain step at which each on-chain event was applied, pins it to IPFS, and calls <code>FlyRegistry.commit()</code> on BNB Smart Chain with the hash (the <code>stateRoot</code>), the IPFS URI, the brain step and the energy. Food exists only through <code>FlyRegistry.feed()</code>: the arena body reads the event and drops the food near the fly. Notable events (ate, jumped, caught) go on-chain as <code>interaction()</code>. At zero energy the body reports the death with a final hash and keeps retrying until the contract agrees; <code>resurrect()</code> burns $FLY and the same brain continues from that snapshot, in whichever body the owner assigns it to next. To verify a checkpoint: download two consecutive snapshots from IPFS and run <code>brain/verify.py A.npz B.npz</code>; it replays A through the recorded events to B&apos;s step and compares the hash. The kernel avoids fast-math so the replay is bit-exact across machines. The connectome file it needs is rebuilt by <code>brain/build_connectome.py</code> from the public FlyWire release, and its sha256 is the fly&apos;s <code>connectome</code> field.</p>

      <h3>DOOM</h3>
      <p>The same brain plays DOOM (ViZDoom, <i>defend the center</i>) with the same senses and readouts: the nearest enemy&apos;s bearing is presented as a scent to the olfactory neurons of that antenna, enemies looming drive LC4/LPLC2 by eye, and a giant-fiber spike fires the gun. Turning is read from DNa02 and the DNa population. One measured fact matters here: in this model the sustained lateralized response of DNa02 is <em>contralateral</em> to the odor (DNa02-left ≈ 15 Hz for a left target, ≈ 75 Hz for a right one; <code>brain/diag2.py</code>), the opposite of the transient response and of the ipsilateral turning reported for the real neuron. The readout uses the sign the model exhibits, and the harness records how often the fly turned toward the nearest enemy (about 55% of turning frames in session 5, against 42% with the textbook sign). Each decision is logged to <code>FlyArcade</code> with the hash of the whole brain at that moment, and the on-chain compass core is cued with the same bearing so real neurons fire in the EVM in sync; its bump is replayed locally and checked against the chain. <code>brain/doom.py</code>.</p>

      <h2>Part 2 · The on-chain core</h2>
      <p>Integer leaky-integrate-and-fire neurons, synchronous spikes, deterministic noise, packed storage. Everything the EVM can do exactly, and nothing it cannot.</p>

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
