"use client";
// The per-fly on-chain core (FlyCore): this fly's own 155 compass neurons executing inside the contract.
// Shown on a fly's page only when CFG.core is set. Reads the whole state vector, draws the same dial as the
// FlyBrain v2 figure from it, lets anyone poke or tick it, and lists who has been anchoring it (pebbles included).
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import tableData from "@/data/table.json";
import params from "@/data/params.json";
import { CFG } from "@/lib/config";
import { Chain, LogScan } from "@/lib/chain";
import { Circuit, FlySim, CH, CH_NAMES, WEDGES } from "@/lib/flysim";
import { drawDial, wedgeAt } from "@/lib/dial";
import { Ev, FlyRecord, fmt, fmtTok, short, pad, bodyName, isCoreOnlyBody, scanLabel } from "@/lib/registry";

type CoreState = {
  v: number[]; bias: number[]; hist: number[]; inp: number[]; step: number; headX: number; headY: number; posX: number; posY: number;
  stimChannel: number; stimParam: number; stimStrength: number; stimUntilStep: number; stimActive: boolean; totalSpikes: number; hash: string; block: number;
};
type Prices = { stimPrice: bigint; stimTTL: number; maxSteps: number };

const EVENTS_SHOWN = 30;
const EVENTS_BLOCKS = 60000;
const POLL_MS = 20000;
const PREVIEW_STEPS = 8;
const circuit = new Circuit((tableData as any).table);

/** Where the bump is, in 0..1 per wedge. A snapshot of membrane potentials alone misleads (a cell that has just
 *  spiked sits at the reset potential), so the ring is read the way the site and the pebbles read it: a bit-exact
 *  local replay of the next PREVIEW_STEPS steps from the exact on-chain state (v, bias, pending input, stimulus),
 *  counting the EPG spikes that fall in each wedge. Nothing is sent; the chain state is untouched. */
function wedgeActivity(cs: CoreState) {
  const sim = new FlySim(circuit, params as any);
  sim.loadState({ v: cs.v, bias: cs.bias, hist: cs.hist, pendingInput: cs.inp, step: cs.step, energy: 1e9, alive: true, generation: 0, posX: cs.posX, posY: cs.posY, headX: cs.headX, headY: cs.headY,
    stim: { channel: cs.stimChannel, param: cs.stimParam, strength: cs.stimStrength, untilStep: cs.stimUntilStep } });
  const r = sim.tick(PREVIEW_STEPS); const bins: number[] = r ? r.bins : new Array(WEDGES).fill(0);
  const hi = Math.max(0, ...bins);
  if (!hi) return { act: new Array(WEDGES).fill(0), bump: -1 };
  return { act: bins.map((b) => b / hi), bump: bins.indexOf(hi) };
}

export default function Core({ id, fly, chain, wallet, connect, toast, names }: {
  id: number; fly: FlyRecord; chain: Chain | null; wallet: string | null; connect: () => Promise<void>; toast: (m: string, ms?: number) => void; names: Record<string, string>;
}) {
  const dialRef = useRef<HTMLCanvasElement>(null);
  const [cs, setCs] = useState<CoreState | null>(null);
  const [evs, setEvs] = useState<Ev[]>([]);
  const [scan, setScan] = useState<LogScan | null>(null);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [senders, setSenders] = useState<Record<string, string>>({});
  const [isBody, setIsBody] = useState(false);
  const [strength, setStrength] = useState(4);
  const [wedge, setWedge] = useState(4);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const looked = useRef(new Set<string>());
  const hashRef = useRef<string | null>(null);   // the core hash last shown: any change (a tick, or a stimulus alone) means new events

  const allNames = useMemo(() => ({ ...senders, ...names }), [senders, names]);
  const { act, bump } = useMemo(() => (cs ? wedgeActivity(cs) : { act: new Array(WEDGES).fill(0), bump: -1 }), [cs]);
  const lastTick = evs.find((e) => e.name === "Ticked");
  const headA = cs && (cs.headX || cs.headY) ? Math.atan2(cs.headY, cs.headX) : 0;
  const headM = cs ? Math.min(1, Math.hypot(cs.headX, cs.headY) / ((params as any).walkThreshold * (lastTick ? Number(lastTick.args.steps) : 16))) : 0;
  const heading = cs && (cs.headX || cs.headY) ? Math.round(((headA * 180) / Math.PI + 360) % 360) : null;

  /** The core's record, and names for the senders that are registered bodies (a pebble signs with its own wallet
   *  and registers as "Pebble N"). The scan is incremental after the first read, so this is cheap to repeat. */
  const loadEvents = async (ch: Chain) => {
    const { events: ev, scan: sc } = await ch.coreEvents(id, EVENTS_BLOCKS); setEvs(ev); setScan(sc);
    const todo = new Set<string>(); for (const e of ev) { const by = String(e.args.by || "").toLowerCase(); if (by && !names[by] && !looked.current.has(by)) todo.add(by); }
    const found: Record<string, string> = {};
    for (const a of todo) { looked.current.add(a); try { const b = await ch.bodyInfo(a); if (b.name) found[a] = b.name; } catch {} }
    if (Object.keys(found).length) setSenders((o) => ({ ...o, ...found }));
  };
  const refresh = async (ch: Chain, withEvents = true) => {
    const s = await ch.coreState(id); setCs(s); hashRef.current = s.hash;
    if (withEvents) await loadEvents(ch);
    return s;
  };
  useEffect(() => {
    if (!chain || !chain.hasCore) return;
    let stop = false, timer: any = null;
    (async () => {
      try { setPrices(await chain.coreInfo()); await refresh(chain); }
      catch (e: any) { setErr("Could not read this fly's core: " + (e.shortMessage || e.message)); }
    })();
    const poll = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try { const before = hashRef.current; const s = await chain.coreState(id); setCs(s); hashRef.current = s.hash; if (before !== null && s.hash !== before) await loadEvents(chain); } catch {}
    };
    timer = setInterval(poll, POLL_MS);
    return () => { stop = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, chain]);
  useEffect(() => { (async () => { if (chain && wallet) { try { setIsBody(await chain.isCoreBody(id)); } catch {} } else setIsBody(false); })(); }, [chain, wallet, id]);

  // draw whenever the state changes and whenever the panel is resized
  useEffect(() => {
    const draw = () => { const c = dialRef.current; if (c) drawDial(c, act, cs?.hist || new Array(WEDGES).fill(0), headA, headM, 320, true); };
    draw();
    const ro = typeof ResizeObserver !== "undefined" && dialRef.current ? new ResizeObserver(draw) : null;
    if (ro && dialRef.current?.parentElement) ro.observe(dialRef.current.parentElement);
    window.addEventListener("resize", draw);
    return () => { ro?.disconnect(); window.removeEventListener("resize", draw); };
  }, [act, cs, headA, headM]);

  const run = async (label: string, fn: () => Promise<any>, done: (rc: any) => string) => {
    if (!chain) return toast("Not connected to BNB Chain.");
    if (!wallet) return connect();
    if (!fly.alive) return toast("A dead fly's core cannot be run. Resurrect it first.");
    setBusy(label);
    try { toast(`${label}: confirm in your wallet…`, 120000); const rc = await fn(); await refresh(chain); toast(done(rc), 10000); }
    catch (e: any) { toast(`${label} failed: ${e.shortMessage || e.reason || e.message}`, 9000); }
    finally { setBusy(null); }
  };
  const ticked = (rc: any) => { try { for (const l of rc.logs || []) { if (String(l.address).toLowerCase() !== CFG.core.toLowerCase()) continue; const p = chain!.core.interface.parseLog({ topics: [...l.topics], data: l.data }); if (p && p.name === "Ticked") return p; } } catch {} return null; };
  const doneMsg = (what: string) => (rc: any) => { const t = ticked(rc); return `${what} in block ${fmt(rc.blockNumber)}${t ? `: ${fmt(t.args.spikes)} spikes in ${t.args.steps} steps, heading ${Math.round(((Math.atan2(Number(t.args.headY), Number(t.args.headX)) * 180) / Math.PI + 360) % 360)}°` : ""}.`; };
  const poke = (label: string, ch: number, param: number, cls: string, hint: string) => (
    <button key={label} className={`poke ${cls}`} disabled={!!busy || !fly.alive} onClick={() => run(label, () => chain!.coreStimulate(id, ch, param, strength, 16), doneMsg(`${label} ×${strength} applied and 16 steps run`))}>
      <b>{busy === label ? "…" : label}</b><small>{hint}</small></button>
  );
  const cost = prices ? fmtTok(prices.stimPrice * BigInt(strength)) : "…";
  const stimText = cs && cs.stimActive ? `${CH_NAMES[cs.stimChannel] || cs.stimChannel}${cs.stimChannel === CH.CUE ? ` at wedge ${cs.stimParam}` : ""} ×${cs.stimStrength} until step ${fmt(cs.stimUntilStep)}` : "none";
  const who = (by: string) => { const a = String(by || ""); const nm = bodyName(a, allNames); const tag = wallet && a.toLowerCase() === wallet.toLowerCase() ? " · you" : fly.body !== "0x0000000000000000000000000000000000000000" && a.toLowerCase() === fly.body.toLowerCase() ? " · its body" : a.toLowerCase() === fly.owner.toLowerCase() ? " · owner" : ""; return <span className="who" title={a}>{nm}{tag}</span>; };
  const row = (e: Ev, i: number) => {
    const a = e.args; let act = "tick", txt: React.ReactNode = e.name;
    if (e.name === "Ticked") txt = <>ran <b>{String(a.steps)} steps</b> from step {fmt(a.fromStep)} · {fmt(a.spikes)} spikes · heading {Math.round(((Math.atan2(Number(a.headY), Number(a.headX)) * 180) / Math.PI + 360) % 360)}°</>;
    else if (e.name === "Stimulated") { act = "stim"; const free = BigInt(a.tokensBurned) === BigInt(0); txt = <><b>{CH_NAMES[Number(a.channel)] || String(a.channel)}{Number(a.channel) === CH.CUE ? ` at wedge ${a.param}` : ""}</b> ×{String(a.strength)} until step {fmt(a.untilStep)} · {free ? "free: sensed by its body" : `${fmtTok(a.tokensBurned)} $FLY burned`}</>; }
    else if (e.name === "Seeded") { act = "life"; txt = <><b>seeded</b> from FlyBrain v2 at step {fmt(a.step)}</>; }
    return (<div className="lrow" key={e.tx + i + e.name}>
      <a className="blk" href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">block {e.block}</a>
      <span className={`act ${act}`}>{act}</span><span className="ev">{txt}</span>{e.name === "Seeded" ? <span className="who">curator</span> : who(a.by)}</div>);
  };
  const fresh = cs && cs.step === 0 && !cs.stimActive;
  const pebble = isCoreOnlyBody(fly.body);

  return (
    <div id="core" style={{ marginTop: 44 }}>
      <div className="fig-head core-head">
        <div><div className="num">Figure · on-chain core · #{pad(id)}</div><h2>This fly&apos;s own 155 neurons, inside the contract</h2></div>
        <p className="cap"><b>Fig. |</b> The whole brain above is anchored to the chain by hashes. This part needs no anchoring: the fly&apos;s head-direction ring (EPG, PEG, PEN and Δ7 cells from FlyWire) runs spike by spike inside <code>FlyCore</code>, one 155-neuron state per fly. Its body cues it with what the fly senses, for free; anyone else may poke it by burning $FLY; anyone may tick it for gas. {pebble ? <>Right now its body is <b>{bodyName(fly.body, allNames)}</b>, a <Link href="/docs/pebbles/">pebble</Link>: it runs only this core, and the whole brain sleeps until a whole-brain body takes the fly back.</> : fresh ? "This core has not run yet: every neuron at rest at step 0. The first stimulus or tick starts it." : `Step ${fmt(cs?.step || 0)}, ${fmt(cs?.totalSpikes || 0)} spikes so far.`}</p>
      </div>
      {err && <div className="banner">{err}</div>}
      <div className="grid2 core-grid">
        <div className="cell">
          <div className="cell-t"><span className="a">a</span><span className="n">Heading</span><span className="r">{heading === null ? "—" : `${heading}°`}{bump >= 0 ? ` · bump at wedge ${bump}` : ""}</span></div>
          <div className="cell-b b-dial"><div className="dial-wrap"><canvas ref={dialRef} onClick={(e) => setWedge(wedgeAt(e))} aria-label="Sixteen-wedge compass of this fly's on-chain core; click a wedge to aim a cue there" /></div></div>
          <div className="cell-cap"><span>wedges: EPG spikes in a bit-exact replay of the next {PREVIEW_STEPS} steps from the on-chain state</span><span style={{ marginLeft: "auto" }}>needle: last on-chain tick · outer ring: memory</span></div>
        </div>
        <div className="stack core-stack">
          <div className="cell">
            <div className="cell-t"><span className="a">b</span><span className="n">State in the contract</span><span className="r">{cs ? `block ${fmt(cs.block)}` : "reading…"}</span></div>
            <div className="core-rows">
              <div className="crow"><span>step</span><span>{cs ? fmt(cs.step) : "—"}</span></div>
              <div className="crow"><span>heading · position</span><span>{cs ? `${heading === null ? "—" : heading + "°"} · ${(cs.posX / 256).toFixed(1)}, ${(cs.posY / 256).toFixed(1)}` : "—"}</span></div>
              <div className="crow"><span>stimulus</span><span>{cs ? stimText : "—"}</span></div>
              <div className="crow"><span>spikes · anchors</span><span>{cs ? `${fmt(cs.totalSpikes)} · ${evs.filter((e) => e.name === "Ticked").length} ticks ${scan && !scan.complete ? "since block " + fmt(scan.from) : scanLabel(scan, EVENTS_BLOCKS)}` : "—"}</span></div>
              <div className="crow"><span>last run by</span><span>{lastTick ? <>{bodyName(String(lastTick.args.by), allNames)} <small className="dim">block {fmt(lastTick.block)}</small></> : "nobody yet"}</span></div>
              <div className="crow"><span>core hash</span><span className="mono" title={cs?.hash}>{cs ? cs.hash.slice(0, 18) + "…" : "—"}</span></div>
            </div>
          </div>
          <div className="cell">
            <div className="cell-t"><span className="a">c</span><span className="n">Poke it</span><span className="r">{isBody ? "gas only · you are its body" : `${cost} $FLY · burned`}</span></div>
            <div className="core-pokes">
              <div className="slider"><label htmlFor="core-strength">strength</label><input id="core-strength" type="range" min={1} max={16} value={strength} onChange={(e) => setStrength(+e.target.value)} /><output>{strength}</output></div>
              <div className="slider"><label htmlFor="core-wedge">cue wedge</label><input id="core-wedge" type="range" min={0} max={15} value={wedge} onChange={(e) => setWedge(+e.target.value)} /><output>{wedge}</output></div>
              <div className="pokes">
                {poke("Landmark", CH.CUE, wedge, "cue", `EPG at wedge ${wedge}`)}
                {poke("Shock", CH.SHOCK, 0, "shock", "all 42 Δ7 cells")}
                {poke("Turn left", CH.TURN_LEFT, 0, "turn", "left PEN cells")}
                {poke("Turn right", CH.TURN_RIGHT, 0, "turn", "right PEN cells")}
              </div>
              <div className="field">
                <button className="btn sm" style={{ flex: 1 }} disabled={!!busy || !fly.alive} onClick={() => run("Tick", () => chain!.coreTick(id, 16), doneMsg("Ran 16 steps"))}>{busy === "Tick" ? "…" : "Tick 16 steps · gas only"}</button>
                {!wallet && <button className="btn sm fill" onClick={connect}>Connect</button>}
              </div>
              <div className="lbl">{!fly.alive ? "dead: its core is frozen until it is resurrected" : isBody ? `${short(wallet)} is the body running this fly` : `a stimulus lasts ${prices ? prices.stimTTL : 64} steps · each poke also runs 16 steps`}</div>
            </div>
          </div>
        </div>
      </div>
      <div className="log-head"><b style={{ fontSize: 13 }}>Core record</b><span className="lbl">every tick and stimulus of this fly&apos;s neurons in the EVM · newest first · last {EVENTS_SHOWN} of {evs.length} {scanLabel(scan, EVENTS_BLOCKS)}</span></div>
      <div className="log-list">
        {evs.length ? evs.slice(0, EVENTS_SHOWN).map(row) : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">{err ? "" : !scan ? "reading BNB Smart Chain…" : scan.complete ? "nothing yet: nobody has run this fly's core" : `nothing since block ${fmt(scan.from)}; the public RPCs would not serve older blocks right now`}</span><span /></div>}
      </div>
    </div>
  );
}
