"use client";
// The Colony (COLONY.md section 5): a shared Minecraft world on the VPS where several flies live at once, each a whole
// brain. The page shows the world through the Colony's browser viewer (an iframe on <origin>/view/, or one fly's own
// viewer at /fly/<id>/view/), a top-down map of everything in it from /colony/state (polled every 3 s), a fly picker,
// and, for the picked fly, the neurology panel: its 139,248 neurons lighting up as they spike (the home page's
// BrainLive, fed by <origin>/fly/<id>/ws, hdr + spikes), the brain by region, what it is doing and saying, its diary,
// and the on-chain block of its last checkpoint. ColonyNeurology and ColonyFigure are reused by a fly's page.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CFG } from "@/lib/config";
import { Chain } from "@/lib/chain";
import { BrainLive } from "@/lib/brain3d";
import { LifeFrame } from "@/lib/arena";
import { ColonyState, ColonyFly, fetchColonyState, drawColonyMap, colonyModeWord } from "@/lib/colony";
import { FlyRecord, fmt, hms, ipfs, pad, colonyOrigin } from "@/lib/registry";

const STATE_POLL_MS = 3000;
const CHAIN_POLL_MS = 60000;
const MISSES_DOWN = 2;   // consecutive unanswered polls before the page says the Colony is down (one slow answer is not an outage)

/** The rendered somata, fetched once per page whatever fly is picked. */
let pointsBuf: Promise<ArrayBuffer> | null = null;
const brainPoints = () => { if (!pointsBuf) pointsBuf = fetch(`${CFG.basePath}/assets/brain_points_v2.bin`).then((r) => r.arrayBuffer()).catch((e) => { pointsBuf = null; throw e; }); return pointsBuf; };

/** A colony frame: the arena's hdr (brain/HOST_PROTOCOL.md) as the Colony's server.py sends it, plus what the bot said. */
type ColonyHdr = LifeFrame & { say?: string; speech?: string; pos?: number[] };
const sw = (c: string) => ({ "--c": c } as React.CSSProperties);
const bar = (label: string, v: number, max: number, color: string) => (
  <div className="dnbar" key={label}><span className="lbl">{label}</span><div className="track"><i style={{ width: `${Math.min(100, (100 * v) / max)}%`, background: color }} /></div><span className="mono">{v.toFixed(0)}</span></div>
);
const wsUrl = (origin: string, path: string) => origin.replace(/^http/, "ws") + path;

// ---------------------------------------------------------------- the neurology panel
/** The picked fly's brain: the point cloud lit by its spikes over <origin>/fly/<id>/ws (exactly the home page's
 *  stream), the brain by region, its mode, energy, speech and diary, and its last checkpoint on the chain (`fly` is
 *  the registry record when the caller has it). `compact` is the fly page's version: the same panel, lower. */
export function ColonyNeurology({ origin, id, name, fly, compact = false, figure }: { origin: string; id: number; name?: string; fly?: FlyRecord | null; compact?: boolean; figure?: string }) {
  const brainRef = useRef<HTMLCanvasElement>(null);
  const brainObj = useRef<BrainLive | null>(null);
  // the frame and the connection are keyed by the stream they came from, so another fly starts from nothing
  const key = `${origin}|${id}`;
  const [frame, setFrame] = useState<{ key: string; hdr: ColonyHdr; nsp: number } | null>(null);
  const [conn, setConn] = useState<{ key: string; live: "connecting" | "live" | "offline" } | null>(null);
  const [gl, setGl] = useState(true);
  const h = frame && frame.key === key ? frame.hdr : null, nsp = frame && frame.key === key ? frame.nsp : 0;
  const live = conn && conn.key === key ? conn.live : origin ? "connecting" : "offline";

  // the point cloud lives as long as the panel; the stream below is swapped per fly
  useEffect(() => {
    let raf = 0, running = true, last = performance.now();
    (async () => {
      try { const buf = await brainPoints(); if (running && brainRef.current) brainObj.current = new BrainLive(brainRef.current, buf); }
      catch (e) { console.warn("WebGL unavailable", e); setGl(false); }
    })();
    const loop = (now: number) => { if (!running) return; const dt = Math.min(0.1, (now - last) / 1000); last = now; brainObj.current?.frame(dt); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); brainObj.current?.dispose(); brainObj.current = null; };
  }, []);
  useEffect(() => {
    if (!origin) return;
    let ws: WebSocket | null = null, running = true, retry: ReturnType<typeof setTimeout> | undefined, backoff = 4000;
    const url = wsUrl(origin, `/fly/${id}/ws`), k = `${origin}|${id}`;
    const setLive = (live: "connecting" | "live" | "offline") => setConn({ key: k, live });
    const connect = () => {
      clearTimeout(retry);
      const prev = ws; ws = null; try { prev?.close(); } catch {}
      let sock: WebSocket;
      try { sock = new WebSocket(url); } catch { setLive("offline"); retry = setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 1.6); return; }
      ws = sock;
      sock.onopen = () => { if (sock === ws) { setLive("live"); backoff = 4000; } };
      sock.onmessage = (m) => {
        if (sock !== ws) return;
        try {
          const j = JSON.parse(m.data); if (!j || !j.hdr) return;
          let nsp = 0;
          if (typeof j.spikes === "string") {   // base64 of uint16 little-endian indices into the rendered point list
            const bin = atob(j.spikes); const arr = new Uint16Array(bin.length >> 1);
            for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
            nsp = arr.length; brainObj.current?.spike(arr);
          }
          setFrame({ key: k, hdr: j.hdr, nsp });
        } catch {}
      };
      sock.onclose = () => { if (sock !== ws) return; setLive("offline"); if (running) { retry = setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 1.6); } };
      sock.onerror = () => { try { sock.close(); } catch {} };
    };
    connect();
    return () => { running = false; clearTimeout(retry); const s = ws; ws = null; try { s?.close(); } catch {} };
  }, [origin, id]);

  const R: Record<string, number> = h?.rates || {}; const streaming = live === "live" && !!h;
  const smell = R.ALPN || 0, memory = (R.KC || 0) + (R.MBON || 0), sight = (R.LC4_left || 0) + (R.LC4_right || 0), steering = Math.abs((R.DNa02_left || 0) - (R.DNa02_right || 0)), taste = R.GRN_labellar || 0, gf = (R.DNp01_left || 0) + (R.DNp01_right || 0);
  const realtime = h && typeof h.realtime === "number" ? h.realtime : null;
  const state = live === "live" ? (h ? (h.alive ? "live" : "dead in the Colony") : "waiting for the first frame…") : live === "connecting" ? "connecting to the Colony…" : "stream offline · reconnecting";
  const say = h ? String(h.say ?? h.speech ?? "") : "";
  const label = name || (fly ? fly.name : "") || `fly #${id}`;
  const lastCheckpoint = fly && fly.lastCommitBlock ? fly.lastCommitBlock : null;
  return (
    <div className={`neuro${compact ? " compact" : ""}`} data-testid="neurology">
      {figure !== undefined && (
        <div className="fig-head">
          <div><div className="num">{figure}</div><h2>{label}&apos;s brain, firing as it walks</h2></div>
          <p className="cap"><b>Fig. |</b> <b>a,</b> 41,873 of the 139,248 neurons of the fly you picked, each lit the instant it spikes in the running simulation on the VPS: optic lobes to either side, central brain in the middle. Drag to rotate. <b>b,</b> The same brain by region: the antennal lobe when it is in a scent, the mushroom body behind it, the looming detectors when a mob approaches, the descending neurons that turn and walk the bot, the giant fiber when it jumps. Nothing here is a video.</p>
        </div>)}
      <div className="grid2 neuro-grid">
        <div className="cell">
          <div className="cell-t"><span className="a">a</span><span className="n">Brain</span><span className="r">{streaming ? `${fmt(nsp)} rendered somata fired in the last 100 ms` : state}</span></div>
          <div className={`cell-b b-brain${compact ? " compact" : ""}`}>
            <span className="panel-note tl">FlyWire 783 · {streaming ? "live spikes" : state}</span>
            <span className="panel-note bl">brain width ≈ 800 µm{realtime !== null ? ` · ${realtime.toFixed(1)}× real time` : ""}</span>
            {!gl && <span className="panel-note tr">WebGL unavailable</span>}
            <canvas ref={brainRef} data-testid="brain-canvas" aria-label={`Three-dimensional point cloud of ${label}'s brain, each soma lit as it spikes`} />
          </div>
          <div className="cell-cap"><span>whole brain on the VPS · body: Colony</span><span style={{ marginLeft: "auto" }}>{h ? `age ${hms(h.t_ms / 1000)} · ${fmt(h.spikes_total)} spikes` : ""}</span></div>
        </div>
        <div className="cell">
          <div className="cell-t"><span className="a">b</span><span className="n">By region</span><span className="r">{streaming ? "live" : state}</span></div>
          <div className="cell-b neuro-b">
            <div className="life-mode"><span className="lbl">doing</span><b className="life-word" data-mode={h?.mode || ""}>{h ? (h.alive ? colonyModeWord(h.mode) : "dead") : "…"}</b></div>
            <div className="life-energy"><span className="lbl">energy</span><span className="mono">{h ? `${hms(h.energy)} · ${fmt(Math.round(h.energy))} s` : "—"}</span></div>
            <div className="life-say"><span className="lbl">says</span><span className="say">{say ? `“${say}”` : "…"}</span></div>
            <div className="life-bars">
              {bar("smell · ALPN", smell, 120, "#42b89e")}
              {bar("memory · KC+MBON", memory, 160, "#d973bf")}
              {bar("sight · LC4 L+R", sight, 150, "#58c4f5")}
              {bar("steering · |DNa02 L−R|", steering, 120, "#ff5a35")}
              {bar("taste · GRN", taste, 80, "#f0b429")}
              {bar("giant fiber · DNp01", gf, 40, "#58c4f5")}
              {!compact && bar("all 1,303 DNs", R.DN_all || 0, 20, "#d9922a")}
              {!compact && bar("DNa02 left", R.DNa02_left || 0, 120, "#ff5a35")}
              {!compact && bar("DNa02 right", R.DNa02_right || 0, 120, "#ff5a35")}
              {!compact && bar("MDN (backward)", (R.MDN_left || 0) + (R.MDN_right || 0), 60, "#8a919c")}
            </div>
            <div className="lbl" style={{ color: "var(--fig-dim)", marginTop: 4 }}>steer {h && typeof h.steer === "number" ? (h.steer >= 0 ? "+" : "") + h.steer.toFixed(1) : "—"} · ORN drive L {h?.orn ? Number(h.orn[0]).toFixed(0) : "—"} / R {h?.orn ? Number(h.orn[1]).toFixed(0) : "—"} Hz · eaten {h ? Math.round(h.ate) : "—"} s · jumps {h ? h.jumps : "—"} · hit {h ? h.hits : "—"}</div>
            <div className="chk">
              <div className="lbl" style={{ color: "var(--fig-dim)" }}>last checkpoint on the chain</div>
              <div className="chk-rows">
                <span>block</span><span className="mono">{lastCheckpoint ? <a href={`${CFG.explorer}/block/${lastCheckpoint}`} target="_blank" rel="noopener">{fmt(lastCheckpoint)}</a> : fly ? "none yet this life" : "—"}</span>
                <span>brain state</span><span className="mono" title={fly?.stateRoot}>{fly ? <a href={ipfs(fly.stateURI)} target="_blank" rel="noopener">{fly.stateRoot.slice(0, 14)}… ↗</a> : h?.chain?.last_hash ? `${String(h.chain.last_hash).slice(0, 14)}…` : "—"}</span>
                <span>energy · step</span><span className="mono">{fly ? `${fmt(fly.energy)} s · ${fmt(fly.brainStep)}` : "—"}</span>
                <span>this life</span><span className="mono">{h?.chain ? `${h.chain.checkpoints} checkpoint${h.chain.checkpoints === 1 ? "" : "s"}` : "—"}</span>
              </div>
            </div>
          </div>
          <div className="cell-cap"><span>firing rates, Hz, 60 ms window</span><span style={{ marginLeft: "auto" }}><Link href={`/fly/?id=${id}`}>#{pad(id)} record →</Link></span></div>
        </div>
      </div>
      <div className="log-head"><b style={{ fontSize: 13 }}>Diary</b><span className="lbl">what happened to it in the Colony · newest first</span></div>
      <div className="log-list" style={{ maxHeight: compact ? 150 : 200 }}>
        {h?.events?.length ? [...h.events].reverse().map((e, i) => <div className="lrow" key={i}><span className="blk">{hms(e[0] / 1000)}</span><span className="act" /><span className="ev">{e[1]}</span><span /></div>)
          : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">{h ? "nothing yet" : state}</span><span /></div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the world viewer
/** The Colony's browser viewer (prismarine-viewer behind the supervisor): the whole world from the camera bot, or one
 *  fly's own view. `serves` false means the Colony is not streaming this fly (queued, or down): nothing is embedded. */
function WorldView({ origin, flyId, flyName, serves, compact = false, initial = "overview" }: { origin: string; flyId: number | null; flyName?: string; serves: boolean; compact?: boolean; initial?: "overview" | "fly" }) {
  const [view, setView] = useState<"overview" | "fly">(initial);
  const which = view === "fly" && flyId !== null && serves ? "fly" : "overview";
  const src = !origin ? "" : which === "fly" ? `${origin}/fly/${flyId}/view/` : `${origin}/view/`;
  return (
    <div className={`panel p-view${compact ? " compact" : ""}`}>
      <span className="panel-note tl">{which === "fly" ? `through fly #${flyId}${flyName ? ` · ${flyName}` : ""}` : "the colony camera"}</span>
      {flyId !== null && serves && (
        <div className="view-tabs" role="tablist" aria-label="Viewer">
          <button role="tab" aria-selected={which === "overview"} className={which === "overview" ? "on" : ""} onClick={() => setView("overview")}>overview</button>
          <button role="tab" aria-selected={which === "fly"} className={which === "fly" ? "on" : ""} onClick={() => setView("fly")}>#{flyId}&apos;s eyes</button>
        </div>)}
      {src && (which === "overview" || serves)
        ? <iframe src={src} title={which === "fly" ? `The Colony through fly #${flyId}` : "The Colony world"} allow="fullscreen" loading="lazy" data-testid="world-view" />
        : <div className="view-empty">{origin ? "the Colony is not streaming this fly right now" : "the Colony's address is unknown"}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- the fly page's figure
/** On a fly's page when its body is the Colony: its own viewer and the neurology panel, compact. */
export function ColonyFigure({ id, origin, fly, serves }: { id: number; origin: string; fly: FlyRecord; serves: boolean }) {
  return (
    <div id="colony" style={{ marginTop: 44 }}>
      <div className="fig-head core-head">
        <div><div className="num">Figure · colony · #{pad(id)}</div><h2>In the Colony: a player in a shared Minecraft world</h2></div>
        <p className="cap"><b>Fig. |</b> Its body is the <Link href="/colony/">Colony</Link>: a Minecraft world on the VPS where several flies live at once. The whole brain runs there; what its neurons sense is the world around the bot, and what they drive is the bot&apos;s body. <b>Above,</b> the world through its own eyes. <b>a,</b> Its 139,248 neurons lighting up as they spike. <b>b,</b> The brain by region, what it is doing and saying, and its last checkpoint: every ten minutes the Colony pins the whole brain to IPFS and commits its hash on the registry, and when it starves it dies on-chain, the brain preserved.{serves ? "" : " The Colony is not streaming this fly right now: it is waiting for a spot, or the Colony is down; the stream below reconnects by itself."}</p>
      </div>
      <WorldView origin={origin} flyId={id} flyName={fly.name} serves={serves} compact initial="fly" />
      <ColonyNeurology origin={origin} id={id} name={fly.name} fly={fly} compact />
    </div>
  );
}

// ---------------------------------------------------------------- the explainer (COLONY.md sections 1 to 3)
function Explainer() {
  return (
    <div className="care-grid">
      <div className="care-col">
        <div className="care-t"><h3>What they are</h3><span className="cost">one whole brain each</span></div>
        <p>A fly in the Colony is a token on the registry whose owner handed it to the Colony body. The Colony fetched its brain from IPFS, checked the hash, and put it into a shared Minecraft world as a player named after it. All 139,248 neurons run on the VPS; what they sense is the world around the bot, and what they drive is the bot&apos;s body. The flies smell the same food, flee the same zombies, and meet each other, and every notable thing is written to the chain.</p>
      </div>
      <div className="care-col">
        <div className="care-t"><h3>What they sense</h3><span className="cost">the arena&apos;s mapping</span></div>
        <p>Food on the ground and food blocks within 32 blocks reach the olfactory receptor neurons, left and right by bearing, as an odor plume. A hostile mob closing in the front 120° drives the looming detectors, by side. Standing on or holding food drives the taste neurons, and eating restores energy. The descending neurons steer: DNa02 and DNa01 left-minus-right turn the bot, the DN population walks it, a giant-fiber spike is a jump, MDN walks it backward. Where a fly ate, it leaves a torch.</p>
      </div>
      <div className="care-col">
        <div className="care-t"><h3>What it costs</h3><span className="cost">1 s of life per second</span></div>
        <p>Being in the Colony costs one second of life per second, from the fly&apos;s on-chain energy, committed at every checkpoint. Feeding it (1 $FLY per second) drops bread near it, 5 s a loaf; it has to smell its way there. A zombie hit costs 60 s; the bot never fights back. At zero energy the fly dies on-chain, <i>starved in the Colony</i>, its brain preserved: resurrect it and assign it again. The Colony holds a fixed number of flies at once; the rest wait in a queue, and the speed of every brain is shown honestly.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page
export default function Colony() {
  const sp = useSearchParams();
  const wanted = parseInt(sp.get("fly") || "", 10) || null;
  const mapRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<ColonyState | null>(null);
  const chainRef = useRef<Chain | null>(null);
  const misses = useRef(0);
  const [origin, setOrigin] = useState(colonyOrigin());
  const [state, setState] = useState<ColonyState | null>(null);
  const [downState, setDown] = useState<boolean | null>(null);   // null until the first answer or miss
  const down = origin ? downState : true;
  const [chosen, setPicked] = useState<number | null>(wanted);
  const [flyRec, setFlyRec] = useState<FlyRecord | null>(null);   // the picked fly's registry record; its id says which
  const [bodyFlies, setBodyFlies] = useState<number | null>(null);   // bodies(colony).flies from the registry
  // Is the Colony a registered body yet? Until its supervisor registers it, assign(id, Colony) reverts with
  // NotRegistered(): the page must not send readers to hand a fly to it. Null until the registry has answered.
  const [registered, setRegistered] = useState<boolean | null>(null);
  // the picked fly: the one chosen if it is in the world, else what the URL asked for, else the first fly
  const flies = state?.flies || [];
  const picked = chosen !== null && flies.some((f) => f.id === chosen) ? chosen : wanted !== null && flies.some((f) => f.id === wanted) ? wanted : flies.length ? flies[0].id : chosen;

  // the origin is fixed (or overridden); the registry's uri is the last resort, and its record says how many flies it holds
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const ch = await new Chain().connectRead(); if (stop) return; chainRef.current = ch;
        const [b, yes] = await Promise.all([ch.bodyInfo(CFG.bodies.colony), ch.isBody(CFG.bodies.colony)]); if (stop) return;
        setBodyFlies(b.flies); setRegistered(yes);
        if (!colonyOrigin()) setOrigin(colonyOrigin(b.uri));
      } catch (e) { console.warn("chain unavailable", e); }
    })();
    return () => { stop = true; };
  }, []);
  // /colony/state every 3 s while the page is visible
  useEffect(() => {
    if (!origin) return;
    let stop = false, inFlight = false;
    const poll = async () => {
      if (stop || inFlight || (typeof document !== "undefined" && document.visibilityState !== "visible" && stateRef.current)) return;
      inFlight = true;
      const s = await fetchColonyState(origin).finally(() => { inFlight = false; }); if (stop) return;
      if (s) { misses.current = 0; stateRef.current = s; setState(s); setDown(false); }
      else { misses.current += 1; if (misses.current >= MISSES_DOWN || !stateRef.current) { setDown(true); } }
    };
    poll(); const timer = setInterval(poll, STATE_POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [origin]);
  // the picked fly's registry record (its last checkpoint), refreshed every minute
  useEffect(() => {
    if (picked === null) return;
    let stop = false;
    const read = async () => { const ch = chainRef.current; if (!ch || stop) return; try { const r = await ch.flyRecord(picked); if (!stop) setFlyRec(r); } catch {} };
    read(); const t = setInterval(read, CHAIN_POLL_MS);
    const late = setTimeout(read, 3000);   // the chain may connect after the first state arrives
    return () => { stop = true; clearInterval(t); clearTimeout(late); };
  }, [picked]);
  // the map, redrawn on every frame so a resize is picked up (the state changes every 3 s)
  useEffect(() => {
    let raf = 0, running = true;
    const loop = () => { if (!running) return; const c = mapRef.current; if (c) drawColonyMap(c, stateRef.current, picked, origin ? "connecting to the Colony…" : "the Colony's address is unknown"); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [picked, origin]);

  const pickedFly: ColonyFly | null = picked !== null ? flies.find((f) => f.id === picked) || null : null;
  const pickedRec = flyRec && flyRec.id === picked ? flyRec : null;
  const alive = flies.filter((f) => f.alive).length;
  const max = state?.max ?? null;
  const queued = state?.queued ?? 0;
  const rt = flies.filter((f) => typeof f.realtime === "number"); const meanRt = rt.length ? rt.reduce((a, f) => a + (f.realtime as number), 0) / rt.length : null;
  const queueLine = max !== null
    ? `${queued === 0 ? "no fly is" : `${queued} ${queued === 1 ? "fly is" : "flies are"}`} waiting for a spot; the colony holds ${max}${flies.length ? `, ${flies.length} ${flies.length === 1 ? "is" : "are"} in it` : ", none is in it yet"}`
    : `${queued === 0 ? "no fly is" : `${queued} ${queued === 1 ? "fly is" : "flies are"}`} waiting for a spot`;
  const condition = down === null ? "connecting…" : down ? "the Colony is not answering" : state?.night ? "live · night" : "live · day";
  const hostShort = origin ? origin.replace(/^https?:\/\//, "") : "unknown";

  return (
    <main>
      <section className="open">
        <div className="wrap">
          <div>
            <h1>The Colony: <em>flies living together in Minecraft.</em></h1>
            <p className="lede">A shared Minecraft world on the VPS where several <Link href="/flies/">Immortal Fruit Flies</Link> live at once, each running its whole brain. What their 139,248 neurons sense is the world around their bot: bread on the ground as scent, a zombie closing in as a looming shadow, another fly nearby as a meeting written to the chain. They converge on the same food, scatter from the same zombie, and leave torches where they ate. Being there costs one second of life per second, from the fly&apos;s on-chain energy; when it starves, it dies on-chain and its brain is preserved.</p>
            <div className="acts">
              <a className="btn fill" href="#world">Watch the world</a>
              {registered === false ? <span className="btn" aria-disabled="true" style={{ opacity: 0.5, cursor: "not-allowed" }} title="The Colony body has not registered on the registry yet; its supervisor does that when it starts">Not open yet: no fly can be assigned</span> : <Link className="btn" href="/flies/">Assign a fly from its page</Link>}
              <a className="btn plain" href="#neurology">The picked fly&apos;s brain</a>
              <Link className="btn plain" href="/docs/colony/">How it works →</Link>
            </div>
          </div>
          <aside className="chart">
            <div className="chart-t"><b>Condition</b><span className="lbl">{condition}</span></div>
            <div className="gauge" style={{ marginTop: 16, marginBottom: 6 }}>
              <div className="big">{state ? `${flies.length}${max !== null ? ` of ${max}` : ""}` : "—"}<small>{state ? `${flies.length === 1 ? "fly" : "flies"} in the world · ${alive} alive` : "flies in the world"}</small></div>
              <div className="bar"><i style={{ width: `${max ? Math.min(100, (100 * flies.length) / max) : 0}%` }} /></div>
              <div className="cap"><span>{state ? queueLine : ""}</span></div>
            </div>
            <div className="crow"><span>world</span><span><span className={`dot${down ? " dead" : down === null ? " sim" : ""}`} style={{ display: "inline-block", marginRight: 7 }} />{hostShort}</span></div>
            <div className="crow"><span>time</span><span>{state ? (state.night === null ? "—" : state.night ? "night: the zombies come" : "day") : "—"}</span></div>
            <div className="crow"><span>speed</span><span>{meanRt !== null ? `${meanRt.toFixed(2)}× real time per brain` : "—"}</span></div>
            <div className="crow"><span>food on the ground</span><span>{state ? fmt(state.food.length) : "—"}</span></div>
            <div className="crow"><span>torches (meals)</span><span>{state ? fmt(state.torches.length) : "—"}</span></div>
            <div className="crow"><span>hostile mobs near</span><span>{state ? fmt(state.mobs.length) : "—"}</span></div>
            <div className="crow"><span>players online</span><span>{state && state.players !== null ? fmt(state.players) : "—"}</span></div>
            <div className="crow"><span>body</span><span><a href={`${CFG.explorer}/address/${CFG.bodies.colony}`} target="_blank" rel="noopener">Colony ↗</a>{registered === false ? " · not registered yet" : bodyFlies !== null ? ` · ${bodyFlies} assigned` : ""}</span></div>
          </aside>
        </div>
      </section>

      {down && !state ? (
        <section className="fig" id="world">
          <div className="wrap">
            <div className="fig-head">
              <div><div className="num">The Colony</div><h2>{origin ? "The Colony is not answering." : "The Colony's address is unknown."}</h2></div>
              <p className="cap"><b>Empty.</b> {origin ? <>Nothing at <span className="mono">{hostShort}</span> answered <span className="mono">/colony/state</span>; the page keeps asking every three seconds and fills in as soon as it does.</> : "No public origin is configured and the registry does not name one for the Colony body."} Nothing here is faked: no world, no map and no brain is shown until the real ones stream. {registered === false ? <>The Colony body has not registered on the registry yet (its supervisor does that when it starts), so no fly can be handed to it for now: the body picker on every fly&apos;s page says so, and the registry would refuse the hand-off.</> : <>To put a fly in the Colony, <Link href="/flies/">assign a fly to the Colony from its page</Link>; it joins when the Colony accepts it and a spot is free.</>}</p>
            </div>
            <div className="panel p-view empty" data-testid="colony-empty"><div className="view-empty">no world to show · the Colony at {hostShort} is down or not yet running</div></div>
          </div>
        </section>
      ) : (<>
        <section className="fig" id="world">
          <div className="wrap">
            <div className="fig-head">
              <div><div className="num">Figure 1</div><h2>The world</h2></div>
              <p className="cap"><b>Fig. 1 |</b> The Colony&apos;s Minecraft world through a browser viewer: the colony camera, or the picked fly&apos;s own eyes. Each fly is a player named after it, walked by its descending neurons. Nothing on this page is a video; it is the live world and the live brain.</p>
            </div>
            <WorldView origin={origin} flyId={picked} flyName={pickedFly?.name} serves={!!pickedFly} />
          </div>
        </section>

        <section className="fig" id="map">
          <div className="wrap">
            <div className="fig-head">
              <div><div className="num">Figure 2</div><h2>The colony map</h2></div>
              <p className="cap"><b>Fig. 2 |</b> <b>a,</b> From above: the flies (red, pointing where they face), food (amber, with the scent their receptors smell), torches where a fly ate (amber crosses: the colony&apos;s shared memory of where the food was), and hostile mobs (blue). <b>b,</b> The flies in the world; pick one to watch its brain below.</p>
            </div>
            <div className="grid2">
              <div className="cell">
                <div className="cell-t"><span className="a">a</span><span className="n">Map</span><span className="r">{pickedFly ? `#${pickedFly.id} at (${Math.round(pickedFly.x)}, ${Math.round(pickedFly.y)}, ${Math.round(pickedFly.z)})` : state ? `${flies.length} flies` : "…"}</span></div>
                <div className="cell-b b-map"><canvas ref={mapRef} className="walk-c" data-testid="colony-map" aria-label="Top-down map of the Colony: flies, food, torches and mobs" /></div>
                <div className="cell-cap"><span><i style={sw("#ff5a35")} />fly</span><span><i style={sw("#f0b429")} />food · torch</span><span><i style={sw("#58c4f5")} />hostile mob</span><span style={{ marginLeft: "auto" }}>from /colony/state every 3 s</span></div>
              </div>
              <div className="cell">
                <div className="cell-t"><span className="a">b</span><span className="n">Flies</span><span className="r">{state ? `${alive} alive · ${queued} waiting` : ""}</span></div>
                <div className="cell-b picker" data-testid="fly-picker">
                  {flies.length ? flies.map((f) => (
                    <button key={f.id} className={`fly-pick${picked === f.id ? " on" : ""}`} onClick={() => setPicked(f.id)} aria-pressed={picked === f.id} data-testid={`pick-${f.id}`}>
                      <span className={`dot${f.alive ? "" : " dead"}`} /><b>{f.name}</b><span className="id">#{pad(f.id)}</span>
                      <span className="m">{f.alive ? colonyModeWord(f.mode) : "dead"} · {hms(f.energy)}{typeof f.realtime === "number" ? ` · ${f.realtime.toFixed(2)}× real time` : ""}{f.say ? ` · “${f.say}”` : ""}</span>
                    </button>))
                    : <div className="view-empty">{state ? "no fly is in the world yet" : "connecting to the Colony…"}</div>}
                  {state && state.queue.length > 0 && (<div className="queue-list"><span className="lbl">waiting for a spot</span>{state.queue.map((q) => <Link key={q.id} href={`/fly/?id=${q.id}`}>#{pad(q.id)} {q.name}</Link>)}</div>)}
                </div>
                <div className="cell-cap"><span>{state ? queueLine : ""}</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className="fig" id="neurology">
          <div className="wrap">
            {picked !== null
              ? <ColonyNeurology origin={origin} id={picked} name={pickedFly?.name} fly={pickedRec} figure={`Figure 3 · neurology · #${pad(picked)}`} />
              : (<div className="fig-head"><div><div className="num">Figure 3</div><h2>Neurology</h2></div><p className="cap"><b>Fig. 3 |</b> Pick a fly above to watch its 139,248 neurons fire as it walks. {state ? "No fly is in the world yet." : ""}</p></div>)}
          </div>
        </section>
      </>)}

      <section className="sec" id="rules">
        <div className="wrap">
          <div className="sec-t">
            <div><div className="num">The rules</div><h2>{state ? queueLine.charAt(0).toUpperCase() + queueLine.slice(1) + "." : "A colony as flies actually have them."}</h2></div>
            <p>Shared environment, shared memory of where the food is, no foreman. The flies do not know what Minecraft is: they smell, see looming, taste and steer, because that is what the connectome does; which item is food and what a zombie is are the body&apos;s translation, exactly as a real fly&apos;s body translates the world into receptor currents. {registered === false ? "The Colony body is not registered on the registry yet, so no fly can be handed to it until its supervisor starts and registers it; then: open a fly's page and hand it to the Colony, and it joins when the Colony accepts and a spot is free." : "To add a fly, open its page and hand it to the Colony; it joins when the Colony accepts and a spot is free."} <Link href="/docs/colony/">The full mapping, the life rules and the architecture →</Link></p>
          </div>
          <Explainer />
        </div>
      </section>
    </main>
  );
}
