"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CFG } from "@/lib/config";
import { Chain, LogScan, LifeInfo } from "@/lib/chain";
import { FlyRecord, RegistryInfo, Ev, ZERO, fmt, fmtTok, short, hms, dur, ipfs, pad, status, bodyName, bodyNote, hostOrigin, colonyOrigin, isCoreOnlyBody, isColonyBody, scanLabel, mergeEvents, inBody } from "@/lib/registry";
import { RecordList } from "@/components/Record";
import Core from "@/components/Core";
import KeepAlive from "@/components/KeepAlive";
import LifeStream, { probeHost, HostHealth } from "@/components/LifeStream";
import { ColonyFigure } from "@/components/Colony";
import { probeColonyFly } from "@/lib/colony";

const EVENTS_BLOCKS = 80000;
const HOST_POLL_MS = 60000;
/** The brain host is asked whether it runs this fly when the fly is alive in a pebble (a registered body that is
 *  neither the arena nor DOOM); with the NEXT_PUBLIC_HOST_URL override set (local development) for any living fly. */
const hostCandidate = (f: FlyRecord) => f.alive && (isCoreOnlyBody(f.body) || !!CFG.hostOverride);
/** The Colony (COLONY.md) is asked whether it streams this fly when the fly is alive in the Colony; with the
 *  NEXT_PUBLIC_COLONY_URL override set (local development) for any living fly, whatever body the registry names. */
const colonyCandidate = (f: FlyRecord) => f.alive && (isColonyBody(f.body) || !!CFG.colonyOverride);
type ColonyAnswer = { id: number; origin: string; serves: boolean | null };
/** What the host said about fly `id`: serves is null until it has been asked. The answer is keyed by the fly it is
 *  about, so after a same-route navigation (a parent or child link) the previous fly's answer renders as "not asked". */
type Host = { id: number; origin: string; serves: boolean | null; health: HostHealth | null };
const notAsked = (id: number): Host => ({ id, origin: "", serves: null, health: null });

export default function Specimen() {
  const sp = useSearchParams(); const id = Math.max(0, parseInt(sp.get("id") || "1", 10) || 0);
  const chainRef = useRef<Chain | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);   // the same object, as state, for children that render from it
  const [f, setF] = useState<FlyRecord | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [info, setInfo] = useState<RegistryInfo | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [scan, setScan] = useState<LogScan | null>(null);
  const [life, setLife] = useState<LifeInfo | null>(null);   // its standing with the LifeFund, as KeepAlive reads it
  const [children, setChildren] = useState<{ id: number; name: string }[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [, setLiveUrl] = useState("");
  const [hostAnswer, setHost] = useState<Host>(notAsked(id));
  const [colonyAnswer, setColony] = useState<ColonyAnswer>({ id, origin: "", serves: null });
  const colonyUri = useRef("");   // bodies(colony).uri, the last resort for the Colony's origin
  // Is the Colony a registered body yet? assign(id, Colony) reverts with NotRegistered() until its supervisor registers
  // it (COLONY.md), so the picker offers it only when the registry says yes; null until the registry has answered.
  const [colonyOpen, setColonyOpen] = useState<boolean | null>(null);
  /** What the registry said; a Colony that is not a body cannot stay picked in the select (the wallet would only see a revert). */
  const noteColonyOpen = (yes: boolean) => { setColonyOpen(yes); if (!yes) setTarget((t) => (t === CFG.bodies.colony ? CFG.bodies.arena : t)); };
  const misses = useRef(0);   // consecutive health probes the host did not answer, for the fly shown now
  const shown = useRef(id);   // the fly this page shows now; an answer still in flight for another one (a same-route navigation) is dropped
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [secs, setSecs] = useState("600");
  const [resSecs, setResSecs] = useState("1800");
  const [target, setTarget] = useState(CFG.bodies.arena);
  const [custom, setCustom] = useState("");
  const [partner, setPartner] = useState("");
  const [childName, setChildName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setT] = useState<string | null>(null);
  const tt = useRef<any>(null);
  const setToast = (m: string, ms = 6000) => { setT(m); clearTimeout(tt.current); tt.current = setTimeout(() => setT(null), ms); };

  const stale = () => shown.current !== id;   // the page moved on to another fly while this closure's work was in flight
  const refresh = async (ch: Chain) => {
    ch.isBody(CFG.bodies.colony).then((yes) => !stale() && noteColonyOpen(yes)).catch(() => {});   // the registry's own test, refreshed with the record
    const rec = await ch.flyRecord(id); if (stale()) return; setF(rec);
    const probing = Promise.all([probe(ch, rec), probeColony(rec)]);   // alongside the event scans, which can take seconds on the public RPCs
    if (rec.uri && rec.uri.startsWith("ipfs://")) ch.metadataOf(rec.uri).then((m) => m && !stale() && setMeta(m));
    // one scan of the registry serves both lists (the second call reads from the first one's cache); the LifeFund's
    // record of this fly (sponsored, kept, granted) is one small request and joins the registry's rows by block
    const [{ events: mine, scan: sc }, { events: all }, { events: fund }] = await Promise.all([ch.registryEvents(EVENTS_BLOCKS, id), ch.registryEvents(EVENTS_BLOCKS), ch.lifeEvents(EVENTS_BLOCKS, id).catch(() => ({ events: [] as Ev[] }))]);
    if (stale()) return;
    setEvents(mergeEvents(mine, fund)); setScan(sc);
    setChildren(all.filter((e) => e.name === "Minted" && (Number(e.args.parentA) === id || Number(e.args.parentB) === id)).map((e) => ({ id: Number(e.args.id), name: e.args.name })));
    const bodies = new Set<string>(); for (const e of mine) { if (e.args.body) bodies.add(String(e.args.body).toLowerCase()); }
    for (const b of [rec.body, rec.pendingBody]) if (b && b !== ZERO) bodies.add(b.toLowerCase());
    const nm: Record<string, string> = {}; for (const b of bodies) { try { const bi = await ch.bodyInfo(b); if (bi.name) nm[b] = bi.name; if (b === CFG.bodies.arena.toLowerCase() && /^https:\/\//.test(bi.uri)) setLiveUrl(bi.uri); if (b === CFG.bodies.colony.toLowerCase()) colonyUri.current = bi.uri; } catch {} }
    if (stale()) return;
    setNames(nm);
    await probing;
  };
  /** Is the whole brain of this fly running on the brain host? bodies(host).uri names the host's origin (or the
   *  development override does); its /fly/<id>/health answers for the flies it runs. Anything else means "core only". */
  const probe = async (ch: Chain, rec: FlyRecord) => {
    if (stale()) return;
    if (!hostCandidate(rec)) { misses.current = 0; setHost(notAsked(id)); return; }
    let origin = "";
    try { origin = hostOrigin(CFG.hostOverride ? "" : (await ch.bodyInfo(CFG.bodies.host)).uri); } catch {}
    const { ok, health } = origin ? await probeHost(origin, id) : { ok: false, health: null };
    if (stale()) return;   // an answer about the previous fly must not touch this one's miss count
    // one missed answer (a slow tunnel) does not take a running stream down: the stream reconnects by itself; two in a
    // row do. Only this fly's own previous answer is kept: the one shown before a navigation says nothing about it.
    misses.current = ok ? 0 : misses.current + 1;
    setHost((prev) => (ok ? { id, origin, serves: true, health } : prev.id === id && prev.serves && prev.origin === origin && misses.current < 2 ? prev : { id, origin, serves: false, health: null }));
  };
  /** Does the Colony stream this fly? Its origin is fixed (or overridden); /fly/<id>/health answers for the flies it
   *  runs. A fly whose body is the Colony but which the Colony does not serve is waiting for a spot (or the Colony is down). */
  const probeColony = async (rec: FlyRecord) => {
    if (stale()) return;
    if (!colonyCandidate(rec)) { setColony({ id, origin: "", serves: null }); return; }
    const origin = colonyOrigin(colonyUri.current);
    const ok = origin ? await probeColonyFly(origin, id) : false;
    if (stale()) return;
    setColony({ id, origin, serves: ok });
  };
  useEffect(() => {
    if (!id) return;
    shown.current = id; misses.current = 0;   // another fly on the same route: what was in flight for the last one is dropped
    setLife(null);
    (async () => {
      try { const ch = await new Chain().connectRead(); chainRef.current = ch; setChain(ch); setInfo(await ch.registryInfo()); await refresh(ch); }
      catch (e: any) { setErr(e.reason === "ERC721NonexistentToken" || /nonexistent/i.test(e.message || "") ? `Fly #${id} has not been minted.` : "Could not read this fly: " + (e.shortMessage || e.message)); }
    })();
    return () => clearTimeout(tt.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // the host comes and goes (a tunnel restart re-registers its uri): ask again every minute while the page is visible
  useEffect(() => {
    if (!f || !hostCandidate(f)) return;
    const t = setInterval(() => { const ch = chainRef.current; if (ch && document.visibilityState === "visible") probe(ch, f).catch(() => {}); }, HOST_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f?.alive, f?.body, id]);
  // the Colony accepts a queued fly when a spot frees up: ask again every minute while the page is visible
  useEffect(() => {
    if (!f || !colonyCandidate(f)) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") probeColony(f).catch(() => {}); }, HOST_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f?.alive, f?.body, id]);

  const connect = async () => {
    const ch = chainRef.current; if (!ch) return setToast("Not connected to BNB Chain.");
    try { const a = await ch.connectWallet(); setWallet(a); setBal(fmtTok(await ch.balance()) + " FLY"); } catch (e: any) { setToast(e.shortMessage || e.message); }
  };
  const run = async (label: string, fn: () => Promise<any>, done: (rc: any) => string) => {
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first.");
    setBusy(true);
    try { setToast(`${label}: confirm in your wallet…`, 120000); const rc = await fn(); await refresh(ch); setInfo(await ch.registryInfo()); setBal(fmtTok(await ch.balance()) + " FLY"); setToast(done(rc), 10000); }
    catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 9000); } finally { setBusy(false); }
  };
  const feed = () => { const n = Math.floor(Number(secs) || 0); if (n < 1) return setToast("At least one second."); run("Feed", () => chainRef.current!.feedFly(id, n, info!.feed), (rc) => `Fed ${fmt(n)} s of life in block ${fmt(rc.blockNumber)}. ${f?.body !== ZERO ? "The body places it as food; the fly has to find it." : "Banked until a body runs it."}`); };
  const resurrect = () => { const n = Math.floor(Number(resSecs) || 0); if (n < 60) return setToast("Give it at least 60 seconds to wake up with."); run("Resurrect", () => chainRef.current!.resurrectFly(id, n, info!.res, info!.feed), (rc) => `Resurrected in block ${fmt(rc.blockNumber)}. Now hand it to a body.`); };
  const assign = async () => {
    const to = target === "custom" ? custom.trim() : target; if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return setToast("That is not an address.");
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first.");
    // the registry's own check, made here first: an unregistered body is a sentence on the page, not a transaction that
    // reverts with NotRegistered() in the wallet. When the RPC cannot answer, the chain decides as before.
    setBusy(true); let registered = true; try { registered = await ch.isBody(to); } catch {} finally { setBusy(false); }
    if (!registered) { if (isColonyBody(to)) noteColonyOpen(false); return setToast(isColonyBody(to) ? "The Colony is not open yet: its body has not registered on the registry (its supervisor does that when it starts). Until then no fly can be handed to it." : `${short(to)} is not a registered body: the registry would refuse the hand-off (NotRegistered).`, 10000); }
    run("Assign", () => ch.assignFly(id, to), (rc) => `Assigned to ${bodyName(to, names)} in block ${fmt(rc.blockNumber)}. It moves as soon as that body accepts and instantiates the brain.`);
  };
  const breed = () => { const p = parseInt(partner, 10); if (!p || p === id) return setToast("Choose another fly you own."); const nm = childName.trim().slice(0, 40); if (!nm) return setToast("Name the child."); run("Breed", () => chainRef.current!.breedFlies(id, p, nm, info!.breed), (rc) => `A child was born in block ${fmt(rc.blockNumber)}.`); };

  if (!id) return <main className="wrap" style={{ padding: "60px 0" }}><p>Which fly? <Link href="/flies/">See the collection.</Link></p></main>;
  // the host's answer about the fly shown now; after a same-route navigation the previous fly's answer is not it, so
  // no live figure, "Watch it live" or "whole brain on the brain host" carries over to a fly the host does not run
  const host = hostAnswer.id === id ? hostAnswer : notAsked(id);
  const hostServes = host.serves === true;
  // the Colony figure: the fly's body is the Colony (streaming or waiting for a spot), or the override says the Colony runs it
  const colony = colonyAnswer.id === id ? colonyAnswer : { id, origin: "", serves: null };
  const inColony = !!f && f.alive && (isColonyBody(f.body) || colony.serves === true);
  const s = f ? status(f, names, host.serves) : null; const isOwner = !!(wallet && f && wallet.toLowerCase() === f.owner.toLowerCase());
  const bn = f ? bodyNote(f, host.serves, names) : null;
  // the body's name for the life figure: the registry's, else what the host says it is (a development override can run a dormant fly)
  const lifeBody = (f && f.body !== ZERO ? bodyName(f.body, names) : host.health?.body ? bodyName(String(host.health.body), names) : "") || "—";
  // where the keeper's food lands, for the "Keep it alive" column: the body's name, or nothing for a dormant fly
  const where = f && f.alive ? inBody(f.body, names) : "";
  const commits = events.filter((e) => e.name === "Commit").length, jumps = events.filter((e) => e.name === "Interaction" && /jumped/.test(String(e.args.data))).length;
  return (
    <main>
      <section className="sec spec" style={{ paddingTop: "clamp(30px, 4vw, 48px)" }}>
        <div className="wrap">
          <p className="crumbs"><Link href="/flies/">Immortal Fruit Flies</Link> <span>/</span> <span className="mono">#{pad(id)}</span></p>
          {err && <div className="banner">{err}</div>}
          <div className="spec-head">
            <div className={`portrait lg ${s?.key || ""}`}>{meta?.image ? <img src={ipfs(meta.image)} alt={`Portrait of ${f?.name}`} /> : <span className="lbl">{f ? "portrait pending" : "…"}</span>}</div>
            <div>
              <div className="num" style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--red)", marginBottom: 8 }}>Specimen {pad(id)} {s && <span className={`pill ${s.key}`} style={{ marginLeft: 10 }}>{s.label}</span>}</div>
              <h1 style={{ fontSize: "clamp(28px, 4vw, 46px)", letterSpacing: "-0.035em" }}>{f ? f.name || `Fly #${id}` : "…"}</h1>
              {s && <p className="serif" style={{ fontSize: 16.5, color: "var(--ink-2)", marginTop: 12, maxWidth: "52ch" }}>{s.note}. {f && f.parentA ? <>Child of <Link href={`/fly/?id=${f.parentA}`}>#{pad(f.parentA)}</Link> and <Link href={`/fly/?id=${f.parentB}`}>#{pad(f.parentB)}</Link>.</> : "A genesis fly: fresh brain, no parents."} {f && f.deaths > 0 ? `It has died ${f.deaths} time${f.deaths === 1 ? "" : "s"} and been brought back each time from the exact state it died in.` : ""}</p>}
              <div className="acts" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
                <a className="btn sm" href={`${CFG.market.asset}/${id}`} target="_blank" rel="noopener">Buy / sell on {CFG.market.name} ↗</a>
                {f && f.body.toLowerCase() === CFG.bodies.arena.toLowerCase() && <Link className="btn sm" href="/#organism">Watch it live</Link>}
                {f && hostServes && <a className="btn sm" href="#life">Watch it live</a>}
                {inColony && <a className="btn sm" href="#colony">Watch it in the Colony</a>}
                {f && f.stateURI && <a className="btn sm plain" href={ipfs(f.stateURI)} target="_blank" rel="noopener">Brain snapshot (IPFS) ↗</a>}
                <a className="btn sm plain" href={`${CFG.explorer}/token/${CFG.registry}?a=${id}`} target="_blank" rel="noopener">BscScan →</a>
              </div>
            </div>
            <aside className="chart" style={{ paddingBottom: 0 }}>
              <div className="chart-t"><b>Record</b><span className="lbl">from the registry</span></div>
              <div className="crow"><span>owner</span><span><a href={`${CFG.explorer}/address/${f?.owner}`} target="_blank" rel="noopener">{f ? short(f.owner) : "—"}</a>{isOwner ? " (you)" : ""}</span></div>
              <div className="crow"><span>body</span><span>{f && bn ? (f.body !== ZERO ? (bn.kind === "host" || bn.kind === "core" ? <>{bn.name} <Link href="/docs/pebbles/" className="dim" title={bn.title}>{bn.tag}</Link></> : bn.kind === "colony" ? <>{bn.name} <Link href="/colony/" className="dim" title={bn.title}>{bn.tag}</Link></> : bn.label) : f.pendingBody !== ZERO ? `→ ${bodyName(f.pendingBody, names)} (pending)` : "none") : "—"}</span></div>
              <div className="crow"><span>energy at last checkpoint</span><span>{f ? hms(f.energy) : "—"}</span></div>
              <div className="crow"><span>sponsored life</span><span title="Seconds of life paid for in BNB and not yet fed; the keeper feeds it from this while it lives somewhere">{life ? (life.credit ? `${dur(life.credit)} left` : "none") : "—"}</span></div>
              <div className="crow"><span>fed by the fund</span><span title="Everything the LifeFund has ever fed this fly, sponsored and free">{life ? (life.fedTotal ? dur(life.fedTotal) : "nothing yet") : "—"}</span></div>
              <div className="crow"><span>generation · deaths</span><span>{f ? `${f.generation} · ${f.deaths}` : "—"}</span></div>
              <div className="crow"><span>brain step</span><span>{f ? fmt(f.brainStep) : "—"}<small className="dim"> ({f ? (f.brainStep / 10000).toFixed(0) : "—"} s lived)</small></span></div>
              <div className="crow"><span>checkpoints · jumps</span><span>{events.length ? `${commits} · ${jumps}` : "—"}</span></div>
              <div className="crow"><span>born · last commit</span><span>{f ? `${fmt(f.bornBlock)} · ${f.lastCommitBlock ? fmt(f.lastCommitBlock) : "—"}` : "—"}</span></div>
              <div className="crow"><span>brain state</span><span className="mono" title={f?.stateRoot}>{f ? f.stateRoot.slice(0, 18) + "…" : "—"}</span></div>
              <div className="crow"><span>memory</span><span className="mono" title={f?.memoryRoot}>{f ? f.memoryRoot.slice(0, 18) + "…" : "—"}</span></div>
              <div className="crow"><span>connectome · model</span><span className="mono" title={f?.connectome}>{f ? `${f.connectome.slice(0, 12)}… · v${f.model}` : "—"}</span></div>
            </aside>
          </div>

          <div className="care-grid" style={{ marginTop: 44 }}>
            <KeepAlive key={id} id={id} alive={!!f && f.alive} where={where} chain={chain} wallet={wallet} connect={connect} toast={setToast} onSponsored={() => refresh(chainRef.current!)} onInfo={(li) => !stale() && setLife(li)}>
              <div className="care-t"><h3 style={{ fontSize: 13.5 }}>Feed it $FLY</h3><span className="cost">{info ? `${fmtTok(info.feed)} $FLY = 1 s` : ""}</span></div>
              <p>{f && f.body !== ZERO ? (bn?.kind === "core" ? `${bodyName(f.body, names)} hears it at its next poll and refills its energy bar.` : bn?.kind === "host" ? `The brain host drops it as food near the fly at its next poll, and ${bodyName(f.body, names)} chirps; the fly has to smell its way there.` : bn?.kind === "colony" ? "The Colony drops it as bread near the fly in the world at its next poll, 5 s a loaf; the fly has to smell its way there and eat." : `Food appears in ${bodyName(f.body, names)} at the next poll; the fly has to smell its way there.`) : "Banked as energy until a body runs it."} Anyone may feed any fly; this burns your own $FLY, one per second.</p>
              <div className="field"><input type="number" min={1} value={secs} onChange={(e) => setSecs(e.target.value)} aria-label="Seconds of life" /><button className="btn" disabled={busy || !f || !f.alive} onClick={wallet ? feed : connect}>{busy ? "…" : wallet ? "Feed" : "Connect"}</button></div>
              <div className="lbl">= {Number(secs) ? hms(Number(secs)) : "—"} of life · {wallet ? `${short(wallet)} · ${bal}` : ""}</div>
            </KeepAlive>
            <div className="care-col">
              {f && !f.alive ? (<>
                <div className="care-t"><h3>Resurrect</h3><span className="cost">{info ? `${fmtTok(info.res)} $FLY + food` : ""}</span></div>
                <p>The brain continues from the exact state it died in, as generation {f.generation + 1}. Anyone may pay. Until then it cannot be transferred or sold.</p>
                <div className="field"><input type="number" min={60} value={resSecs} onChange={(e) => setResSecs(e.target.value)} aria-label="Seconds of food to wake up with" /><button className="btn fill" disabled={busy} onClick={wallet ? resurrect : connect}>{busy ? "…" : wallet ? "Resurrect" : "Connect"}</button></div>
                <div className="lbl">wakes with {Number(resSecs) ? hms(Number(resSecs)) : "—"} · minimum 60 s</div>
              </>) : (<>
                <div className="care-t"><h3>Hand it to a body</h3><span className="cost">owner or current body</span></div>
                <p>A body downloads the last committed brain, checks its hash, and runs it. The arena streams live; the <Link href="/colony/">Colony</Link> puts it in a shared Minecraft world with the other flies{colonyOpen === false ? " (not open yet: its body has not registered on the registry)" : ""}; DOOM sessions are run by the operator.</p>
                <div className="field">
                  <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Body"><option value={CFG.bodies.arena}>Arena (live, streams here)</option><option value={CFG.bodies.colony} disabled={colonyOpen === false}>{colonyOpen === false ? "Colony (not open yet: not a registered body)" : "Colony (Minecraft, shared world)"}</option><option value={CFG.bodies.doom}>DOOM</option><option value="custom">Another body address…</option></select>
                  <button className="btn" disabled={busy || !isOwner} onClick={assign} title={isOwner ? "" : "Only the owner (or the body running it) may do this"}>Assign</button>
                </div>
                {target === "custom" && <input className="text" placeholder="0x… a registered body" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Body address" />}
                <div className="lbl">{isOwner ? "you own this fly" : wallet ? "not your fly" : "connect the owner wallet"}</div>
              </>)}
            </div>
            <div className="care-col">
              <div className="care-t"><h3>Breed</h3><span className="cost">{info ? `${fmtTok(info.breed)} $FLY` : ""}</span></div>
              <p>Two living flies you own produce a child with a fresh brain and both parents in its lineage. Memory inheritance arrives with mushroom-body plasticity (see roadmap).</p>
              <div className="field"><input type="number" min={1} placeholder="partner #" value={partner} onChange={(e) => setPartner(e.target.value)} aria-label="Partner fly id" /><input className="text" placeholder="child’s name" value={childName} onChange={(e) => setChildName(e.target.value)} aria-label="Child name" /><button className="btn" disabled={busy || !isOwner || !f?.alive} onClick={breed}>Breed</button></div>
              <div className="lbl">{children.length ? <>children: {children.map((c) => <Link key={c.id} href={`/fly/?id=${c.id}`} style={{ marginRight: 8 }}>#{pad(c.id)} {c.name}</Link>)}</> : "no children yet"}</div>
            </div>
          </div>

          {f && hostServes && host.origin && <LifeStream id={id} origin={host.origin} body={lifeBody} />}

          {f && inColony && <ColonyFigure id={id} origin={colony.origin || colonyOrigin()} fly={f} serves={colony.serves === true} />}

          {CFG.core && f && <Core id={id} fly={f} chain={chain} wallet={wallet} connect={connect} toast={setToast} names={names} hostServes={hostServes} />}

          <div style={{ marginTop: 44 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Interaction history</b><span className="lbl">every body it has lived in · newest first · {events.length} events {scanLabel(scan, EVENTS_BLOCKS)}</span></div>
            <RecordList events={events} names={names} empty={err ? "" : !scan ? "reading BNB Smart Chain…" : scan.complete ? "no events yet" : `no events since block ${fmt(scan.from)}; the public RPCs would not serve older blocks right now`} />
          </div>
          {meta?.attributes && <div style={{ marginTop: 34 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Token metadata</b><span className="lbl">as marketplaces read it · <a href={ipfs(f?.uri || "")} target="_blank" rel="noopener">{f?.uri.slice(0, 30)}…</a></span></div>
            <div className="chips" style={{ marginTop: 12 }}>{meta.attributes.map((a: any, i: number) => <span key={i} className="chip"><span className="lbl">{a.trait_type}</span><b>{String(a.value)}</b></span>)}</div>
          </div>}
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
