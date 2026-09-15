"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useArcade } from "@/hooks/useArcade";
import type { ArcadeDecision } from "@/lib/arcade";
import { CFG } from "@/lib/config";
import SiteHeader from "./SiteHeader";
import WatchSources from "./WatchSources";
import styles from "./ArcadeDashboard.module.css";

const number = (value: number | bigint) => value.toLocaleString("en-US");
const turnLabel = (turn: number) => turn > 0 ? "Turn left" : turn < 0 ? "Turn right" : "No net turn";
const turnValue = (turn: number) => `${turn > 0 ? "+" : ""}${number(turn)}°`;
const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const when = (timestamp: number | null) => timestamp === null ? "Time unavailable" : new Date(timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function DecisionChart({ decisions, selected }: { decisions: ArcadeDecision[]; selected?: string }) {
  const recent = decisions.slice(-80);
  if (!recent.length) return <div className={styles.chartEmpty}>Decision history appears here when records are available.</div>;
  const maxTurn = Math.max(10, ...recent.map(record => Math.abs(record.turn)));
  const width = 660, left = 48, right = 636, center = 102;
  const slot = (right - left) / recent.length;
  return <figure className={styles.chart}>
    <figcaption><strong>Recorded turns</strong><span>Left + / Right −</span></figcaption>
    <svg viewBox={`0 0 ${width} 237`} role="img" aria-label={`Net turn and firing reported in ${recent.length} decisions, from ${recent[0].n} to ${recent[recent.length - 1].n}`}>
      <line x1={left} x2={right} y1="32" y2="32" className={styles.chartRule} />
      <line x1={left} x2={right} y1={center} y2={center} className={styles.chartZero} />
      <line x1={left} x2={right} y1="172" y2="172" className={styles.chartRule} />
      <text x="0" y="36">+{number(maxTurn)}°</text><text x="28" y="106">0</text><text x="0" y="176">−{number(maxTurn)}°</text>
      {recent.map((record, index) => {
        const x = left + (index + .5) * slot, height = Math.abs(record.turn) / maxTurn * 70;
        return <g key={record.id}>
          {record.id === selected && <rect x={x - slot / 2} y="24" width={slot} height="187" fill="#d2dac3" opacity=".28" />}
          <rect x={x - Math.min(9, slot * .34)} y={record.turn >= 0 ? center - Math.max(1, height) : center} width={Math.min(18, slot * .68)} height={Math.max(1, height)} rx=".7" fill={record.turn > 0 ? "#6e8155" : record.turn < 0 ? "#a99167" : "#a6ada0"} />
          {record.fire && <circle cx={x} cy="198" r="2.7" fill="#be7553" />}
          <title>{`Decision ${record.n}: ${turnLabel(record.turn)}, ${turnValue(record.turn)}; ${record.fire ? "fired" : "no firing reported"}`}</title>
        </g>;
      })}
      <text x="6" y="202">Fire</text><text x={left} y="232">#{recent[0].n}</text><text x={right} y="232" textAnchor="end">#{recent[recent.length - 1].n}</text>
    </svg>
    <p>Net turn and any firing since the previous report.</p>
  </figure>;
}

function OutcomeChart({ decisions }: { decisions: ArcadeDecision[] }) {
  const records = decisions.slice(-80);
  if (!records.length) return null;
  const maxHealth = Math.max(100, ...records.map(record => record.health));
  const plot = (index: number, value: number) => `${40 + (records.length === 1 ? 0 : index / (records.length - 1)) * 582},${150 - value / maxHealth * 112}`;
  const segments: { record: ArcadeDecision; index: number }[][] = [];
  records.forEach((record, index) => {
    const previous = records[index - 1];
    if (!previous || record.n !== previous.n + 1 || record.gameTic < previous.gameTic) segments.push([]);
    segments[segments.length - 1].push({ record, index });
  });
  return <figure className={styles.outcomeChart}>
    <figcaption><strong>Reported health</strong><span>Game state at each report</span></figcaption>
    <svg viewBox="0 0 660 188" role="img" aria-label={`Reported health across ${records.length} decisions. Latest health ${records[records.length - 1].health}.`}>
      <line x1="40" x2="622" y1="38" y2="38" className={styles.chartRule} /><line x1="40" x2="622" y1="150" y2="150" className={styles.chartRule} />
      <text x="0" y="42">{number(maxHealth)}</text><text x="20" y="154">0</text>
      {segments.filter(segment => segment.length > 1).map(segment => <polyline key={segment[0].record.id} points={segment.map(({ record, index }) => plot(index, record.health)).join(" ")} fill="none" stroke="#748663" strokeWidth="2" strokeLinejoin="round" />)}
      {records.map((record, i) => { const [cx, cy] = plot(i, record.health).split(","); return <circle key={record.id} cx={cx} cy={cy} r="2.2" fill="#748663"><title>{`Decision ${record.n}: health ${record.health}, kills ${record.kills}`}</title></circle>; })}
      <text x="40" y="181">#{records[0].n}</text><text x="622" y="181" textAnchor="end">#{records[records.length - 1].n}</text>
    </svg>
  </figure>;
}

export default function ArcadeDashboard() {
  const arcade = useArcade();
  const params = useSearchParams();
  const sessionParam = params.get("session");
  const decisionParam = params.get("decision");
  const queryKey = `${sessionParam ?? ""}:${decisionParam ?? ""}`;
  const requestedSession = sessionParam && /^\d{1,78}$/.test(sessionParam) ? BigInt(sessionParam) : null;
  const requestedDecision = decisionParam && /^\d{1,10}$/.test(decisionParam) ? Number(decisionParam) : null;
  const handledSession = useRef<string | null>(null);
  const [selection, setSelection] = useState<{ query: string; session: string; decisionId: string | null } | null>(null);
  const session = arcade.selectedSession;
  const localSelection = selection?.session === session?.id.toString() && selection?.query === queryKey;
  const selectedId = localSelection ? selection?.decisionId : session?.id === requestedSession ? arcade.decisions.find(record => record.n === requestedDecision)?.id : null;
  const missingRequestedDecision = requestedDecision !== null && session?.id === requestedSession && !localSelection && arcade.decisionStatus !== "loading" && !arcade.decisions.some(record => record.n === requestedDecision);
  const decision = missingRequestedDecision ? undefined : arcade.decisions.find(record => record.id === selectedId) ?? arcade.decisions[arcade.decisions.length - 1];
  const history = useMemo(() => arcade.decisions.slice().reverse(), [arcade.decisions]);
  const sessionOptions = session && !arcade.sessions.some(item => item.id === session.id) ? [session, ...arcade.sessions] : arcade.sessions;
  const selectSession = arcade.selectSession;
  useEffect(() => {
    if (handledSession.current === queryKey) return;
    const firstRoute = handledSession.current === null;
    handledSession.current = queryKey;
    if (requestedSession !== null || !firstRoute) selectSession(requestedSession);
  }, [requestedSession, selectSession, queryKey]);
  const ended = Boolean(session && session.endBlock > BigInt(0));
  const hasHash = Boolean(decision && /^0x[\da-f]{64}$/i.test(decision.brainHash) && !/^0x0{64}$/i.test(decision.brainHash));
  const recorded = arcade.status === "ready";
  const unavailable = arcade.status === "unavailable";
  const notice = arcade.error || (arcade.status === "loading" ? "Reading arcade records…" : unavailable ? "Arcade records are unavailable. Retrying automatically." : arcade.status === "partial" ? "Some records are unavailable. Showing the received history." : null);

  return <><SiteHeader current="arcade" /><main id="main" className={`fly-dashboard ${styles.dashboard}`}>
    <div className={styles.heading}>
      <div><span className={styles.eyebrow}>Watch / Arcade</span><h1>The brain plays DOOM</h1></div>
      <span className={styles.status} data-ready={recorded}><i />{recorded ? "Connected to BSC" : arcade.status === "loading" ? "Connecting…" : unavailable ? "Connection unavailable" : "Partial history"}</span>
    </div>
    <WatchSources current="arcade" />
    <div className={styles.sessionBar}>
      <div><span className={styles.eyebrow}>Recorded session</span><h2>{session?.game || "Waiting for a session"}</h2><p>{session ? `Session ${number(session.id)} · ${ended ? "End recorded" : "No end recorded"}` : "Operator-reported game decisions on BNB Smart Chain"}</p></div>
      <label>Session<select aria-label="Arcade session" value={session?.id.toString() ?? ""} disabled={!sessionOptions.length} onChange={event => { setSelection({ query: queryKey, session: event.target.value, decisionId: null }); arcade.selectSession(BigInt(event.target.value)); }}>
        {!session && <option value="">{arcade.status === "loading" ? "Loading sessions…" : sessionOptions.length ? "No session selected" : "No sessions available"}</option>}
        {sessionOptions.map(item => <option key={item.id.toString()} value={item.id.toString()}>#{item.id.toString()} · {item.game}</option>)}
      </select></label>
    </div>
    {notice && <p className={styles.notice} role="status">{notice} <button type="button" onClick={arcade.refresh}>Refresh</button></p>}
    <div className={styles.workspace}>
      <section className={styles.tracking} aria-label="Recorded decision tracking">
        <DecisionChart decisions={arcade.decisions} selected={decision?.id} />
        <p className={styles.videoNote}>Decision records only. No video stream is published.</p>
      </section>
      <section className={styles.detail} aria-label="Selected arcade decision">
        {decision ? <>
          <div className={styles.detailHeading}><span className={styles.eyebrow}>Decision #{number(decision.n)}</span><a href={`${CFG.explorer}/tx/${decision.tx}`} target="_blank" rel="noopener noreferrer">Transaction ↗</a></div>
          <h2>{turnLabel(decision.turn)}{decision.fire && <span> + fire</span>}</h2>
          <p className={styles.reportedAt}>{when(decision.timestamp)} · block {number(decision.block)}</p>
          <dl className={styles.results}>
            <div><dt>Net turn</dt><dd>{turnValue(decision.turn)}</dd></div>
            <div><dt>Firing</dt><dd>{decision.fire ? "Reported" : "None reported"}</dd></div>
            <div><dt>Health</dt><dd>{number(decision.health)}</dd></div>
            <div><dt>Episode kills</dt><dd>{number(decision.kills)}</dd></div>
          </dl>
          <div className={styles.brainRecord}><div><span>Brain step</span><strong>{number(decision.brainStep)}</strong></div><div><span>Game tic</span><strong>{number(decision.gameTic)}</strong></div></div>
          <details className={styles.proof}><summary>{hasHash ? "Recorded brain hash" : "Hash unavailable"} <span>↗</span></summary>{hasHash && <p>{decision.brainHash}</p>}<dl><div><dt>Spike counter</dt><dd>{number(decision.spikes)}</dd></div></dl><small>Cumulative counter, stored as 32 bits.</small></details>
        </> : <div className={styles.empty}><h2>{missingRequestedDecision ? `Decision #${number(requestedDecision!)}` : "No decisions to show"}</h2><p>{missingRequestedDecision ? "This decision is outside the received history. Select an available record below." : arcade.decisionStatus === "loading" ? "Reading the selected session…" : unavailable ? "The contract could not be read." : session ? "No decisions were received for this session." : "Sessions will appear when their records are available."}</p></div>}
      </section>
    </div>

    {session && <dl className={styles.sessionStats}>
      <div><dt>Session decisions</dt><dd>{number(session.decisions)}</dd></div>
      <div><dt>History loaded</dt><dd>{number(arcade.decisions.length)}</dd></div>
      <div><dt>Start block</dt><dd>{number(session.startBlock)}</dd></div>
      <div><dt>End block</dt><dd>{ended ? number(session.endBlock) : "—"}</dd></div>
    </dl>}

    <OutcomeChart decisions={arcade.decisions} />
    <section className={styles.history} aria-label="Arcade decision history">
      <div className={styles.sectionHeading}><h2>Decision history</h2>{selectedId != null && session && <button type="button" onClick={() => setSelection({ query: queryKey, session: session.id.toString(), decisionId: null })}>{arcade.isLatest ? "Follow latest" : "Latest in view"}</button>}</div>
      {history.length ? <>
        <div className={styles.historyScroll}><table><thead><tr><th>Decision</th><th>Turn</th><th>Fire</th><th>Health</th><th>Kills</th><th>Transaction</th></tr></thead><tbody>
          {history.map(record => <tr key={record.id} data-selected={record.id === decision?.id}>
            <td><button type="button" onClick={() => setSelection({ query: queryKey, session: record.session.toString(), decisionId: record.id })} aria-pressed={record.id === decision?.id}>#{number(record.n)}</button><time>{when(record.timestamp)}</time></td>
            <td>{turnValue(record.turn)}</td><td>{record.fire ? "Yes" : "—"}</td><td>{number(record.health)}</td><td>{number(record.kills)}</td>
            <td><a href={`${CFG.explorer}/tx/${record.tx}`} target="_blank" rel="noopener noreferrer" aria-label={`Transaction for decision ${record.n}`}>{shortHash(record.tx)} ↗</a></td>
          </tr>)}
        </tbody></table></div>
        <p className={styles.historyNote}>{arcade.fromBlock !== null && arcade.toBlock !== null ? `Blocks ${number(arcade.fromBlock)}–${number(arcade.toBlock)}` : "Received records"}</p>
      </> : <p className={styles.historyNote}>No decision history received.</p>}
      {(arcade.canLoadOlder || !arcade.isLatest) && <div className={styles.historyNavigation}>
        {arcade.canLoadOlder && <button type="button" disabled={arcade.loadingOlder || arcade.status === "loading"} onClick={() => { if (session) setSelection({ query: queryKey, session: session.id.toString(), decisionId: decision?.id ?? null }); arcade.loadOlder(); }}>{arcade.loadingOlder ? "Loading earlier records…" : "← Earlier records"}</button>}
        {!arcade.isLatest && <button type="button" disabled={arcade.loadingOlder || arcade.status === "loading"} onClick={() => { if (session) setSelection({ query: queryKey, session: session.id.toString(), decisionId: null }); arcade.showLatest(); }}>Latest records →</button>}
      </div>}
    </section>
    <div className={styles.sourceNote}><p>Game actions are reported by the operator. The contract records the reports and brain hashes.</p><a href={`${CFG.explorer}/address/${CFG.arcade}`} target="_blank" rel="noopener noreferrer">FlyArcade ↗</a></div>
  </main></>;
}
