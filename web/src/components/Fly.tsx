"use client";
import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import circuitData from "@/data/circuit.json";
import tableData from "@/data/table.json";
import params from "@/data/params.json";
import { CFG } from "@/lib/config";
import { Circuit, FlySim, CH, COS16, SIN16, WEDGES } from "@/lib/flysim";
import { Chain } from "@/lib/chain";
import { drawDial as drawDialRing, wedgeAt } from "@/lib/dial";

const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };
const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));

type Ev = { name: string; args: any; block: number; tx: string };
type Lin = { generation: number; bornBlock: number; diedBlock: number; steps: number; spikes: number; hash: string };

const RASTER_W = 200;
const FIG = { epg: "#f0b429", peg: "#d9922a", pen: "#ff5a35", d7: "#58c4f5" };

export default function Fly() {
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
  const [ui, setUi] = useState<any>({ alive: true, mode: "preview", step: 0, energy: 0, spikes: 0, gen: 0, px: 0, py: 0, heading: 0, rate: 0, burned: "—", block: 0, lives: 1, born: 0 });
  const [care, setCare] = useState<{ stepsPerDay: number; daysLeft: number; ticks: number } | null>(null);
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
    const grp = (i: number) => (circuit.type[i] <= 1 ? 0 : circuit.type[i] === 2 ? 1 : circuit.type[i] <= 4 ? 2 : 3);
    const order = [...Array(circuit.N).keys()].sort((a, b) => {
      if (grp(a) !== grp(b)) return grp(a) - grp(b);
      const wa = circuit.wedge[a] === 255 ? 99 : circuit.wedge[a], wb = circuit.wedge[b] === 255 ? 99 : circuit.wedge[b];
      return wa !== wb ? wa - wb : circuit.side[a] - circuit.side[b];
    });
    const row = new Array(circuit.N).fill(0); order.forEach((n, i) => (row[n] = i));
    const ends = [0, 0, 0, 0]; order.forEach((n, i) => (ends[grp(n)] = i));

    let raf = 0, running = true;
    const pushTrail = () => { const x = sim.posX / 256, y = sim.posY / 256, t = trailRef.current, l = t[t.length - 1]; if (!l || l[0] !== x || l[1] !== y) { t.push([x, y]); if (t.length > 4000) t.shift(); } };

    sim.onStep = (spikes) => {
      raster.current.push(spikes.map((i) => row[i] * 8 + grp(i)));
      if (raster.current.length > RASTER_W) raster.current.shift();
      let hx = 0, hy = 0;
      for (const i of spikes) { const w = circuit.wedge[i]; if (circuit.type[i] <= 1 && w !== 255) { wedgeAct.current[w] = Math.min(3, wedgeAct.current[w] + 1); hx += COS16[w]; hy += SIN16[w]; } }
      if (hx || hy) { head.current.a = Math.atan2(hy, hx); head.current.m = Math.min(1, Math.hypot(hx, hy) / 400); }
    };

    const fit = (c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      return { W, H, dpr };
    };

    const drawRaster = () => {
      const c = rasterRef.current; if (!c) return; const g = c.getContext("2d")!;
      const { W, H, dpr } = fit(c); const padL = 68 * dpr, padB = 18 * dpr, padT = 10 * dpr;
      g.clearRect(0, 0, W, H);
      const plotW = W - padL - 10 * dpr, plotH = H - padB - padT, rowH = plotH / circuit.N, colW = plotW / RASTER_W;
      const bands: [string, number][] = [["compass", 0], ["sustain", 1], ["rotate", 2], ["inhibit", 3]];
      let prev = -1;
      g.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`; g.textBaseline = "middle";
      for (const [name, gi] of bands) {
        const y0 = padT + (prev + 1) * rowH, y1 = padT + (ends[gi] + 1) * rowH;
        if (gi % 2 === 1) { g.fillStyle = "rgba(232,230,224,0.03)"; g.fillRect(padL, y0, plotW, y1 - y0); }
        g.fillStyle = "rgba(232,230,224,0.42)"; g.textAlign = "right"; g.fillText(name, padL - 12 * dpr, (y0 + y1) / 2);
        g.strokeStyle = "rgba(232,230,224,0.09)"; g.beginPath(); g.moveTo(padL, y1); g.lineTo(padL + plotW, y1); g.stroke();
        prev = ends[gi];
      }
      const cols = raster.current, n = cols.length, x0 = padL + plotW - n * colW;
      const dh = Math.max(1.2 * dpr, rowH * 0.9), dw = Math.max(1.2 * dpr, colW * 0.88);
      const cc = [FIG.epg, FIG.peg, FIG.pen, FIG.d7];
      for (let k = 0; k < n; k++) {
        const x = x0 + k * colW, fade = 0.32 + 0.68 * (k / Math.max(1, n - 1));
        g.globalAlpha = fade;
        for (const p of cols[k]) { g.fillStyle = cc[p & 7]; g.fillRect(x, padT + (p >> 3) * rowH, dw, dh); }
      }
      g.globalAlpha = 1;
      g.strokeStyle = "rgba(255,90,53,0.55)"; g.beginPath(); g.moveTo(padL + plotW, padT); g.lineTo(padL + plotW, padT + plotH); g.stroke();
      g.fillStyle = "rgba(232,230,224,0.34)"; g.textBaseline = "top"; g.textAlign = "left";
      g.fillText(`${RASTER_W} steps ago`, padL, padT + plotH + 5 * dpr);
      g.textAlign = "right"; g.fillText("now", padL + plotW, padT + plotH + 5 * dpr);
      g.save(); g.translate(14 * dpr, padT + plotH / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillStyle = "rgba(232,230,224,0.3)";
      g.fillText("155 neurons", 0, 0); g.restore();
    };

    // the dial itself lives in lib/dial.ts so the per-fly core figure (Core.tsx) draws the identical ring
    const drawDial = () => { const c = dialRef.current; if (c) drawDialRing(c, wedgeAct.current.map((a) => Math.min(1, a / 2)), sim.hist, head.current.a, head.current.m); };

    const drawWalk = () => {
      const c = walkRef.current; if (!c) return; const g = c.getContext("2d")!; const { W, H, dpr } = fit(c);
      g.clearRect(0, 0, W, H);
      const pts = trailRef.current.length ? trailRef.current : ([[0, 0]] as [number, number][]);
      let mnx = 0, mxx = 0, mny = 0, mxy = 0;
      for (const [x, y] of pts) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
      const span = Math.max(6, mxx - mnx, mxy - mny) * 1.25, sc = Math.min(W, H) / span, cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
      const P = ([x, y]: [number, number]) => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];
      g.strokeStyle = "rgba(232,230,224,0.06)"; g.lineWidth = 1;
      const gr = Math.pow(10, Math.floor(Math.log10(span / 4)));
      for (let x = Math.floor((cx - span) / gr) * gr; x < cx + span; x += gr) { const [px] = P([x, 0]); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); }
      for (let y = Math.floor((cy - span) / gr) * gr; y < cy + span; y += gr) { const [, py] = P([0, y]); g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke(); }
      const [ox, oy] = P([0, 0]); g.strokeStyle = "rgba(232,230,224,0.3)"; g.beginPath(); g.arc(ox, oy, 3 * dpr, 0, 7); g.stroke();
      g.strokeStyle = FIG.epg; g.lineWidth = Math.max(1.2, W / 440); g.lineJoin = "round";
      g.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      const [ex, ey] = P(pts[pts.length - 1]);
      g.save(); g.translate(ex, ey); g.rotate(-head.current.a); g.fillStyle = "#ff5a35";
      g.beginPath(); g.moveTo(W / 52, 0); g.lineTo(-W / 84, W / 108); g.lineTo(-W / 84, -W / 108); g.closePath(); g.fill(); g.restore();
      g.fillStyle = "rgba(232,230,224,0.32)"; g.font = `${Math.round(9.5 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText(`grid ${gr} body length${gr === 1 ? "" : "s"}`, 10 * dpr, H - 9 * dpr);
    };

    let rateBuf: number[] = [];
    const render = () => {
      const cs = csRef.current, src = modeRef.current === "chain" && cs ? cs : sim;
      setUi((u: any) => ({ ...u, alive: sim.alive, mode: modeRef.current, step: src.step, energy: src.energy,
        spikes: modeRef.current === "chain" ? cs.totalSpikes : sim.totalSpikes, gen: src.generation,
        px: src.posX / 256, py: src.posY / 256, heading: Math.round(((head.current.a * 180) / Math.PI + 360) % 360),
        rate: rateBuf.length ? rateBuf.reduce((a, b) => a + b, 0) / rateBuf.length : 0,
        burned: cs ? fmtTok(cs.totalBurned) : "—", block: cs ? cs.block : 0, lives: cs ? cs.lineageLength + 1 : 1 }));
    };

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
      drawRaster(); drawDial(); drawWalk(); if (n) render();
      raf = requestAnimationFrame(loop);
    };

    const applyChain = (s: any) => { sim.loadState(s); sim.totalSpikes = 0; csRef.current = s; trailRef.current.length = 0; pushTrail(); };
    const loadEvents = async () => {
      const ch = chainRef.current!; const { events: evs } = await ch.recentEvents(40000); setEvents(evs.slice(0, 60));
      const ticks = evs.filter((e) => e.name === "Ticked").reverse();
      if (ticks.length) { trailRef.current.length = 0; for (const t of ticks) trailRef.current.push([Number(t.args.posX) / 256, Number(t.args.posY) / 256]); pushTrail(); }
      const cs = csRef.current; if (cs?.lineageLength) setLineage(await ch.readLineage(cs.lineageLength));
      try { const r = await ch.careRate(evs); if (r && cs) setCare({ stepsPerDay: r.stepsPerDay, daysLeft: cs.energy / r.stepsPerDay, ticks: r.ticks }); } catch {}
    };
    const syncChain = async () => {
      try {
        const ch = chainRef.current!, s = await ch.readState(), cs = csRef.current;
        if (!cs || s.step !== cs.step || s.generation !== cs.generation || s.alive !== cs.alive || s.energy > cs.energy) {
          if (cs && s.step !== cs.step) setToast(`Kept alive: the brain advanced ${fmt(s.step - cs.step)} steps on-chain.`, 3000);
          applyChain(s); loadEvents().catch(() => {});
        } else { cs.block = s.block; cs.totalBurned = s.totalBurned; }
        render();
      } catch (e) { console.warn("sync failed", e); }
    };
    (window as any).__fly = { sim, syncChain, pushTrail, render };

    (async () => {
      if (CFG.brain) {
        try { const ch = await new Chain().connectRead(); chainRef.current = ch; const s = await ch.readState(); modeRef.current = "chain"; applyChain(s); setPrices(ch.prices); loadEvents().catch(() => {}); (window as any).__flyInt = setInterval(syncChain, 5000); }
        catch (e) { console.warn("chain unreachable, preview", e); modeRef.current = "preview"; }
      }
      if (modeRef.current === "preview") { sim.energy = 1e7; sim.stimulate(CH.CUE, 4, 4); }
      for (let i = 0; i < RASTER_W && sim.alive; i++) stepOnce();
      render(); raf = requestAnimationFrame(loop);
    })();
    return () => { running = false; cancelAnimationFrame(raf); clearInterval((window as any).__flyInt); };
  }, []);

  const act = async (kind: string, fn: () => Promise<any>, preview: () => void) => {
    const f = (window as any).__fly;
    if (modeRef.current === "preview") { preview(); setToast(`Preview only: ${kind} was applied to the local copy of the brain.`); f.render(); return; }
    if (!wallet) { setToast("Connect a wallet to act on the live specimen."); return; }
    setBusy(kind);
    try { setToast(`${kind}: confirm in your wallet…`, 90000); const rc = await fn(); setToast(`${kind} recorded in block ${fmt(rc.blockNumber)}.`); await f.syncChain(); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); }
    catch (e: any) { console.error(e); setToast(`${kind} failed: ${e.shortMessage || e.reason || e.message}`, 8000); }
    finally { setBusy(null); }
  };
  const sim = () => simRef.current!;
  const connect = async () => {
    if (modeRef.current !== "chain") return setToast("Not connected to BNB Chain right now.");
    try { const a = await chainRef.current!.connectWallet(); setWallet(a); setBal(fmtTok(await chainRef.current!.balance()) + " FLY"); setToast(`Connected ${short(a)}`); }
    catch (e: any) { setToast(e.shortMessage || e.message, 6000); }
  };
  const dialClick = (e: React.MouseEvent<HTMLCanvasElement>) => setWedge(wedgeAt(e));
  const stimCost = prices ? fmtTok(prices.stimPrice * BigInt(strength)) : String(100 * strength);
  const poke = (label: string, ch: number, param: number, cls: string, hint: string) => (
    <button className={`poke ${cls}`} disabled={!!busy} onClick={() => act(label, () => chainRef.current!.stimulate(ch, param, strength, 16), () => sim().stimulate(ch, param, strength))}>
      <b>{label}</b><small>{hint}</small></button>
  );
  const evRow = (e: Ev, i: number) => {
    const a = e.args, names = ["none", "cue", "turn left", "turn right", "shock"];
    let act = "tick", txt: React.ReactNode = e.name;
    if (e.name === "Ticked") txt = <>ran <b>{a.steps} steps</b> of the brain · {fmt(a.spikes)} spikes</>;
    else if (e.name === "Fed") { act = "feed"; txt = <>fed <b>{fmtTok(a.tokensBurned)} $FLY</b> · {fmt(a.energyAdded)} more steps of life</>; }
    else if (e.name === "Stimulated") { act = "stim"; txt = <><b>{names[Number(a.channel)]}{Number(a.channel) === 1 ? ` at wedge ${a.param}` : ""}</b> ×{a.strength} · {fmtTok(a.tokensBurned)} $FLY</>; }
    else if (e.name === "Died") { act = "life"; txt = <><b>died</b> · generation {String(a.generation)} lived {fmt(a.lifeSteps)} steps</>; }
    else if (e.name === "Resurrected") { act = "life"; txt = <><b>resurrected</b> · generation {String(a.generation)}</>; }
    return (<div className="lrow" key={e.tx + i}>
      <a className="blk" href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">block {e.block}</a>
      <span className={`act ${act}`}>{act}</span><span className="ev">{txt}</span><span className="who">{short(a.by)}</span></div>);
  };

  const days = care ? care.daysLeft : null;
  const energyPct = Math.max(2, Math.min(100, (ui.energy / 1_000_000) * 100));

  return (
    <>
      {/* ── the on-chain core ─────────────────────────────── */}
      <section className="fig" id="core">
        <div className="wrap">
          <div className="fig-head core-head">
            <div><div className="num">Specimen 001 · fully on-chain</div><h2>The compass core, inside the contract itself</h2></div>
            <p className="cap">The whole brain above runs on a server and is anchored to the chain by hashes. This part needs no anchoring: 155 real neurons of the fly&apos;s head-direction ring — the compass it uses to know where it is facing — are simulated spike by spike <em>inside</em> a BNB Smart Chain contract, with every membrane potential in storage. It has its own energy, memory and lineage, and anyone can feed or stimulate it. Age {fmt(ui.step)} steps, energy {fmt(ui.energy)}{days !== null ? `, about ${days.toFixed(1)} days of life at the current rate of care.` : "."}</p>
          </div>
        </div>
      </section>

      {/* ── Figure 2 ──────────────────────────────────────── */}
      <section className="fig" id="signs">
        <div className="wrap">
          <div className="fig-head">
            <div><div className="num">Figure 3</div><h2>Vital signs of the core</h2></div>
            <p className="cap"><b>Fig. 3 |</b> <b>a,</b> Spike raster of all 155 on-chain neurons, ordered by role and by position on the ring. A single band of activity — the bump — marks the animal&apos;s current heading; it jumps rows when the heading changes. <b>b,</b> The same activity read as a compass. <b>c,</b> The path the animal has walked, decoded from the bump.</p>
          </div>
          <div className="grid2">
          <div className="cell">
            <div className="cell-t"><span className="a">a</span><span className="n">Spike raster</span><span className="r">{ui.rate.toFixed(1)} spikes per step</span></div>
            <div className="cell-b b-raster"><canvas ref={rasterRef} className="raster-c" aria-label="Spike raster: rows are neurons grouped by role, columns are simulation steps" /></div>
            <div className="cell-cap">
              <span><i style={{ "--c": FIG.epg } as any} />EPG compass</span>
              <span><i style={{ "--c": FIG.peg } as any} />PEG sustain</span>
              <span><i style={{ "--c": FIG.pen } as any} />PEN rotate</span>
              <span><i style={{ "--c": FIG.d7 } as any} />Δ7 inhibit</span>
              <span style={{ marginLeft: "auto" }}>{ui.mode === "chain" ? "continued from the last on-chain state" : "local simulation"}</span>
            </div>
          </div>
          <div className="stack">
            <div className="cell">
              <div className="cell-t"><span className="a">b</span><span className="n">Heading</span><span className="r">{ui.heading}°</span></div>
              <div className="cell-b b-dial"><div className="dial-wrap"><canvas ref={dialRef} onClick={dialClick} aria-label="Sixteen-wedge compass showing the head-direction bump" /></div></div>
              <div className="cell-cap"><span>16 wedges of the ellipsoid body</span><span style={{ marginLeft: "auto" }}>outer ring: heading memory</span></div>
            </div>
            <div className="cell">
              <div className="cell-t"><span className="a">c</span><span className="n">Path</span><span className="r">{ui.px.toFixed(1)}, {ui.py.toFixed(1)}</span></div>
              <div className="cell-b b-walk"><canvas ref={walkRef} className="walk-c" aria-label="Map of the path the animal has walked" /></div>
              <div className="cell-cap"><span>origin ○ · one stride per step when the bump is strong</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── care ──────────────────────────────────────────── */}
      <section className="sec care" id="care">
        <div className="wrap">
          <div className="sec-t">
            <div><div className="num">Husbandry · core</div><h2>The core stays alive because people feed it.</h2></div>
            <p>Nothing about this organism is automatic. Running the brain forward costs gas; keeping it fed costs $FLY, which is destroyed in the act. Anyone may do either, and both are written into the animal&apos;s permanent record along with the address that did it. {days !== null && <>At the rate it is currently being cared for it has about <b>{days.toFixed(0)} days</b> left.</>}</p>
          </div>
          {ui.mode === "preview" && <div className="banner">This page cannot reach BNB Smart Chain from here, so it is running the same circuit locally. Actions below will not touch the live specimen.</div>}
          <div className="care-grid">
            <div className="care-col">
              <div className="care-t"><h3>Feed</h3><span className="cost">{prices ? `${fmtTok(prices.tokensPerStep)} $FLY = 1 step` : "1 $FLY = 1 step"}</span></div>
              <p>One unit of energy is consumed per simulation step. Feeding sends $FLY to the dead address; it is gone, and the animal lives longer.</p>
              <div className="field">
                <input type="number" min={1} value={feedAmt} onChange={(e) => setFeedAmt(e.target.value)} aria-label="Amount of FLY to feed" />
                <button className="btn fill" disabled={!!busy} onClick={() => { const a = Number(feedAmt) || 0; if (a <= 0) return setToast("Enter an amount of $FLY."); act("Feed", () => chainRef.current!.feed(ethers.parseEther(String(a))), () => { sim().energy += Math.floor(a); }); }}>{busy === "Feed" ? "…" : "Feed"}</button>
              </div>
              <button className="btn sm" disabled={!!busy} onClick={() => act("Tick", () => chainRef.current!.tick(32), () => { sim().tick(32); (window as any).__fly.pushTrail(); })}>Run the brain 32 steps · gas only</button>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>Stimulate</h3><span className="cost">{stimCost} $FLY</span></div>
              <p>Inject current into a named group of real neurons for 64 steps, the way an experimenter would, then watch Figure 2.</p>
              <div className="slider"><label htmlFor="strength">strength</label><input id="strength" type="range" min={1} max={16} value={strength} onChange={(e) => setStrength(+e.target.value)} /><output>{strength}</output></div>
              <div className="slider"><label htmlFor="cuewedge">cue wedge</label><input id="cuewedge" type="range" min={0} max={15} value={wedge} onChange={(e) => setWedge(+e.target.value)} /><output>{wedge}</output></div>
              <div className="pokes">
                {poke("Landmark", CH.CUE, wedge, "cue", `EPG at wedge ${wedge}`)}
                {poke("Shock", CH.SHOCK, 0, "shock", "all 42 Δ7 cells")}
                {poke("Turn left", CH.TURN_LEFT, 0, "turn", "left PEN cells")}
                {poke("Turn right", CH.TURN_RIGHT, 0, "turn", "right PEN cells")}
              </div>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>{ui.alive ? "Your record" : "Resurrect"}</h3><span className="cost">{ui.alive ? `life ${ui.lives} · gen ${ui.gen}` : prices ? `${fmtTok(prices.resurrectPrice)} $FLY + food` : "100,000 $FLY"}</span></div>
              {ui.alive ? (<>
                <p>Every feed and every stimulus is stored against the address that sent it. The animal keeps a list of who has kept it alive.</p>
                {wallet ? <div className="field"><span className="btn sm" style={{ flex: 1, justifyContent: "space-between", cursor: "default" }}><span className="mono">{short(wallet)}</span><span className="mono dim">{bal}</span></span></div>
                        : <button className="btn" onClick={connect}>Connect wallet</button>}
                <a className="btn sm plain" href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener">Read the contract on BscScan →</a>
              </>) : (<>
                <p>Energy reached zero and the brain was frozen at the exact state it died in. Burn $FLY to wake the same brain in a new body.</p>
                <div className="field">
                  <input type="number" min={0} value={resFood} onChange={(e) => setResFood(e.target.value)} aria-label="Extra food" />
                  <button className="btn fill" disabled={!!busy} onClick={() => { const x = Number(resFood) || 0; act("Resurrect", () => chainRef.current!.resurrect(ethers.parseEther(String(x))), () => { const s = sim(); s.alive = true; s.generation++; s.energy = x; s.posX = 0; s.posY = 0; trailRef.current.length = 0; }); }}>Resurrect</button>
                </div>
              </>)}
            </div>
          </div>

          <div style={{ marginTop: 40 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Care record · core</b><span className="lbl">every interaction, oldest at the bottom</span>{care && <span className="lbl" style={{ marginLeft: "auto" }}>{care.ticks} ticks in the window</span>}</div>
            <div className="log-list">
              {events.length ? events.map(evRow) : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">{ui.mode === "chain" ? "no interactions in the last 40,000 blocks" : "reading BNB Smart Chain…"}</span><span /></div>}
            </div>
          </div>

          {lineage.length > 0 && (
            <div style={{ marginTop: 40 }}>
              <table className="data"><caption>Table 2 | Lineage — every life this brain has had</caption>
                <thead><tr><th>Gen</th><th className="num">Born</th><th className="num">Died</th><th className="num">Steps lived</th><th className="num">Spikes</th><th>Brain hash at death</th></tr></thead>
                <tbody>{lineage.map((l) => <tr key={l.generation}><td className="mono">{l.generation}</td><td className="mono num">{fmt(l.bornBlock)}</td><td className="mono num">{fmt(l.diedBlock)}</td><td className="mono num">{fmt(l.steps)}</td><td className="mono num">{fmt(l.spikes)}</td><td className="mono">{l.hash.slice(0, 22)}…</td></tr>)}</tbody></table>
            </div>)}
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
