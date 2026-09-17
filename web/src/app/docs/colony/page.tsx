import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/DocsShell";
import { CFG } from "@/lib/config";
export const metadata: Metadata = {
  title: "The Colony: flies in Minecraft",
  description: "A shared Minecraft world on the VPS where many Immortal Fruit Flies live at once, each running its whole brain and spending its on-chain life to be there: the senses-to-neurons mapping, the life rules, the architecture, and the honest limits.",
  alternates: { canonical: `${CFG.site}/docs/colony/` },
};

const DOC = `${CFG.links.github}/blob/main/COLONY.md`;
const HOST = `${CFG.links.github}/blob/main/brain/HOST_PROTOCOL.md`;

export default function Page() {
  return (
    <DocsShell current="/docs/colony/">
      <h1>The Colony: flies living together in Minecraft</h1>
      <p className="lede">A Minecraft world on the VPS where many flies live at once, viewable in the browser, each running its whole brain, each spending its on-chain life to be there. The next body after the arena, DOOM and the pebbles.</p>

      <div className="callout">
        <b>What it is.</b> The Colony is a registered body on <code>FlyRegistry</code> (name <i>Colony</i>, address <a href={`${CFG.explorer}/address/${CFG.bodies.colony}`}>{CFG.bodies.colony}</a>). An owner assigns a fly to it from the fly&apos;s page; the Colony accepts, downloads the fly&apos;s brain from IPFS, verifies the hash, and the fly <strong>joins a shared Minecraft server as a player</strong> named after it. Its 139,248 neurons run on the VPS; what those neurons sense is the Minecraft world around the bot, and what they drive is the bot&apos;s body. Several flies live in the same world at the same time: they smell the same food, flee the same zombies, and meet each other. Every notable thing is written to the chain as an <code>interaction</code>; the brain is checkpointed to IPFS every ten minutes; when the fly starves it dies on-chain and its brain is preserved, exactly as in the arena. Nobody needs Minecraft installed to watch: <Link href="/colony/">the Colony page</Link> shows the world through a browser viewer, with each fly&apos;s brain lighting up beside it. The design document is <a href={DOC}>COLONY.md</a>.
      </div>

      <h2>Senses and motor: the honest mapping</h2>
      <p>The mapping reuses the arena&apos;s, so the behaviour is the same organism in a new world. Nothing is added to the brain; the body translates.</p>
      <table className="data"><thead><tr><th>Minecraft</th><th>Fly neurons</th><th>How</th></tr></thead><tbody>
        <tr><td>Food items on the ground (bread, apples, cookies) and food blocks (sweet berry bushes, cake) within 32 blocks</td><td>Olfactory receptor neurons, left/right by bearing (an odor plume with the arena&apos;s distance decay)</td><td>The strongest scent wins, bilateral contrast as in <code>world.py</code></td></tr>
        <tr><td>A hostile mob approaching (zombie, skeleton, spider) in the front 120°</td><td>LC4 / LPLC2 looming detectors, by side</td><td>Angular size growth, as in DOOM</td></tr>
        <tr><td>Standing on / holding food</td><td>Gustatory neurons (GRN)</td><td>Eating restores energy: 1 s of life per food point, bread = 5</td></tr>
        <tr><td>Another fly within 6 blocks</td><td><code>interaction(id, &quot;met&quot;, &quot;fly #n&quot;)</code>, once per minute per pair</td><td>Social history; no neural input yet (the model has no social circuit)</td></tr>
        <tr><td>Light level (night)</td><td>None in v1</td><td>Night is when the zombies come</td></tr>
        <tr><td>DNa02 L−R, DNa01</td><td>Turn rate (yaw)</td><td>The arena&apos;s steering readout</td></tr>
        <tr><td>DN population</td><td>Forward speed (walk / sprint)</td><td>Surge-and-cast locomotion program from the arena</td></tr>
        <tr><td>Giant fiber (DNp01) spike</td><td>Jump</td><td>The escape reflex, as in the arena and DOOM</td></tr>
        <tr><td>MDN</td><td>Walk backward</td><td>As in the arena</td></tr>
      </tbody></table>
      <p>What flies do together, without pretending they cooperate: they converge on the same food, they scatter from the same zombie, they mark where they ate (the bot places a torch: a landmark the others can see as light, and the colony&apos;s map fills with torches where the food was), and their meetings go on-chain. That is a colony as flies actually have them: shared environment, shared memory of where the food is, no foreman.</p>

      <h2>Life, energy, death</h2>
      <ul>
        <li><strong>Being in the Colony costs 1 s of life per second</strong>, from the fly&apos;s on-chain energy (the body commits <code>energy</code> every checkpoint).</li>
        <li><strong><code>feed(id, seconds)</code></strong> on the registry (payable: a little BNB, about 0.01 a day; nothing burned) drops that many food points near the fly in the world (bread, 5 s each), as the arena drops food. The fly has to smell its way there and eat.</li>
        <li><strong>A zombie hit costs 60 s</strong> (the arena&apos;s rule) and knocks the bot; the bot never fights back (flies don&apos;t).</li>
        <li><strong>Energy 0 → <code>died(id, …, &quot;starved in the Colony&quot;)</code></strong>, the bot leaves the world; resurrect on the site and assign again.</li>
        <li><strong>Capacity:</strong> <code>COLONY_MAX_FLIES</code> at once (default 6; each whole brain gets <code>28 // n</code> threads; the frame carries <code>realtime</code> so the speed is always shown honestly). Beyond that, assigned flies wait in a queue and the site says so.</li>
      </ul>

      <h2>Architecture</h2>
      <div className="arch" role="figure" aria-label="The registry on the left, the Colony supervisor and its processes on the right">
        <div className="box"><b>BNB Smart Chain · FlyRegistry</b>
          <span>owner: <i>assign(id, Colony)</i></span>
          <span>Colony body: <i>accept / commit / interaction / died</i></span>
          <span>key: <i>body_colony.key</i>, the Colony&apos;s own address</span>
          <span>every 10 min: <i>stateRoot</i> = sha256 of the whole brain, bytes on IPFS</span>
          <span>feed(id, s) → <i>Fed</i> → bread dropped near the fly</span>
          <span>energy 0 → <i>died(id, …, &quot;starved in the Colony&quot;)</i></span>
        </div>
        <div className="link"><span><em>→</em>scans</span><span><em>←</em>signed tx</span></div>
        <div className="box"><b>VPS · brain/colony/colony.py</b>
          <span>supervisor: aiohttp on <i>:8125</i>, public origin <i>mc.immortalfly.app</i></span>
          <span>alive flies whose body is the Colony → <i>one brain process each</i> (cap COLONY_MAX_FLIES)</span>
          <span><i>server.py --colony</i>: the whole brain + <i>MinecraftWorld</i> (world.py senses/motor reused)</span>
          <span>↕ local WebSocket, 10 Hz ↕ <i>agent.mjs</i> (mineflayer bot &quot;fly&lt;id&gt;&quot;): senses in, motor out</span>
          <span><i>PaperMC</i> server: offline mode, whitelist = the flies, the viewer bots, ALLOW_PLAYERS</span>
          <span><i>prismarine-viewer</i> per fly at /fly/&lt;id&gt;/view/, one colony camera at /view/</span>
          <span>/colony/state · /fly/&lt;id&gt;/ws?lite=1 · /fly/&lt;id&gt;/ws (hdr + spikes)</span>
        </div>
      </div>
      <p className="arch-cap">Figure | The Colony is a body like the arena: the same registry protocol, the same simulator, the same snapshot format. The chain is the only authority; the world is where the senses come from.</p>
      <p><code>server.py --colony</code> is the same process as the arena and the <a href={HOST}>brain host</a>, with <code>World</code> swapped for <code>MinecraftWorld</code>: the same odor/looming/taste code, the same DN readouts, the same snapshot format (so <code>verify.py</code> replays it), the same checkpoint/death/interaction paths, using the Colony key. The Node agent is a thin body: it does no thinking.</p>

      <h3>Agent protocol (local WebSocket <code>ws://127.0.0.1:&lt;port&gt;/agent</code>)</h3>
      <p>Node → Python, 10 Hz:</p>
      <pre><code>{`{"t": 1789600000.1, "pos": [x, y, z], "yaw": 1.57, "health": 20, "onGround": true, "light": 15, "night": false,
 "food": [{"dx": 3.2, "dz": -1.0, "dist": 3.4, "points": 5, "kind": "bread"}],
 "mobs": [{"dx": -8.0, "dz": 2.0, "dist": 8.2, "kind": "zombie", "closing": 1.9}],
 "flies": [{"id": 12, "dist": 4.1}], "eating": false, "holdingFood": 3, "hit": false}`}</code></pre>
      <p>Python → Node, 10 Hz:</p>
      <pre><code>{`{"turn": -0.6, "forward": 1.0, "sprint": false, "back": false, "jump": false, "eat": true, "torch": false, "say": "yum"}`}</code></pre>
      <p><code>turn</code> is rad/s (clamped ±3), <code>forward</code> 0..1, <code>eat</code> makes the bot pick up / eat the nearest food, <code>torch</code> places a torch where it stands (once per meal), <code>say</code> is a chat line (the speech strip: “I smell something…”, “a shadow!”, “yum”).</p>

      <h2>The web view</h2>
      <p><Link href="/colony/">/colony</Link> shows the world through a browser viewer (prismarine-viewer, embedded), a colony map (top-down: flies, food, torches, mobs; from <code>/colony/state</code>, every 3 s), and a fly picker. For the picked fly: the 3D brain point cloud lighting up (the home page&apos;s <code>BrainLive</code>, fed by <code>/fly/&lt;id&gt;/ws</code>), the region bars, the diary and its speech, and the on-chain block of its last checkpoint. That is the <em>neurology</em> panel: the real neurons of the fly you are watching, firing as it walks. Each fly&apos;s page gets a <strong>Colony</strong> figure when its body is the Colony: its own viewer and the same panel. Nothing on the page is a video: it is the live world and the live brain.</p>

      <h3>What the supervisor serves the site</h3>
      <p>The page is built against these, and the supervisor is held to them (<code>web/src/lib/colony.ts</code> is the reader). Every JSON answer carries <code>Access-Control-Allow-Origin: *</code>, exactly as <code>server.py</code> and <code>flyhost.py</code> do, because the site (<code>www.immortalfly.app</code>) and the Colony (<code>mc.immortalfly.app</code>) are different origins and nginx in front of the Colony adds no such header; without it a browser cannot read the answer at all. The site on Vercel also reaches the state and the health checks through its own origin (<code>/api/colony/…</code>, a proxy that only ever asks the Colony) when the direct read is blocked; the GitHub Pages mirror has no server and reads the Colony directly.</p>
      <table className="data"><thead><tr><th>Endpoint</th><th>Serves</th><th>Read by</th></tr></thead><tbody>
        <tr><td><code>GET /colony/state</code></td><td>the world as JSON, below; polled every 3 s</td><td>the map, the fly picker, the condition panel</td></tr>
        <tr><td><code>GET /fly/&lt;id&gt;/health</code></td><td><code>{`{ok, alive, age_ms, realtime, body, fly}`}</code> for a fly it runs (<a href={HOST}>the brain host&apos;s</a>); anything else for one it does not</td><td>a fly&apos;s page, to decide whether the Colony figure streams</td></tr>
        <tr><td><code>/fly/&lt;id&gt;/ws</code>, <code>?lite=1</code></td><td>WebSocket: <code>{`{hdr, spikes}`}</code> as the arena, the lite frame without spikes; <code>hdr</code> may carry <code>say</code></td><td>the neurology panel (a WebSocket needs no CORS header)</td></tr>
        <tr><td><code>/view/</code>, <code>/fly/&lt;id&gt;/view/</code></td><td>prismarine-viewer: the colony camera, one fly&apos;s eyes; must be embeddable in a frame from the site</td><td>the world viewer (an iframe)</td></tr>
      </tbody></table>
      <pre><code>{`{"ok": true, "wall": 1789600000.1, "max": 6, "night": false, "time": 6000, "spawn": [0, 64, 0], "players": 3,
 "flies": [{"id": 12, "name": "Specimen 012", "pos": [x, y, z], "yaw": 1.57, "mode": "surge", "energy": 812.4,
            "alive": true, "realtime": 0.33, "health": 20, "last_event": [t_ms, "smelled food"], "say": "yum"}],
 "queue": [{"id": 14, "name": "…"}],
 "food": [{"pos": [x, y, z], "points": 5, "kind": "bread"}], "torches": [[x, y, z]], "mobs": [{"pos": [x, y, z], "kind": "zombie"}]}`}</code></pre>
      <p>Only <code>flies</code> is required; a missing list is an empty list, a position may be <code>[x, y, z]</code> or <code>{`{x, y, z}`}</code>, and <code>queue</code> may be a count. The registry, not this JSON, says whether a fly is in the Colony: a fly&apos;s page shows the Colony figure when its body is the Colony, and says it is waiting for a spot (or that the Colony is down) when the health check does not answer for it. Until the supervisor has called <code>registerBody</code>, the fly pages do not offer the Colony as a body and <Link href="/colony/">the Colony page</Link> says it is not open yet, because <code>assign</code> would revert.</p>

      <h2>Honest limits</h2>
      <ul>
        <li><strong>Speed.</strong> Six whole brains on one machine run at roughly a third of real time each; the page says so. The number of flies in the world is the cap, not a hidden slowdown.</li>
        <li><strong>The brains do not know what Minecraft is.</strong> They smell, see looming, taste, and steer, because that is what the connectome does; everything else (which item is food, what a zombie is) is the body&apos;s translation, exactly as a real fly&apos;s body translates the world into receptor currents.</li>
        <li><strong>No social circuit.</strong> Another fly nearby is a meeting written to the chain, not a neural input: the model has no circuit for it yet.</li>
        <li><strong>Later.</strong> Real players on a whitelist, night raids, breeding in the world.</li>
      </ul>
    </DocsShell>
  );
}
