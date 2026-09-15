"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CFG } from "@/lib/config";
import { Chain, LogScan } from "@/lib/chain";
import { FlyRecord, RegistryInfo, Ev, ZERO, fmt, fmtTok, short, hms, ipfs, pad, status, bodyName, isCoreOnlyBody, scanLabel } from "@/lib/registry";
import { RecordList } from "@/components/Record";

const PAGE = 24;
const EVENTS_BLOCKS = 60000;

export function FlyCard({ f, meta, names }: { f: FlyRecord; meta?: any; names?: Record<string, string> }) {
  const s = status(f, names);
  return (
    <Link href={`/fly/?id=${f.id}`} className={`fly-card ${s.key}`}>
      <div className="portrait">{meta?.image ? <img src={ipfs(meta.image)} alt={`Portrait of ${f.name}`} loading="lazy" /> : <span className="lbl">portrait pending</span>}</div>
      <div className="fc-b">
        <div className="fc-t"><span className="mono">#{pad(f.id)}</span><span className={`pill ${s.key}`}>{s.label}</span></div>
        <b>{f.name || `Fly #${f.id}`}</b>
        <span className="fc-m">{f.alive ? (f.body !== ZERO ? `in ${bodyName(f.body, names)}${isCoreOnlyBody(f.body) ? " (core only)" : ""} · ${hms(f.energy)} at last checkpoint` : `${hms(f.energy)} banked`) : `died ${f.deaths}× · gen ${f.generation}`}</span>
        <span className="fc-m dim">gen {f.generation} · step {fmt(f.brainStep)} · {f.parentA ? `child of #${f.parentA} × #${f.parentB}` : "genesis"}</span>
      </div>
    </Link>
  );
}

export default function Collection() {
  const chainRef = useRef<Chain | null>(null);
  const [info, setInfo] = useState<RegistryInfo | null>(null);
  const [flies, setFlies] = useState<FlyRecord[]>([]);
  const [metas, setMetas] = useState<Record<number, any>>({});
  const [page, setPage] = useState(0);
  const [events, setEvents] = useState<Ev[]>([]);
  const [scan, setScan] = useState<LogScan | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const looked = useRef(new Set<string>());
  const [wallet, setWallet] = useState<string | null>(null);
  const [bal, setBal] = useState("");
  const [mine, setMine] = useState<number[]>([]);
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
    const ids: number[] = []; for (let i = total - p * PAGE; i > Math.max(0, total - (p + 1) * PAGE); i--) ids.push(i);
    const recs = (await Promise.all(ids.map((i) => ch.flyRecord(i).catch(() => null)))).filter(Boolean) as FlyRecord[];
    setFlies(recs);
    learnNames(ch, recs.flatMap((f) => [f.body, f.pendingBody])).catch(() => {});
    recs.forEach(async (f) => { if (f.uri && f.uri.startsWith("ipfs://")) { const m = await ch.metadataOf(f.uri); if (m) setMetas((o) => ({ ...o, [f.id]: m })); } });
  };
  useEffect(() => {
    (async () => {
      try {
        const ch = await new Chain().connectRead(); chainRef.current = ch;
        const ri = await ch.registryInfo(); setInfo(ri);
        await loadPage(ch, ri.total, 0);
        const { events: evs, scan: sc } = await ch.registryEvents(EVENTS_BLOCKS); setEvents(evs); setScan(sc);
        learnNames(ch, evs.map((e) => e.args.body).filter(Boolean)).catch(() => {});
      } catch (e: any) { setErr("Could not reach BNB Smart Chain: " + (e.shortMessage || e.message)); }
    })();
    return () => clearTimeout(tt.current);
  }, []);
  useEffect(() => { const ch = chainRef.current; if (ch && info) loadPage(ch, info.total, page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    const ch = chainRef.current; if (!ch) return setToast("Not connected to BNB Chain.");
    try { const a = await ch.connectWallet(); setWallet(a); setBal(fmtTok(await ch.balance()) + " FLY"); if (info && a) setMine(await ch.ownedFlies(a, Math.min(info.total, 400))); } catch (e: any) { setToast(e.shortMessage || e.message); }
  };
  const mint = async () => {
    const ch = chainRef.current; if (!ch || !wallet) return setToast("Connect a wallet first."); if (!info) return;
    const nm = name.trim().slice(0, 40); if (!nm) return setToast("Give it a name.");
    setBusy(true);
    try {
      setToast("Mint: confirm in your wallet (approve $FLY once, then mint)…", 120000);
      const rc = await ch.mintFly(nm, info.mint);
      const ri = await ch.registryInfo(); setInfo(ri); setPage(0); await loadPage(ch, ri.total, 0); setMine(await ch.ownedFlies(wallet as string, Math.min(ri.total, 400))); setBal(fmtTok(await ch.balance()) + " FLY");
      setToast(`Fly #${ri.total} “${nm}” is alive, block ${fmt(rc.blockNumber)}. Its portrait is drawn within a minute; then assign it to a body from its page.`, 12000); setName("");
    } catch (e: any) { setToast(`Failed: ${e.shortMessage || e.reason || e.message}`, 9000); } finally { setBusy(false); }
  };
  const pages = info ? Math.ceil(info.total / PAGE) : 0;

  return (
    <main>
      <section className="sec" id="collection" style={{ paddingTop: "clamp(30px, 4vw, 48px)" }}>
        <div className="wrap">
          <div className="sec-t">
            <div><div className="num">The collection · ERC-721 on BNB Smart Chain</div><h2>Immortal Fruit Flies</h2></div>
            <p>Each token is a whole fruit-fly brain: the FlyWire connectome, 139,248 neurons, with its own state, memory, lineage and history anchored on-chain forever. Mint one for 1 $FLY and it wakes with an hour of life. Hand it to a body (the arena, DOOM) and it lives there; feed it or it starves; when it dies its brain is frozen at the last checkpoint and it cannot be sold until someone resurrects it. Two living flies can breed. At most 10,000 will ever exist.</p>
          </div>
          {err && <div className="banner">{err}</div>}
          <div className="avail" style={{ marginBottom: 34 }}>
            <div><span className="lbl">minted</span><div className="big-n">{info ? `${fmt(info.total)} / ${fmt(info.max)}` : "—"}</div><div className="v">specimens · {info ? `${fmt(info.max - info.total)} left` : ""}</div></div>
            <div><span className="lbl">$FLY burned for life</span><div className="big-n">{info ? fmtTok(info.burned) : "—"}</div><div className="v">mints, feeding, resurrections, breeding</div></div>
            <div><span className="lbl">prices</span><div className="v" style={{ marginTop: 8 }}>mint <b>{info ? fmtTok(info.mint) : "1"} $FLY</b> · feed <b>{info ? fmtTok(info.feed) : "1"} $FLY / s</b><br />resurrect <b>{info ? fmtTok(info.res) : "1,000"} $FLY</b> + food · breed <b>{info ? fmtTok(info.breed) : "5,000"} $FLY</b><br />royalty 2.5% on secondary sales</div></div>
          </div>
          <div className="care-grid" style={{ marginBottom: 40 }}>
            <div className="care-col">
              <div className="care-t"><h3>Mint a fly</h3><span className="cost">{info ? `${fmtTok(info.mint)} $FLY · burned` : "1 $FLY"}</span></div>
              <p>A fresh brain in the canonical resting state, generation 0, {info ? hms(info.genesisEnergy) : "1 h"} of life banked until a body starts running it.</p>
              <div className="field"><input type="text" maxLength={40} placeholder="Name it" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name for the new fly" /><button className="btn fill" disabled={busy || !info || info.total >= info.max} onClick={wallet ? mint : connect}>{busy ? "…" : wallet ? "Mint" : "Connect wallet"}</button></div>
              <div className="lbl">{wallet ? `${short(wallet)} · ${bal}` : "MetaMask or any BNB Chain wallet"}</div>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>Your flies</h3><span className="cost">{wallet ? `${mine.length} owned` : ""}</span></div>
              {wallet ? (mine.length ? <div className="chips">{mine.map((i) => <Link key={i} href={`/fly/?id=${i}`} className="btn sm">#{pad(i)}</Link>)}</div> : <p>None yet. Mint one, or buy one on {CFG.market.name}.</p>) : <p>Connect a wallet to see the flies you own, then open one to feed it, hand it to a body, resurrect it or breed it.</p>}
              <a className="btn sm plain" href={CFG.market.collection} target="_blank" rel="noopener">Collection on {CFG.market.name} ↗</a>
            </div>
            <div className="care-col">
              <div className="care-t"><h3>The rules</h3><span className="cost">enforced by the contract</span></div>
              <ul className="rules">
                <li>A dead fly cannot be transferred or sold. Resurrect it first.</li>
                <li>Only the body running a fly may write its brain state; commits must move its brain forward.</li>
                <li>Breeding needs two living flies you own, and burns {info ? fmtTok(info.breed) : "5,000"} $FLY.</li>
                <li>The owner, or the body running it, may hand a fly to another body.</li>
                <li>No admin keys over anyone&apos;s fly. Curator only sets portraits while a fly is dormant.</li>
              </ul>
              <a className="btn sm plain" href={`${CFG.explorer}/address/${CFG.registry}#code`} target="_blank" rel="noopener">FlyRegistry, verified on BscScan →</a>
            </div>
          </div>

          <div className="log-head" style={{ marginBottom: 18 }}><b style={{ fontSize: 13 }}>Specimens</b><span className="lbl">newest first</span>{pages > 1 && <span className="lbl" style={{ marginLeft: "auto" }}><button className="btn sm plain" disabled={page === 0} onClick={() => setPage(page - 1)}>← newer</button> page {page + 1} / {pages} <button className="btn sm plain" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>older →</button></span>}</div>
          <div className="flies-grid">{flies.length ? flies.map((f) => <FlyCard key={f.id} f={f} meta={metas[f.id]} names={names} />) : <div className="lbl" style={{ padding: "20px 0" }}>{err ? "" : info && info.total === 0 ? "no flies yet" : "reading the registry…"}</div>}</div>

          <div style={{ marginTop: 44 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Species record</b><span className="lbl">everything that happened to every fly · newest first · {events.length} events {scanLabel(scan, EVENTS_BLOCKS)}</span></div>
            <RecordList events={events} names={names} max={80} showId empty={err ? "" : !scan ? "reading BNB Smart Chain…" : scan.complete ? `nothing happened to any fly ${scanLabel(scan, EVENTS_BLOCKS)}` : `nothing since block ${fmt(scan.from)}; the public RPCs would not serve older blocks right now`} />
          </div>
        </div>
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
