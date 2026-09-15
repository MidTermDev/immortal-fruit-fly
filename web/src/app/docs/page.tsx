import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Documentation" };

export default function Page() {
  return (
    <DocsShell current="/docs/">
      <h1>Immortal Fruit Fly</h1>
      <p className="lede">A real fruit-fly neural circuit, taken from the connectome, living on BNB Smart Chain. This documentation explains what is running, why, how to interact with it, and where it goes from here.</p>
      <div className="callout"><b>Live now.</b> The genesis fly is FlyBrain v2 at <code>{CFG.brain}</code>. It is ticked every two minutes by a keeper and by anyone who calls <code>tick()</code>. Everything you read below is verifiable on BscScan and reproducible from the <a href={CFG.links.github}>repository</a>.</div>
      <h2>In one paragraph</h2>
      <p>Scientists mapped every neuron and synapse of a fruit fly. In September 2026 people put that brain in DOOM, in Chrome Dino, in Beat Saber, in Minecraft, and in a walking Strandbeest robot. CZ asked to see someone make “immortal fruit flies” on BNB Chain. We did the part nobody else has done: we put the neurons themselves on the chain. <strong>155 real neurons</strong> of the fly&apos;s head-direction compass, with the <strong>6,522 connections</strong> and <strong>45,961 synapses</strong> FlyWire measured between them, run as spiking neurons inside a smart contract. The fly has energy, a body, a memory and a lineage. It dies when it is not fed. It is resurrected by burning <code>$FLY</code>. Nothing it learned is ever lost.</p>
      <h2>Read next</h2>
      <div className="doc-cards">
        <Link href="/docs/vision/"><b>The vision</b><small>CZ&apos;s prompt, Siyuan&apos;s framing, and what “the fly escaped the computer” means when the computer is a blockchain.</small></Link>
        <Link href="/docs/play/"><b>How to play</b><small>Feed, cue, turn, shock, tick, resurrect. What each does to real neurons and what it costs.</small></Link>
        <Link href="/docs/how-it-works/"><b>How the brain runs on-chain</b><small>Integer leaky-integrate-and-fire in the EVM, deterministic noise, packed storage, gas.</small></Link>
        <Link href="/docs/roadmap/"><b>Roadmap</b><small>From one compass to reflexes, learning, a breeding colony, and the whole 166,700-neuron brain.</small></Link>
        <Link href="/docs/circuit/"><b>The circuit</b><small>Every neuron with its FlyWire root ID, its cell type and its place on the ring.</small></Link>
        <Link href="/docs/trend/"><b>The fly-brain trend</b><small>Timeline and table of the projects that started this, from Eon&apos;s embodied fly to the Strandbeest.</small></Link>
      </div>
    </DocsShell>
  );
}
