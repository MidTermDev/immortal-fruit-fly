"use client";
import Link from "next/link";
import { CFG } from "@/lib/config";
import { Ev, fmt, fmtTok, short, bodyName, decodeKind } from "@/lib/registry";

/** One line of a fly's on-chain record. Every row links to its transaction. */
export function RecordRow({ e, names, showId }: { e: Ev; names?: Record<string, string>; showId?: boolean }) {
  const a = e.args; let act = "note", who: React.ReactNode = "", txt: React.ReactNode = e.name;
  const body = (x: string) => bodyName(x, names);
  switch (e.name) {
    case "Minted": act = "life"; who = short(a.to); txt = a.parentA && Number(a.parentA) ? <><b>born</b> as “{a.name}”, child of <Link href={`/fly/?id=${a.parentA}`}>#{String(a.parentA)}</Link> × <Link href={`/fly/?id=${a.parentB}`}>#{String(a.parentB)}</Link></> : <><b>minted</b> as “{a.name}” with a fresh genesis brain</>; break;
    case "Fed": act = "feed"; who = short(a.by); txt = <>fed <b>{fmt(a.seconds_)} s of life</b> · {fmtTok(a.tokensBurned)} $FLY burned</>; break;
    case "Resurrected": act = "life"; who = short(a.by); txt = <><b>resurrected</b> as generation {String(a.generation)} with {fmt(a.energy)} s of life · {fmtTok(a.tokensBurned)} $FLY burned</>; break;
    case "Died": act = "life"; who = body(a.body); txt = <><b>died</b> in {body(a.body)}: {a.cause} · final brain <span className="mono">{String(a.stateRoot).slice(0, 14)}…</span></>; break;
    case "Commit": act = "brain"; who = body(a.body); txt = <>checkpoint at step {fmt(a.brainStep)} · brain <a className="mono" href={CFG.ipfsGateway + String(a.stateURI).replace("ipfs://", "")} target="_blank" rel="noopener">{String(a.stateRoot).slice(0, 14)}…</a> · {fmt(a.energy)} s left</>; break;
    case "Interaction": { const k = decodeKind(a.kind); act = k === "jumped" ? "jump" : k === "doom" ? "doom" : k === "ate" ? "feed" : "note"; who = body(a.body);
      let d = String(a.data); if (k === "doom" && d.startsWith("{")) { try { const j = JSON.parse(d); d = `decision ${j.n}: turn ${j.turn}${j.fire ? ", fire" : ""} · ${j.kills} kills · brain ${String(j.brain).slice(0, 12)}…`; } catch {} }
      txt = <>{d}</>; break; }
    case "Assigned": act = "body"; who = short(a.by); txt = <>assigned to <b>{body(a.body)}</b></>; break;
    case "Accepted": act = "body"; who = body(a.body); txt = <><b>{body(a.body)}</b> took custody and instantiated the brain from its last committed state</>; break;
    case "Released": act = "body"; who = body(a.body); txt = <>{body(a.body)} released it</>; break;
    case "Attested": act = "brain"; who = short(a.attestor); txt = <>independent replay at step {fmt(a.brainStep)}: <b>{a.matches ? "matches" : "does not match"}</b></>; break;
    case "Transfer": if (a.from === "0x0000000000000000000000000000000000000000") return null; act = "owner"; who = short(a.to); txt = <>transferred from {short(a.from)} to {short(a.to)}</>; break;
    default: return null;
  }
  return (
    <div className="lrow">
      <a className="blk" href={`${CFG.explorer}/tx/${e.tx}`} target="_blank" rel="noopener">block {e.block}</a>
      <span className={`act ${act}`}>{act}</span>
      <span className="ev">{showId && a.id !== undefined ? <><Link href={`/fly/?id=${a.id}`} className="mono">#{String(a.id)}</Link> </> : null}{txt}</span>
      <span className="who">{who}</span>
    </div>
  );
}

export function RecordList({ events, names, empty = "reading BNB Smart Chain…", max, showId }: { events: Ev[]; names?: Record<string, string>; empty?: string; max?: number; showId?: boolean }) {
  const rows = (max ? events.slice(0, max) : events).map((e, i) => <RecordRow key={e.tx + i + e.name} e={e} names={names} showId={showId} />).filter(Boolean);
  return <div className="log-list">{rows.length ? rows : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">{empty}</span><span /></div>}</div>;
}
