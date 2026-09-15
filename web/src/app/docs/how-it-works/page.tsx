import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import params from "@/data/params.json";
export const metadata: Metadata = { title: "How the brains run" };

export default function Page() {
  const p = params;
  return (
    <DocsShell current="/docs/how-it-works/">
      <h1>How it works</h1>
      <p className="lede">Three integrations share connectome data: a whole-brain arena, an on-chain compass core, and a separate whole-brain DOOM player. Their state, feeding and evidence are distinct.</p>

      <h2>Part 1 · The whole brain</h2>
      <h3>The model</h3>
      <p>All 139,248 neurons of FlyWire release 783 and the 2,700,429 connections with at least five synapses (34.2 M synapses in total), as leaky integrate-and-fire units with the parameters of Shiu et al. 2024 (<i>Nature</i> 634:210), the model every whole-brain demo of the last year uses: resting and reset potential −52 mV, threshold −45 mV, membrane time constant 20 ms, synaptic time constant 5 ms, refractory period 2.2 ms, synaptic delay 1.8 ms, and 0.275 mV of drive per synapse, negative when the presynaptic neuron is predicted GABAergic or glutamatergic. Time step 0.1 ms. Sensory neurons are driven as Poisson spike sources.</p>
      <p>The kernel is event-driven and compiled with Numba: only neurons that spike traverse their outgoing synapses. Its random stream is derived from the step number and neuron index. The live server reports its simulation speed; actual throughput depends on the host and workload. Reproducing a run also requires its starting state, sensory inputs and integration timing.</p>
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
      </ul>
      <div className="callout"><b>Data and model choices.</b> The connectome supplies neurons, wiring and predicted transmitters. The neuron equations, sensory drive, contrast sharpening, adaptive baselines and movement rules are modelling choices. The frontend displays the resulting observations; it does not establish that the model reproduces a living fly&apos;s full behavior.</div>
      <h3>Metabolism and the chain</h3>
      <p>One simulated second consumes one unit of energy. A <code>FlyWorld.placeFood()</code> transaction burns FLY and records a food placement; the server reads that event and adds food to the arena. Placement is separate from consumption. The current feeding page places food at the arena center, and energy increases when it is eaten.</p>
      <p>The server defaults to a checkpoint every ten minutes, saving a snapshot and reporting a hash, position, energy and spike count through <code>FlyWorld.checkpoint()</code>. It reports death when energy reaches zero. A confirmed <code>resurrect()</code> transaction records starting energy for the server to apply. These actions affect the arena instance, not the separate DOOM process.</p>
      <h3>What the hash covers</h3>
      <p>The current <code>WholeBrain.state_hash()</code> hashes <code>v</code>, <code>g</code>, <code>ring</code> and the simulation step <code>t</code>. It does not hash every field saved in the snapshot: refractory timers, counters and world state are outside that digest. Matching this hash checks those covered fields; it is not a complete simulation proof. The contract records the operator&apos;s report without executing or validating the whole-brain model.</p>

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
      <p>Contract noise is <code>keccak256(stepNumber)</code>, re-hashed every 32 neurons, one signed byte per neuron. It uses neither block hash nor timestamp. Replay must preserve transaction order and exact tick batch sizes: bias and movement update at the end of each batch.</p>

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
      <p>The inner loop is hand-written Yul. Measured on the live circuit: about 25k gas per step for the 155 neurons, plus roughly 70 gas per synapse event. A 32-step tick with an active bump costs 4.4–7M gas; a strong turn stimulus (many PEN and EPG spikes) up to 12M. Actual BNB fees depend on gas used and the current gas price.</p>

      <h2>Determinism, tested</h2>
      <p><code>test/Differential.t.sol</code> deploys the contract in Foundry, replays the exact transactions sent to the v1 mainnet fly, and asserts the spike counts, heading vectors and positions recorded in the mainnet events. The Python and TypeScript simulators pass the same replay.</p>

      <h2>Part 3 · DOOM and FlyArcade</h2>
      <p><code>brain/doom.py</code> starts its own whole-brain instance. Object bearings and size drive olfactory and looming inputs; descending-neuron readouts produce turn commands, and selected giant-fiber and take-off spikes trigger firing. The mapping from these neural signals to game buttons is application code. This process does not read FlyWorld food or use the arena&apos;s energy balance.</p>
      <h3>Recorded decisions</h3>
      <p>The operator submits a <code>FlyArcade.Decision</code> record at configurable intervals, 1.2 seconds by default. Several game actions may be represented by one record. The contract accepts the operator&apos;s values and hash; it holds no funds and does not verify game play.</p>
      <table className="data"><thead><tr><th>Field</th><th>Meaning in the current runner</th></tr></thead><tbody>
        <tr><td><code>turn</code></td><td>Accumulated, rounded turn commands since the previous sample. Positive means left, negative means right. This is not an absolute heading.</td></tr>
        <tr><td><code>fire</code></td><td>At least one firing command occurred during the sampled interval.</td></tr>
        <tr><td><code>spikes</code></td><td>The whole-brain cumulative spike counter modulo 2³², not spikes generated by this decision.</td></tr>
        <tr><td><code>kills</code>, <code>health</code>, <code>gameTic</code></td><td>Reported game counters. Kills can reset when the runner starts another episode within the same contract session.</td></tr>
        <tr><td><code>brainHash</code>, <code>brainStep</code></td><td>Captured when the queued chain job is processed. They can be later than the sampled action and game counters.</td></tr>
      </tbody></table>
      <h3>What the frontend can show</h3>
      <p>Contract records support a session timeline, reported turns and firing, game counters, hashes and transaction links. The current runner writes a local <code>doom_fly.mp4</code> and <code>run.json</code>; it provides no browser video stream or published per-decision brain snapshots. The arena&apos;s WebSocket stream is a different simulation and cannot stand in for DOOM observations.</p>
      <p>The runner also sends cues to the 155-neuron core in separate transactions. Those core results are actual EVM executions, but the contracts contain no explicit link from a core tick to an Arcade decision or session. The frontend therefore treats them as separate records. An end-session event records the operator&apos;s end call; the current contract does not prevent later decisions for that session.</p>
    </DocsShell>
  );
}
