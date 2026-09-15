"use client";
import { useEffect, useRef, useState } from "react";
import { CFG } from "@/lib/config";
import Link from "next/link";
import { Chain, LogScan } from "@/lib/chain";
import { BrainLive } from "@/lib/brain3d";
import { FlyRecord, RegistryInfo, Ev, ZERO, fmt, fmtTok, short, hms, ipfs, status, bodyName, scanLabel } from "@/lib/registry";
import { RecordList } from "@/components/Record";

const FLY_ID = 1;
const EVENTS_BLOCKS = 40000;
type Frame = { hdr: any; spikes: Uint16Array };

export default function LiveFly() {
  const brainRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLCanvasElement>(null);
  const chainRef = useRef<Chain | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const spikeRate = useRef(0);
  const [h, setH] = useState<any>(null);            // latest header from the live server
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const [origin, setOrigin] = useState<string>(CFG.liveFallback);
  const [fly, setFly] = useState<FlyRecord | null>(null);
  const [reg, setReg] = useState<RegistryInfo | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [scan, setScan] = useState<LogScan | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [amount, setAmount] = useState("600");
  const [resFood, setResFood] = useState("1800");
  const [busy, setBusy] = useState(false);
  const [toast, setT] = useState<string | null>(null);
  const tt = useRef<any>(null);
  const setToast = (m: string, ms = 5000) => { setT(m); clearTimeout(tt.current); tt.current = setTimeout(() => setT(null), ms); };

  // ---------------------------------------------------------------- live stream
  useEffect(() => {
    let ws: WebSocket | null = null, brain: BrainLive | null = null, raf = 0, running = true, retry: any = null, poll: any = null;
    const orgRef = { current: "" }; let backoff = 4000;
    const connect = (org: string) => {
      clearTimeout(retry); orgRef.current = org;
      if (!org) { setLive("offline"); return; }
      const prev = ws; ws = null; try { prev?.close(); } catch {}
      const sock = new WebSocket(org.replace(/^http/, "ws") + "/ws"); ws = sock; setLive("connecting");
      sock.onopen = () => { if (sock === ws) { setLive("live"); backoff = 4000; } };
      sock.onmessage = (m) => {
        if (sock !== ws) return;
        const j = JSON.parse(m.data); const bin = atob(j.spikes); const arr = new Uint16Array(bin.length / 2);
        for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        frameRef.current = { hdr: j.hdr, spikes: arr }; spikeRate.current = arr.length;
        if (brain) brain.spike(arr);
        setH(j.hdr);
      };
      sock.onclose = () => { if (sock !== ws) return; setLive("offline"); if (running) { retry = setTimeout(() => connect(orgRef.current), backoff); backoff = Math.min(60000, backoff * 1.6); } };
      sock.onerror = () => { try { sock.close(); } catch {} };
    };
    let last = performance.now();
    const loop = (now: number) => { if (!running) return; const dt = Math.min(0.1, (now - last) / 1000); last = now; if (brain) brain.frame(dt); drawArena(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    (async () => {
      try { const buf = await (await fetch(`${CFG.basePath}/assets/brain_points_v2.bin`)).arrayBuffer(); if (brainRef.current) brain = new BrainLive(brainRef.current, buf); } catch (e) { console.warn("WebGL unavailable", e); }
      let org = CFG.liveFallback;
      try {
        const ch = await new Chain().connectRead(); chainRef.current = ch;
        // The arena body announces its live stream origin in bodies(arena).uri; a fly's whole record is on the registry.
        const read = async () => { const [rec, ri, evs, body] = await Promise.all([ch.flyRecord(FLY_ID), ch.registryInfo(), ch.registryEvents(EVENTS_BLOCKS, FLY_ID), ch.bodyInfo(CFG.bodies.arena)]); setFly(rec); setReg(ri); setEvents(evs.events); setScan(evs.scan); return /^https:\/\//.test(body.uri) ? new URL(body.uri).origin : ""; };
        const o = await read(); if (o) org = o;
        poll = setInterval(async () => { try { const o2 = await read(); if (o2 && o2 !== orgRef.current) { setOrigin(o2); connect(o2); } } catch {} }, 60000);
      } catch (e) { console.warn("chain unavailable", e); }
      setOrigin(org); connect(org);
    })();
    const drawArena = () => {
      const c = arenaRef.current, f = frameRef.current; if (!c) return; const g = c.getContext("2d")!;
      const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      g.clearRect(0, 0, W, H);
      const A = f ? f.hdr.arena : 240, S = Math.min(W, H) * 0.96, sc = S / A, cx = W / 2, cy = H / 2;
      const P = (x: number, y: number) => [cx + x * sc, cy - y * sc];
      g.strokeStyle = "rgba(232,230,224,0.06)"; g.lineWidth = 1;
      for (let v = -A / 2; v <= A / 2; v += 20) { const [x0, y0] = P(v, -A / 2), [x1, y1] = P(v, A / 2); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); const [a0, b0] = P(-A / 2, v), [a1, b1] = P(A / 2, v); g.beginPath(); g.moveTo(a0, b0); g.lineTo(a1, b1); g.stroke(); }
      g.strokeStyle = "rgba(232,230,224,0.35)"; g.strokeRect(cx - S / 2, cy - S / 2, S, S);
      if (!f) { g.fillStyle = "rgba(232,230,224,0.4)"; g.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`; g.textAlign = "center"; g.fillText("connecting to the live fly…", cx, cy); return; }
      const hd = f.hdr;
      // odor plumes
      for (const fd of hd.food) { const [x, y] = P(fd.x, fd.y); const frac = fd.energy / Math.max(1, fd.energy0); const grd = g.createRadialGradient(x, y, 0, x, y, 30 * 2.2 * sc); grd.addColorStop(0, `rgba(240,180,41,${0.10 + 0.25 * frac})`); grd.addColorStop(1, "rgba(240,180,41,0)"); g.fillStyle = grd; g.beginPath(); g.arc(x, y, 30 * 2.2 * sc, 0, 7); g.fill(); }
      for (const fd of hd.food) { const [x, y] = P(fd.x, fd.y); g.fillStyle = "#f0b429"; g.beginPath(); g.arc(x, y, Math.max(3, 3 * sc), 0, 7); g.fill(); g.fillStyle = "rgba(232,230,224,0.55)"; g.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.fillText(`${Math.round(fd.energy)} s`, x + 6 * dpr, y - 5 * dpr); }
      // predator
      if (hd.predator) { const [x, y] = P(hd.predator.x, hd.predator.y); g.fillStyle = "rgba(88,196,245,0.8)"; g.beginPath(); g.arc(x, y, Math.max(4, hd.predator.size * sc), 0, 7); g.fill(); }
      // path (from server: only current position; draw a trail we keep locally)
      const tr = (drawArena as any).trail || ((drawArena as any).trail = []); const l = tr[tr.length - 1];
      if (!l || Math.hypot(l[0] - hd.x, l[1] - hd.y) > 0.4) { tr.push([hd.x, hd.y]); if (tr.length > 1500) tr.shift(); }
      g.strokeStyle = "rgba(240,180,41,0.55)"; g.lineWidth = Math.max(1, 1.2 * dpr); g.beginPath(); tr.forEach((p: number[], i: number) => { const [x, y] = P(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      // fly
      const [fx, fy] = P(hd.x, hd.y); g.save(); g.translate(fx, fy); g.rotate(-hd.heading); g.fillStyle = hd.alive ? "#ff5a35" : "#8a919c";
      const L = Math.max(7, 4 * sc); g.beginPath(); g.moveTo(L, 0); g.lineTo(-L * 0.6, L * 0.45); g.lineTo(-L * 0.6, -L * 0.45); g.closePath(); g.fill(); g.restore();
      g.fillStyle = "rgba(232,230,224,0.35)"; g.font = `${Math.round(9.5 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText(`${A} × ${A} body lengths · ${hd.mode}`, cx - S / 2 + 8 * dpr, cy + S / 2 - 6 * dpr);
    };
    return () => { running = false; clearTimeout(retry); clearInterval(poll); cancelAnimationFrame(raf); const s = ws; ws = null; try { s?.close(); } catch {}; if (brain) brain.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    const ch = chainRef.current; if (!ch) return setToast("Not connected to BNB Chain.");
    try { const a = await ch.connectWallet(); setWallet(a); setBal(fmtTok(await ch.balance()) + " FLY"); setToast(`Connected ${short(a)}`); } catch (e: any) { setToast(e.shortMessage || e.message, 6000); }
  };
  const reload = async (ch: Chain) => { const [rec, evs] = await Promise.all([ch.flyRecord(FLY_ID), ch.registryEvents(EVENTS_BLOCKS, FLY_ID)]); setFly(rec); setEvents(evs.events); setScan(evs.scan); setBal(fmtTok(await ch.balance()) + " FLY"); };
  const feed = async () => {
    const ch = chainRef.current; if (!ch || !wallet || !reg) return setToast("Connect a wallet first.");
    const n = Math.floor(Number(amount) || 0); if (n < 1) return setToast("At least one second.");
    setBusy(true);
    try { setToast("Feed: confirm in your wallet (approve $FLY once, then feed)…", 120000); const rc = await ch.feedFly(FLY_ID, n, reg.feed); setToast(`Fed ${fmt(n)} s of life in block ${fmt(rc.blockNumber)}. The arena drops it as food within a minute; the fly has to smell its way there.`, 10000); await reload(ch); }
    catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 8000); } finally { setBusy(false); }
  };
  const resurrect = async () => {
    const ch = chainRef.current; if (!ch || !wallet || !reg) return setToast("Connect a wallet first.");
    const extra = Math.floor(Number(resFood) || 0); if (extra < 60) return setToast("Give it at least 60 seconds of food to live on, or it starves again immediately.");
    setBusy(true);
    try { setToast("Resurrect: confirm in your wallet…", 120000); const rc = await ch.resurrectFly(FLY_ID, extra, reg.res, reg.feed); setToast(`Resurrected in block ${fmt(rc.blockNumber)}. The arena picks it up at its next poll.`, 10000); await reload(ch); }
    catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 8000); } finally { setBusy(false); }
  };

  const R = h?.rates || {}; const alive = fly ? fly.alive : h ? h.alive : true; const streaming = live === "live" && !!h;
  const st = fly ? status(fly) : null; const hosted = !!fly && fly.body !== ZERO;
  const chainCheckpoints = events.filter((e) => e.name === "Commit").length;
  const energyS = h ? h.energy : fly ? fly.energy : 0; const hoursLeft = energyS / 3600;
  const bar = (label: string, v: number, max: number, color: string) => (
    <div className="dnbar" key={label}><span className="lbl">{label}</span><div className="track"><i style={{ width: `${Math.min(100, (100 * v) / max)}%`, background: color }} /></div><span className="mono">{v.toFixed(0)}</span></div>
  );

  return (
    <>
      <section className="open">
        <div className="wrap">
          <div>
            <h1>A whole fruit-fly brain, <em>alive and foraging on BNB Chain.</em></h1>
            <p className="lede">This is Specimen 001, fly #1 of the <Link href="/flies/">Immortal Fruit Flies</Link>. All 139,248 neurons of the FlyWire connectome run as spiking neurons at real time. Its real olfactory neurons smell food that holders give it by burning $FLY; its looming detectors see a predator coming and its giant fiber makes it jump; its descending neurons steer. Every ten minutes the whole brain is snapshotted to IPFS and its hash committed to BNB Smart Chain, so it can die here and wake up in another body, provably the same brain. If it does not find food, it starves.</p>
            <div className="acts">
              <a className="btn fill" href="#care">Feed it</a>
              <Link className="btn" href="/flies/">Mint your own · 1 $FLY</Link>
              <a className="btn plain" href="#organism">Watch the brain</a>
              <a className="btn plain" href="/docs/how-it-works/">How it works →</a>
            </div>
          </div>
          <aside className="chart">
            <div className="chart-t"><b>Condition</b><span className="lbl">{live === "live" ? "live stream" : live === "connecting" ? "connecting…" : "stream offline"}</span></div>
            <div className="gauge" style={{ marginTop: 16, marginBottom: 6 }}>
              <div className="big">{h ? hms(energyS) : "—"}<small>of life left, at one second of life per second</small></div>
              <div className="bar"><i style={{ width: `${Math.min(100, (100 * hoursLeft) / 2)}%` }} /></div>
              <div className="cap"><span>{h ? `${fmt(Math.round(energyS))} s of energy` : ""}</span><span>{h ? `${h.food.length} food item${h.food.length === 1 ? "" : "s"} in the arena` : ""}</span></div>
            </div>
            <div className="crow"><span>status</span><span><span className={`dot${alive ? "" : " dead"}${streaming ? "" : " sim"}`} style={{ display: "inline-block", marginRight: 7 }} />{st ? (st.key === "alive" ? (streaming ? `alive · in ${bodyName(fly!.body)}` : `alive · in ${bodyName(fly!.body)} · stream offline`) : st.label) : alive ? "alive" : "dead"}</span></div>
            <div className="crow"><span>token</span><span><Link href={`/fly/?id=${FLY_ID}`}>fly #{FLY_ID}</Link> · <a href={`${CFG.market.asset}/${FLY_ID}`} target="_blank" rel="noopener">{CFG.market.name} ↗</a></span></div>
            <div className="crow"><span>generation · deaths</span><span>{fly ? `${fly.generation} · ${fly.deaths}` : h ? h.generation : "—"}</span></div>
            <div className="crow"><span>age</span><span>{h ? hms(h.t_ms / 1000) : "—"}</span></div>
            <div className="crow"><span>spikes fired</span><span>{h ? fmt(h.spikes_total) : "—"}</span></div>
            <div className="crow"><span>firing now</span><span>{streaming ? `${fmt(spikeRate.current * 10)} / s (rendered subset)` : "—"}</span></div>
            <div className="crow"><span>eaten · jumps · caught</span><span>{h ? `${Math.round(h.ate)} s · ${h.jumps} · ${h.hits}` : "—"}</span></div>
            <div className="crow"><span>speed</span><span>{h ? `${h.realtime}× real time` : "—"}</span></div>
            <div className="crow"><span>checkpoints on-chain</span><span>{events.length ? `${chainCheckpoints} in the last 40k blocks` : "—"}</span></div>
            <div className="crow"><span>brain state</span><span className="mono" title={fly?.stateRoot}>{fly ? <a href={ipfs(fly.stateURI)} target="_blank" rel="noopener">{fly.stateRoot.slice(0, 14)}… ↗</a> : "—"}</span></div>
          </aside>
        </div>
      </section>

      <section className="fig" id="organism">
        <div className="wrap">
          <div className="fig-head">
            <div><div className="num">Figure 1</div><h2>The brain, firing</h2></div>
            <p className="cap"><b>Fig. 1 |</b> 41,873 of the 139,248 neurons, each lit the instant it spikes in the running simulation. Optic lobes to either side, central brain in the middle. Watch the antennal lobes and mushroom bodies light up when the fly is in an odor plume, and the descending neurons at the base when it turns. Drag to rotate.</p>
          </div>
          <div className="panel p-brain">
            <span className="panel-note tl">FlyWire 783 · {streaming ? "live spikes" : live === "connecting" ? "connecting to the stream…" : "stream offline · last known state"}</span>
            <span className="panel-note tr">{h ? `${fmt(spikeRate.current)} rendered somata fired in the last 100 ms` : ""}</span>
            <span className="panel-note bl">brain width ≈ 800 µm</span>
            <canvas ref={brainRef} aria-label="Three-dimensional point cloud of the fruit fly brain, each soma lit as it spikes" />
          </div>
        </div>
      </section>

      <section className="fig" id="arena">
        <div className="wrap">
          <div className="fig-head">
            <div><div className="num">Figure 2</div><h2>The arena</h2></div>
            <p className="cap"><b>Fig. 2 |</b> <b>a,</b> The world: food (amber) with its odor plume, the fly (red) and its path, and the predator (blue) when one looms. <b>b,</b> The descending neurons that drive its body. Odor-guided turning follows DNa02 and DNa01 left-minus-right (Rayshubskiy et al. 2025); a giant-fiber spike is a jump; walking speed follows the surge-and-cast program of Álvarez-Salvado et al. 2018.</p>
          </div>
          <div className="grid2">
            <div className="cell">
              <div className="cell-t"><span className="a">a</span><span className="n">World</span><span className="r">{h ? `(${h.x.toFixed(1)}, ${h.y.toFixed(1)}) · ${Math.round((((h.heading * 180) / Math.PI) % 360 + 360) % 360)}°` : ""}</span></div>
              <div className="cell-b b-arena"><canvas ref={arenaRef} className="walk-c" aria-label="Top-down view of the arena with food, fly and predator" /></div>
              <div className="cell-cap"><span><i style={{ "--c": "#f0b429" } as any} />food + plume</span><span><i style={{ "--c": "#ff5a35" } as any} />fly</span><span><i style={{ "--c": "#58c4f5" } as any} />predator</span><span style={{ marginLeft: "auto" }}>food lands near the fly; it has to smell its way there</span></div>
            </div>
            <div className="cell">
              <div className="cell-t"><span className="a">b</span><span className="n">Descending neurons</span><span className="r">{h ? h.mode : ""}</span></div>
              <div className="cell-b" style={{ background: "var(--fig)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
                {bar("DNa02 left", R.DNa02_left || 0, 120, "#ff5a35")}{bar("DNa02 right", R.DNa02_right || 0, 120, "#ff5a35")}
                {bar("DNa01 left", R.DNa01_left || 0, 120, "#ff7a52")}{bar("DNa01 right", R.DNa01_right || 0, 120, "#ff7a52")}
                {bar("DNa pop. left", R.DNa_left || 0, 30, "#ff9a7a")}{bar("DNa pop. right", R.DNa_right || 0, 30, "#ff9a7a")}
                {bar("MDN (backward)", (R.MDN_left || 0) + (R.MDN_right || 0), 60, "#8a919c")}{bar("giant fiber", (R.DNp01_left || 0) + (R.DNp01_right || 0), 40, "#58c4f5")}
                {bar("all 1,303 DNs", R.DN_all || 0, 20, "#d9922a")}
                <div style={{ borderTop: "1px solid var(--fig-rule)", paddingTop: 8, marginTop: 2 }}>
                  {bar("olfactory PNs", R.ALPN || 0, 120, "#42b89e")}{bar("Kenyon cells", R.KC || 0, 40, "#d973bf")}{bar("MBONs", R.MBON || 0, 120, "#d973bf")}{bar("LC4 looming L/R", (R.LC4_left || 0) + (R.LC4_right || 0), 150, "#58c4f5")}{bar("taste (GRN)", R.GRN_labellar || 0, 80, "#f0b429")}
                </div>
                <div className="lbl" style={{ color: "var(--fig-dim)", marginTop: 4 }}>steer {h ? (h.steer >= 0 ? "+" : "") + h.steer.toFixed(1) : "—"} · ORN drive L {h ? h.orn[0].toFixed(0) : "—"} / R {h ? h.orn[1].toFixed(0) : "—"} Hz</div>
              </div>
              <div className="cell-cap"><span>firing rates, Hz, 60 ms window</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="sec care" id="care">
        <div className="wrap">
          <div className="sec-t">
            <div><div className="num">Husbandry</div><h2>It eats what you put in its world.</h2></div>
            <p>Feeding is a BNB Chain transaction on the registry: burn $FLY for seconds of life, and the arena drops that food somewhere near the fly at its next poll. One $FLY buys one second, but only if the fly smells its way there before it starves. Everything it has ever been given, every checkpoint of its brain, every jump and every body it has lived in is in the record below.</p>
          </div>
          <div className="care-grid">
            <div className="care-col">
              <div className="care-t"><h3>Feed</h3><span className="cost">{reg ? `${fmtTok(reg.feed)} $FLY = 1 s` : "1 $FLY = 1 s"}</span></div>
              <p>Food lands 40 to 110 body lengths from the fly. Its plume reaches about 60; the fly walks 3 to 4 per second. Anyone may feed it.</p>
              <div className="field"><input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Seconds of life" /><button className="btn fill" disabled={busy || !alive} onClick={wallet ? feed : connect}>{busy ? "…" : wallet ? "Feed" : "Connect wallet"}</button></div>
              <div className="lbl">= {Number(amount) ? hms(Number(amount)) : "—"} of life if eaten{wallet ? ` · ${short(wallet)} · ${bal}` : ""}</div>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>{alive ? "The organism" : "Resurrect"}</h3><span className="cost">{alive ? (fly ? `gen ${fly.generation} · ${fly.deaths} deaths` : "") : reg ? `${fmtTok(reg.res)} $FLY + food` : ""}</span></div>
              {alive ? (<>
                <p>Fly #1 is a token in the <Link href="/flies/">Immortal Fruit Flies</Link>. Its brain, memory, lineage and history live on the registry, not in this arena; {hosted ? `${bodyName(fly!.body)} is only the body running it right now` : "no body is running it right now"}. Every feed is stored against the address that paid.</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link className="btn sm" href={`/fly/?id=${FLY_ID}`}>Fly #1’s record</Link><a className="btn sm" href={`${CFG.market.asset}/${FLY_ID}`} target="_blank" rel="noopener">{CFG.market.name} ↗</a><Link className="btn sm plain" href="/flies/">Mint your own →</Link></div>
              </>) : (<>
                <p>Energy reached zero. The brain was frozen at that instant and its hash written on-chain. Burn $FLY to continue the same brain, as generation {fly ? fly.generation + 1 : ""}. Until then the token cannot be sold.</p>
                <div className="field"><input type="number" min={60} value={resFood} onChange={(e) => setResFood(e.target.value)} aria-label="Seconds of food to wake up with" /><button className="btn fill" disabled={busy} onClick={wallet ? resurrect : connect}>{wallet ? "Resurrect" : "Connect wallet"}</button></div>
                <div className="lbl">= {Number(resFood) ? hms(Number(resFood)) : "—"} of life on waking · minimum 60 s</div>
              </>)}
            </div>
            <div className="care-col">
              <div className="care-t"><h3>Verify it</h3><span className="cost">{h?.chain?.last_hash ? h.chain.last_hash.slice(0, 10) + "…" : ""}</span></div>
              <p>Each checkpoint pins a snapshot to IPFS: every membrane potential, synaptic current and refractory clock, the full world state, and the step at which each on-chain event was applied. Its sha256 is the <code>stateRoot</code> on the registry, so any body, or anyone, can fetch it, check it, and run this exact brain. <code>brain/verify.py</code> replays one snapshot into the next and checks the hash.</p>
              {fly?.stateURI && <a className="btn sm" href={ipfs(fly.stateURI)} target="_blank" rel="noopener">Latest snapshot on IPFS ↗</a>}
              <a className="btn sm plain" href={CFG.links.github + "/tree/main/brain"} target="_blank" rel="noopener">Simulator source →</a>
            </div>
          </div>
          <div style={{ marginTop: 40 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Record</b><span className="lbl">feeds, checkpoints, jumps, bodies, deaths · newest first · {events.length} events {scanLabel(scan, EVENTS_BLOCKS)} · <Link href={`/fly/?id=${FLY_ID}`}>full history →</Link></span></div>
            <RecordList events={events} max={60} empty={!scan ? "reading BNB Smart Chain…" : scan.complete ? `nothing ${scanLabel(scan, EVENTS_BLOCKS)}: see the full history` : `nothing since block ${fmt(scan.from)}; the public RPCs would not serve older blocks right now`} />
          </div>
          {h?.events?.length > 0 && (<div style={{ marginTop: 28 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Diary</b><span className="lbl">what happened to it in the arena</span></div>
            <div className="log-list" style={{ maxHeight: 200 }}>{[...h.events].reverse().map((e: any, i: number) => <div className="lrow" key={i}><span className="blk">{hms(e[0] / 1000)}</span><span className="act" /><span className="ev">{e[1]}</span><span /></div>)}</div>
          </div>)}
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
