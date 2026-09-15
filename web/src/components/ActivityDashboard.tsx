"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { formatEther } from "ethers";
import { useActivity, type ActivityEvent } from "@/hooks/useActivity";
import { CFG } from "@/lib/config";
import { count, timeLabel, txLabel } from "@/lib/decisions";
import SiteHeader from "./SiteHeader";
import { ActivityNotice } from "./ExecutionView";
import styles from "./Observer.module.css";

function detail(event: ActivityEvent) {
  const a = event.args;
  switch (event.name) {
    case "Ticked": return `${count(Number(a.steps))} steps · ${count(Number(a.spikes))} spikes`;
    case "Fed": return `+${count(BigInt(a.energyAdded))} energy steps · ${formatEther(a.tokensBurned)} FLY`;
    case "Stimulated": return `Channel ${a.channel} · strength ${a.strength}`;
    case "Checkpoint": return `Step ${count(BigInt(a.step))} · generation ${a.generation}`;
    case "FoodPlaced": return `${a.seconds_} seconds of food · position ${a.x}, ${a.y}`;
    case "Resurrected": return `Generation ${a.generation} · ${count(BigInt(a.energy))} ${event.source === "world" ? "seconds" : "steps"} of energy`;
    case "Died": return `Generation ${a.generation} ended`;
    case "SessionStarted": return `${String(a.game)} · session ${count(BigInt(a.id))}`;
    case "Decision": return `${Number(a.turn) === 0 ? "No net turn" : `${Number(a.turn) > 0 ? "Left" : "Right"} ${Math.abs(Number(a.turn))}°`} · ${a.fire ? "fired" : "no fire"} · health ${a.health} · kills ${a.kills}`;
    case "SessionEnded": return `${count(Number(a.decisions))} decisions · ${count(Number(a.kills))} kills at close`;
    default: return "Contract event";
  }
}

export default function ActivityDashboard() {
  const activity = useActivity();
  const [source, setSource] = useState("all");
  const [kind, setKind] = useState("all");
  const records = useMemo(() => activity.events.filter(event => (source === "all" || event.source === source) && (kind === "all" || event.name === kind)).slice().reverse(), [activity.events, source, kind]);
  return <><SiteHeader current="activity" /><main className={`fly-dashboard ${styles.dashboard}`} id="main">
    <div className={styles.heading}><div><span className={styles.eyebrow}>BNB Smart Chain</span><h1>Activity</h1></div><span className={styles.status}>{activity.toBlock === null ? "Connecting…" : `Through block ${count(activity.toBlock)}`}</span></div>
    <div className={styles.filters}><div className={styles.filterTabs} aria-label="Contract filter">{[["all", "All"], ["core", "Circuit"], ["world", "Whole brain"], ["arcade", "Arcade"]].map(([value, label]) => <button key={value} type="button" aria-pressed={source === value} onClick={() => { setSource(value); setKind("all"); }}>{label}</button>)}</div><label>Event<select value={kind} onChange={event => setKind(event.target.value)}><option value="all">All events</option>{["Ticked", "Fed", "Stimulated", "Checkpoint", "FoodPlaced", "Died", "Resurrected", "SessionStarted", "Decision", "SessionEnded"].map(name => <option key={name}>{name}</option>)}</select></label></div>
    <ActivityNotice activity={activity} />
    <div className={styles.activityList}>{records.slice(0, 100).map(event => <article className={styles.activityRow} key={event.id}>
      <div><span className={styles.eventSource}>{event.source === "core" ? "CIRCUIT" : event.source === "arcade" ? "ARCADE" : "WORLD"}</span><h2>{event.name === "Ticked" ? "Executed" : event.name}</h2></div>
      <div className={styles.activityDetail}><p>{detail(event)}</p>{event.name === "Checkpoint" && <small title={String(event.args.stateHash)}>State {txLabel(String(event.args.stateHash))}</small>}{event.source === "arcade" && <small><Link href={`/arcade/?session=${String(event.name === "Decision" ? event.args.session : event.args.id)}${event.name === "Decision" ? `&decision=${String(event.args.n)}` : ""}`}>View {event.name === "Decision" ? `decision ${String(event.args.n)}` : "session"} ↗</Link></small>}</div>
      <div><time>{timeLabel(event.timestamp)}</time><small>Block {count(event.block)}</small></div>
      <a href={`${CFG.explorer}/tx/${event.tx}`} target="_blank" rel="noopener noreferrer">{txLabel(event.tx)} ↗</a>
    </article>)}</div>
    {records.length === 0 && activity.status !== "loading" && <p className={styles.empty}>{activity.status === "unavailable" ? "Waiting for contract activity." : "No matching events in the current block window."}</p>}
    <p className={styles.footnote}>{activity.fromBlock === null ? "" : `Blocks ${count(activity.fromBlock)}–${count(activity.toBlock ?? activity.fromBlock)} · Showing up to 100 events`}</p>
  </main></>;
}
