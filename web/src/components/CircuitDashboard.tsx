"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useFly } from "@/hooks/useFly";
import { useActivity } from "@/hooks/useActivity";
import { count, executions, heading } from "@/lib/decisions";
import SiteHeader from "./SiteHeader";
import WatchSources from "./WatchSources";
import FlyStage from "./FlyStage";
import { ActivityNotice, ExecutionDetail, ExecutionList } from "./ExecutionView";
import styles from "./Observer.module.css";

export default function CircuitDashboard() {
  const { snapshot, connection } = useFly();
  const activity = useActivity();
  const records = useMemo(() => executions(activity.events), [activity.events]);
  const direction = snapshot ? heading(snapshot.headX, snapshot.headY) : null;
  return <><SiteHeader current="fly" /><main className={`fly-dashboard ${styles.dashboard}`} id="main">
    <div className={styles.heading}><div><span className={styles.eyebrow}>Watch</span><h1>The on-chain circuit</h1></div><div className={styles.status}><i data-state={connection} />{connection === "live" ? "Connected to BSC" : connection === "loading" ? "Connecting…" : "Reconnecting…"}</div></div>
    <WatchSources current="core" />
    <div className={styles.watchGrid}>
      <section className={styles.visual} aria-label="Confirmed circuit state"><FlyStage snapshot={snapshot} connection={connection} /><div className={styles.visualMeta}><span>Confirmed state</span><span>{snapshot ? `Block ${count(snapshot.block)}` : "Waiting for state"}</span></div></section>
      <section className={styles.latest} aria-label="Latest execution"><ExecutionDetail execution={records[0]} loading={activity.status === "loading"} /><ActivityNotice activity={activity} /></section>
    </div>
    <dl className={styles.metrics}>
      <div><dt>State</dt><dd>{snapshot ? snapshot.alive ? "Alive" : "Ended" : "—"}</dd></div>
      <div><dt>Energy remaining</dt><dd>{snapshot ? count(snapshot.energyRaw ?? snapshot.energy) : "—"}<small>steps</small></dd></div>
      <div><dt>Circuit step</dt><dd>{snapshot ? count(snapshot.step) : "—"}</dd></div>
      <div><dt>Heading</dt><dd>{direction === null ? "—" : `${direction.toFixed(1)}°`}</dd></div>
      <div><dt>Generation</dt><dd>{snapshot ? count(snapshot.generation) : "—"}</dd></div>
    </dl>
    <section className={styles.section}><div className={styles.sectionHeading}><h2>Recent executions</h2><Link href="/decisions/">All decisions ↗</Link></div><ExecutionList records={records.slice(0, 6)} /><p className={styles.footnote}>{activity.fromBlock !== null ? `Recent block window · ${count(activity.fromBlock)}–${count(activity.toBlock ?? activity.fromBlock)}` : "Waiting for contract records"}</p></section>
  </main></>;
}
