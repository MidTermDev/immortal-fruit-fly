"use client";
import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import circuitData from "@/data/circuit.json";
import tableData from "@/data/table.json";
import params from "@/data/params.json";
import { CFG } from "@/lib/config";
import { Circuit, FlySim, CH, COS16, SIN16, WEDGES } from "@/lib/flysim";
import { Chain } from "@/lib/chain";
import { Brain3D } from "@/lib/brain3d";

const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };
const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

type Ev = { name: string; args: any; block: number; tx: string };
type Lin = { generation: number; bornBlock: number; diedBlock: number; steps: number; spikes: number; hash: string };

const RASTER_W = 200;           // steps of history shown
const ROW_COLORS = ["#f0b429", "#f0b429", "#d9922a", "#ff4a26", "#ff7a52", "#58c4f5"];

export default function Fly() {
  const heroRef = useRef<HTMLCanvasElement>(null);
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const dialRef = useRef<HTMLCanvasElement>(null);
  const walkRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<FlySim | null>(null);
  const chainRef = useRef<Chain | null>(null);
  const modeRef = useRef<"chain" | "preview">("preview");
  const csRef = useRef<any>(null);
  const trailRef = useRef<[number, number][]>([]);
  const wedgeAct = useRef(new Array(WEDGES).fill(0));
  const head = useRef({ a: 0, m: 0 });
  const raster = useRef<number[][]>([]);
  const [ui, setUi] = useState<any>({ alive: true, mode: "preview", step: 0, energy: 0, spikes: 0, gen: 0, px: 0, py: 0, heading: 0, rate: 0, stim: "none", burned: "—", block: 0, lives: 1, energyMax: 1e6 });
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [lineage, setLineage] = useState<Lin[]>([]);
  const [toast, setT] = useState<string | null>(null);
  const [strength, setStrength] = useState(4);
  const [wedge, setWedge] = useState(4);
  const [feedAmt, setFeedAmt] = useState("1000");
  const [resFood, setResFood] = useState("10000");
  const [prices, setPrices] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const tt = useRef<any>(null);
  const setToast = (m: string, ms = 4500) => { setT(m); clearTimeout(tt.current); tt.current = setTimeout(() => setT(null), ms); };

  useEffect(() => {
    const circuit = new Circuit((tableData as any).table);
    const sim = new FlySim(circuit, params as any); simRef.current = sim;

    // raster row order: compass by wedge, then sustain, rotate, inhibit — so the bump reads as a band
    const order = [...Array(circuit.N).keys()].sort((a, b) => {
      const ga = circuit.type[a] <= 1 ? 0 : circuit.type[a] === 2 ? 1 : circuit.type[a] <= 4 ? 2 : 3;
      const gb = circuit.type[b] <= 1 ? 0 : circuit.type[b] === 2 ? 1 : circuit.type[b] <= 4 ? 2 : 3;
      if (ga !== gb) return ga - gb;
      const wa = circuit.wedge[a] === 255 ? 99 : circuit.wedge[a], wb = circuit.wedge[b] === 255 ? 99 : circuit.wedge[b];
      if (wa !== wb) return wa - wb;
      return circuit.side[a] - circuit.side[b];
    });
    const row = new Array(circuit.N).fill(0); order.forEach((n, i) => (row[n] = i));
    const groupEnds = [0, 0, 0, 0];
    order.forEach((n, i) => { const g = circuit.type[n] <= 1 ? 0 : circuit.type[n] === 2 ? 1 : circuit.type[n] <= 4 ? 2 : 3; groupEnds[g] = i; });

    let brain: Brain3D | null = null, raf = 0, running = true;
    const pushTrail = () => { const x = sim.posX / 256, y = sim.posY / 256, t = trailRef.current, l = t[t.length - 1]; if (!l || l[0] !== x || l[1] !== y) { t.push([x, y]); if (t.length > 4000) t.shift(); } };

    sim.onStep = (spikes) => {
      if (brain) brain.spike(spikes);
      raster.current.push(spikes.map((i) => row[i] * 8 + (circuit.type[i] <= 1 ? 0 : circuit.type[i] === 2 ? 1 : circuit.type[i] <= 4 ? 2 : 3)));
      if (raster.current.length > RASTER_W) raster.current.shift();
      let hx = 0, hy = 0;
      for (const i of spikes) { const w = circuit.wedge[i]; if (circuit.type[i] <= 1 && w !== 255) { wedgeAct.current[w] = Math.min(3, wedgeAct.current[w] + 1); hx += COS16[w]; hy += SIN16[w]; } }
      if (hx || hy) { head.current.a = Math.atan2(hy, hx); head.current.m = Math.min(1, Math.hypot(hx, hy) / 400); }
    };

    const fit = (c: HTMLCanvasElement, h?: number) => {
      const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round((h ?? r.height) * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      return { W, H, dpr };
    };

    const drawRaster = () => {
      const c = rasterRef.current; if (!c) return; const g = c.getContext("2d")!;
      const { W, H, dpr } = fit(c); const padL = 66 * dpr, padB = 17 * dpr;
      g.clearRect(0, 0, W, H);
      const plotW = W - padL, plotH = H - padB, rowH = plotH / circuit.N, colW = plotW / RASTER_W;
      // group bands + labels
      const bands = [["COMPASS", 0], ["SUSTAIN", 1], ["ROTATE", 2], ["INHIBIT", 3]] as const;
      let prev = -1;
      g.font = `${Math.round(8.5 * dpr)}px ui-monospace, monospace`; g.textBaseline = "middle";
      for (const [name, gi] of bands) {
        const y0 = (prev + 1) * rowH, y1 = (groupEnds[gi] + 1) * rowH;
        if (gi % 2 === 1) { g.fillStyle = "rgba(236,234,228,0.022)"; g.fillRect(padL, y0, plotW, y1 - y0); }
        g.fillStyle = "rgba(236,234,228,0.34)"; g.textAlign = "right";
        g.fillText(name, padL - 11 * dpr, (y0 + y1) / 2);
        g.strokeStyle = "rgba(236,234,228,0.07)"; g.beginPath(); g.moveTo(padL, y1); g.lineTo(W, y1); g.stroke();
        prev = groupEnds[gi];
      }
      // spikes
      const cols = raster.current, n = cols.length, x0 = padL + plotW - n * colW;
      const dotH = Math.max(1.2 * dpr, rowH * 0.92), dotW = Math.max(1.2 * dpr, colW * 0.9);
      for (let k = 0; k < n; k++) {
        const x = x0 + k * colW, fade = 0.35 + 0.65 * (k / Math.max(1, n - 1));
        for (const packed of cols[k]) {
          const r = packed >> 3, t = packed & 7;
          g.fillStyle = ROW_COLORS[t === 0 ? 0 : t === 1 ? 2 : t === 2 ? 3 : 5];
          g.globalAlpha = fade; g.fillRect(x, r * rowH, dotW, dotH);
        }
      }
      g.globalAlpha = 1;
      // time axis
      g.fillStyle = "rgba(236,234,228,0.28)"; g.textAlign = "left"; g.textBaseline = "top";
      g.fillText(`−${RASTER_W} steps`, padL, H - padB + 3 * dpr);
      g.textAlign = "right"; g.fillText("now", W, H - padB + 3 * dpr);
      g.strokeStyle = "rgba(255,74,38,0.5)"; g.beginPath(); g.moveTo(W - 0.5 * dpr, 0); g.lineTo(W - 0.5 * dpr, plotH); g.stroke();
    };

    const drawDial = () => {
      const c = dialRef.current; if (!c) return; const g = c.getContext("2d")!;
      const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      const css = Math.max(1, Math.floor(Math.min(r.width, r.height)));
      if (c.style.width !== css + "px") { c.style.width = css + "px"; c.style.height = css + "px"; }
      const S = Math.max(1, Math.round(css * dpr));
      if (c.width !== S || c.height !== S) { c.width = S; c.height = S; }
      const cx = S / 2, R = S * 0.40, r0 = S * 0.245; g.clearRect(0, 0, S, S);
      const hm = Math.max(1, ...sim.hist);
      for (let w = 0; w < WEDGES; w++) {
        const a0 = (w * 2 * Math.PI) / WEDGES, a1 = a0 + (2 * Math.PI) / WEDGES - 0.028, act = Math.min(1, wedgeAct.current[w] / 2);
        g.beginPath(); g.arc(cx, cx, R, -a1, -a0, false); g.arc(cx, cx, r0, -a0, -a1, true); g.closePath();
        g.fillStyle = `rgba(240,180,41,${0.05 + act * 0.85})`; g.fill();
        if (act > 0.55) { g.fillStyle = `rgba(255,74,38,${(act - 0.55) * 1.5})`; g.fill(); }
        g.beginPath(); g.arc(cx, cx, R + S * 0.036, -a1, -a0, false); g.arc(cx, cx, R + S * 0.014, -a0, -a1, true); g.closePath();
        g.fillStyle = `rgba(88,196,245,${0.07 + 0.62 * ((sim.hist[w] || 0) / hm)})`; g.fill();
      }
      g.save(); g.translate(cx, cx); g.rotate(-head.current.a);
      g.beginPath(); g.moveTo(0, -S * 0.011); g.lineTo(r0 * (0.35 + 0.65 * head.current.m), 0); g.lineTo(0, S * 0.011); g.closePath();
      g.fillStyle = "#eceae4"; g.fill(); g.restore();
      g.beginPath(); g.arc(cx, cx, S * 0.016, 0, 7); g.fillStyle = "#ff4a26"; g.fill();
      g.fillStyle = "rgba(236,234,228,0.42)"; g.font = `${Math.round(S * 0.038)}px ui-monospace, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
      for (let w = 0; w < WEDGES; w += 4) { const a = ((w + 0.5) * 2 * Math.PI) / WEDGES; g.fillText(String(w), cx + Math.cos(a) * S * 0.465, cx - Math.sin(a) * S * 0.465); }
    };

    const drawWalk = () => {
      const c = walkRef.current; if (!c) return; const g = c.getContext("2d")!; const { W, H, dpr } = fit(c);
      g.clearRect(0, 0, W, H);
      const pts = trailRef.current.length ? trailRef.current : ([[0, 0]] as [number, number][]);
      let mnx = 0, mxx = 0, mny = 0, mxy = 0;
      for (const [x, y] of pts) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
      const span = Math.max(6, mxx - mnx, mxy - mny) * 1.2, sc = Math.min(W, H) / span, cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
      const P = ([x, y]: [number, number]) => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];
      g.strokeStyle = "rgba(236,234,228,0.055)"; g.lineWidth = 1;
      const gr = Math.pow(10, Math.floor(Math.log10(span / 4)));
      for (let x = Math.floor((cx - span) / gr) * gr; x < cx + span; x += gr) { const [px] = P([x, 0]); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); }
      for (let y = Math.floor((cy - span) / gr) * gr; y < cy + span; y += gr) { const [, py] = P([0, y]); g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke(); }
      const [ox, oy] = P([0, 0]); g.strokeStyle = "rgba(236,234,228,0.22)"; g.beginPath(); g.arc(ox, oy, 3 * dpr, 0, 7); g.stroke();
      g.strokeStyle = "rgba(240,180,41,0.9)"; g.lineWidth = Math.max(1.2, W / 420); g.lineJoin = "round";
      g.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      const [ex, ey] = P(pts[pts.length - 1]);
      g.save(); g.translate(ex, ey); g.rotate(-head.current.a); g.fillStyle = "#ff4a26";
      g.beginPath(); g.moveTo(W / 52, 0); g.lineTo(-W / 84, W / 110); g.lineTo(-W / 84, -W / 110); g.closePath(); g.fill(); g.restore();
      g.fillStyle = "rgba(236,234,228,0.3)"; g.font = `${Math.round(9.5 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText(`grid ${gr} cell${gr === 1 ? "" : "s"} · origin ○`, 9 * dpr, H - 8 * dpr);
    };

    let rateBuf: number[] = [];
    const render = () => {
      const cs = csRef.current, src = modeRef.current === "chain" && cs ? cs : sim;
      const stimOn = sim.stimChannel && sim.step < sim.stimUntil;
      const names = ["none", "cue", "turn left", "turn right", "shock"];
      setUi((u: any) => ({ ...u, alive: sim.alive, mode: modeRef.current, step: src.step, energy: src.energy,
        spikes: modeRef.current === "chain" ? cs.totalSpikes : sim.totalSpikes, gen: src.generation,
        px: src.posX / 256, py: src.posY / 256, heading: Math.round(((head.current.a * 180) / Math.PI + 360) % 360),
        rate: rateBuf.length ? rateBuf.reduce((a, b) => a + b, 0) / rateBuf.length : 0,
        stim: stimOn ? `${names[sim.stimChannel]}${sim.stimChannel === 1 ? " @" + sim.stimParam : ""} ×${sim.stimStrength}` : "none",
        burned: cs ? fmtTok(cs.totalBurned) : "—", block: cs ? cs.block : 0, lives: cs ? cs.lineageLength + 1 : 1,
        energyMax: Math.max(u.energyMax, src.energy) }));
    };

    // The bump decays without input, so the local continuation gives the fly a landmark
    // whenever it falls silent — the same CUE channel a caretaker sends on-chain.
    let quiet = 0, cueW = 4;
    const stepOnce = () => {
      sim.tick(1); pushTrail();
      const col = raster.current[raster.current.length - 1];
      if (!col || col.length === 0) quiet++; else quiet = 0;
      if (quiet > 22 && sim.alive) { cueW = (cueW + 3) % WEDGES; sim.stimulate(CH.CUE, cueW, 4); quiet = 0; }
    };

    let last = performance.now(), acc = 0;
    const loop = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt * CFG.previewStepsPerSecond; let n = 0;
      while (acc >= 1 && n < 4) { acc -= 1; n++; if (sim.alive) stepOnce(); }
      if (n) { const c = raster.current[raster.current.length - 1]; rateBuf.push(c ? c.length : 0); if (rateBuf.length > 40) rateBuf.shift(); }
      const dec = Math.exp(-dt * 3); for (let w = 0; w < WEDGES; w++) wedgeAct.current[w] *= dec;
      head.current.m *= Math.exp(-dt * 0.5);
      if (brain) brain.frame(dt);
      drawRaster(); drawDial(); drawWalk(); if (n) render();
      raf = requestAnimationFrame(loop);
    };

    const applyChain = (s: any) => { sim.loadState(s); sim.totalSpikes = 0; csRef.current = s; trailRef.current.length = 0; pushTrail(); };
    const loadEvents = async () => {
      const ch = chainRef.current!; const evs = await ch.recentEvents(40000); setEvents(evs.slice(0, 50));
      const ticks = evs.filter((e) => e.name === "Ticked").reverse();
      if (ticks.length) { trailRef.current.length = 0; for (const t of ticks) trailRef.current.push([Number(t.args.posX) / 256, Number(t.args.posY) / 256]); pushTrail(); }
      const cs = csRef.current; if (cs?.lineageLength) setLineage(await ch.readLineage(cs.lineageLength));
    };
    const syncChain = async () => {
      try {
        const ch = chainRef.current!, s = await ch.readState(), cs = csRef.current;
        if (!cs || s.step !== cs.step || s.generation !== cs.generation || s.alive !== cs.alive || s.energy > cs.energy) {
          if (cs && s.step !== cs.step) setToast(`On-chain tick: step ${fmt(cs.step)} → ${fmt(s.step)}`, 2600);
          applyChain(s); loadEvents().catch(() => {});
        } else { cs.block = s.block; cs.totalBurned = s.totalBurned; }
        render();
      } catch (e) { console.warn("sync failed", e); }
    };
    (window as any).__fly = { sim, syncChain, pushTrail, render };

    (async () => {
      try { const buf = await (await fetch(`${CFG.basePath}/assets/brain_points.bin`)).arrayBuffer(); if (heroRef.current) brain = new Brain3D(heroRef.current, buf, (circuitData as any).neurons, { camY: 0.0, yOffset: 0.2, dist: 1.66, sway: true }); }
      catch (e) { console.warn("WebGL unavailable", e); }
      if (CFG.brain) {
        try { const ch = await new Chain().connectRead(); chainRef.current = ch; const s = await ch.readState(); modeRef.current = "chain"; applyChain(s); setPrices(ch.prices); loadEvents().catch(() => {}); (window as any).__flyInt = setInterval(syncChain, 5000); }
        catch (e) { console.warn("chain unreachable, preview", e); modeRef.current = "preview"; }
      }
      if (modeRef.current === "preview") { sim.energy = 1e7; sim.stimulate(CH.CUE, 4, 4); }
      for (let i = 0; i < RASTER_W && sim.alive; i++) stepOnce();   // fill the raster's history window
      render(); raf = requestAnimationFrame(loop);
    })();
    return () => { running = false; cancelAnimationFrame(raf); clearInterval((window as any).__flyInt); if (brain) brain.dispose(); };
  }, []);

  const act = async (kind: string, fn: () => Promise<any>, preview: () => void) => {
    const f = (window as any).__fly;
    if (modeRef.current === "preview") { preview(); setToast(`Preview: ${kind} applied to the local copy of the brain.`); f.render(); return; }
    if (!wallet) { setToast("Connect a wallet to act on the live fly."); return; }
    setBusy(kind);
    try { setToast(`${kind}: confirm in your wallet…`, 90000); const rc = await fn(); setToast(`${kind} confirmed in block ${fmt(rc.blockNumber)}.`); await f.syncChain(); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); }
    catch (e: any) { console.error(e); setToast(`${kind} failed: ${e.shortMessage || e.reason || e.message}`, 8000); }
    finally { setBusy(null); }
  };
  const sim = () => simRef.current!;
  const connect = async () => {
    if (modeRef.current !== "chain") return setToast("Not connected to BNB Chain right now (preview mode).");
    try { const a = await chainRef.current!.connectWallet(); setWallet(a); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); setToast(`Connected ${short(a)}`); }
    catch (e: any) { setToast(e.shortMessage || e.message, 6000); }
  };
  const dialClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2, y = -(e.clientY - r.top - r.height / 2);
    setWedge(((Math.floor(Math.atan2(y, x) / ((2 * Math.PI) / WEDGES)) % WEDGES) + WEDGES) % WEDGES);
  };
  const stimCost = prices ? fmtTok(prices.stimPrice * BigInt(strength)) : String(100 * strength);
  const poke = (label: string, ch: number, param: number, cls: string, hint: string) => (
    <button className={`poke ${cls}`} disabled={!!busy} onClick={() => act(label, () => chainRef.current!.stimulate(ch, param, strength, 16), () => sim().stimulate(ch, param, strength))}>
      <b>{label}</b><small>{hint}</small>
    </button>
  );
  const evRow = (e: Ev, i: number) => {
    const a = e.args, names = ["none", "cue", "turn left", "turn right", "shock"];
    let tag = "tick", txt: React.ReactNode = e.name;
    if (e.name === "Ticked") { tag = "tick"; txt = <>ran <b>{a.steps} steps</b> · {fmt(a.spikes)} spikes</>; }
    else if (e.name === "Fed") { tag = "feed"; txt = <>fed <b>{fmtTok(a.tokensBurned)} FLY</b> · +{fmt(a.energyAdded)} steps of life</>; }
    else if (e.name === "Stimulated") { tag = "stim"; txt = <><b>{names[Number(a.channel)]}{Number(a.channel) === 1 ? ` @ wedge ${a.param}` : ""}</b> ×{a.strength} · {fmtTok(a.tokensBurned)} FLY</>; }
    else if (e.name === "Died") { tag = "life"; txt = <><b>died</b> · generation {String(a.generation)} lived {fmt(a.lifeSteps)} steps</>; }
    else if (e.name === "Resurrected") { tag = "life"; txt = <><b>resurrected</b> · generation {String(a.generation)}</>; }
    return (<div className="feed-row" key={e.tx + i}>
      <a className="blk mono" href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">#{e.block}</a>
      <span className="ev"><span className={`tag ${tag}`}>{tag}</span>{txt}</span>
      <span className="who">{short(a.by)}</span>
    </div>);
  };

  return (
    <>
      <section className="hero" id="top">
        <canvas ref={heroRef} aria-label="The fruit fly brain: 44,716 of its 139,248 neurons, with the 155 on-chain cells lit as they spike" />
        <div className="hero-hint"><i /><span className="lbl">100&#8202;<span style={{ textTransform: "none" }}>µm</span> · drag to rotate</span></div>
        <div className="hero-tag"><span className={`dot${ui.alive ? "" : " dead"}${ui.mode === "chain" ? "" : " sim"}`} /><span className="lbl">{ui.mode === "chain" ? "live on BNB Smart Chain" : "local preview"} · FlyWire 783</span></div>
        <div className="hero-copy wrap">
          <h1>The fly brain <em>lives on-chain.</em></h1>
          <p className="hero-sub">155 real neurons from a fruit fly&apos;s compass circuit, spiking inside a smart contract. It walks. It remembers. When it starves, the brain is frozen on-chain and can be woken again.</p>
          <div className="hero-cta">
            <a className="btn solid" href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener">Buy $FLY</a>
            <a className="btn" href="#monitor">Watch it think</a>
            <a className="btn quiet" href="/docs/vision/">The vision →</a>
          </div>
        </div>
      </section>

      <div className="vitals">
        <div className="wrap">
          {[["step", fmt(ui.step)], ["energy left", compact(ui.energy)], ["spikes", compact(ui.spikes)], ["firing", ui.rate.toFixed(1) + "/step"],
            ["heading", ui.heading + "°"], ["position", `${ui.px.toFixed(1)}, ${ui.py.toFixed(1)}`], ["$FLY eaten", ui.burned]].map(([k, v]) => (
            <div className="vital" key={k as string}><span className="lbl">{k}</span><span className="v">{v}</span></div>))}
        </div>
      </div>

      <section className="wrap monitor" id="monitor">
        <div className="mon-head">
          <h2>Live neural monitor</h2>
          <p>Every dot is one real neuron firing. Read left to right in time, top to bottom by role.</p>
        </div>
        <div className="rack">
          <div className="instr">
            <div className="instr-head"><span className="dot" /><span className="t">Spike raster · 155 neurons</span><span className="r mono">{ui.rate.toFixed(1)} spikes/step</span></div>
            <div className="instr-body fill"><canvas ref={rasterRef} className="raster-c" aria-label="Spike raster: rows are neurons grouped by role, columns are simulation steps" /></div>
            <div className="key">
              <span><i style={{ "--c": "#f0b429" } as any} />EPG compass</span>
              <span><i style={{ "--c": "#d9922a" } as any} />PEG sustain</span>
              <span><i style={{ "--c": "#ff4a26" } as any} />PEN rotate</span>
              <span><i style={{ "--c": "#58c4f5" } as any} />Δ7 inhibit</span>
              <span style={{ marginLeft: "auto" }}>{ui.mode === "chain" ? "continuing from the last on-chain state" : "local simulation"}</span>
            </div>
          </div>
          <div className="side">
            <div className="instr">
              <div className="instr-head"><span className="t">Compass · ellipsoid body</span><span className="r mono">{ui.heading}°</span></div>
              <div className="instr-body"><div className="dial-box"><canvas ref={dialRef} className="compass-c" onClick={dialClick} aria-label="Sixteen-wedge compass showing the head-direction bump" /></div></div>
              <div className="key"><span>click a wedge to aim a cue</span><span style={{ marginLeft: "auto" }}><i style={{ "--c": "#58c4f5" } as any} />outer ring = memory</span></div>
            </div>
            <div className="instr">
              <div className="instr-head"><span className="t">Walk · on-chain world</span><span className="r mono">{ui.px.toFixed(1)}, {ui.py.toFixed(1)}</span></div>
              <div className="instr-body walk"><canvas ref={walkRef} className="walk-c" aria-label="Map of the path the fly has walked" /></div>
            </div>
          </div>
        </div>

        <div className="controls">
          {ui.mode === "preview" && <div className="banner"><span>◐</span><span>Preview: this page can&apos;t reach BNB Chain right now, so it is running the same circuit locally. Your actions won&apos;t touch the live fly.</span></div>}
          <div className="ctl-row">
            <div className="ctl">
              <div className="ctl-t"><h3>Feed</h3><span className="cost">{prices ? `${fmtTok(prices.tokensPerStep)} FLY = 1 step` : "1 FLY = 1 step"}</span></div>
              <p>The fly burns one unit of energy per simulation step. $FLY you feed it goes to the dead address, forever.</p>
              <div className="field">
                <input type="number" min={1} value={feedAmt} onChange={(e) => setFeedAmt(e.target.value)} aria-label="Amount of FLY to feed" />
                <button className="btn amber" disabled={!!busy} onClick={() => { const a = Number(feedAmt) || 0; if (a <= 0) return setToast("Enter an amount of $FLY."); act("Feed", () => chainRef.current!.feed(ethers.parseEther(String(a))), () => { sim().energy += Math.floor(a); }); }}>{busy === "Feed" ? "…" : "Feed"}</button>
              </div>
              <button className="btn sm" disabled={!!busy} onClick={() => act("Tick 32", () => chainRef.current!.tick(32), () => { sim().tick(32); (window as any).__fly.pushTrail(); })}>Run 32 steps · gas only</button>
            </div>
            <div className="ctl">
              <div className="ctl-t"><h3>Stimulate real neurons</h3><span className="cost">{stimCost} FLY</span></div>
              <div className="slider"><label htmlFor="strength">strength</label><input id="strength" type="range" min={1} max={16} value={strength} onChange={(e) => setStrength(+e.target.value)} /><output>{strength}</output></div>
              <div className="slider"><label htmlFor="cuewedge">cue wedge</label><input id="cuewedge" type="range" min={0} max={15} value={wedge} onChange={(e) => setWedge(+e.target.value)} /><output>{wedge}</output></div>
              <div className="pokes">
                {poke("Flash cue", CH.CUE, wedge, "cue", `EPG @ wedge ${wedge}`)}
                {poke("Shock", CH.SHOCK, 0, "shock", "all 42 Δ7 cells")}
                {poke("Turn left", CH.TURN_LEFT, 0, "turn", "left PEN cells")}
                {poke("Turn right", CH.TURN_RIGHT, 0, "turn", "right PEN cells")}
              </div>
            </div>
            <div className="ctl">
              <div className="ctl-t"><h3>{ui.alive ? "Your wallet" : "Resurrect"}</h3><span className="cost">{ui.alive ? `gen ${ui.gen} · life ${ui.lives}` : prices ? `${fmtTok(prices.resurrectPrice)} FLY + food` : "100,000 FLY"}</span></div>
              {ui.alive ? (<>
                <p>Anyone can keep the brain running. Feeding and poking burn $FLY and are recorded forever as acts of care.</p>
                {wallet ? <div className="field"><span className="btn sm" style={{ flex: 1, justifyContent: "space-between" }}><span className="mono">{short(wallet)}</span><span className="mono dim">{bal}</span></span></div>
                        : <button className="btn" onClick={connect}>Connect wallet</button>}
                <a className="btn sm quiet" href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener">FlyBrain on BscScan ↗</a>
              </>) : (<>
                <p>Energy hit zero. The brain is frozen exactly as it was. Bring it back in a new body.</p>
                <div className="field">
                  <input type="number" min={0} value={resFood} onChange={(e) => setResFood(e.target.value)} aria-label="Extra food" />
                  <button className="btn solid" disabled={!!busy} onClick={() => { const x = Number(resFood) || 0; act("Resurrect", () => chainRef.current!.resurrect(ethers.parseEther(String(x))), () => { const s = sim(); s.alive = true; s.generation++; s.energy = x; s.posX = 0; s.posY = 0; trailRef.current.length = 0; }); }}>Resurrect</button>
                </div>
              </>)}
            </div>
          </div>
        </div>

        <div className="feed">
          <div className="feed-head"><span className="lbl">Interaction history</span><span className="lbl" style={{ marginLeft: "auto" }}>{ui.block ? `block ${fmt(ui.block)}` : ""}</span></div>
          <div className="feed-list">
            {events.length ? events.map(evRow) : <div className="feed-row"><span className="blk">—</span><span className="ev">{ui.mode === "chain" ? "no interactions in the last 40,000 blocks" : "connecting to BNB Chain…"}</span><span /></div>}
          </div>
        </div>

        {lineage.length > 0 && (
          <div className="feed" style={{ marginTop: 14 }}>
            <div className="feed-head"><span className="lbl">Lineage · {lineage.length} {lineage.length === 1 ? "death" : "deaths"}</span></div>
            <div style={{ padding: "4px 16px 10px" }}>
              <table className="data"><thead><tr><th>Gen</th><th>Born</th><th>Died</th><th>Steps lived</th><th>Spikes</th><th>Brain hash at death</th></tr></thead>
                <tbody>{lineage.map((l) => <tr key={l.generation}><td className="mono">{l.generation}</td><td className="mono">{fmt(l.bornBlock)}</td><td className="mono">{fmt(l.diedBlock)}</td><td className="mono">{fmt(l.steps)}</td><td className="mono">{fmt(l.spikes)}</td><td className="mono">{l.hash.slice(0, 20)}…</td></tr>)}</tbody></table>
            </div>
          </div>)}
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
