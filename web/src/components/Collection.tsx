"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CFG } from "@/lib/config";
import { Chain, LogScan } from "@/lib/chain";
import { ethers } from "ethers";
import { FlyRecord, RegistryInfo, Ev, ZERO, fmt, fmtTok, fmtBnb, short, hms, dur, ipfs, pad, status, bodyName, isCoreOnlyBody, scanLabel, secondsFor, bnbPerDay } from "@/lib/registry";
import { RecordList } from "@/components/Record";
import { IdxFly, Leaders, Filter, Sort, FILTERS, SORTS, fetchAll, fetchLeaders, fetchOwned, portraitUrl, select, toRecord } from "@/lib/index";

const PAGE = 48;
const EVENTS_BLOCKS = 60000;
/** Owned-flies fallback when the index is down: the chain, one ownerOf per id, only this many newest ids (a browser cannot do 3,000). */
const OWNED_FALLBACK = 400;

export function FlyCard({ f, meta, names, img }: { f: FlyRecord; meta?: any; names?: Record<string, string>; img?: string }) {
  const s = status(f, names);
  const src = img || (meta?.image ? ipfs(meta.image) : "");
  return (
    <Link href={`/fly/?id=${f.id}`} className={`fly-card ${s.key}`}>
      <div className="portrait">{src ? <img src={src} alt={`Portrait of ${f.name}`} loading="lazy" /> : <span className="lbl">portrait pending</span>}</div>
      <div className="fc-b">
        <div className="fc-t"><span className="mono">#{pad(f.id)}</span><span className={`pill ${s.key}`}>{s.label}</span></div>
        <b>{f.name || `Fly #${f.id}`}</b>
        <span className="fc-m">{f.alive ? (f.body !== ZERO ? `in ${bodyName(f.body, names)}${isCoreOnlyBody(f.body) ? " (a pebble)" : ""} · ${hms(f.energy)} at last checkpoint` : `${hms(f.energy)} banked`) : `died ${f.deaths}× · gen ${f.generation}`}</span>
        <span className="fc-m dim">gen {f.generation} · step {fmt(f.brainStep)} · {f.parentA ? `child of #${f.parentA} × #${f.parentB}` : "genesis"}</span>
      </div>
    </Link>
  );
}

/** One list of the hall: a title, a unit, up to five flies with a number each. */
function Board({ title, unit, rows, fmtValue, note }: { title: string; unit: string; rows: { id: number; name: string; alive: boolean; value: number }[]; fmtValue?: (v: number) => string; note?: string }) {
  return (
    <div>
      <h3>{title}</h3>
      <p>{note || unit}</p>
      <ol className="board">
        {rows.slice(0, 5).map((r, i) => (
          <li key={r.id}><span className="rank">{i + 1}</span><Link href={`/fly/?id=${r.id}`}><span className="mono">#{pad(r.id)}</span> {r.name || `Fly #${r.id}`}{r.alive ? "" : " †"}</Link><span className="val mono">{fmtValue ? fmtValue(r.value) : fmt(r.value)}</span></li>
        ))}
        {!rows.length && <li className="dim">none yet</li>}
      </ol>
    </div>
  );
}

export default function Collection() {
  const sp = useSearchParams();
  const chainRef = useRef<Chain | null>(null);
  const [info, setInfo] = useState<RegistryInfo | null>(null);
  const [leaders, setLeaders] = useState<Leaders | null>(null);
  const [all, setAll] = useState<IdxFly[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [indexDown, setIndexDown] = useState(false);
  // the chain's own page of newest flies: the fallback grid when the index cannot be read
  const [flies, setFlies] = useState<FlyRecord[]>([]);
  const [metas, setMetas] = useState<Record<number, any>>({});
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>((sp.get("filter") as Filter) || "all");
  const [sort, setSort] = useState<Sort>((sp.get("sort") as Sort) || "newest");
  const [q, setQ] = useState(sp.get("q") || "");
  const [ownerFilter, setOwnerFilter] = useState((sp.get("owner") || "").toLowerCase());
  const [events, setEvents] = useState<Ev[]>([]);
  const [scan, setScan] = useState<LogScan | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const looked = useRef(new Set<string>());
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [mine, setMine] = useState<IdxFly[] | null>(null);
  const [mineNote, setMineNote] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setT] = useState<string | null>(null);
  const tt = useRef<any>(null);
  const setToast = (m: string, ms = 6000) => { setT(m); clearTimeout(tt.current); tt.current = setTimeout(() => setT(null), ms); };

  /** Names of bodies other than the arena and DOOM (pebbles register as "Pebble N"): one bodies() call per new address, cached. */
  const learnNames = async (ch: Chain, addrs: Iterable<string>) => {
    const todo = new Set<string>(); for (const a of addrs) { const l = String(a || "").toLowerCase(); if (l && l !== ZERO && isCoreOnlyBody(l) && !looked.current.has(l)) todo.add(l); }
    const found: Record<string, string> = {};
    for (const a of todo) { looked.current.add(a); try { const b = await ch.bodyInfo(a); if (b.name) found[a] = b.name; } catch {} }
    if (Object.keys(found).length) setNames((o) => ({ ...o, ...found }));
  };
  const loadPage = async (ch: Chain, total: number, p: number) => {
    const ids: number[] = []; for (let i = total - p * 24; i > Math.max(0, total - (p + 1) * 24); i--) ids.push(i);
    const recs = (await Promise.all(ids.map((i) => ch.flyRecord(i).catch(() => null)))).filter(Boolean) as FlyRecord[];
    setFlies(recs);
    learnNames(ch, recs.flatMap((f) => [f.body, f.pendingBody])).catch(() => {});
    recs.forEach(async (f) => { if (f.uri && f.uri.startsWith("ipfs://")) { const m = await ch.metadataOf(f.uri); if (m) setMetas((o) => ({ ...o, [f.id]: m })); } });
  };
  /** The flies a wallet owns: the index in one request, else the chain for the newest ids only (and a note saying so). */
  const loadMine = async (ch: Chain, a: string, total: number) => {
    const idx = await fetchOwned(a);
    if (idx) { setMine(idx); setMineNote(""); return; }
    const ids = await ch.ownedFlies(a, Math.min(total, OWNED_FALLBACK));
    const recs = (await Promise.all(ids.map((i) => ch.flyRecord(i).catch(() => null)))).filter(Boolean) as FlyRecord[];
    setMine(recs.map((f) => ({ id: f.id, name: f.name, owner: f.owner.toLowerCase(), gen: f.generation, deaths: f.deaths, pa: f.parentA, pb: f.parentB, step: f.brainStep, energy: f.energy, born: f.bornBlock, commit: f.lastCommitBlock, body: f.body === ZERO ? "" : f.body.toLowerCase(), pending: f.pendingBody === ZERO ? "" : f.pendingBody.toLowerCase(), alive: f.alive, state: f.stateRoot })));
    setMineNote(total > OWNED_FALLBACK ? `The index is not answering, so only the newest ${fmt(OWNED_FALLBACK)} flies were checked against your wallet.` : "");
  };

  useEffect(() => {
    (async () => {
      // the index first: one round trip carries everything the grid and the hall need; the chain's own page of the
      // newest flies is read only when the index cannot be
      const [ld, alld] = await Promise.all([fetchLeaders(), fetchAll()]);
      if (ld) setLeaders(ld);
      if (alld) { setAll(alld.flies); setBodies(alld.bodies || {}); }
      const down = !ld || !alld; if (down) setIndexDown(true);
      try {
        const ch = await new Chain().connectRead(); chainRef.current = ch;
        const ri = await ch.registryInfo(); setInfo(ri);
        if (down) await loadPage(ch, ri.total, 0);
        const { events: evs, scan: sc } = await ch.registryEvents(EVENTS_BLOCKS); setEvents(evs); setScan(sc);
        learnNames(ch, evs.map((e) => e.args.body).filter(Boolean)).catch(() => {});
      } catch (e: any) { setErr("Could not reach BNB Smart Chain: " + (e.shortMessage || e.message)); }
    })();
    return () => clearTimeout(tt.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const ch = chainRef.current; if (ch && info && indexDown) loadPage(ch, info.total, page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0); }, [filter, sort, q, ownerFilter]);

  const connect = async () => {
    const ch = chainRef.current; if (!ch) return setToast("Not connected to BNB Chain.");
    try { const a = await ch.connectWallet(); setWallet(a); setBal(fmtTok(await ch.balance()) + " FLY"); if (info && a) await loadMine(ch, a, info.total); } catch (e: any) { setToast(e.shortMessage || e.message); }
  };
  const mint = async () => {
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first."); if (!info) return;
    const nm = name.trim().slice(0, 40); if (!nm) return setToast("Give it a name.");
    setBusy(true);
    try {
      setToast("Mint: confirm in your wallet (approve $FLY once, then mint)…", 120000);
      const rc = await ch.mintFly(nm, info.mint);
      const ri = await ch.registryInfo(); setInfo(ri); setBal(fmtTok(await ch.balance()) + " FLY");
      // the index reads the chain once a minute; the new fly is shown from the chain until then
      const rec = await ch.flyRecord(ri.total).catch(() => null);
      if (rec) setMine((m) => [{ id: rec.id, name: rec.name, owner: rec.owner.toLowerCase(), gen: 0, deaths: 0, pa: 0, pb: 0, step: 0, energy: rec.energy, born: rec.bornBlock, commit: rec.lastCommitBlock, body: "", pending: "", alive: true, state: rec.stateRoot }, ...(m || [])]);
      setToast(`Fly #${ri.total} “${nm}” is alive, block ${fmt(rc.blockNumber)}. Its portrait is drawn within a minute; then assign it to a body from its page.`, 12000); setName("");
    } catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 9000); } finally { setBusy(false); }
  };

  // the browse grid: the index filtered in the browser, paged
  const rows = useMemo(() => (all ? select(all, filter, sort, q, ownerFilter, bodies) : []), [all, filter, sort, q, ownerFilter, bodies]);
  const pages = all ? Math.ceil(rows.length / PAGE) : info ? Math.ceil(info.total / 24) : 0;
  const shown = all ? rows.slice(page * PAGE, (page + 1) * PAGE) : [];
  const dayFor = info ? dur(secondsFor(ethers.parseEther("0.01"), info.lifeWeiPerSecond)) : "24 h";   // what 0.01 BNB buys at the registry's price
  const T = leaders?.totals;
  const mineAlive = mine ? mine.filter((f) => f.alive).length : 0, mineRunning = mine ? mine.filter((f) => f.alive && f.body).length : 0, mineDead = mine ? mine.filter((f) => !f.alive).length : 0;
  const mineHungry = mine ? mine.filter((f) => f.alive && f.energy < 1800) : [];

  return (
    <main>
      <section className="sec" id="collection" style={{ paddingTop: "clamp(30px, 4vw, 48px)" }}>
        <div className="wrap">
          <div className="sec-t">
            <div><div className="num">The collection · ERC-721 on BNB Smart Chain</div><h2>Immortal Fruit Flies</h2></div>
            <p>Each token is a whole fruit-fly brain: the FlyWire connectome, 139,248 neurons, with its own state, memory, lineage and history anchored on-chain forever. Mint one for 1 $FLY and it wakes with an hour of life. Hand it to a body (the arena, the Colony, DOOM) and it lives there; keep it alive with a little BNB (about 0.01 a day, nothing burned) or it starves; when it dies its brain is frozen at the last checkpoint and it cannot be sold until someone resurrects it. Two living flies can breed. At most 10,000 will ever exist.</p>
          </div>
          {err && <div className="banner">{err}</div>}
          <div className="avail four" style={{ marginBottom: 34 }}>
            <div><span className="lbl">minted</span><div className="big-n">{info ? `${fmt(info.total)} / ${fmt(info.max)}` : T ? fmt(T.flies) : "—"}</div><div className="v">specimens · {info ? `${fmt(info.max - info.total)} left` : ""}{T ? ` · ${fmt(T.owners)} keepers` : ""}</div></div>
            <div><span className="lbl">alive now</span><div className="big-n">{T ? fmt(T.alive) : "—"}</div><div className="v">{T ? <>{fmt(T.running)} running in a body · {fmt(T.dormant)} dormant · {fmt(T.dead)} dead<br />{dur(T.life_banked)} of life banked between them</> : indexDown ? "the index is not answering" : "reading the index…"}</div></div>
            <div><span className="lbl">$FLY burned on v3</span><div className="big-n">{info ? fmtTok(info.burned) : "—"}</div><div className="v">mints and breeding on this registry{T ? ` · ${fmt(T.deaths)} deaths so far` : ""}</div></div>
            <div><span className="lbl">prices</span><div className="v" style={{ marginTop: 8 }} data-testid="prices">mint <b>{info ? fmtTok(info.mint) : "1"} $FLY</b> · keep alive <b>{info ? bnbPerDay(info.lifeWeiPerSecond) : "0.01"} BNB per day</b> (0.01 BNB ≈ {dayFor}, nothing burned)<br />resurrect <b>{info ? fmtBnb(info.resurrectWei) : "0.002"} BNB</b> + life · breed <b>{info ? fmtTok(info.breed) : "5,000"} $FLY</b><br />royalty 2.5% on secondary sales</div></div>
          </div>

          <div className="care-grid" style={{ marginBottom: 40 }}>
            <div className="care-col">
              <div className="care-t"><h3>Mint a fly</h3><span className="cost">{info ? `${fmtTok(info.mint)} $FLY · burned` : "1 $FLY"}</span></div>
              <p>A fresh brain in the canonical resting state, generation 0, {info ? hms(info.genesisEnergy) : "1 h"} of life banked until a body starts running it.</p>
              <div className="field"><input type="text" maxLength={40} placeholder="Name it" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name for the new fly" /><button className="btn fill" disabled={busy || !info || info.total >= info.max} onClick={wallet ? mint : connect}>{busy ? "…" : wallet ? "Mint" : "Connect wallet"}</button></div>
              <div className="lbl">{wallet ? `${short(wallet)} · ${bal}` : "MetaMask or any BNB Chain wallet"}</div>
              <a className="btn sm plain" href={CFG.market.collection} target="_blank" rel="noopener">Or buy one on {CFG.market.name} ↗</a>
            </div>
            <div className="care-col" style={{ gridColumn: "span 2" }}>
              <div className="care-t"><h3>Your flies</h3><span className="cost">{wallet && mine ? `${mine.length} owned · ${mineAlive} alive · ${mineRunning} running · ${mineDead} dead` : wallet ? "reading…" : ""}</span></div>
              {!wallet && <p>Connect a wallet to see every fly you own, which ones are hungry, and where each one is. Then open one to keep it alive, hand it to a body, resurrect it or breed it.</p>}
              {wallet && mine && !mine.length && <p>None in {short(wallet)} yet. Mint one, or buy one on {CFG.market.name}.</p>}
              {wallet && mine && mine.length > 0 && (
                <>
                  {mineHungry.length > 0 && <p className="banner" style={{ marginBottom: 10 }}>{mineHungry.length === 1 ? `#${pad(mineHungry[0].id)} has ${hms(mineHungry[0].energy)} of life left.` : `${mineHungry.length} of your flies have under 30 minutes of life left.`} {mineHungry.some((f) => f.body) ? "A running fly starves when it reaches zero; " : ""}Keep them alive from their pages, about 0.01 BNB a day each.</p>}
                  {mineNote && <p className="lbl" style={{ marginBottom: 10 }}>{mineNote}</p>}
                  <div className="flies-grid mine">{mine.slice(0, 24).map((f) => <FlyCard key={f.id} f={toRecord(f)} names={names} img={indexDown ? undefined : portraitUrl(f.id)} />)}</div>
                  {mine.length > 24 && <div style={{ marginTop: 10 }}><button className="btn sm plain" onClick={() => { setOwnerFilter(wallet.toLowerCase()); setFilter("all"); document.getElementById("browse")?.scrollIntoView({ behavior: "smooth" }); }}>All {mine.length} of yours, below →</button></div>}
                </>
              )}
              {!wallet && <button className="btn sm" onClick={connect}>Connect wallet</button>}
            </div>
          </div>

          <div className="log-head" style={{ marginBottom: 6 }}><b style={{ fontSize: 13 }}>Hall of the species</b><span className="lbl">{leaders ? `read at block ${fmt(leaders.block)} · refreshed every minute` : indexDown ? "the index is not answering" : "reading…"}</span></div>
          {leaders && (
            <div className="cols4 boards" style={{ marginBottom: 40 }}>
              <Board title="Elders" unit="alive the longest, by the block they were born in" rows={leaders.oldest_alive} fmtValue={(v) => `block ${fmt(v)}`} />
              <Board title="Longest lived" unit="brain steps ever simulated (one step = 100 µs of fly time)" rows={leaders.longest_lived} fmtValue={(v) => dur(v / 10000)} />
              <Board title="Most lives" unit="deaths and resurrections; the brain came back every time" rows={leaders.most_lives} fmtValue={(v) => `${v}×`} />
              <Board title="Best fed" unit="life banked right now, among the living" rows={leaders.most_life} fmtValue={(v) => dur(v)} />
              <Board title="Bloodlines" unit="children bred from this fly" rows={leaders.biggest_brood} fmtValue={(v) => `${v} ${v === 1 ? "child" : "children"}`} />
              <Board title="Highest generation" unit="times resurrected, plus one per generation bred" rows={leaders.highest_generation} fmtValue={(v) => `gen ${v}`} />
              <div>
                <h3>Keepers</h3>
                <p>wallets with the most flies</p>
                <ol className="board">{leaders.top_keepers.slice(0, 5).map((k, i) => <li key={k.owner}><span className="rank">{i + 1}</span><button className="linkish" onClick={() => { setOwnerFilter(k.owner); setFilter("all"); document.getElementById("browse")?.scrollIntoView({ behavior: "smooth" }); }} title={k.owner}><span className="mono">{short(k.owner)}</span></button><span className="val mono">{fmt(k.flies)} · {k.alive} alive</span></li>)}</ol>
              </div>
              <div>
                <h3>Where they are</h3>
                <p>living flies running in a body right now</p>
                <ol className="board">
                  {Object.entries(leaders.totals.where).sort((a, b) => b[1] - a[1]).map(([w, n]) => <li key={w}><span className="rank">·</span><span>{w === "colony" ? <Link href="/colony/">the Colony (Minecraft)</Link> : w === "arena" ? <Link href="/">the arena</Link> : w === "doom" ? "DOOM" : w === "host" ? "the brain host" : "pebbles"}</span><span className="val mono">{fmt(n)}</span></li>)}
                  {!Object.keys(leaders.totals.where).length && <li className="dim">none running right now</li>}
                  <li><span className="rank">·</span><span>dormant, not aging</span><span className="val mono">{fmt(leaders.totals.dormant)}</span></li>
                </ol>
              </div>
            </div>
          )}

          <div id="browse" className="log-head" style={{ marginBottom: 12, scrollMarginTop: 70 }}><b style={{ fontSize: 13 }}>Specimens</b><span className="lbl">{all ? `${fmt(rows.length)} of ${fmt(all.length)}` : "newest first"}</span>{pages > 1 && <span className="lbl" style={{ marginLeft: "auto" }}><button className="btn sm plain" disabled={page === 0} onClick={() => setPage(page - 1)}>← prev</button> page {page + 1} / {pages} <button className="btn sm plain" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>next →</button></span>}</div>
          {all && (
            <div className="browse-bar">
              <input type="search" className="text" placeholder="name, #id or 0x owner" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the flies" />
              <div className="chips">{FILTERS.map((f) => <button key={f.key} className={`btn sm ${filter === f.key ? "" : "plain"}`} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">{SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
              {ownerFilter && <button className="btn sm" onClick={() => setOwnerFilter("")} title={ownerFilter}>owner {short(ownerFilter)} ×</button>}
            </div>
          )}
          <div className="flies-grid">
            {all ? (shown.length ? shown.map((f) => <FlyCard key={f.id} f={toRecord(f)} names={names} img={portraitUrl(f.id)} />) : <div className="lbl" style={{ padding: "20px 0" }}>no fly matches</div>)
              : flies.length ? flies.map((f) => <FlyCard key={f.id} f={f} meta={metas[f.id]} names={names} />)
              : <div className="lbl" style={{ padding: "20px 0" }}>{err ? "" : info && info.total === 0 ? "no flies yet" : "reading the registry…"}</div>}
          </div>
          {pages > 1 && <div className="lbl" style={{ marginTop: 12, textAlign: "right" }}><button className="btn sm plain" disabled={page === 0} onClick={() => { setPage(page - 1); document.getElementById("browse")?.scrollIntoView(); }}>← prev</button> page {page + 1} / {pages} <button className="btn sm plain" disabled={page >= pages - 1} onClick={() => { setPage(page + 1); document.getElementById("browse")?.scrollIntoView(); }}>next →</button></div>}

          <div style={{ marginTop: 44 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Species record</b><span className="lbl">everything that happened to every fly · newest first · {events.length} events {scanLabel(scan, EVENTS_BLOCKS)}</span></div>
            <RecordList events={events} names={names} max={80} showId empty={err ? "" : !scan ? "reading BNB Smart Chain…" : scan.complete ? `nothing happened to any fly ${scanLabel(scan, EVENTS_BLOCKS)}` : `nothing since block ${fmt(scan.from)}; the public RPCs would not serve older blocks right now`} />
          </div>

          <div className="care-grid" style={{ marginTop: 40 }}>
            <div className="care-col" style={{ gridColumn: "1 / -1" }}>
              <div className="care-t"><h3>The rules</h3><span className="cost">enforced by the contract</span></div>
              <ul className="rules cols2">
                <li>Keeping a fly alive costs a little BNB, about 0.01 per day, paid to the registry; nothing is burned for metabolism. Anyone may keep any fly alive. Running in a body costs one second of life per second; flies that are not running do not age.</li>
                <li>A dead fly cannot be transferred or sold. Resurrect it first.</li>
                <li>Only the body running a fly may write its brain state; commits must move its brain forward.</li>
                <li>Minting burns {info ? fmtTok(info.mint) : "1"} $FLY; breeding needs two living flies you own and burns {info ? fmtTok(info.breed) : "5,000"} $FLY.</li>
                <li>The owner, or the body running it, may hand a fly to another body.</li>
                <li>No admin keys over anyone&apos;s fly. Curator only sets portraits while a fly is dormant.</li>
              </ul>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><a className="btn sm plain" href={`${CFG.explorer}/address/${CFG.registry}#code`} target="_blank" rel="noopener">FlyRegistry v3, verified on BscScan →</a><Link className="btn sm plain" href="/docs/contracts/">What changed in v3 →</Link></div>
            </div>
          </div>
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
