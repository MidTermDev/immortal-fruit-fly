"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActivity } from "@/hooks/useActivity";
import { count, executions } from "@/lib/decisions";
import SiteHeader from "./SiteHeader";
import CircuitHistory from "./CircuitHistory";
import { ActivityNotice, ExecutionDetail, ExecutionList } from "./ExecutionView";
import styles from "./Observer.module.css";

export default function DecisionsDashboard() {
  const activity = useActivity();
  const records = useMemo(() => executions(activity.events), [activity.events]);
  const searchParams = useSearchParams();
  const tx = searchParams.get("tx");
  const eventId = searchParams.get("event");
  const [selected, setSelected] = useState<string | null>(null);
  const current = records.find(record => record.event.id === selected) ?? records.find(record => record.event.id === eventId) ?? records.find(record => record.event.tx === tx) ?? records[0];
  return <><SiteHeader current="decisions" /><main className={`fly-dashboard ${styles.dashboard}`} id="main">
    <div className={styles.heading}><div><span className={styles.eyebrow}>FlyBrain / on chain</span><h1>Decisions</h1></div><span className={styles.status}>{count(records.length)} executions in view</span></div>
    <nav className={styles.subnav} aria-label="Decision source"><Link href="/decisions/" aria-current="page">Circuit executions</Link><Link href="/arcade/">DOOM decisions ↗</Link></nav>
    <section className={styles.decisionDetail} aria-label="Selected execution"><ExecutionDetail execution={current} loading={activity.status === "loading"} /></section>
    <ActivityNotice activity={activity} />
    <CircuitHistory records={records} selected={current?.event.id} />
    <section className={styles.section}><div className={styles.sectionHeading}><h2>Execution history</h2><span>Select a record</span></div><ExecutionList records={records.slice(0, 100)} selected={current?.event.id} onSelect={setSelected} /><p className={styles.footnote}>Recent block window. Inputs are new events before each execution in its transaction; earlier stimuli may persist.</p></section>
  </main></>;
}
