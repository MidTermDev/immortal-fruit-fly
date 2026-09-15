"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CFG } from "@/lib/config";
import { Chain } from "@/lib/chain";
import { FlyRecord, RegistryInfo, Ev, ZERO, fmt, fmtTok, short, hms, ipfs, pad, status, bodyName } from "@/lib/registry";
import { RecordList } from "@/components/Record";

export default function Specimen() {
  const sp = useSearchParams(); const id = Math.max(0, parseInt(sp.get("id") || "1", 10) || 0);
  const chainRef = useRef<Chain | null>(null);
  const [f, setF] = useState<FlyRecord | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [info, setInfo] = useState<RegistryInfo | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [children, setChildren] = useState<{ id: number; name: string }[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [, setLiveUrl] = useState("");
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

  const refresh = async (ch: Chain) => {
    const rec = await ch.flyRecord(id); setF(rec);
    if (rec.uri && rec.uri.startsWith("ipfs://")) ch.metadataOf(rec.uri).then((m) => m && setMeta(m));
    const [mine, all] = await Promise.all([ch.registryEvents(80000, id), ch.registryEvents(80000)]);
    setEvents(mine);
    setChildren(all.filter((e) => e.name === "Minted" && (Number(e.args.parentA) === id || Number(e.args.parentB) === id)).map((e) => ({ id: Number(e.args.id), name: e.args.name })));
    const bodies = new Set<string>(); for (const e of mine) { if (e.args.body) bodies.add(String(e.args.body).toLowerCase()); }
    const nm: Record<string, string> = {}; for (const b of bodies) { try { const bi = await ch.bodyInfo(b); if (bi.name) nm[b] = bi.name; if (b === CFG.bodies.arena.toLowerCase() && /^https:\/\//.test(bi.uri)) setLiveUrl(bi.uri); } catch {} }
    setNames(nm);
  };
  useEffect(() => {
    if (!id) return;
    (async () => {
      try { const ch = await new Chain().connectRead(); chainRef.current = ch; setInfo(await ch.registryInfo()); await refresh(ch); }
      catch (e: any) { setErr(e.reason === "ERC721NonexistentToken" || /nonexistent/i.test(e.message || "") ? `Fly #${id} has not been minted.` : "Could not read this fly: " + (e.shortMessage || e.message)); }
    })();
    return () => clearTimeout(tt.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
  const assign = () => { const to = target === "custom" ? custom.trim() : target; if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return setToast("That is not an address."); run("Assign", () => chainRef.current!.assignFly(id, to), (rc) => `Assigned to ${bodyName(to, names)} in block ${fmt(rc.blockNumber)}. It moves as soon as that body accepts and instantiates the brain.`); };
  const breed = () => { const p = parseInt(partner, 10); if (!p || p === id) return setToast("Choose another fly you own."); const nm = childName.trim().slice(0, 40); if (!nm) return setToast("Name the child."); run("Breed", () => chainRef.current!.breedFlies(id, p, nm, info!.breed), (rc) => `A child was born in block ${fmt(rc.blockNumber)}.`); };

  if (!id) return <main className="wrap" style={{ padding: "60px 0" }}><p>Which fly? <Link href="/flies/">See the collection.</Link></p></main>;
  const s = f ? status(f) : null; const isOwner = !!(wallet && f && wallet.toLowerCase() === f.owner.toLowerCase());
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
                {f && f.stateURI && <a className="btn sm plain" href={ipfs(f.stateURI)} target="_blank" rel="noopener">Brain snapshot (IPFS) ↗</a>}
                <a className="btn sm plain" href={`${CFG.explorer}/token/${CFG.registry}?a=${id}`} target="_blank" rel="noopener">BscScan →</a>
              </div>
            </div>
            <aside className="chart" style={{ paddingBottom: 0 }}>
              <div className="chart-t"><b>Record</b><span className="lbl">from the registry</span></div>
              <div className="crow"><span>owner</span><span><a href={`${CFG.explorer}/address/${f?.owner}`} target="_blank" rel="noopener">{f ? short(f.owner) : "—"}</a>{isOwner ? " (you)" : ""}</span></div>
              <div className="crow"><span>body</span><span>{f ? (f.body !== ZERO ? bodyName(f.body, names) : f.pendingBody !== ZERO ? `→ ${bodyName(f.pendingBody, names)} (pending)` : "none") : "—"}</span></div>
              <div className="crow"><span>energy at last checkpoint</span><span>{f ? hms(f.energy) : "—"}</span></div>
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
            <div className="care-col">
              <div className="care-t"><h3>Feed</h3><span className="cost">{info ? `${fmtTok(info.feed)} $FLY = 1 s` : ""}</span></div>
              <p>{f && f.body !== ZERO ? `Food appears in ${bodyName(f.body, names)} at the next poll; the fly has to smell its way there.` : "Banked as energy until a body runs it."} Anyone may feed any fly.</p>
              <div className="field"><input type="number" min={1} value={secs} onChange={(e) => setSecs(e.target.value)} aria-label="Seconds of life" /><button className="btn fill" disabled={busy || !f || !f.alive} onClick={wallet ? feed : connect}>{busy ? "…" : wallet ? "Feed" : "Connect"}</button></div>
              <div className="lbl">= {Number(secs) ? hms(Number(secs)) : "—"} of life · {wallet ? `${short(wallet)} · ${bal}` : ""}</div>
            </div>
            <div className="care-col">
              {f && !f.alive ? (<>
                <div className="care-t"><h3>Resurrect</h3><span className="cost">{info ? `${fmtTok(info.res)} $FLY + food` : ""}</span></div>
                <p>The brain continues from the exact state it died in, as generation {f.generation + 1}. Anyone may pay. Until then it cannot be transferred or sold.</p>
                <div className="field"><input type="number" min={60} value={resSecs} onChange={(e) => setResSecs(e.target.value)} aria-label="Seconds of food to wake up with" /><button className="btn fill" disabled={busy} onClick={wallet ? resurrect : connect}>{busy ? "…" : wallet ? "Resurrect" : "Connect"}</button></div>
                <div className="lbl">wakes with {Number(resSecs) ? hms(Number(resSecs)) : "—"} · minimum 60 s</div>
              </>) : (<>
                <div className="care-t"><h3>Hand it to a body</h3><span className="cost">owner or current body</span></div>
                <p>A body downloads the last committed brain, checks its hash, and runs it. The arena streams live; DOOM sessions are run by the operator.</p>
                <div className="field">
                  <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Body"><option value={CFG.bodies.arena}>Arena (live, streams here)</option><option value={CFG.bodies.doom}>DOOM</option><option value="custom">Another body address…</option></select>
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

          <div style={{ marginTop: 44 }}>
            <div className="log-head"><b style={{ fontSize: 13 }}>Interaction history</b><span className="lbl">every body it has lived in · newest first · {events.length} events in the last 80k blocks</span></div>
            <RecordList events={events} names={names} empty={err ? "" : "reading BNB Smart Chain…"} />
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
