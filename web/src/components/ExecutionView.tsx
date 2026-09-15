import Link from "next/link";
import { CFG } from "@/lib/config";
import { count, inputLabel, timeLabel, txLabel, type Execution } from "@/lib/decisions";
import type { ActivityState } from "@/hooks/useActivity";
import styles from "./Observer.module.css";

export function ActivityNotice({ activity }: { activity: ActivityState }) {
  if (activity.status === "ready") return null;
  return <p className={styles.notice} role="status">{activity.status === "loading" ? "Reading contract events…" : activity.status === "unavailable" ? "Contract activity is unavailable. Retrying automatically." : "Some activity or timestamps are unavailable. Showing received records."}</p>;
}

export function ExecutionDetail({ execution, loading = false }: { execution: Execution | undefined; loading?: boolean }) {
  if (!execution) return <div className={styles.empty}>{loading ? "Waiting for execution records…" : "No execution records available in the current block window."}</div>;
  const { event } = execution;
  return <>
    <div className={styles.executionTop}><div><span className={styles.eyebrow}>Recorded execution</span><h2>Step {count(execution.from)} <span>→</span> {count(execution.to)}</h2></div><a href={`${CFG.explorer}/tx/${event.tx}`} target="_blank" rel="noopener noreferrer">{txLabel(event.tx)} ↗</a></div>
    <div className={styles.flow}>
      <section><span className={styles.flowIndex}>01 / INPUT</span><strong>{execution.inputs.length ? execution.inputs.map(inputLabel).join(" → ") : "No new input event"}</strong><p>{execution.inputs.length ? "Recorded before this execution" : "An earlier stimulus may still be active"}</p>{execution.inputs.filter(input => input.name === "Stimulated").map(input => <small key={input.id}>Strength {count(Number(input.args.strength))} · channel {String(input.args.channel)}</small>)}</section>
      <section><span className={styles.flowIndex}>02 / CIRCUIT</span><strong>{count(execution.spikes)} spikes</strong><p>{count(execution.steps)} simulation steps executed</p></section>
      <section><span className={styles.flowIndex}>03 / OUTPUT</span><strong>{execution.direction === null ? "No heading" : `${execution.direction.toFixed(1)}° heading`}</strong><p>Position {execution.x}, {execution.y}</p><small>{count(execution.energy)} energy remaining</small></section>
    </div>
    <div className={styles.recordMeta}><span>Block {count(event.block)} · {timeLabel(event.timestamp)}</span><span>FlyBrain · BNB Smart Chain</span></div>
  </>;
}

export function ExecutionList({ records, selected, onSelect }: { records: Execution[]; selected?: string; onSelect?: (id: string) => void }) {
  if (!records.length) return null;
  return <div className={styles.records}>
    <div className={styles.recordHead}><span>Execution</span><span>Spikes</span><span>Heading</span><span>Recorded</span></div>
    {records.map(record => {
      const content = <><span><strong>Step {count(record.to)}</strong><small>{count(record.steps)} steps</small></span><span>{count(record.spikes)}</span><span>{record.direction === null ? "—" : `${record.direction.toFixed(1)}°`}</span><span>{timeLabel(record.event.timestamp)} <b aria-hidden="true">↗</b></span></>;
      return onSelect ? <button key={record.event.id} className={styles.record} onClick={() => onSelect(record.event.id)} aria-pressed={selected === record.event.id}>{content}</button> : <Link key={record.event.id} className={styles.record} href={`/decisions/?tx=${record.event.tx}&event=${encodeURIComponent(record.event.id)}`}>{content}</Link>;
    })}
  </div>;
}
