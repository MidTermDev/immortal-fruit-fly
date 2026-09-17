import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Roadmap" };

export default function Page() {
  return (
    <DocsShell current="/docs/roadmap/">
      <h1>Roadmap: a species that lives on-chain</h1>
      <p className="lede">Siyuan&apos;s sentence is the specification: parts of a fly&apos;s neural behavior on-chain, and a permanent layer for identity, brain state, memory, lineage and interaction history, so a fly can die in a game and be instantiated again. Phases below are what exists and what is next, in order. No dates.</p>

      <div className="callout"><b>The loop that makes it immortal.</b> A body (the arena, DOOM, a robot) downloads a fly&apos;s last committed brain from IPFS, checks that its sha256 equals the <code>stateRoot</code> on the registry, runs it, commits new state and history as it goes, and commits its final state when the fly dies. Any body can pick it up again. The brain outlives every body.</div>

      <div className="phase done"><span className="k">done · live</span><h3>The compass core</h3>
        <p>155 real neurons (EPG, EPGt, PEG, PEN_a, PEN_b, Δ7) from FlyWire 783 running entirely inside the EVM: <code>FlyBrain</code> v2, with energy, death, resurrection, lineage and an engram. Keeper ticking. Bit-exact replica on the site.</p></div>

      <div className="phase done"><span className="k">done · live</span><h3>The whole brain, embodied</h3>
        <p>All 139,248 neurons of the connectome as spiking neurons (Shiu et al. 2024 model) at real time on a CPU, deterministic to the bit, with <code>verify.py</code> replaying one snapshot into the next. Two bodies: the <b>arena</b> (odor plumes, food, a looming predator, giant-fiber jumps, descending-neuron steering, streamed live) and <b>DOOM</b> (nearest enemy as scent, looming as vision, 71 decisions hashed on-chain in session 5, released as video).</p></div>

      <div className="phase done"><span className="k">done · live</span><h3>The registry and the collection</h3>
        <p><code>FlyRegistry</code>: an ERC-721 where each token is a fly with its connectome hash, brain state root, memory root, IPFS snapshot, energy, generation, deaths, parents and body. Mint for 1 $FLY, breed for 5,000; keep alive and resurrect for a little BNB (v3: about 0.01 BNB a day, nothing burned for metabolism); assign to bodies; bodies accept, commit, log interactions and report deaths. Dead flies cannot be sold. At most 10,000. Fly #1 has already died in the arena, woken in DOOM and come back with matching hashes. <a href="/flies/">Mint one.</a></p></div>

      <div className="phase"><span className="k">next</span><h3>Many flies, many bodies</h3>
        <ul>
          <li><strong>The arena hosts every fly assigned to it.</strong> One brain kernel, time-sliced; about 50 flies per machine at real time, more slower. Flies see each other (mutual looming) and compete for the same food.</li>
          <li><strong>Body SDK.</strong> The Python loop the arena and DOOM use, packaged: <code>instantiate → step → commit → died</code>, so anyone can plug in a game, a simulator or a robot without asking us. The RuneScape world we copied is the first outside body.</li>
          <li><strong>Attestors.</strong> Publish the re-runner; anyone with a CPU replays a fly&apos;s commits and calls <code>attest</code>. Fly pages show <i>attested by N</i>. Bodies that lie get caught.</li>
        </ul></div>

      <div className="phase"><span className="k">next</span><h3>Neural behavior on-chain, per fly</h3>
        <ul>
          <li><strong>FlyCore.</strong> The 155-neuron compass becomes per-fly storage keyed by registry id. A body must cue a fly&apos;s core with what it senses at least once per commit, and the commit carries the core&apos;s own on-chain heading: the part of the fly a body cannot fake.</li>
          <li><strong>Giant-fiber escape on-chain.</strong> LC4 and LPLC2 looming detectors onto DNp01 (about 200 neurons, one table), so “it jumped” becomes a chain fact rather than a body&apos;s claim.</li>
        </ul></div>

      <div className="phase"><span className="k">next</span><h3>Memory and a species</h3>
        <ul>
          <li><strong>Mushroom-body plasticity.</strong> Kenyon cell → MBON synapses depressed by dopamine (Aso 2014, Hige 2015); reward is eating, punishment is being caught. The weights are the <code>memoryRoot</code>. A fly that lived learns; the snapshot carries it through death.</li>
          <li><strong>Breeding that means something.</strong> A child&apos;s memory is a published, deterministic crossover of its parents&apos; memory vectors, committed with both parent roots so anyone can check. Selection pressure is who gets fed. The connectome is fixed; memory evolves.</li>
          <li><strong>Alive without us.</strong> A keeper pool paid from feeds so ticks and commits never depend on one operator; snapshots mirrored to BNB Greenfield next to IPFS.</li>
        </ul></div>

      <h2>What we stopped doing</h2>
      <ul>
        <li>No more one-off contracts per demo. FlyWorld and FlyArcade are read-only history; every new thing is a body on the registry.</li>
        <li>No brain state on a temporary URL. Snapshots are content-addressed on IPFS and named by their hash on-chain.</li>
        <li>No claims the code does not make true. The verification ladder is: deterministic model and open snapshots today, attestors next, proofs later.</li>
      </ul>
      <p>The full plan, with the open decisions and their answers, is <a href={`${CFG.links.github}/blob/main/PLAN.md`}>PLAN.md</a> in the repository.</p>
    </DocsShell>
  );
}
