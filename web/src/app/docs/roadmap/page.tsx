import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
export const metadata: Metadata = { title: "Roadmap" };

export default function Page() {
  return (
    <DocsShell current="/docs/roadmap/">
      <h1>Roadmap: a fly that actually lives on-chain</h1>
      <p className="lede">From one compass circuit to reflexes, learning, a breeding colony, and the whole 166,700-neuron brain anchored to BNB Chain. Every phase names the real neurons it will run and the numbers that make it feasible.</p>

      <div className="callout"><b>Cost model.</b> Measured on the live fly: about 25k gas per step for 155 neurons plus roughly 70 gas per synapse event. A circuit table holds up to 24 KB per data contract and a brain can point to several. Rule of thumb: reflexes and steering on BSC, big circuits on opBNB with checkpoints on BSC.</div>

      <div className="phase done"><span className="k">genesis · live</span><h3>The compass</h3>
        <p>155 neurons (EPG, EPGt, PEG, PEN_a, PEN_b, Δ7), 6,522 connections. Energy, death, resurrection, lineage, engram, walking. Keeper ticking every two minutes. Website with a bit-exact local replica.</p></div>

      <div className="phase"><span className="k">phase 1</span><h3>Alive without us</h3>
        <ul>
          <li><strong>Keeper economy.</strong> A share of every feed goes to a keeper pool; whoever calls <code>tick()</code> is paid from it. The brain never stops because one bot died.</li>
          <li><strong>Senses from the chain.</strong> Large <code>$FLY</code> transfers become a food smell that pulls the compass toward the sender&apos;s wedge; large sells become a looming shadow (Δ7 shock). The fly reacts to its own market.</li>
          <li><strong>Public EEG.</strong> Every spike streamed from the events, a 24/7 render for X and Telegram.</li>
        </ul></div>

      <div className="phase"><span className="k">phase 2</span><h3>Reflexes: the escape circuit and steering</h3>
        <p>The two circuits every fly-brain demo actually uses, added to the same contract shape.</p>
        <ul>
          <li><strong>Giant fiber (DNp01) loom-escape.</strong> LC4 (55 cells, 2,442 synapses onto GF) and LPLC2 (108 cells, 1,366 synapses) looming detectors converge on the giant fiber, which drives the jump motor neuron TTMn and, via PSI, the flight muscles. Roughly 190–250 neurons, a few hundred edges: one table. The gap junctions GF→TTMn/PSI are invisible to EM and will be hard-coded as forward-only edges (Phelan 2008). Input: a loom is a stimulus channel; output: one GF spike and its latency. Prior art: von Reyn 2017, Ache 2019, Dombrovski 2023, and the c3s-reflex-circuits project which compiled this reflex to 173 NAND gates.</li>
          <li><strong>Descending steering.</strong> DNa02 (left minus right rate = rotational velocity, Rayshubskiy 2025), DNa01, DNp09 (forward), MDN (backward), plus the DN–DN network Braun 2024 mapped (32 DNs recruited by DNp09, 14 by MDN) and their central-complex inputs PFL3/PFL2. About 100–200 neurons. The compass then steers a body through real descending neurons instead of a population vector.</li>
          <li><strong>Arena.</strong> An on-chain world with food, walls and predators. The fly&apos;s walk becomes a game anyone can watch and influence.</li>
        </ul></div>

      <div className="phase"><span className="k">phase 3</span><h3>Learning</h3>
        <ul>
          <li><strong>A mushroom-body compartment.</strong> A subsampled set of Kenyon cells, one MBON, and the PAM/PPL1 dopamine neurons that gate KC→MBON depression (Aso 2014, Hige 2015, Li 2020). The same mechanism the DOOM and Stonkfly projects pulse; on-chain, the weights are storage and anyone can audit what was learned.</li>
          <li><strong>Reward is food, punishment is shock.</strong> Feeding pulses the reward dopamine neurons, shocks pulse the aversive ones. The fly learns which stimulus channels predict food and steers toward them.</li>
          <li><strong>Heritable memory.</strong> Learned weights travel with the engram through death and resurrection.</li>
        </ul></div>

      <div className="phase"><span className="k">phase 4</span><h3>The colony</h3>
        <ul>
          <li><strong>FlyFactory.</strong> Mint a fly: an NFT whose token is a live brain contract. Same circuit, its own life, its own caretakers.</li>
          <li><strong>Shared world.</strong> Flies see each other (mutual looming), compete for food, get fed by fans.</li>
          <li><strong>Breeding.</strong> Two dead flies&apos; engrams cross over, with mutation, into a child&apos;s initial memory. Selection pressure is who gets fed. The connectome is fixed; memory evolves. A species.</li>
          <li>Leaderboards: oldest, most spikes, longest walk, most generations.</li>
        </ul></div>

      <div className="phase"><span className="k">phase 5</span><h3>The whole brain</h3>
        <ul>
          <li><strong>Full connectome off-chain, verifiable on-chain.</strong> MaleCNS v1.0 (166,700 neurons, 25.6M directed connections) in the standard Shiu-style LIF recipe, integer-exact, with Merkle roots of the membrane state posted every N steps.</li>
          <li><strong>Verification ladder.</strong> Optimistic first: anyone can dispute a checkpoint by replaying one window on-chain with the same integer model. Then ZK proofs of windows once proving is cheap enough.</li>
          <li><strong>Where it lives.</strong> Small circuits on BSC. High-frequency ticks on opBNB. Snapshots on BNB Greenfield, hashes on BSC.</li>
          <li><strong>The payoff.</strong> The same fly that lives in the contract is the one that plays DOOM, Dino and Beat Saber, with every input and output anchored to the chain.</li>
        </ul></div>

      <h2>Feasibility ranking</h2>
      <table className="data"><thead><tr><th>Circuit</th><th>Neurons</th><th>Edges</th><th>Input / output</th><th>On-chain verdict</th></tr></thead><tbody>
        <tr><td>Head-direction ring (live)</td><td>155</td><td>6,522</td><td>cue/turn/shock → heading</td><td>running</td></tr>
        <tr><td>Giant-fiber escape</td><td>~190–250</td><td>a few hundred</td><td>loom → GF spike, TTMn</td><td>next; cheapest, binary readout</td></tr>
        <tr><td>Descending steering layer</td><td>~100–200</td><td>a few hundred</td><td>PFL3 → DNa02 L−R</td><td>after GF; same contract shape</td></tr>
        <tr><td>Mushroom-body compartment</td><td>~200 KC subsample + MBON + DANs</td><td>~10k plastic</td><td>odor+reward → MBON</td><td>feasible; plasticity in storage</td></tr>
        <tr><td>VNC leg premotor + MNs</td><td>1,045 (MaleCNS cut)</td><td>17,224</td><td>DN → leg MN spikes</td><td>opBNB only; gait needs CPG dynamics EM does not encode</td></tr>
        <tr><td>Whole brain</td><td>166,700</td><td>25.6M</td><td>pixels → DNs</td><td>off-chain + checkpoints + disputes</td></tr>
      </tbody></table>
      <h2>Economics across phases</h2>
      <ul><li>Feeds and stimuli are burns. A keeper pool takes a slice of feeds to pay tickers.</li><li>Resurrection price scales with generation.</li><li>Minting a fly in phase 4 burns; breeding burns both parents&apos; resurrection cost.</li></ul>
    </DocsShell>
  );
}
