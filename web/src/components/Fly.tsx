"use client";
import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import circuitData from "@/data/circuit.json";
import tableData from "@/data/table.json";
import params from "@/data/params.json";
import { CFG } from "@/lib/config";
import { Circuit, FlySim, CH, CH_NAMES, COS16, SIN16, WEDGES, TYPE_NAMES } from "@/lib/flysim";
import { Chain } from "@/lib/chain";
import { Brain3D } from "@/lib/brain3d";

const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
const short = (a: string | null | undefined) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };

type Ev = { name: string; args: any; block: number; tx: string };
type Lin = { generation: number; bornBlock: number; diedBlock: number; steps: number; spikes: number; hash: string };

export default function Fly() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialRef = useRef<HTMLCanvasElement>(null);
  const walkRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<FlySim | null>(null);
  const chainRef = useRef<Chain | null>(null);
  const modeRef = useRef<"chain" | "preview">("preview");
  const chainStateRef = useRef<any>(null);
  const trailRef = useRef<[number, number][]>([]);
  const wedgeAct = useRef(new Array(WEDGES).fill(0));
  const head = useRef({ a: 0, m: 0 });
  const [ui, setUi] = useState<any>({ alive: true, mode: "preview", step: 0, energy: 0, spikes: 0, gen: 0, pos: "0, 0", heading: 0, stim: "none", burned: "—", block: "—", lives: 1, energyMax: 1000000 });
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState<string>("");
  const [events, setEvents] = useState<Ev[]>([]);
  const [lineage, setLineage] = useState<Lin[]>([]);
  const [toast, setToastState] = useState<string | null>(null);
  const [strength, setStrength] = useState(4);
  const [wedge, setWedge] = useState(4);
  const [feedAmt, setFeedAmt] = useState("1000");
  const [resFood, setResFood] = useState("10000");
  const [prices, setPrices] = useState<any>(null);
  const toastTimer = useRef<any>(null);
  const setToast = (m: string, ms = 4200) => { setToastState(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastState(null), ms); };

  useEffect(() => {
    const circuit = new Circuit((tableData as any).table);
    const sim = new FlySim(circuit, params as any); simRef.current = sim;
    let brain: Brain3D | null = null; let raf = 0; let alive = true;
    const pushTrail = () => { const x = sim.posX / 256, y = sim.posY / 256; const t = trailRef.current; const l = t[t.length - 1]; if (!l || l[0] !== x || l[1] !== y) { t.push([x, y]); if (t.length > 4000) t.shift(); } };
    sim.onStep = (spikes) => {
      if (brain) brain.spike(spikes);
      let hx = 0, hy = 0;
      for (const i of spikes) { const w = circuit.wedge[i]; if (circuit.type[i] <= 1 && w !== 255) { wedgeAct.current[w] = Math.min(3, wedgeAct.current[w] + 1); hx += COS16[w]; hy += SIN16[w]; } }
      if (hx || hy) { head.current.a = Math.atan2(hy, hx); head.current.m = Math.min(1, Math.hypot(hx, hy) / 400); }
    };
    const render = () => {
      const cs = chainStateRef.current; const src = modeRef.current === "chain" && cs ? cs : sim;
      const stimOn = sim.stimChannel && sim.step < sim.stimUntil;
      setUi((u: any) => ({ ...u, alive: sim.alive, mode: modeRef.current, step: src.step, energy: src.energy, spikes: modeRef.current === "chain" ? cs.totalSpikes : sim.totalSpikes, gen: src.generation,
        pos: `${(src.posX / 256).toFixed(1)}, ${(src.posY / 256).toFixed(1)}`, heading: Math.round(((head.current.a * 180) / Math.PI + 360) % 360),
        stim: stimOn ? `${CH_NAMES[sim.stimChannel]}${sim.stimChannel === 1 ? " @" + sim.stimParam : ""} ×${sim.stimStrength}` : "none",
        burned: cs ? fmtTok(cs.totalBurned) : "—", block: cs ? fmt(cs.block) : "—", lives: cs ? cs.lineageLength + 1 : 1, energyMax: Math.max(u.energyMax, src.energy) }));
    };
    const drawCompass = () => {
      const dial = dialRef.current; if (!dial) return; const ctx = dial.getContext("2d")!; const r = dial.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2);
      if (dial.width !== Math.round(r.width * dpr)) { dial.width = Math.round(r.width * dpr); dial.height = Math.round(r.width * dpr); }
      const S = dial.width, c = S / 2, R = S * 0.44, r0 = S * 0.27; ctx.clearRect(0, 0, S, S);
      const hm = Math.max(1, ...sim.hist);
      for (let w = 0; w < WEDGES; w++) {
        const a0 = (w * 2 * Math.PI) / WEDGES, a1 = a0 + (2 * Math.PI) / WEDGES - 0.02, act = Math.min(1, wedgeAct.current[w] / 2);
        ctx.beginPath(); ctx.arc(c, c, R, -a1, -a0, false); ctx.arc(c, c, r0, -a0, -a1, true); ctx.closePath(); ctx.fillStyle = `rgba(245,184,64,${0.06 + act * 0.9})`; ctx.fill();
        if (act > 0.6) { ctx.fillStyle = `rgba(255,77,46,${(act - 0.6) * 1.6})`; ctx.fill(); }
        ctx.beginPath(); ctx.arc(c, c, R + S * 0.03, -a1, -a0, false); ctx.arc(c, c, R + S * 0.012, -a0, -a1, true); ctx.closePath(); ctx.fillStyle = `rgba(79,195,247,${0.08 + 0.7 * ((sim.hist[w] || 0) / hm)})`; ctx.fill();
      }
      ctx.save(); ctx.translate(c, c); ctx.rotate(-head.current.a); ctx.beginPath(); ctx.moveTo(0, -S * 0.012); ctx.lineTo(r0 * (0.4 + 0.6 * head.current.m), 0); ctx.lineTo(0, S * 0.012); ctx.closePath(); ctx.fillStyle = "#e8e4da"; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.arc(c, c, S * 0.018, 0, 7); ctx.fillStyle = "#ff4d2e"; ctx.fill();
      ctx.fillStyle = "rgba(232,228,218,0.55)"; ctx.font = `${Math.round(S * 0.032)}px JetBrains Mono, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let w = 0; w < WEDGES; w += 4) { const a = ((w + 0.5) * 2 * Math.PI) / WEDGES; ctx.fillText(String(w), c + Math.cos(a) * S * 0.485, c - Math.sin(a) * S * 0.485); }
    };
    const drawWalk = () => {
      const walk = walkRef.current; if (!walk) return; const ctx = walk.getContext("2d")!; const r = walk.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2);
      if (walk.width !== Math.round(r.width * dpr)) { walk.width = Math.round(r.width * dpr); walk.height = Math.round(r.height * dpr); }
      const W = walk.width, H = walk.height; ctx.clearRect(0, 0, W, H);
      const pts = trailRef.current.length ? trailRef.current : [[0, 0] as [number, number]];
      let minx = 0, maxx = 0, miny = 0, maxy = 0; for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      const span = Math.max(8, maxx - minx, maxy - miny) * 1.15, sc = Math.min(W, H) / span, cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
      const P = ([x, y]: [number, number]) => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];
      ctx.strokeStyle = "rgba(232,228,218,0.07)"; ctx.lineWidth = 1; const g = Math.pow(10, Math.floor(Math.log10(span / 4)));
      for (let x = Math.floor((cx - span) / g) * g; x < cx + span; x += g) { const [px] = P([x, 0]); ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); }
      for (let y = Math.floor((cy - span) / g) * g; y < cy + span; y += g) { const [, py] = P([0, y]); ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke(); }
      ctx.strokeStyle = "rgba(245,184,64,0.9)"; ctx.lineWidth = Math.max(1, W / 400); ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
      const [ex, ey] = P(pts[pts.length - 1]); ctx.save(); ctx.translate(ex, ey); ctx.rotate(-head.current.a); ctx.fillStyle = "#ff4d2e"; ctx.beginPath(); ctx.moveTo(W / 60, 0); ctx.lineTo(-W / 90, W / 120); ctx.lineTo(-W / 90, -W / 120); ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.fillStyle = "rgba(232,228,218,0.5)"; ctx.font = `${Math.round(W / 42)}px JetBrains Mono, monospace`; ctx.textAlign = "left"; ctx.fillText(`grid ${g} cell${g === 1 ? "" : "s"}`, 8 * dpr, H - 8 * dpr);
    };
    let last = performance.now(), acc = 0; const SPS = CFG.previewStepsPerSecond;
    const loop = (now: number) => {
      if (!alive) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt * SPS; let n = 0;
      while (acc >= 1 && n < 4) { acc -= 1; n++; if (sim.alive) { sim.tick(1); pushTrail(); } }
      const dec = Math.exp(-dt * 3); for (let w = 0; w < WEDGES; w++) wedgeAct.current[w] *= dec; head.current.m *= Math.exp(-dt * 0.5);
      if (brain) brain.frame(dt); drawCompass(); drawWalk(); if (n) render();
      raf = requestAnimationFrame(loop);
    };
    const applyChainState = (s: any) => { sim.loadState(s); sim.totalSpikes = 0; chainStateRef.current = s; trailRef.current.length = 0; pushTrail(); };
    const loadEvents = async () => {
      const ch = chainRef.current!; const evs = await ch.recentEvents(40000); setEvents(evs.slice(0, 40));
      const ticks = evs.filter((e) => e.name === "Ticked").reverse();
      if (ticks.length) { trailRef.current.length = 0; for (const t of ticks) trailRef.current.push([Number(t.args.posX) / 256, Number(t.args.posY) / 256]); pushTrail(); }
      const cs = chainStateRef.current; if (cs && cs.lineageLength) setLineage(await ch.readLineage(cs.lineageLength));
    };
    const syncChain = async () => {
      try {
        const ch = chainRef.current!; const s = await ch.readState(); const cs = chainStateRef.current;
        if (!cs || s.step !== cs.step || s.generation !== cs.generation || s.alive !== cs.alive || s.energy > cs.energy) { if (cs && s.step !== cs.step) setToast(`On-chain tick: step ${fmt(cs.step)} → ${fmt(s.step)}`, 2500); applyChainState(s); loadEvents().catch(() => {}); }
        else { cs.block = s.block; cs.totalBurned = s.totalBurned; }
        render();
      } catch (e) { console.warn("sync failed", e); }
    };
    (window as any).__fly = { sim, syncChain, applyChainState, pushTrail, render };
    (async () => {
      try { const buf = await (await fetch(`${CFG.basePath}/assets/brain_points.bin`)).arrayBuffer(); if (canvasRef.current) brain = new Brain3D(canvasRef.current, buf, (circuitData as any).neurons); } catch (e) { console.warn("WebGL unavailable", e); }
      let interval: any = null;
      if (CFG.brain) {
        try { const ch = await new Chain().connectRead(); chainRef.current = ch; const s = await ch.readState(); modeRef.current = "chain"; applyChainState(s); setPrices(ch.prices); loadEvents().catch(() => {}); interval = setInterval(syncChain, 5000); }
        catch (e) { console.warn("chain unavailable, preview mode", e); modeRef.current = "preview"; }
      }
      if (modeRef.current === "preview") { sim.energy = 10_000_000; sim.stimulate(CH.CUE, 4, 4); }
      render(); raf = requestAnimationFrame(loop);
      return () => clearInterval(interval);
    })();
    return () => { alive = false; cancelAnimationFrame(raf); if (brain) brain.dispose(); };
  }, []);

  const act = async (kind: string, fn: () => Promise<any>, preview: () => void) => {
    const f = (window as any).__fly;
    if (modeRef.current === "preview") { preview(); setToast(`Preview: ${kind} applied to the local copy of the brain.`); f.render(); return; }
    if (!wallet) { setToast("Connect a wallet first."); return; }
    try { setToast(`${kind}: confirm in your wallet…`, 60000); const rc = await fn(); setToast(`${kind}: confirmed in block ${fmt(rc.blockNumber)}.`); await f.syncChain(); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); }
    catch (e: any) { console.error(e); setToast(`${kind} failed: ${e.shortMessage || e.reason || e.message}`, 7000); }
  };
  const sim = () => simRef.current!;
  const connect = async () => {
    if (modeRef.current !== "chain") return setToast("Not connected to BNB Chain right now (preview mode).");
    try { const a = await chainRef.current!.connectWallet(); setWallet(a); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); setToast(`Connected ${short(a)}`); } catch (e: any) { setToast(e.shortMessage || e.message, 6000); }
  };
  const stimCost = prices ? `${fmtTok(prices.stimPrice * BigInt(strength))} FLY` : `${100 * strength} FLY`;
  const dialClick = (e: React.MouseEvent<HTMLCanvasElement>) => { const r = (e.target as HTMLCanvasElement).getBoundingClientRect(); const x = e.clientX - r.left - r.width / 2, y = -(e.clientY - r.top - r.height / 2); const w = ((Math.floor(Math.atan2(y, x) / ((2 * Math.PI) / WEDGES)) % WEDGES) + WEDGES) % WEDGES; setWedge(w); setToast(`Wedge ${w} selected. Press “Flash cue” to pin the compass there.`, 2500); };
  const evLabel = (e: Ev) => {
    const a = e.args;
    switch (e.name) {
      case "Ticked": return `tick +${a.steps} steps · ${a.spikes} spikes · by ${short(a.by)}`;
      case "Fed": return `fed ${fmtTok(a.tokensBurned)} FLY (+${fmt(a.energyAdded)} steps) · by ${short(a.by)}`;
      case "Stimulated": return `${CH_NAMES[Number(a.channel)]}${Number(a.channel) === 1 ? " @" + a.param : ""} ×${a.strength} · ${fmtTok(a.tokensBurned)} FLY · by ${short(a.by)}`;
      case "Died": return `DIED · generation ${a.generation} · lived ${fmt(a.lifeSteps)} steps, ${fmt(a.lifeSpikes)} spikes`;
      case "Resurrected": return `RESURRECTED · generation ${a.generation} · by ${short(a.by)}`;
      default: return e.name;
    }
  };

  return (
    <>
      <section className="hero" id="top">
        <canvas ref={canvasRef} className="hero-canvas" aria-label="The fruit fly brain, 139,248 neurons, with the 155 on-chain neurons lit by their spikes" />
        <div className="wrap hero-grid">
          <aside className="panel" aria-label="Specimen label">
            <div className="label-head"><span className="name">Specimen 001</span><span className={`status${ui.alive ? "" : " dead"}${ui.mode === "preview" ? " preview" : ""}`}>{ui.alive ? "alive" : "dead"} · {ui.mode === "chain" ? "on-chain" : "preview"}</span></div>
            <dl className="kv">
              <dt>species</dt><dd>Drosophila melanogaster</dd>
              <dt>circuit</dt><dd>head-direction ring</dd>
              <dt>neurons on-chain</dt><dd>155</dd>
              <dt>connections</dt><dd>6,522</dd>
              <dt>generation</dt><dd>{ui.gen}</dd>
              <dt>step</dt><dd className="big">{fmt(ui.step)}</dd>
              <dt>energy (steps left)</dt><dd>{fmt(ui.energy)}</dd>
            </dl>
            <div className="energybar"><i style={{ width: `${Math.min(100, (100 * ui.energy) / Math.max(1, ui.energyMax))}%` }} /></div>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>spikes</dt><dd>{fmt(ui.spikes)}</dd>
              <dt>position</dt><dd>{ui.pos}</dd>
              <dt>heading</dt><dd>{ui.heading}°</dd>
              <dt>stimulus</dt><dd>{ui.stim}</dd>
              <dt>$FLY burned</dt><dd>{ui.burned}</dd>
              <dt>block</dt><dd>{ui.block}</dd>
            </dl>
            <div className="addr">FlyBrain <a href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener">{CFG.brain}</a></div>
            <div className="addr">$FLY <a href={`${CFG.explorer}/token/${CFG.token}`} target="_blank" rel="noopener">{CFG.token}</a></div>
          </aside>
          <div className="hero-mid">
            <p className="eyebrow">FlyWire connectome · release 783 · BNB Smart Chain</p>
            <h1 className="hero-title">The fly brain<br /><span className="line2">lives on-chain.</span></h1>
            <p className="hero-sub">155 real neurons from a fruit fly&apos;s compass circuit, simulated spike by spike inside a smart contract. It walks. It remembers. When it dies, the brain is frozen on-chain and can be woken again.</p>
            <div className="hero-cta">
              <a className="btn primary" href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener">Buy $FLY</a>
              <a className="btn" href="#play">Feed the fly</a>
              <a className="btn ghost" href="/docs/vision/">The vision →</a>
            </div>
            <div className="scalebar"><i /> 100 µm · drag to rotate · scroll to zoom</div>
          </div>
          <aside className="panel compass-wrap" aria-label="Compass">
            <div className="label-head"><span className="name">Compass</span><span className="eyebrow">EPG bump</span></div>
            <canvas ref={dialRef} className="compass" onClick={dialClick} aria-label="16-wedge compass showing the head-direction bump" />
            <div className="compass-foot"><span>click a wedge to aim a cue</span><span>outer ring = memory</span></div>
            <div className="legend"><span style={{ "--c": "#f5b840" } as any}>EPG / PEG</span><span style={{ "--c": "#ff4d2e" } as any}>PEN</span><span style={{ "--c": "#4fc3f7" } as any}>Δ7 (inhibitory)</span></div>
          </aside>
        </div>
      </section>

      <div className="ticker" aria-hidden="true"><div className="track">{[...events.slice(0, 12), ...events.slice(0, 12)].map((e, i) => <span key={i}><a href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">#{e.block}</a> <b>{evLabel(e)}</b></span>)}{events.length === 0 && <span>{ui.mode === "chain" ? "reading the chain…" : "preview mode: the same circuit running locally"}</span>}</div></div>

      <section className="deck" id="play">
        <div className="wrap">
          <div className={`mode-banner${ui.mode === "preview" ? " show" : ""}`}><span>◐</span><span>This page cannot reach BNB Chain from here, so it is running the same circuit locally. Open the site directly for the live on-chain fly.</span></div>
          <div className="card">
            <h3>Feed <span className="cost">{prices ? `${fmtTok(prices.tokensPerStep)} FLY = 1 step` : "1 FLY = 1 step"}</span></h3>
            <p className="note">Every simulation step burns one unit of energy. Feeding sends $FLY to the dead address and gives the fly time to live.</p>
            <div className="row"><input id="feed-amount" className="input" type="number" min={1} value={feedAmt} onChange={(e) => setFeedAmt(e.target.value)} aria-label="Amount of FLY to feed" /><button className="btn gold" onClick={() => { const amt = Number(feedAmt) || 0; if (amt <= 0) return setToast("Enter an amount of FLY."); act("Feed", () => chainRef.current!.feed(ethers.parseEther(String(amt))), () => { sim().energy += Math.floor(amt); }); }}>Feed</button></div>
            <h3 style={{ marginTop: 6 }}>Walk</h3>
            <canvas ref={walkRef} className="walk" aria-label="Map of the fly's walk" />
            <div className="row"><button className="btn small" onClick={() => act("Tick 32", () => chainRef.current!.tick(32), () => { sim().tick(32); (window as any).__fly.pushTrail(); })}>Run 32 steps (gas only)</button><span className="note">Anyone can tick the brain forward.</span></div>
          </div>
          <div className="card">
            <h3>Stimulate <span className="cost">{stimCost}</span></h3>
            <p className="note">Inject current into a group of real neurons for 64 steps, then run 16 steps so you see the reaction.</p>
            <div className="row"><label className="note" htmlFor="strength">strength</label><input id="strength" type="range" min={1} max={16} value={strength} onChange={(e) => setStrength(Number(e.target.value))} style={{ flex: 1 }} /><span className="mono">{strength}</span></div>
            <div className="row"><label className="note" htmlFor="cue-wedge">cue wedge</label><input id="cue-wedge" type="range" min={0} max={15} value={wedge} onChange={(e) => setWedge(Number(e.target.value))} style={{ flex: 1 }} /><span className="mono">{wedge}</span></div>
            <div className="row">
              <button className="btn" onClick={() => act(`Cue @${wedge}`, () => chainRef.current!.stimulate(CH.CUE, wedge, strength, 16), () => sim().stimulate(CH.CUE, wedge, strength))}>Flash cue</button>
              <button className="btn" onClick={() => act("Turn left", () => chainRef.current!.stimulate(CH.TURN_LEFT, 0, strength, 16), () => sim().stimulate(CH.TURN_LEFT, 0, strength))}>↺ Turn left</button>
              <button className="btn" onClick={() => act("Turn right", () => chainRef.current!.stimulate(CH.TURN_RIGHT, 0, strength, 16), () => sim().stimulate(CH.TURN_RIGHT, 0, strength))}>↻ Turn right</button>
              <button className="btn" style={{ borderColor: "#4fc3f7", color: "#4fc3f7" }} onClick={() => act("Shock", () => chainRef.current!.stimulate(CH.SHOCK, 0, strength, 16), () => sim().stimulate(CH.SHOCK, 0, strength))}>⚡ Shock</button>
            </div>
            <p className="note"><b className="gold">Cue</b> drives the EPG neurons of one wedge (a landmark). <b className="eye">Turn</b> drives the left or right PEN neurons (angular velocity). <b className="cyan">Shock</b> drives every Δ7 neuron: global inhibition, the bump collapses.</p>
            <div className="row" style={{ marginTop: 4 }}>{wallet ? <span className="mono muted">{short(wallet)} · {bal}</span> : <button className="btn small" onClick={connect}>Connect wallet</button>}</div>
          </div>
          <div className="card">
            <h3>Interaction history <span className="cost">lives: {ui.lives}</span></h3>
            <div className="log">{events.length ? events.map((e, i) => <div key={i}><a href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">#{e.block}</a><b>{evLabel(e)}</b></div>) : <div><span>—</span><b>{ui.mode === "chain" ? "no interactions in the last 40,000 blocks" : "connecting…"}</b></div>}</div>
            {!ui.alive && (<div>
              <h3 style={{ marginTop: 8 }}>Resurrect <span className="cost">{prices ? `${fmtTok(prices.resurrectPrice)} FLY + food` : "100,000 FLY + food"}</span></h3>
              <p className="note">The fly is dead. Its brain is frozen exactly as it was. Bring it back with a new body.</p>
              <div className="row"><input className="input" type="number" min={0} value={resFood} onChange={(e) => setResFood(e.target.value)} aria-label="Extra food" /><button className="btn primary" onClick={() => { const extra = Number(resFood) || 0; act("Resurrect", () => chainRef.current!.resurrect(ethers.parseEther(String(extra))), () => { const s = sim(); s.alive = true; s.generation++; s.energy = extra; s.posX = 0; s.posY = 0; trailRef.current.length = 0; }); }}>Resurrect</button></div>
            </div>)}
          </div>
        </div>
      </section>

      <section className="block" id="immortality">
        <div className="wrap">
          <div className="sec-head"><div><p className="eyebrow">Digital immortality</p><h2>It can die. It cannot be lost.</h2></div><p>The organism burns one step of energy per simulation step. When energy reaches zero it dies: ticks stop, the brain is hashed, and the life is recorded in an on-chain lineage. Anyone can resurrect it. The same membrane potentials, the same engram, the same heading memory wake up in a new body at the origin. Generation plus one.</p></div>
          <div className="steps">
            <div><span className="k">state</span><h3>Brain</h3><p>155 membrane potentials and pending synaptic currents, packed into storage words. Updated on every tick.</p></div>
            <div><span className="k">memory</span><h3>Engram</h3><p>Neurons that fire habitually potentiate, silent ones depress. Slow, bounded, permanent. Plus a histogram of where the compass has pointed.</p></div>
            <div><span className="k">death</span><h3>Frozen</h3><p>Energy hits zero. The state hash, birth block, death block, steps and spikes go into <code>lineage[]</code>.</p></div>
            <div><span className="k">rebirth</span><h3>Resurrect</h3><p>Burn $FLY. The identical brain continues from the exact state it died in. Only the body is new.</p></div>
          </div>
          <div style={{ marginTop: 32 }}>
            <p className="eyebrow" style={{ marginBottom: 12 }}>Lineage</p>
            <table className="data"><thead><tr><th>Gen</th><th>Born (block)</th><th>Died (block)</th><th>Steps lived</th><th>Spikes</th><th>Brain hash at death</th></tr></thead>
              <tbody>{lineage.map((l) => <tr key={l.generation}><td className="mono">{l.generation}</td><td className="mono">{fmt(l.bornBlock)}</td><td className="mono">{fmt(l.diedBlock)}</td><td className="mono">{fmt(l.steps)}</td><td className="mono">{fmt(l.spikes)}</td><td className="mono">{l.hash.slice(0, 18)}…</td></tr>)}</tbody></table>
            {lineage.length === 0 && <p className="note" style={{ marginTop: 10 }}>Generation {ui.gen} is alive. No deaths yet.</p>}
          </div>
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
