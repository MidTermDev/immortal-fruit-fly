"use client";
import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import { Chain } from "@/lib/chain";
import { BrainLive } from "@/lib/brain3d";

const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };
const hms = (s: number) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; };

type Frame = { hdr: any; spikes: Uint16Array };
type Ev = { name: string; args: any; block: number; tx: string };

export default function LiveFly() {
  const brainRef = useRef<HTMLCanvasElement>(null);
  const arenaRef = useRef<HTMLCanvasElement>(null);
  const chainRef = useRef<Chain | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const spikeRate = useRef(0);
  const [h, setH] = useState<any>(null);            // latest header from the live server
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");
  const [origin, setOrigin] = useState<string>(CFG.liveFallback);
  const [info, setInfo] = useState<any>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const [amount, setAmount] = useState("600");
  const [resFood, setResFood] = useState("1800");
  const [busy, setBusy] = useState(false);
  const [toast, setT] = useState<string | null>(null);
  const tt = useRef<any>(null);
  const setToast = (m: string, ms = 5000) => { setT(m); clearTimeout(tt.current); tt.current = setTimeout(() => setT(null), ms); };

  // ---------------------------------------------------------------- live stream
  useEffect(() => {
    let ws: WebSocket | null = null, brain: BrainLive | null = null, raf = 0, running = true, retry: any = null;
    const connect = (org: string) => {
      try { ws?.close(); } catch {}
      const url = org.replace(/^http/, "ws") + "/ws";
      ws = new WebSocket(url); setLive("connecting");
      ws.onopen = () => setLive("live");
      ws.onmessage = (m) => {
        const j = JSON.parse(m.data); const bin = atob(j.spikes); const arr = new Uint16Array(bin.length / 2);
        for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        frameRef.current = { hdr: j.hdr, spikes: arr }; spikeRate.current = arr.length;
        if (brain) brain.spike(arr);
        setH(j.hdr);
      };
      ws.onclose = () => { setLive("offline"); if (running) retry = setTimeout(() => connect(org), 4000); };
      ws.onerror = () => { try { ws?.close(); } catch {} };
    };
    (async () => {
      try { const buf = await (await fetch(`${CFG.basePath}/assets/brain_points_v2.bin`)).arrayBuffer(); if (brainRef.current) brain = new BrainLive(brainRef.current, buf); } catch (e) { console.warn("WebGL unavailable", e); }
      let org = CFG.liveFallback;
      try {
        const ch = await new Chain().connectRead(); chainRef.current = ch;
        const [wi, evs] = await Promise.all([ch.worldInfo(), ch.worldEvents(40000)]);
        setInfo(wi); setEvents(evs.slice(0, 60));
        const o = ch.liveOrigin(evs); if (o) org = o;
        setInterval(async () => { try { const evs2 = await ch.worldEvents(40000); setEvents(evs2.slice(0, 60)); setInfo(await ch.worldInfo()); const o2 = ch.liveOrigin(evs2); if (o2 && o2 !== org) { org = o2; setOrigin(o2); connect(o2); } } catch {} }, 60000);
      } catch (e) { console.warn("chain unavailable", e); }
      setOrigin(org); connect(org);
      let last = performance.now();
      const loop = (now: number) => { if (!running) return; const dt = Math.min(0.1, (now - last) / 1000); last = now; if (brain) brain.frame(dt); drawArena(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
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
      // pick
      if (pick) { const [x, y] = P(pick.x, pick.y); g.strokeStyle = "#f0b429"; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.arc(x, y, 8 * dpr, 0, 7); g.stroke(); g.setLineDash([]); }
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
    return () => { running = false; clearTimeout(retry); cancelAnimationFrame(raf); try { ws?.close(); } catch {}; if (brain) brain.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const arenaClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget, r = c.getBoundingClientRect(); const A = h?.arena || 240, S = Math.min(r.width, r.height) * 0.96, sc = S / A;
    const x = Math.round((e.clientX - r.left - r.width / 2) / sc), y = Math.round(-(e.clientY - r.top - r.height / 2) / sc);
    if (Math.abs(x) <= A / 2 && Math.abs(y) <= A / 2) { setPick({ x, y }); setToast(`Food will be placed at (${x}, ${y}). Choose an amount and confirm.`, 4000); }
  };
  const connect = async () => {
    const ch = chainRef.current; if (!ch) return setToast("Not connected to BNB Chain.");
    try { const a = await ch.connectWallet(); setWallet(a); setBal(fmtTok(await ch.balance()) + " FLY"); setToast(`Connected ${short(a)}`); } catch (e: any) { setToast(e.shortMessage || e.message, 6000); }
  };
  const placeFood = async () => {
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first."); if (!pick) return setToast("Click a spot in the arena first.");
    const amt = Number(amount) || 0; if (info && ethers.parseEther(String(amt)) < info.minFood) return setToast(`Minimum is ${fmtTok(info.minFood)} $FLY.`);
    setBusy(true);
    try { setToast("Place food: confirm in your wallet…", 90000); const rc = await ch.placeFood(pick.x, pick.y, ethers.parseEther(String(amt))); setToast(`Food placed in block ${fmt(rc.blockNumber)}. The fly has to find it now.`); setPick(null); setEvents((await ch.worldEvents(40000)).slice(0, 60)); setBal(fmtTok(await ch.balance()) + " FLY"); }
    catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 8000); } finally { setBusy(false); }
  };
  const resurrect = async () => {
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first.");
    setBusy(true);
    try { setToast("Resurrect: confirm in your wallet…", 90000); const rc = await ch.resurrectWorld(ethers.parseEther(String(Number(resFood) || 0)), info.resPrice); setToast(`Resurrected in block ${fmt(rc.blockNumber)}.`); }
    catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 8000); } finally { setBusy(false); }
  };

  const R = h?.rates || {}; const alive = h ? h.alive : true;
  const energyS = h ? h.energy : 0; const hoursLeft = energyS / 3600;
  const evRow = (e: Ev, i: number) => {
    const a = e.args; let act = "tick", txt: React.ReactNode = e.name;
    if (e.name === "FoodPlaced") { act = "feed"; txt = <>placed <b>{fmt(a.seconds_)} s of food</b> at ({String(a.x)}, {String(a.y)}) · {fmtTok(a.tokensBurned)} $FLY</>; }
    else if (e.name === "Checkpoint") { act = "tick"; txt = <>checkpoint at age {(Number(a.ageMs) / 1000).toFixed(0)} s · brain hash <span className="mono">{String(a.stateHash).slice(0, 14)}…</span> · {fmt(a.spikes)} spikes</>; }
    else if (e.name === "Died") { act = "life"; txt = <><b>died</b> at age {(Number(a.ageMs) / 1000).toFixed(0)} s · generation {String(a.generation)}</>; }
    else if (e.name === "Resurrected") { act = "life"; txt = <><b>resurrected</b> · generation {String(a.generation)} · {fmt(a.energy)} s of life</>; }
    return (<div className="lrow" key={e.tx + i}><a className="blk" href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">block {e.block}</a><span className={`act ${act}`}>{act}</span><span className="ev">{txt}</span><span className="who">{a.by ? short(a.by) : "operator"}</span></div>);
  };
  const bar = (label: string, v: number, max: number, color: string) => (
    <div className="dnbar" key={label}><span className="lbl">{label}</span><div className="track"><i style={{ width: `${Math.min(100, (100 * v) / max)}%`, background: color }} /></div><span className="mono">{v.toFixed(0)}</span></div>
  );

  return (
    <>
      <section className="open">
        <div className="wrap">
          <div>
            <h1>A whole fruit-fly brain, <em>alive and foraging on BNB Chain.</em></h1>
            <p className="lede">All 139,248 neurons of the FlyWire connectome, running as spiking neurons at real time. Its real olfactory neurons smell food that holders place by burning $FLY. Its real looming detectors see a predator coming, and its giant fiber makes it jump. Its real descending neurons steer. Every ten minutes a hash of the entire brain state is written to BNB Smart Chain. If it does not find food, it starves.</p>
            <div className="acts">
              <a className="btn fill" href="#care">Place food</a>
              <a className="btn" href="#organism">Watch the brain</a>
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
            <div className="crow"><span>status</span><span><span className={`dot${alive ? "" : " dead"}${live === "live" ? "" : " sim"}`} style={{ display: "inline-block", marginRight: 7 }} />{alive ? "alive" : "dead"}</span></div>
            <div className="crow"><span>generation</span><span>{h ? h.generation : "—"}</span></div>
            <div className="crow"><span>age</span><span>{h ? hms(h.t_ms / 1000) : "—"}</span></div>
            <div className="crow"><span>spikes fired</span><span>{h ? fmt(h.spikes_total) : "—"}</span></div>
            <div className="crow"><span>firing now</span><span>{h ? `${fmt(spikeRate.current * 10)} / s (rendered subset)` : "—"}</span></div>
            <div className="crow"><span>eaten · jumps · caught</span><span>{h ? `${Math.round(h.ate)} s · ${h.jumps} · ${h.hits}` : "—"}</span></div>
            <div className="crow"><span>speed</span><span>{h ? `${h.realtime}× real time` : "—"}</span></div>
            <div className="crow"><span>checkpoints on-chain</span><span>{h ? h.chain.checkpoints : "—"}</span></div>
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
            <span className="panel-note tl">FlyWire 783 · {live === "live" ? "live spikes" : "waiting for stream"}</span>
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
            <p className="cap"><b>Fig. 2 |</b> <b>a,</b> The world: food (amber) with its odor plume, the fly (red) and its path, and the predator (blue) when one looms. <b>b,</b> The descending neurons that drive its body. Odor-guided turning follows DNa02 and DNa01 left-minus-right (Rayshubskiy et al. 2025); a giant-fiber spike is a jump; walking speed follows the surge-and-cast program of Álvarez-Salvado et al. 2018. Click the arena to choose where to put food.</p>
          </div>
          <div className="grid2">
            <div className="cell">
              <div className="cell-t"><span className="a">a</span><span className="n">World</span><span className="r">{h ? `(${h.x.toFixed(1)}, ${h.y.toFixed(1)}) · ${Math.round(((h.heading * 180) / Math.PI + 360) % 360)}°` : ""}</span></div>
              <div className="cell-b b-arena"><canvas ref={arenaRef} className="walk-c" onClick={arenaClick} aria-label="Top-down view of the arena with food, fly and predator" /></div>
              <div className="cell-cap"><span><i style={{ "--c": "#f0b429" } as any} />food + plume</span><span><i style={{ "--c": "#ff5a35" } as any} />fly</span><span><i style={{ "--c": "#58c4f5" } as any} />predator</span><span style={{ marginLeft: "auto" }}>{pick ? `chosen: (${pick.x}, ${pick.y})` : "click to choose a food spot"}</span></div>
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
            <p>Food is a BNB Chain transaction: burn $FLY, choose a spot, and a plume of odor appears in the arena at the next chain poll. One $FLY buys one second of life, but only if the fly smells its way there before it starves. Everything it has ever been given, and every checkpoint of its brain, is in the record below.</p>
          </div>
          <div className="care-grid">
            <div className="care-col">
              <div className="care-t"><h3>Place food</h3><span className="cost">{info ? `min ${fmtTok(info.minFood)} $FLY · 1 $FLY = 1 s` : "1 $FLY = 1 s"}</span></div>
              <p>{pick ? `Spot chosen at (${pick.x}, ${pick.y}).` : "Click a spot in Figure 2a."} The plume reaches about 60 body lengths; the fly walks 3 to 4 per second.</p>
              <div className="field"><input type="number" min={60} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount of FLY" /><button className="btn fill" disabled={busy || !pick} onClick={placeFood}>{busy ? "…" : "Place food"}</button></div>
              <div className="lbl">= {Number(amount) ? hms(Number(amount)) : "—"} of life if eaten</div>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>{alive ? "Your wallet" : "Resurrect"}</h3><span className="cost">{alive ? (info ? `gen ${info.generation}` : "") : info ? `${fmtTok(info.resPrice)} $FLY + food` : ""}</span></div>
              {alive ? (<>
                <p>Every placement is stored against the address that paid for it. The arena contract has no owner functions beyond the operator&apos;s checkpoints.</p>
                {wallet ? <div className="field"><span className="btn sm" style={{ flex: 1, justifyContent: "space-between", cursor: "default" }}><span className="mono">{short(wallet)}</span><span className="mono dim">{bal}</span></span></div> : <button className="btn" onClick={connect}>Connect wallet</button>}
                <a className="btn sm plain" href={`${CFG.explorer}/address/${CFG.world}`} target="_blank" rel="noopener">FlyWorld on BscScan →</a>
              </>) : (<>
                <p>Energy reached zero. The brain was frozen and its hash written on-chain. Burn $FLY to wake the same brain in a new body.</p>
                <div className="field"><input type="number" min={0} value={resFood} onChange={(e) => setResFood(e.target.value)} aria-label="Extra food" /><button className="btn fill" disabled={busy} onClick={resurrect}>Resurrect</button></div>
              </>)}
            </div>
            <div className="care-col">
              <div className="care-t"><h3>Verify it</h3><span className="cost">{h?.chain?.last_hash ? h.chain.last_hash.slice(0, 10) + "…" : ""}</span></div>
              <p>Each checkpoint names a snapshot of every membrane potential and synaptic current. Download it, run the published model with the same seed, and you get the next checkpoint&apos;s hash.</p>
              <a className="btn sm" href={`${origin}/snapshots/`} target="_blank" rel="noopener">Snapshots ↗</a>
              <a className="btn sm plain" href={CFG.links.github + "/tree/main/brain"} target="_blank" rel="noopener">Simulator source →</a>
            </div>
          </div>
          <div style={{ marginTop: 40 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Record</b><span className="lbl">food, checkpoints, deaths, resurrections · newest first</span></div>
            <div className="log-list">{events.length ? events.map(evRow) : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">reading BNB Smart Chain…</span><span /></div>}</div>
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
