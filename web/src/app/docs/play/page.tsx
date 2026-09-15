import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "How to play" };

export default function Page() {
  return (
    <DocsShell current="/docs/play/">
      <h1>How to play</h1>
      <p className="lede">Own a fly, keep it alive, move it between bodies, bring it back when it dies. Then, separately, poke the on-chain core. Every action is a transaction on BNB Smart Chain.</p>
      <div className="callout"><b>You need:</b> a wallet on BNB Smart Chain (MetaMask, Rabby, Binance Wallet), a little BNB for gas, and <code>$FLY</code> for anything that creates or sustains life. <a href={CFG.links.pancake + CFG.token}>Get $FLY on PancakeSwap</a>.</div>
      <h2>Your fly</h2>
      <table className="data"><thead><tr><th>Action</th><th>What happens</th><th>Cost</th></tr></thead><tbody>
        <tr><td><a href="/flies/">Mint</a></td><td>A new fly with a fresh whole brain (139,248 neurons in the canonical resting state), an hour of life banked, and a portrait. It is yours: an ERC-721 you can hold or sell on <a href={`${CFG.opensea}/1`}>OpenSea</a>.</td><td>1 FLY, burned</td></tr>
        <tr><td>Assign to a body</td><td>Hand it to the Arena (it streams live on the home page and forages for food) or to DOOM. The body downloads its last committed brain, checks the hash, and runs it. Only you, or the body running it, can do this.</td><td>gas</td></tr>
        <tr><td>Feed</td><td>Seconds of life. In the arena that is food dropped near the fly; it has to smell its way there. Dormant flies bank it. Anyone may feed any fly.</td><td>1 FLY per second, burned</td></tr>
        <tr><td>Resurrect</td><td>Only when dead. The same brain continues from exactly the state it died in, generation + 1. Until then the token cannot be transferred or sold.</td><td>1,000 FLY + food, burned</td></tr>
        <tr><td>Breed</td><td>Two living flies you own produce a child, generation 0, with both parents in its lineage.</td><td>5,000 FLY, burned</td></tr>
      </tbody></table>
      <h2>The on-chain core</h2>
      <p>Separately from the whole brain, a 155-neuron compass circuit runs entirely inside the EVM (<code>FlyBrain</code>). These actions touch those neurons directly:</p>
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
