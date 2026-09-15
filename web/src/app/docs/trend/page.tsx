import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
export const metadata: Metadata = { title: "The fly-brain trend" };

const ROWS: [string, string, string, string][] = [
  ["Eon Systems embodied fly", "Shiu, Harris et al.", "NeuroMechFly body; grooming, feeding emerge; 15 ms brain–body sync", "https://eon.systems/updates/embodied-brain-emulation"],
  ["NeuroCraft (Minecraft)", "@evnsnclr", "full 166,700-neuron MaleCNS, first viral post (4 Sep)", "https://x.com/evnsnclr/status/2095975490708291948"],
  ["DOOMFLY", "@nftechie_", "ViZDoom; 3,335 R1–R6 + 811 R8 inputs; DNp20 turning; PPL1 punishment", "https://github.com/nftechie/doomfly"],
  ["Fly Brain Minecraft mod", "@BlendiByl", "Fabric mod, Shiu LIF, 176k neurons, per-mob brains", "https://github.com/blendi-remade/fly-brain-minecraft"],
  ["Fly64", "ornata", "Super Mario 64; DNg100 forward, DNa02/DNg13 steer, DNp01 jump", "https://github.com/ornata/fly"],
  ["Fly Dino", "cobanov", "80-neuron circuit, 99/100 courses after CEM training", "https://github.com/cobanov/flyjump"],
  ["Beat Saber", "@_lyraaaa_", "~22M views; motor track trained on a replay", "https://x.com/_lyraaaa_/status/2097527368919470162"],
  ["flyverse", "djmango", "Rust LIF, 6,091 photoreceptors, 0.23× real time", "https://github.com/djmango/flyverse"],
  ["flypoke", "vshapenko", "poke a neuron in the full FlyWire brain on a laptop", "https://github.com/vshapenko/flypoke"],
  ["DesktopFly / gnat", "DenisSergeevitch / lubabs770", "668-neuron escape+walk circuit as a desktop pet", "https://github.com/DenisSergeevitch/desktop-fly"],
  ["Strandbeest robot", "@Frank_web33", "“The fly brain escaped the computer”; 14k likes", "https://x.com/Frank_web33/status/2099122649968357551"],
  ["Overwatch / parallel parking / Bad Apple", "@derpchud / @alright_mark / @linguinelabs", "the meme wave", "https://knowyourmeme.com/memes/fruit-fly-brain-simulations"],
  ["$FLYBRAIN, $HER, bFlyBrain, Richy", "various", "tokens; brain runs off-chain, only swaps are on-chain", "https://github.com/townie/awesome-fruit-fly"],
];

export default function Page() {
  return (
    <DocsShell current="/docs/trend/">
      <h1>The fly-brain trend</h1>
      <p className="lede">How a connectome paper became a meme in nine days, and what everyone actually built.</p>
      <h2>Timeline</h2>
      <table className="data"><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>
        <tr><td>Oct 2024</td><td>Shiu et al., <em>Nature</em>: whole-brain leaky-integrate-and-fire model of the FlyWire connectome. The recipe everyone copies.</td></tr>
        <tr><td>8 Jun 2026</td><td>MaleCNS v1.0 public (Janelia + Google): 166,700 neurons, whole male central nervous system, CC-BY.</td></tr>
        <tr><td>3 Sep 2026</td><td><em>Cell</em> paper and Google Research blog post.</td></tr>
        <tr><td>4–6 Sep</td><td>Minecraft, DOOM, Fabric mod, Bad Apple on the fly&apos;s brain.</td></tr>
        <tr><td>9 Sep</td><td>Beat Saber, ~22M views.</td></tr>
        <tr><td>10–11 Sep</td><td>$FLYBRAIN launches on Robinhood Chain, peaks ~$54M after Marc Andreessen follows; $HER, bFlyBrain (BSC) follow.</td></tr>
        <tr><td>13 Sep</td><td>The Strandbeest: “the fly brain escaped the computer.”</td></tr>
        <tr><td>15 Sep 04:07</td><td>Siyuan (YZi Labs): on-chain / immortal fruit flies on BNB Chain.</td></tr>
        <tr><td>15 Sep 04:15</td><td>CZ: “Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”</td></tr>
        <tr><td>15 Sep</td><td>Immortal Fruit Fly genesis brain deployed to BSC mainnet.</td></tr>
      </tbody></table>
      <h2>Projects</h2>
      <table className="data"><thead><tr><th>Project</th><th>Who</th><th>What</th></tr></thead><tbody>
        {ROWS.map(([n, w, d, u]) => <tr key={n}><td><a href={u} target="_blank" rel="noopener">{n}</a></td><td>{w}</td><td>{d}</td></tr>)}
      </tbody></table>
      <h2>The common recipe</h2>
      <ol>
        <li>Download the 1.1 GB MaleCNS weights file (or FlyWire v783), keep the retained neurons, sign edges by predicted neurotransmitter.</li>
        <li>Shiu-style LIF: rest −52 mV, threshold −45 mV, 0.275 mV per synapse, τ 20 ms, 0.1 ms step.</li>
        <li>Render the game, sample pixels into photoreceptors as Poisson spikes.</li>
        <li>Read a handful of named descending neurons (DNa02, DNp09, MDN, DNp01, DNp20) as a joystick, with a hand-made or trained readout.</li>
        <li>Optionally pulse dopamine neurons (PAM11 reward, PPL101 punishment) to depress KC→MBON synapses. No project has demonstrated task learning from this.</li>
      </ol>
      <p>What none of them did: put the neurons on the chain. See <a href="/docs/vision/">the vision</a>.</p>
      <p>Full curated list: <a href="https://github.com/cobanov/awesome-fly" target="_blank" rel="noopener">awesome-fly</a>.</p>
    </DocsShell>
  );
}
