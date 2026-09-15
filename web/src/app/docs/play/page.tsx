import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/DocsShell";

export const metadata: Metadata = { title: "Watch & feed" };

export default function Page() {
  return (
    <DocsShell current="/docs/play/">
      <h1>Watch &amp; feed</h1>
      <p className="lede">Follow the fly, inspect its recorded executions, and help keep it alive.</p>

      <h2>Watch</h2>
      <p><Link href="/">Watch</Link> shows the circuit&apos;s latest confirmed state. The brain visualization shows its latest neural state; execution records show position and heading.</p>
      <p>The <Link href="/world/">whole-brain world</Link> shows the simulator&apos;s live stream. Its movements and spikes arrive from the simulator; checkpoints are recorded separately on BNB Smart Chain. When a connection stops, the last received state remains visible.</p>

      <h2>Decisions</h2>
      <p><Link href="/decisions/">Decisions</Link> lets you inspect an execution: input events earlier in the same transaction, steps run, spikes, heading, and resulting position. Each record links to its transaction.</p>

      <h2>Activity</h2>
      <p><Link href="/activity/">Activity</Link> lists recent events from the circuit, world, and arcade contracts. Filter by contract or event type to find feeds, executions, checkpoints, and game decisions. The page shows the block window it has loaded.</p>

      <h2>Arcade</h2>
      <p><Link href="/arcade/">Arcade</Link> follows the whole brain playing DOOM. Choose a session, inspect its recorded turn and firing commands, and follow changes in reported health and kills. Each decision links to its transaction and recorded brain hash.</p>
      <p>These are periodic reports from a separate brain simulation. Game video is not published by the current runner, and the contract does not execute the game or verify the brain computation.</p>

      <h2>Feed the fly</h2>
      <p>The Feed the fly link opens the circuit or arena feeding page. You need FLY and BNB for network fees.</p>
      <p><Link href="/feed/">Circuit feeding</Link> adds energy directly. <Link href="/feed/world/">Whole-brain feeding</Link> places food at the arena center; energy is added when the fly eats it.</p>
      <ol>
        <li>Choose an amount and connect your wallet on BNB Smart Chain.</li>
        <li>Review the FLY cost, then approve the allowance if your wallet requests it.</li>
        <li>Confirm the feed transaction and wait for its confirmation.</li>
      </ol>
      <p>Both feeding pages offer revival when their contract records a death. Watching and inspecting records do not require a wallet.</p>
      <p>Feeding the arena does not affect the separate DOOM run. From Arcade, the feeding link opens the on-chain circuit that the runner also cues.</p>

      <h2>Contract reference</h2>
      <p>The <Link href="/docs/contracts/">contract reference</Link> documents feeding, world food placement, simulation steps, stimuli, and resurrection, with their addresses and parameters.</p>
    </DocsShell>
  );
}
