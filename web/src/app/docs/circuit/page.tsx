import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
import circuitData from "@/data/circuit.json";
import { CFG } from "@/lib/config";
import { TYPE_NAMES } from "@/lib/flysim";
export const metadata: Metadata = { title: "The circuit" };

export default function Page() {
  const c = circuitData as any;
  const counts: Record<string, number> = {};
  for (const n of c.neurons) { const k = `${TYPE_NAMES[n.type]} ${n.side}`; counts[k] = (counts[k] || 0) + 1; }
  return (
    <DocsShell current="/docs/circuit/">
      <h1>The circuit, neuron by neuron</h1>
      <p className="lede">155 neurons, 6,522 connections, 45,961 synapses, from FlyWire release 783. Every root ID below opens the real cell in FlyWire Codex.</p>
      <h2>How it was built</h2>
      <ol>
        <li>Take every neuron annotated EPG, EPGt, PEG, PEN_a, PEN_b or Delta7 in the FlyWire community annotations (Schlegel et al. 2024).</li>
        <li>Sum the synapse counts between those neurons across all neuropils from the proofread connections table (Zenodo 10676866, sha256 <code>{c.meta.connections_file_sha256.slice(0, 16)}…</code>).</li>
        <li>Measure each neuron&apos;s angle on the ring from the positions of its own synapses inside the ellipsoid body: postsynaptic sites for EPG (their dendrites), presynaptic sites for PEG and PEN (their axons). 110,056 synapse coordinates from the 9.5 GB FlyWire synapse table. Bin into 16 wedges.</li>
        <li>Pack into a byte table (types, wedges, sides, CSR synapse lists, root IDs), keccak256 it, store it as bytecode.</li>
      </ol>
      <table className="data"><thead><tr><th>Type</th><th>Left</th><th>Right</th><th>Neurotransmitter (FlyWire prediction)</th><th>Role</th></tr></thead><tbody>
        <tr><td>EPG</td><td>24</td><td>23</td><td>acetylcholine</td><td>compass; one wedge each</td></tr>
        <tr><td>EPGt</td><td>2</td><td>2</td><td>acetylcholine</td><td>compass, tile variant</td></tr>
        <tr><td>PEG</td><td>9</td><td>11</td><td>acetylcholine</td><td>recurrent sustain</td></tr>
        <tr><td>PEN_a</td><td>10</td><td>10</td><td>acetylcholine</td><td>rotation (angular velocity)</td></tr>
        <tr><td>PEN_b</td><td>11</td><td>11</td><td>acetylcholine</td><td>rotation, slower</td></tr>
        <tr><td>Δ7</td><td>21</td><td>21</td><td>glutamate (inhibitory)</td><td>global inhibition</td></tr>
      </tbody></table>
      <h2>Geometry</h2>
      <p>{c.meta.ring_geometry}. Circuit table keccak256: <code>{c.meta.table_keccak256}</code>.</p>
      <div className="neurons"><table className="data"><thead><tr><th>#</th><th>type</th><th>side</th><th>wedge</th><th>angle</th><th>out</th><th>FlyWire root id</th></tr></thead>
        <tbody>{c.neurons.map((n: any) => <tr key={n.i}><td>{n.i}</td><td>{TYPE_NAMES[n.type]}</td><td>{n.side[0].toUpperCase()}</td><td>{n.wedge === null ? "—" : n.wedge}</td><td>{n.angle === null ? "—" : Math.round((n.angle * 180) / Math.PI) + "°"}</td><td>{n.out_degree}</td><td><a href={CFG.links.codex + n.root_id} target="_blank" rel="noopener">{n.root_id}</a></td></tr>)}</tbody></table></div>
    </DocsShell>
  );
}
