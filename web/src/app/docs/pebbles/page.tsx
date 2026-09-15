import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = { title: "Pebbles: the fly in hardware", description: "Five handheld M5Stack CoreS3 devices, each a wallet that owns a fruit fly and the body that runs its on-chain compass neurons. The demo, the architecture, the wiring, the gas, and the bring-up." };

const HW = `${CFG.links.github}/blob/main/HARDWARE.md`;

export default function Page() {
  return (
    <DocsShell current="/docs/pebbles/">
      <h1>Pebbles: the fly in hardware</h1>
      <p className="lede">Five handheld devices on a table. Each one is a wallet that owns a fly and the body that runs its neurons: the same 155 compass cells that execute on BNB Smart Chain, turned by a gyroscope, cued by magnets, anchored to the chain by transactions the pebble signs itself.</p>

      <div className="callout">
        <b>Status.</b> The per-fly core contract, <code>FlyCore</code>, is written and tested (differential against <code>FlyBrain</code> v2, body-versus-poker permissions, seed-once, alive gating in the registry). {CFG.core
          ? <>It is live at <a href={`${CFG.explorer}/address/${CFG.core}#code`}>{CFG.core}</a>; every fly page shows its core.</>
          : <>It is not deployed yet: the address appears here, and the <em>On-chain core</em> figure appears on every fly page, once it is. The firmware is in <code>firmware/</code>.</>} The full build document is <a href={HW}>HARDWARE.md</a> in the repository.
      </div>

      <h2>The demo, in ninety seconds</h2>
      <div className="steps-list">
        <div><div><h3>Turn a pebble in your hand.</h3><p>The compass neurons on its screen, the same EPG, PEN and Δ7 cells that run on BNB Chain, rotate their bump of activity with the gyroscope. The fly knows which way it is facing because real fly neurons say so.</p></div></div>
        <div><div><h3>Slide the landmark magnet past its left side.</h3><p>The hall sensor fires, the EPG neurons of that wedge get a cue, and the bump snaps to the landmark. Slide the spider magnet past instead: a Δ7 shock, the bump collapses, the screen flashes, the fly freezes.</p></div></div>
        <div><div><h3>Look at BscScan.</h3><p>Every 45 seconds the pebble signs <code>FlyCore.stimulate(…)</code> and <code>tick(16)</code> with its own key: the cues it sensed, applied to the same neurons in the EVM. The transaction is from the pebble&apos;s address. The fly&apos;s page shows the on-chain heading next to the pebble&apos;s.</p></div></div>
        <div><div><h3>Feed it from your phone.</h3><p><code>feed(id, 600)</code> on the fly&apos;s page. The pebble chirps “fed 600 s by 0x8a…” and its energy bar refills.</p></div></div>
        <div><div><h3>Let one starve.</h3><p>The screen goes grey: DEAD, brain preserved at block N, a QR code to resurrect it. Resurrect it on the site; the pebble wakes with the identical compass state.</p></div></div>
        <div><div><h3>Touch two pebbles together.</h3><p>BLE finds the neighbour; the current body signs <code>assign(id, neighbour)</code>, the neighbour signs <code>accept(id)</code>, reads the core state from the chain, and continues it. The fly hopped bodies. On the site: <i>body: Pebble 3</i>, with the whole hand-off in its interaction history.</p></div></div>
        <div><div><h3>Mint from the pebble.</h3><p>A fresh pebble with 1 $FLY and some BNB presses <i>Hatch</i>: it mints its own fly and becomes its body. Hardware that owns an organism.</p></div></div>
      </div>
      <p style={{ marginTop: 18 }}>What makes it more than a gadget: nothing on the pebble is authoritative. The fly&apos;s identity, its neurons&apos; state, its energy and its history are on the chain. Unplug the pebble and the fly is still there; hand it to a different pebble, or to the arena, and it is the same fly.</p>

      <h2>How the pieces fit</h2>
      <div className="arch" role="figure" aria-label="A pebble on the left signs transactions to, and reads state from, two contracts on BNB Smart Chain on the right">
        <div className="box"><b>Pebble · ESP32-S3</b>
          <span>gyro → <i>TURN_LEFT / TURN_RIGHT</i></span>
          <span>hall left / right → <i>CUE wedge 4 / 12</i></span>
          <span>magnetometer → <i>weak CUE at north</i></span>
          <span>hall “spider” → <i>SHOCK</i></span>
          <span>local bit-exact replica of the core <i>(preview)</i></span>
          <span>screen: ring, bump, fly, energy, chain status</span>
          <span>NVS: private key <i>(the pebble&apos;s wallet)</i></span>
          <span>BLE: find neighbour pebbles → hand-off</span>
        </div>
        <div className="link"><span><em>→</em>signed tx</span><span><em>←</em>reads</span></div>
        <div className="box"><b>BNB Smart Chain</b>
          <span><i>FlyRegistry</i> · the organism, ERC-721</span>
          <span>registerBody / accept / interaction / commit / died / assign</span>
          <span><i>FlyCore</i> · per-fly 155 neurons in the EVM</span>
          <span>stimulate(id, …) / tick(id, n)</span>
          <span>state: v[155], bias, hist, head, step</span>
          <span><i>$FLY</i> · mint, feed, resurrect burn it</span>
        </div>
      </div>
      <p className="arch-cap">Figure | A pebble is a body: it speaks the registry protocol and runs the fly&apos;s on-chain core. The chain is the only authority.</p>
      <p><strong>The pebble is a body.</strong> It speaks the registry protocol exactly like the arena and DOOM do: <code>registerBody(&quot;Pebble 3&quot;, uri)</code>, waits to be assigned, <code>accept(id)</code>, then <code>interaction</code>s as things happen, <code>commit</code>s on a schedule, <code>died</code> when energy hits zero.</p>
      <p><strong>What it runs is the fly&apos;s on-chain core.</strong> A pebble cannot run the 139,248-neuron whole brain (12 MB of state, sixteen CPU cores at real time). It runs the fly&apos;s <em>other</em> brain: the compass circuit that already executes inside the EVM. <code>FlyCore</code> makes that per-fly: every fly in the registry gets its own 155-neuron state in the contract, keyed by token id. The pebble keeps a bit-exact local replica for the display (the same integer model, the same <code>keccak256(step)</code> noise) and anchors it on-chain every <code>ANCHOR_EVERY</code> seconds by sending the cues it sensed and ticking the EVM neurons, then re-reading the state so the replica stays exact. This is the same replica-plus-anchor scheme the website and the DOOM harness already use.</p>
      <p><strong>The whole brain sleeps while a fly is in a pebble.</strong> A pebble commits with the fly&apos;s existing <code>stateRoot</code> and <code>stateURI</code> unchanged (the whole-brain snapshot is preserved exactly), <code>brainStep</code> advanced by the core steps it ticked, and <code>energy</code> decremented by real seconds. When a whole-brain body such as the arena takes the fly back, it continues from that snapshot. The fly&apos;s page says so: <i>body: Pebble 3 (core only: the whole brain sleeps)</i>.</p>

      <h3>The per-fly core, in the contract</h3>
      <pre><code>{`function tick(uint256 id, uint16 steps) external;                 // anyone, gas only; the fly must be alive in the registry
function stimulate(uint256 id, uint8 ch, uint8 param, uint8 strength, uint16 steps) external;
    // the fly's current body (registry.fly(id).body == msg.sender): gas only, its senses
    // anyone else: burns strength × STIM_PRICE $FLY, a poke
function core(uint256 id) view returns (int16[] v, int8[] bias, uint16[16] headingHist, int32[] pendingInput, uint64 step,
    int32 headX, int32 headY, int64 posX, int64 posY, uint8 stimChannel, uint8 stimParam, uint16 stimStrength, uint64 stimUntilStep, uint64 totalSpikes);
function coreHash(uint256 id) view returns (bytes32);
event Ticked(uint256 indexed id, address indexed by, uint64 fromStep, uint16 steps, uint32 spikes, int32 headX, int32 headY, int64 posX, int64 posY);
event Stimulated(uint256 indexed id, address indexed by, uint8 channel, uint8 param, uint16 strength, uint64 untilStep, uint256 tokensBurned);`}</code></pre>
      <p>No energy, no death, no lineage in the core: those belong to the registry. The parameters are immutable and there is no owner; a curator can only <code>seed</code> a fresh core once, while its step is still zero, which is how fly #1 carries its <code>FlyBrain</code> v2 state over. The kernel is the v2 kernel, unchanged (see <Link href="/docs/how-it-works/">how the brain runs on-chain</Link>), so a 16-step tick costs about 4.5M gas.</p>

      <h2>Senses to neurons</h2>
      <table className="data"><thead><tr><th>Physical input</th><th>Neurons</th><th>How</th></tr></thead><tbody>
        <tr><td>Gyro yaw rate (BMI270)</td><td>PEN_a / PEN_b, left or right hemisphere (<code>CH_TURN_*</code>)</td><td>Locally: strength proportional to the rate, applied continuously. On-chain: the net rotation since the last anchor, as one turn stimulus of matching strength.</td></tr>
        <tr><td>Magnetometer heading (BMM150)</td><td>EPG of the wedge facing magnetic north (<code>CH_CUE</code>, weak)</td><td>The on-chain compass stays anchored to the real world: the pebble&apos;s neurons know which way north is.</td></tr>
        <tr><td>Hall sensor, left side</td><td>EPG wedge 4 (<code>CH_CUE</code>, strong)</td><td>A landmark on the left.</td></tr>
        <tr><td>Hall sensor, right side</td><td>EPG wedge 12 (<code>CH_CUE</code>, strong)</td><td>A landmark on the right.</td></tr>
        <tr><td>Hall sensor tagged “spider” (hero pebble, Port C)</td><td>All Δ7 (<code>CH_SHOCK</code>)</td><td>The bump collapses, the fly freezes; <code>interaction(id, &quot;shock&quot;)</code>.</td></tr>
        <tr><td>Touch: hold the ring</td><td><code>CH_CUE</code> at the touched wedge</td><td>A poke, like the website.</td></tr>
        <tr><td>Light (camera mean, CoreS3 only)</td><td>none in v1</td><td>Later: looming.</td></tr>
      </tbody></table>

      <h2>Wiring (CoreS3)</h2>
      <table className="data"><thead><tr><th>Port</th><th>Pins</th><th>Sensor</th></tr></thead><tbody>
        <tr><td>Port B (black)</td><td>G8 = hall left OUT, G9 = hall right OUT, 3V3, GND</td><td>Two hall switches, internal pull-ups, active low.</td></tr>
        <tr><td>Port C (blue), hero pebble only</td><td>G17, G18 as GPIO</td><td>Third and fourth hall sensors (spider, landmark 2).</td></tr>
        <tr><td>Port A (red)</td><td>I2C, free</td><td>Future: more sensors via a Grove hub.</td></tr>
      </tbody></table>
      <p>Analog (49E) boards use the same pins, read with <code>analogRead</code> and thresholded at ±15% of the idle value; the firmware auto-detects at boot (a digital switch idles at 3.3 V, a 49E at about 1.65 V). The devices are M5Stack CoreS3 boards (ESP32-S3, 16 MB flash, 8 MB PSRAM, 2.0&quot; 320×240 touch screen, BMI270 gyro and accelerometer, BMM150 magnetometer, Wi-Fi, BLE, 500 mAh battery); a different M5Stack S3 board changes only this pin table and the screen size, because the firmware is written on M5Unified.</p>

      <h2>Chain cadence and gas</h2>
      <table className="data"><thead><tr><th>Action</th><th>Who signs</th><th>Gas</th><th>When</th></tr></thead><tbody>
        <tr><td><code>registerBody</code></td><td>pebble</td><td>~90k</td><td>first boot (name “Pebble N”, uri = the site&apos;s fly page)</td></tr>
        <tr><td><code>accept</code></td><td>pebble</td><td>~60k</td><td>when assigned</td></tr>
        <tr><td><code>FlyCore.stimulate</code> + <code>tick(16)</code></td><td>pebble</td><td>~4.6M ≈ 0.00023 BNB</td><td>every <code>ANCHOR_EVERY</code> s (default 45 s → 0.018 BNB/h, about $11/h per pebble; set 120 s for a long day)</td></tr>
        <tr><td><code>interaction</code></td><td>pebble</td><td>~35k</td><td>landmark seen, shock, hand-off, fed</td></tr>
        <tr><td><code>commit</code></td><td>pebble</td><td>~120k</td><td>every 10 min</td></tr>
        <tr><td><code>died</code></td><td>pebble</td><td>~90k</td><td>energy 0</td></tr>
        <tr><td><code>assign</code> (hand-off)</td><td>the current pebble</td><td>~50k</td><td>touch</td></tr>
        <tr><td><code>mint</code> (hatch)</td><td>pebble</td><td>~250k + 1 $FLY</td><td>button</td></tr>
      </tbody></table>
      <p>Load each pebble with <strong>0.05 BNB</strong> (about two hours of anchoring at 45 s plus everything else) and, for hatching, <strong>2 $FLY</strong>. The pebble shows its address and a QR code at boot. Gas is the cost of the story: anchoring the EVM neurons is what makes the demo real, and the cadence knob is there so a day of demos does not cost a day of BNB. Between anchors the screen is a preview, exactly as on the site; the two agree at every anchor or the pebble resyncs and says so.</p>

      <h2>Bring-up</h2>
      <ol>
        <li><code>pip install platformio</code> (or use the repository&apos;s venv), <code>cd firmware</code>, copy <code>include/secrets.example.h</code> to <code>include/secrets.h</code> and fill in the Wi-Fi.</li>
        <li><code>pio run -e cores3 -t upload</code> with a pebble on USB-C. It boots, shows <i>Pebble 1 · 0xABCD…</i> and a QR code.</li>
        <li>Send it 0.05 BNB. It registers itself; watch the transaction on the screen and on BscScan.</li>
        <li>On the site, open a fly you own, <i>Hand it to a body</i>, choose “Another body address…” and paste the pebble&apos;s address. The pebble accepts within a poll and the ring lights up.</li>
        <li>Rotate it. Bring the magnets. Feed it from the site. Repeat for the other four.</li>
        <li>Two pebbles: hold <i>Hand off</i> on the one hosting a fly, tap the neighbour when it appears, and watch the fly move.</li>
      </ol>
      <p>The private key is generated on first boot from the ESP32 hardware RNG and never leaves the device; holding both touch buttons under the screen for three seconds shows it once, for backup. The rest of the design, the risks, and the honest caveats are in <a href={HW}>HARDWARE.md</a>.</p>
    </DocsShell>
  );
}
