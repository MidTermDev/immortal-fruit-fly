import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Documentation" };

export default function Page() {
  return (
    <DocsShell current="/docs/">
      <h1>Immortal Fruit Fly</h1>
      <p className="lede">The site follows an on-chain compass circuit, a whole-brain arena simulation, and recorded DOOM decisions. Each has its own source of state.</p>
      <div className="callout"><b>Reading the dashboards.</b> FlyBrain execution results come from BNB Smart Chain. Whole-brain observations come from a server. FlyWorld checkpoints and FlyArcade decisions are operator reports recorded on-chain; their presence alone does not verify the simulation.</div>
      <h2>Three parts</h2>
      <table className="data"><thead><tr><th>Part</th><th>What runs</th><th>Feeding</th></tr></thead><tbody>
        <tr><td><Link href="/">FlyBrain</Link></td><td>155 neurons and 6,522 connections execute inside the contract. Events record each tick&apos;s steps, spikes, heading and position.</td><td><Link href="/feed/">Add energy to the circuit</Link>, or revive it when its contract state is dead.</td></tr>
        <tr><td><Link href="/world/">FlyWorld</Link></td><td>A server runs the 139,248-neuron model in an arena. The contract records food placements, checkpoints and lifecycle reports.</td><td><Link href="/feed/world/">Place food in the arena</Link>. Energy is added when the simulated fly eats it.</td></tr>
        <tr><td><Link href="/arcade/">FlyArcade</Link></td><td>A separate whole-brain process plays DOOM. The operator records sampled actions, game counters and a brain hash.</td><td>No feeding function. FlyWorld food does not fuel the DOOM process.</td></tr>
      </tbody></table>
      <p>The model and integrations are in the <a href={CFG.links.github}>repository</a>. The live availability shown on each dashboard is separate from whether its contract can be read.</p>
      <h2>Read next</h2>
      <div className="doc-cards">
        <Link href="/docs/vision/"><b>The vision</b><small>CZ&apos;s prompt, Siyuan&apos;s framing, and what “the fly escaped the computer” means when the computer is a blockchain.</small></Link>
        <Link href="/docs/play/"><b>Watch &amp; feed</b><small>Follow the fly, inspect recorded decisions and activity, and add energy.</small></Link>
        <Link href="/docs/how-it-works/"><b>How the brains run</b><small>The circuit, arena and DOOM integrations, with the limits of their recorded evidence.</small></Link>
        <Link href="/docs/roadmap/"><b>Roadmap</b><small>From one compass to reflexes, learning, a breeding colony, and the whole 166,700-neuron brain.</small></Link>
        <Link href="/docs/circuit/"><b>The circuit</b><small>Every neuron with its FlyWire root ID, its cell type and its place on the ring.</small></Link>
        <Link href="/docs/trend/"><b>The fly-brain trend</b><small>Timeline and table of the projects that started this, from Eon&apos;s embodied fly to the Strandbeest.</small></Link>
      </div>
    </DocsShell>
  );
}
