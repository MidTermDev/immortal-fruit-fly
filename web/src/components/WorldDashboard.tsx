"use client";

import Link from "next/link";
import { memo } from "react";
import { CFG } from "@/lib/config";
import { useWorld } from "@/hooks/useWorld";
import { worldOrigin } from "@/lib/world-types";
import type { WorldObservation } from "@/lib/world-types";
import SiteHeader from "./SiteHeader";
import WatchSources from "./WatchSources";
import WorldStage from "./WorldStage";
import styles from "./WorldDashboard.module.css";

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const compact = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const elapsed = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
};
const modes: Record<string, string> = { walk: "Walking", surge: "Surging", cast: "Casting" };
const observedTime = (time: number) => new Date(time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function SignalChart({ history, kind }: { history: WorldObservation[]; kind: "steering" | "odor" }) {
  const steering = kind === "steering";
  const series = steering ? [{ name: "Steering", color: "#526e3f", value: (record: WorldObservation) => record.steer }] : [{ name: "Left", color: "#9b752f", value: (record: WorldObservation) => record.orn[0] }, { name: "Right", color: "#627d9a", value: (record: WorldObservation) => record.orn[1] }];
  const max = Math.max(1, ...history.flatMap((record) => series.map((line) => Math.abs(line.value(record)))));
  const first = history[0].receivedAt, last = history[history.length - 1].receivedAt;
  const x = (time: number) => 44 + (last > first ? (time - first) / (last - first) : .5) * 428;
  const y = (value: number) => steering ? 66 - value / max * 48 : 114 - value / max * 96;
  // Never connect a gap in the stream or separate generations with an invented trace.
  const paths = (line: typeof series[number]) => history.map((record, index) => {
    const previous = history[index - 1];
    const separate = !previous || record.receivedAt - previous.receivedAt > 5000 || record.generation !== previous.generation || record.t_ms < previous.t_ms;
    return `${separate ? "M" : "L"}${x(record.receivedAt).toFixed(1)},${y(line.value(record)).toFixed(1)}`;
  }).join(" ");
  return <figure className={styles.signalChart}>
    <figcaption><strong>{steering ? "Steering signal" : "Odor input"}</strong><span>{steering ? "Signed readout" : "Hz"}</span></figcaption>
    <svg viewBox="0 0 490 144" role="img" aria-label={`${steering ? "Steering" : "Left and right odor input"} across ${history.length} observed samples from ${observedTime(first)} to ${observedTime(last)}`}>
      <line x1="44" y1="18" x2="472" y2="18" className={styles.chartRule} />
      <line x1="44" y1="114" x2="472" y2="114" className={styles.chartRule} />
      {steering && <line x1="44" y1="66" x2="472" y2="66" className={styles.chartZero} />}
      <text x="35" y="22" textAnchor="end">{compact(max)}</text>
      <text x="35" y="118" textAnchor="end">{steering ? `−${compact(max)}` : "0"}</text>
      {series.map((line) => <g key={line.name}>
        <path d={paths(line)} fill="none" stroke={line.color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {history.map((record) => <circle key={record.id} cx={x(record.receivedAt)} cy={y(line.value(record))} r="1.8" fill={line.color}><title>{`${observedTime(record.receivedAt)} · ${line.name}: ${number(line.value(record))}${steering ? "" : " Hz"}`}</title></circle>)}
      </g>)}
      <text x="44" y="139">{observedTime(first)}</text><text x="472" y="139" textAnchor="end">{observedTime(last)}</text>
    </svg>
    <div className={styles.chartLegend}>{series.map((line) => <span key={line.name}><i style={{ background: line.color }} />{line.name}</span>)}</div>
  </figure>;
}

const WorldHistory = memo(function WorldHistory({ history }: { history: WorldObservation[] }) {
  const changes = history.filter((record, index) => !index || record.mode !== history[index - 1].mode || record.alive !== history[index - 1].alive || record.generation !== history[index - 1].generation);
  return <section id="world-history" className={styles.history} aria-labelledby="world-history-title">
    <div className={styles.historyHeading}><h2 id="world-history-title">Behavior history</h2><span>{history.length ? `${history.length} observed samples · this session` : "Live simulation"}</span></div>
    {history.length ? <div className={styles.historyGrid}>
      <div className={styles.modeChanges}><h3>Mode changes</h3><ol>{changes.slice(-5).reverse().map((record) => <li key={record.id}>
        <div><strong>{record.alive ? modes[record.mode] || record.mode : "Stopped"}</strong><small>{record.id === history[0].id ? "First sample in view" : `Generation ${record.generation} · step ${number(record.step)}`}</small></div>
        <time dateTime={new Date(record.receivedAt).toISOString()}>{observedTime(record.receivedAt)}</time>
      </li>)}</ol></div>
      <SignalChart history={history} kind="steering" /><SignalChart history={history} kind="odor" />
    </div> : <p className={styles.historyEmpty}>Waiting for observed samples. The timeline starts when the live stream connects.</p>}
    {history.length > 0 && <p className={styles.caption}>Server-reported modes and signals. Times show when this browser received each sample; gaps remain gaps.</p>}
  </section>;
});

export default function WorldDashboard() {
  const { frame, spikes, live, info, chainStatus, events, historyStatus, history, streamError, refresh } = useWorld();
  const checkpoint = events.find((event) => (event.name === "Checkpoint" || event.name === "Died") && (!info?.lastHash || String(event.args.stateHash).toLowerCase() === info.lastHash.toLowerCase()));
  const hash = info?.lastHash || (checkpoint ? String(checkpoint.args.stateHash) : null);
  const hasCheckpoint = !!hash && /^0x[0-9a-f]{64}$/i.test(hash) && !/^0x0{64}$/i.test(hash);
  const snapshotURI = checkpoint && typeof checkpoint.args.snapshotURI === "string" && worldOrigin(checkpoint.args.snapshotURI) ? checkpoint.args.snapshotURI : null;
  const status = live === "live" ? "Live simulation" : live === "stale" ? "Stream interrupted" : live === "connecting" ? "Connecting to stream" : "Stream offline";
  const observedEvents = frame?.events.slice(-4).reverse() ?? [];

  return <>
    <SiteHeader current="world" />
    <main id="main" className={`fly-dashboard ${styles.page}`}>
      <div className={styles.heading}>
        <div><h1>Whole brain</h1><p>Live neural activity and observed behavior.</p></div>
        <div className={styles.status} data-live={live === "live"}><span aria-hidden="true" />{status}</div>
      </div>

      <WatchSources current="world" />

      <div className={styles.workspace}>
        <section className={styles.visual} aria-label="Live simulation visualization">
          <div className={styles.stage}><WorldStage frame={frame} spikes={spikes} status={live} arena={info ? info.arena * 2 : 240} /></div>
          <dl className={styles.vitals}>
            <div><dt>Energy remaining</dt><dd>{frame ? elapsed(frame.energy) : "—"}</dd></div>
            <div><dt>Biological age</dt><dd>{frame ? elapsed(frame.t_ms / 1000) : "—"}</dd></div>
            <div><dt>Generation</dt><dd>{frame ? number(frame.generation) : "—"}</dd></div>
          </dl>
          <p className={styles.source}>Movement and neural activity come from the live simulation. Its state is periodically checkpointed on BNB Chain.</p>
        </section>

        <aside className={styles.observer} aria-label="Behavior and checkpoint evidence">
          <section className={styles.behavior}>
            <div className={styles.sectionTitle}><h2>Current behavior</h2><a href="#world-history">View history ↓</a></div>
            <div className={styles.mode}>{frame ? frame.alive ? modes[frame.mode] || frame.mode : "Stopped" : "Waiting for the fly"}</div>
            <p className={styles.caption}>{frame ? `${live === "live" ? "Observed" : "Last observed"} at step ${number(frame.step)}` : "Behavior appears when a valid live frame arrives."}</p>
            <dl className={styles.signals}>
              <div><dt>Steering signal</dt><dd>{frame ? `${frame.steer > 0 ? "+" : ""}${number(frame.steer)}` : "—"}</dd></div>
              <div><dt>Odor input · left</dt><dd>{frame ? `${number(frame.orn[0])} Hz` : "—"}</dd></div>
              <div><dt>Odor input · right</dt><dd>{frame ? `${number(frame.orn[1])} Hz` : "—"}</dd></div>
              <div><dt>Total spikes</dt><dd>{frame ? compact(frame.spikes_total) : "—"}</dd></div>
            </dl>
          </section>

          <section className={styles.checkpoint}>
            <div className={styles.sectionTitle}><h2>On-chain checkpoint</h2><span>{chainStatus === "live" ? "Confirmed" : chainStatus === "loading" ? "Loading" : info ? "Last read" : "Unavailable"}</span></div>
            {hasCheckpoint ? <>
              <p className={styles.hash} title={hash!}>{hash!.slice(0, 14)}…{hash!.slice(-12)}</p>
              <dl className={styles.checkpointStats}>
                <div><dt>Age recorded</dt><dd>{info ? elapsed(info.lastAgeMs / 1000) : "—"}</dd></div>
                <div><dt>Energy recorded</dt><dd>{info ? `${number(info.lastEnergy)} s` : "—"}</dd></div>
              </dl>
              <div className={styles.proofLinks}>
                {checkpoint && <a href={`${CFG.explorer}/tx/${checkpoint.tx}`} target="_blank" rel="noopener noreferrer">Transaction ↗</a>}
                {snapshotURI && <a href={snapshotURI} target="_blank" rel="noopener noreferrer">State snapshot ↗</a>}
              </div>
            </> : <p className={styles.empty}>{chainStatus === "loading" ? "Reading the world contract…" : info ? "No checkpoint hash is available yet." : "The checkpoint could not be read."}</p>}
            {info?.block && <p className={styles.caption}>Contract read at block {number(info.block)}</p>}
            {(chainStatus === "offline" || chainStatus === "stale") && <button className={styles.retry} type="button" onClick={() => void refresh()}>Retry chain connection</button>}
          </section>

          <section className={styles.events}>
            <div className={styles.sectionTitle}><h2>Observed events</h2><Link href="/activity/">Chain activity ↗</Link></div>
            {observedEvents.length > 0 ? <ol>{observedEvents.map(([time, text], index) => <li key={`${time}:${text}:${index}`}><span>{text}</span><time>{elapsed(time / 1000)}</time></li>)}</ol> : <p className={styles.empty}>{frame ? "No events in the latest frame." : "Waiting for events from the simulation."}</p>}
          </section>
        </aside>
      </div>

      <WorldHistory history={history} />

      <div className={styles.connectionNote}>
        <span>{streamError || "Live simulation and confirmed chain records are shown separately."}{historyStatus === "unavailable" ? " Recent checkpoint events are unavailable." : ""}</span>
        <a href={`${CFG.explorer}/address/${CFG.world}`} target="_blank" rel="noopener noreferrer">World contract ↗</a>
      </div>
    </main>
  </>;
}
