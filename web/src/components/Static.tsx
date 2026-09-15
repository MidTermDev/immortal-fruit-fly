import circuitData from "@/data/circuit.json";
import { CFG } from "@/lib/config";
import { TYPE_NAMES } from "@/lib/flysim";

export function CircuitSection() {
  return (
    <section className="block" id="brain">
      <div className="wrap">
        <div className="sec-head"><div><p className="eyebrow">What is actually running on-chain</p><h2>The fly&apos;s compass, neuron for neuron.</h2></div>
          <p>Inside the ellipsoid body of every fruit fly, about fifty EPG neurons hold a single bump of activity that points where the fly is facing. PEN neurons push the bump around when the fly turns. Δ7 neurons inhibit everything else so there is only ever one bump. PEG neurons keep it alive. <span className="gold">FlyBrain.sol</span> runs exactly these cells, with the synapse counts FlyWire measured between them, as integer leaky-integrate-and-fire neurons in the EVM. Every membrane potential is a storage slot.</p></div>
        <div className="circuit-grid">
          <svg className="circuit-svg" viewBox="0 0 560 420" role="img" aria-label="Diagram of the ring attractor: EPG ring in the ellipsoid body, PEN and PEG in the protocerebral bridge, Delta7 inhibition">
            <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8f94a3" /></marker></defs>
            <circle cx="200" cy="230" r="120" fill="none" stroke="#f5b840" strokeOpacity="0.35" strokeWidth="26" />
            <g fill="#f5b840">{Array.from({ length: 16 }, (_, w) => { const a = (w * 2 * Math.PI) / 16; return <circle key={w} cx={200 + Math.cos(a) * 120} cy={230 - Math.sin(a) * 120} r="7" />; })}</g>
            <circle cx="311" cy="184" r="16" fill="#ff4d2e" fillOpacity="0.35" /><circle cx="320" cy="230" r="22" fill="#ff4d2e" fillOpacity="0.55" /><circle cx="311" cy="276" r="16" fill="#ff4d2e" fillOpacity="0.35" />
            <text x="200" y="236" textAnchor="middle" fill="#e8e4da" fontFamily="var(--display)" fontWeight="800" fontSize="16">ELLIPSOID BODY</text>
            <text x="200" y="256" textAnchor="middle" fill="#8f94a3" fontFamily="var(--mono)" fontSize="11">51 EPG · 16 wedges · the bump</text>
            <rect x="380" y="60" width="150" height="46" rx="4" fill="#151a29" stroke="#f5b840" strokeOpacity="0.6" /><text x="455" y="80" textAnchor="middle" fill="#f5b840" fontFamily="var(--mono)" fontSize="12" fontWeight="700">PEG ×20</text><text x="455" y="96" textAnchor="middle" fill="#8f94a3" fontFamily="var(--mono)" fontSize="10">same wedge · sustain</text>
            <rect x="380" y="130" width="150" height="46" rx="4" fill="#151a29" stroke="#ff4d2e" strokeOpacity="0.7" /><text x="455" y="150" textAnchor="middle" fill="#ff4d2e" fontFamily="var(--mono)" fontSize="12" fontWeight="700">PEN ×42</text><text x="455" y="166" textAnchor="middle" fill="#8f94a3" fontFamily="var(--mono)" fontSize="10">wedge ±1 · rotate</text>
            <rect x="380" y="300" width="150" height="46" rx="4" fill="#151a29" stroke="#4fc3f7" strokeOpacity="0.7" /><text x="455" y="320" textAnchor="middle" fill="#4fc3f7" fontFamily="var(--mono)" fontSize="12" fontWeight="700">Δ7 ×42</text><text x="455" y="336" textAnchor="middle" fill="#8f94a3" fontFamily="var(--mono)" fontSize="10">global inhibition</text>
            <g stroke="#8f94a3" strokeWidth="1.5" fill="none" markerEnd="url(#ah)"><path d="M300 120 C 340 95, 360 88, 378 84" /><path d="M325 190 C 350 175, 365 160, 378 153" /><path d="M330 300 C 350 310, 365 318, 378 323" /><path d="M380 92 C 350 110, 335 130, 327 165" stroke="#f5b840" /><path d="M380 160 C 355 200, 350 215, 344 225" stroke="#ff4d2e" /><path d="M380 315 C 340 280, 330 260, 322 245" stroke="#4fc3f7" /></g>
            <text x="20" y="30" fill="#8f94a3" fontFamily="var(--mono)" fontSize="11">PROTOCEREBRAL BRIDGE →</text>
            <text x="20" y="400" fill="#5d6270" fontFamily="var(--mono)" fontSize="10">weights = FlyWire synapse counts, 45,961 synapses total</text>
          </svg>
          <div className="celltypes">
            <div><b className="gold">EPG</b><span className="n">47+4</span><p>Compass neurons. Each reads one wedge of the ring. Their spikes are the fly&apos;s heading: the contract decodes them into a direction and walks.</p></div>
            <div><b className="gold">PEG</b><span className="n">20</span><p>Recurrent excitation back into the same wedge. Keeps the bump from fading.</p></div>
            <div><b className="eye">PEN_a</b><span className="n">20</span><p>Angular-velocity input. Left-side PEN neurons shift the bump one way, right-side the other. That is what “turn” drives.</p></div>
            <div><b className="eye">PEN_b</b><span className="n">22</span><p>A second, slower PEN population with the same shift.</p></div>
            <div><b className="cyan">Δ7</b><span className="n">42</span><p>Glutamatergic, inhibitory. They read the bump and suppress everything far from it. “Shock” drives all of them at once.</p></div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function TokenSection() {
  return (
    <section className="block" id="token">
      <div className="wrap">
        <div className="sec-head"><div><p className="eyebrow">$FLY</p><h2>Everything the fly eats is gone forever.</h2></div><p>$FLY is a plain BEP-20 on BNB Smart Chain. There is no tax, no owner, no mint. The only sink is the fly: feeding, stimulating and resurrecting send tokens to the dead address. Supply only goes down, and every burn is a recorded act of care in the interaction history.</p></div>
        <div className="tiles">
          <div className="tile"><span className="v">1B</span><span className="k">total supply</span><p>1,000,000,000 FLY, 18 decimals.</p></div>
          <div className="tile"><span className="v">0%</span><span className="k">tax</span><p>Ownership renounced. No transfer fees, no blacklist.</p></div>
          <div className="tile"><span className="v">0.05</span><span className="k">gwei on BSC</span><p>A 32-step tick of the whole circuit costs about 0.0003 BNB. That is why the brain can live here.</p></div>
          <div className="tile"><span className="v">∞</span><span className="k">lives</span><p>Resurrection has no limit. Only the price.</p></div>
        </div>
        <div className="checks"><ul><li>Fixed supply, minted once</li><li>Burns go to 0x…dEaD, verifiable by anyone</li><li>FlyBrain has no owner and no admin functions</li></ul><ul><li>Every parameter of the brain is immutable</li><li>Deterministic: replay the whole life from events</li><li>Open source, MIT</li></ul><ul><li>Anyone can tick, feed, poke, resurrect</li><li>Circuit table stored as bytecode, hash-anchored</li><li>Source verified on Sourcify (exact match)</li></ul></div>
      </div>
    </section>
  );
}

export function ProvenanceSection() {
  const c = circuitData as any;
  return (
    <section className="block" id="provenance">
      <div className="wrap">
        <div className="sec-head"><div><p className="eyebrow">Provenance</p><h2>Check every neuron yourself.</h2></div><p>The circuit comes from FlyWire release 783, the public whole-brain connectome of an adult female <i>Drosophila</i> (Dorkenwald et al., Nature 2024; Schlegel et al., Nature 2024). Each on-chain neuron carries its FlyWire root ID. The angular position of each EPG in the ring was measured from the coordinates of its synapses in the ellipsoid body. The full brain in the header is the same dataset: 139,248 neurons.</p></div>
        <div className="tiles" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", marginBottom: 30 }}>
          <div className="tile hash"><span className="k">circuit table keccak256</span><span className="v">{c.meta.table_keccak256}</span></div>
          <div className="tile hash"><span className="k">connections file sha256 (Zenodo 10676866)</span><span className="v">{c.meta.connections_file_sha256}</span></div>
          <div className="tile hash"><span className="k">ring geometry</span><span className="v">{c.meta.ring_geometry}</span></div>
        </div>
        <div className="neurons"><table className="data"><thead><tr><th>#</th><th>type</th><th>side</th><th>wedge</th><th>out</th><th>FlyWire root id (opens Codex)</th></tr></thead>
          <tbody>{c.neurons.map((n: any) => <tr key={n.i}><td>{n.i}</td><td>{TYPE_NAMES[n.type]}</td><td>{n.side[0].toUpperCase()}</td><td>{n.wedge === null ? "—" : n.wedge}</td><td>{n.out_degree}</td><td><a href={CFG.links.codex + n.root_id} target="_blank" rel="noopener">{n.root_id}</a></td></tr>)}</tbody></table></div>
      </div>
    </section>
  );
}

export function VisionTeaser() {
  return (
    <section className="block" id="vision">
      <div className="wrap">
        <div className="sec-head">
          <div><p className="eyebrow">The vision</p><h2>From one compass to a species.</h2></div>
          <div>
            <blockquote className="quote">“Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”<cite>CZ, 15 September 2026, quoting Siyuan (YZi Labs) on the fly brain that escaped the computer</cite></blockquote>
            <p style={{ marginTop: 22 }}>We took that literally. The genesis fly is the first organism whose brain state, memory, lineage and every interaction live on BNB Chain. The roadmap goes from here to reflexes, learning, a colony that breeds, and finally the whole 166,700-neuron brain anchored to the chain.</p>
            <div className="hero-cta" style={{ justifyContent: "flex-start", marginTop: 18 }}><a className="btn gold" href="/docs/vision/">Read the vision</a><a className="btn" href="/docs/roadmap/">Roadmap</a><a className="btn ghost" href="/docs/">Documentation →</a></div>
          </div>
        </div>
        <div className="roadmap">
          <div className="now"><span className="k">now · live</span><h3>Genesis fly</h3><p>One brain, one body, one lineage. Feed it, steer it, keep it alive.</p></div>
          <div><span className="k">phase 1</span><h3>Alive</h3><p>Keepers paid to tick. Senses from the chain: transfers smell like food, dumps loom like shadows.</p></div>
          <div><span className="k">phase 2</span><h3>Reflexes</h3><p>The giant-fiber escape circuit and descending steering neurons. The fly jumps and turns a body.</p></div>
          <div><span className="k">phase 3</span><h3>Learning</h3><p>A mushroom-body compartment with dopamine-gated plasticity. Reward is food. It learns on-chain.</p></div>
          <div><span className="k">phase 4–5</span><h3>Colony · whole brain</h3><p>Many flies, shared world, breeding of engrams. Then the full connectome, checkpointed and verifiable.</p></div>
        </div>
      </div>
    </section>
  );
}
