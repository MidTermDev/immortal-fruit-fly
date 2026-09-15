import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
export const metadata: Metadata = { title: "The vision" };

export default function Page() {
  return (
    <DocsShell current="/docs/vision/">
      <h1>The fly escaped the computer. Now it can never die.</h1>
      <p className="lede">Bringing CZ&apos;s “immortal fruit flies on BNB Chain” to life, literally: a nervous system whose identity, brain state, memory, lineage and every interaction are on-chain.</p>

      <h2>The prompt</h2>
      <p>On 13 September 2026, Frank (@Frank_web33) posted a video with the caption <em>“THE FLY BRAIN ESCAPED THE COMPUTER. I PUT IT INSIDE A PHYSICAL ROBOT.”</em> A simulated fruit-fly brain, the 166,700-neuron MaleCNS connectome released by Janelia and Google, was wired to a Strandbeest. Its neural activity was translated into motor commands for mechanical legs. Before that it had played DOOM, Chrome Dino, Beat Saber, Super Mario 64 and Minecraft.</p>
      <p>Two days later Siyuan of YZi Labs (@cyodyssey) quoted the post:</p>
      <blockquote className="quote" style={{ fontSize: 20 }}>“BNB Chain is fast and low-cost enough to potentially host parts of a fly&apos;s neural behavior on-chain, while serving as a permanent layer for identity, brain state, memory, lineage, and interaction history. A fly could die in a game while its brain state remains preserved and can later be instantiated again, creating a form of digital immortality. … Maybe this is how we finally get truly persistent on-chain life, years after CryptoKitties.”<cite>@cyodyssey · 15 Sep 2026 04:07 UTC</cite></blockquote>
      <p>Eight minutes later CZ quoted that:</p>
      <blockquote className="quote">“Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”<cite>@cz_binance · 15 Sep 2026 04:15 UTC</cite></blockquote>

      <h2>What everyone else built, and what was missing</h2>
      <p>Within a week of the connectome paper there were dozens of fly-brain projects, and several tokens: <code>$FLYBRAIN</code> on Robinhood Chain (peaked around $54M), <code>$HER</code>, <code>bFlyBrain</code> on BSC. In every one of them the brain runs off-chain on a GPU. The chain only sees a swap or a token-creation transaction signed by a bot. The fly is not on-chain. It is a screenshot of a fly, next to a token.</p>
      <p>Siyuan&apos;s list is precise: <strong>identity, brain state, memory, lineage, interaction history</strong>. Those five things are what makes an organism persistent, and those five things are exactly what a blockchain is good at holding. So that is what we built.</p>

      <h2>What “on-chain life” means here</h2>
      <table className="data"><thead><tr><th>Siyuan&apos;s requirement</th><th>How the genesis fly does it</th></tr></thead><tbody>
        <tr><td>Identity</td><td>155 FlyWire root IDs and the keccak256 of the circuit table are baked into the contract&apos;s bytecode. Anyone can look up each neuron on FlyWire Codex.</td></tr>
        <tr><td>Brain state</td><td>The membrane potential and pending synaptic current of every neuron are storage variables, updated by every <code>tick()</code>.</td></tr>
        <tr><td>Memory</td><td>An engram: per-neuron potentiation that grows with habitual firing and decays with silence. Plus a histogram of every direction the compass has held.</td></tr>
        <tr><td>Lineage</td><td>Every life is a struct: born block, died block, steps lived, spikes fired, and the hash of the brain at death.</td></tr>
        <tr><td>Interaction history</td><td>Every tick, feed, stimulus, death and resurrection is an event, with the caretaker&apos;s address. The website replays them.</td></tr>
        <tr><td>Dies in a game, comes back</td><td>Energy runs out, the fly dies, the brain freezes. <code>resurrect()</code> wakes the same brain in a new body. Generation + 1.</td></tr>
      </tbody></table>

      <h2>Why the compass first</h2>
      <p>The demos that went viral read a handful of descending neurons as a joystick and feed the game&apos;s pixels into photoreceptors. That works on a GPU. It does not fit in a block. We needed a circuit small enough to run every step on-chain and meaningful enough that its activity <em>is</em> behaviour, not a proxy for it.</p>
      <p>The head-direction ring attractor is that circuit. About fifty EPG neurons in the ellipsoid body hold a single bump of activity that tracks which way the fly is facing. Turning shifts it through the PEN neurons; Δ7 neurons keep it a single bump; PEG neurons keep it alive. It is one of the best-understood circuits in any brain (Seelig &amp; Jayaraman 2015; Kim et al. 2017; Turner-Evans et al. 2017; Hulse et al. 2021). Its output is a direction. A direction moves a body. So the fly walks.</p>

      <h2>The principles</h2>
      <ol>
        <li><strong>Real wiring only.</strong> Every neuron has a connectome root ID. No invented networks.</li>
        <li><strong>The chain is the only body.</strong> Anything that matters lives in storage. The website is a view.</li>
        <li><strong>Deterministic and replayable.</strong> Background noise is <code>keccak256(step)</code>, never block data. Any client recomputes the whole life from events, bit for bit. A Foundry test replays the real mainnet transactions.</li>
        <li><strong>Everything it eats is gone.</strong> Feeding, stimulating and resurrecting send <code>$FLY</code> to the dead address. No faucets in the base protocol.</li>
        <li><strong>Cheap enough to be alive.</strong> A 32-step tick costs about 7M gas, roughly 0.0003 BNB at BSC&apos;s 0.05 gwei. That is the whole reason this is possible on BNB Chain and not elsewhere.</li>
      </ol>

      <h2>Where it goes</h2>
      <p>The genesis fly is a compass. The <a href="/docs/roadmap/">roadmap</a> adds the giant-fiber escape reflex (the loom-and-jump circuit the Strandbeest used), descending steering neurons so the compass drives a body, a mushroom-body compartment so the fly learns on-chain with dopamine-gated plasticity, a colony of flies that breed by crossing their engrams, and finally the whole 166,700-neuron brain running off-chain with its state checkpointed and disputable on-chain. Persistent on-chain life, years after CryptoKitties.</p>
    </DocsShell>
  );
}
