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
      <h2>Reading the compass</h2>
      <p>The dial on the home page shows the 16 wedges of the ellipsoid body. Bright wedges are where EPG neurons are spiking right now; the needle is the population vector; the faint outer ring is the heading histogram, the fly&apos;s memory of where it has pointed. Click a wedge to aim a cue there.</p>
      <h2>Preview vs. on-chain</h2>
      <p>Between on-chain ticks the site runs the same circuit locally from the last on-chain state, so the animation is continuous. The label panel always reports the on-chain figures. When you send an action in preview mode (no wallet, or chain unreachable) it only changes your local copy.</p>
      <h2>Gas notes</h2>
      <p>Public BSC RPCs cap gas estimation at 16.7M, so the site sets gas limits itself: 32-step ticks use up to 9M, stimuli with 16 follow-up steps up to 9M. A strong turn stimulus makes many neurons spike and costs more; that is real neural activity you are paying for.</p>
    </DocsShell>
  );
}
