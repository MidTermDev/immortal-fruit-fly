import { count, type Execution } from "@/lib/decisions";
import styles from "./Observer.module.css";

export default function CircuitHistory({ records, selected }: { records: Execution[]; selected?: string }) {
  const series = records.slice(0, 24).reverse();
  if (series.length < 2) return null;
  const peak = Math.max(1, ...series.map(record => record.spikes / Math.max(1, record.steps)));
  const cell = 640 / series.length;
  return <div className={styles.charts}>
    <section className={styles.chart}><div className={styles.sectionHeading}><h2>Neural response</h2><span>Spikes / step</span></div>
      <svg viewBox="0 0 680 165" role="img" aria-label={`Neural response across ${series.length} recorded executions, oldest to newest. Peak ${peak.toFixed(1)} spikes per step.`}>
        <line x1="30" x2="670" y1="130" y2="130" stroke="#cdd1c7" />
        <line x1="30" x2="670" y1="25" y2="25" stroke="#dfe2d8" strokeDasharray="3 5" />
        <text x="0" y="134">0</text><text x="0" y="25">{peak.toFixed(0)}</text>
        {series.map((record, index) => { const value = record.spikes / Math.max(1, record.steps), height = value / peak * 105; return <rect key={record.event.id} x={30 + index * cell + cell * .18} y={130 - height} width={cell * .64} height={Math.max(1, height)} rx="1" fill={record.event.id === selected ? "#d74a2e" : "#74866b"}><title>{`Step ${count(record.to)}: ${value.toFixed(2)} spikes / step`}</title></rect>; })}
        <text x="30" y="158">Earlier</text><text x="670" y="158" textAnchor="end">Latest</text>
      </svg>
    </section>
    <section className={styles.chart}><div className={styles.sectionHeading}><h2>Heading outputs</h2><span>One vector / execution</span></div>
      <svg viewBox="0 0 680 165" role="img" aria-label={`Heading outputs across ${series.length} recorded executions, oldest to newest.`}>
        {series.map((record, index) => <g key={record.event.id} transform={`translate(${30 + (index + .5) * cell} 78)`}>
          <title>{`Step ${count(record.to)}: ${record.direction === null ? "no heading" : `${record.direction.toFixed(1)} degrees`}`}</title>
          <circle r="2" fill="#b7c0ae" />
          {record.direction !== null && <g transform={`rotate(${-record.direction})`} stroke={record.event.id === selected ? "#d74a2e" : "#556c48"} strokeWidth="2" fill="none"><path d="M-12 0H13m-5-5 5 5-5 5" /></g>}
        </g>)}
        <text x="30" y="158">Earlier</text><text x="670" y="158" textAnchor="end">Latest</text>
      </svg>
    </section>
  </div>;
}
