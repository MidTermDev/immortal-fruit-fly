import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "How to play" };

export default function Page() {
  return (
    <DocsShell current="/docs/play/">
      <h1>How to play</h1>
      <p className="lede">Six actions. Each one touches real neurons. Each one is a transaction on BNB Smart Chain.</p>
      <div className="callout"><b>You need:</b> a wallet on BNB Smart Chain (MetaMask, Rabby, Binance Wallet), a little BNB for gas, and <code>$FLY</code> for anything that feeds or pokes the fly. <a href={CFG.links.pancake + CFG.token}>Get $FLY on PancakeSwap</a>.</div>
      <table className="data"><thead><tr><th>Action</th><th>What happens to the neurons</th><th>Cost</th></tr></thead><tbody>
        <tr><td><code>tick(steps)</code></td><td>Runs the brain forward up to 64 steps. Leak, integrate, threshold, spike, propagate. The compass bump decides where the fly walks.</td><td>gas only (~7M for 32 steps)</td></tr>
        <tr><td><code>feed(amount)</code></td><td>Adds <code>amount / 1 FLY</code> steps of energy. The fly burns one step per simulation step.</td><td>burned</td></tr>
        <tr><td><code>stimulate(CUE, wedge, strength)</code></td><td>Injects current into the EPG neurons of one of 16 wedges (and half as much into its neighbours) for 64 steps. A landmark. The bump forms or jumps there.</td><td>100 FLY × strength, burned</td></tr>
        <tr><td><code>stimulate(TURN_LEFT / TURN_RIGHT)</code></td><td>Drives the left- or right-hemisphere PEN neurons: angular-velocity input. The bump rotates, the heading changes.</td><td>100 FLY × strength, burned</td></tr>
        <tr><td><code>stimulate(SHOCK)</code></td><td>Drives all 42 Δ7 neurons: global inhibition. The bump collapses. The fly stops walking until it recovers.</td><td>100 FLY × strength, burned</td></tr>
        <tr><td><code>resurrect(extraFood)</code></td><td>Only when dead. Wakes the identical brain in a new body at the origin, with <code>extraFood</code> steps of energy. Generation + 1.</td><td>100,000 FLY + food, burned</td></tr>
      </tbody></table>
      <h2>Using the dashboard</h2>
      <p>Choose a feeding amount, connect your wallet, then confirm the feed. For other interactions, choose an action and review its FLY cost. Expand the strength controls to adjust an interaction or the direction of a landmark. Wallet approval and transaction confirmation appear beside the controls.</p>
      <h2>Reading the visual</h2>
      <p>Fly view shows the latest confirmed position and a trail of positions received during this visit. Brain view shows the anatomy and the latest available neural state. Visual transitions smooth those updates; they do not run new simulation steps. If the connection is interrupted, the dashboard keeps the last state visible and pauses paid actions until it reconnects.</p>
      <h2>Gas notes</h2>
      <p>Public BSC RPCs cap gas estimation at 16.7M, so the site sets gas limits itself: 32-step ticks use up to 9M, stimuli with 16 follow-up steps up to 9M. A strong turn stimulus makes many neurons spike and costs more; that is real neural activity you are paying for.</p>
    </DocsShell>
  );
}
