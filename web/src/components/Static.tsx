import circuitData from "@/data/circuit.json";
import { CFG } from "@/lib/config";
import { TYPE_NAMES } from "@/lib/flysim";

export function CircuitSection() {
  return (
    <section className="blk" id="brain">
      <div className="wrap">
        <div className="head">
          <div><p className="lbl">What is actually running on-chain</p><h2>The fly&apos;s compass, neuron for neuron.</h2></div>
          <p>Inside the ellipsoid body of every fruit fly, about fifty EPG neurons hold a single bump of activity that points where the fly is facing. PEN neurons push the bump around when it turns. Δ7 neurons inhibit everything else, so there is only ever one bump. PEG neurons keep it alive. The contract runs exactly these cells, with the synapse counts FlyWire measured between them, as integer leaky-integrate-and-fire neurons in the EVM. Every membrane potential is a storage slot.</p>
        </div>
        <div className="two">
          <svg viewBox="0 0 560 400" style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="The ring attractor: an EPG ring in the ellipsoid body, PEG and PEN in the protocerebral bridge, Delta7 providing global inhibition">
            <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#565e6d" /></marker></defs>
            <circle cx="186" cy="212" r="112" fill="none" stroke="#f0b429" strokeOpacity="0.18" strokeWidth="30" />
            {Array.from({ length: 16 }, (_, w) => { const a = (w * 2 * Math.PI) / 16; const on = w >= 14 || w <= 1;
              return <circle key={w} cx={186 + Math.cos(a) * 112} cy={212 - Math.sin(a) * 112} r={on ? 8 : 6} fill={on ? "#ff4a26" : "#f0b429"} fillOpacity={on ? 0.95 : 0.55} />; })}
            <circle cx="298" cy="212" r="26" fill="#ff4a26" fillOpacity="0.16" />
            <text x="186" y="206" textAnchor="middle" fill="#eceae4" fontFamily="var(--font-display)" fontWeight="700" fontSize="15">ELLIPSOID BODY</text>
            <text x="186" y="226" textAnchor="middle" fill="#8b93a1" fontFamily="var(--font-mono)" fontSize="10.5">51 EPG · 16 wedges · one bump</text>
            <text x="186" y="246" textAnchor="middle" fill="#ff4a26" fontFamily="var(--font-mono)" fontSize="10.5">← the heading</text>
            {[[52, "#f0b429", "PEG ×20", "same wedge · sustain"], [130, "#ff4a26", "PEN ×42", "wedge ±1 · rotate"], [278, "#58c4f5", "Δ7 ×42", "everywhere · inhibit"]].map(([y, c, t, s]) => (
              <g key={t as string}>
                <rect x="386" y={y as number} width="158" height="52" rx="7" fill="#0c1016" stroke={c as string} strokeOpacity="0.45" />
                <text x="465" y={(y as number) + 22} textAnchor="middle" fill={c as string} fontFamily="var(--font-mono)" fontSize="12" fontWeight="700">{t}</text>
                <text x="465" y={(y as number) + 39} textAnchor="middle" fill="#8b93a1" fontFamily="var(--font-mono)" fontSize="10">{s}</text>
              </g>))}
            <g stroke="#565e6d" strokeWidth="1.3" fill="none" markerEnd="url(#ar)">
              <path d="M280 128 C 330 100, 358 86, 382 80" /><path d="M300 178 C 336 168, 360 160, 382 154" /><path d="M300 252 C 336 268, 360 286, 382 300" />
            </g>
            <g strokeWidth="1.3" fill="none" markerEnd="url(#ar)">
              <path d="M386 86 C 350 108, 330 132, 312 172" stroke="#f0b429" strokeOpacity="0.8" />
              <path d="M386 162 C 358 186, 344 196, 330 204" stroke="#ff4a26" strokeOpacity="0.8" />
              <path d="M386 304 C 344 280, 326 258, 312 240" stroke="#58c4f5" strokeOpacity="0.8" />
            </g>
            <text x="386" y="26" fill="#565e6d" fontFamily="var(--font-mono)" fontSize="10" letterSpacing="0.12em">PROTOCEREBRAL BRIDGE</text>
            <text x="8" y="386" fill="#565e6d" fontFamily="var(--font-mono)" fontSize="9.5">edge weights = FlyWire synapse counts · 45,961 synapses in the circuit</text>
          </svg>
          <div className="types">
            <div><b style={{ color: "#f0b429" }}>EPG</b><span className="n">47+4</span><p>Compass cells. Each reads one wedge of the ring. Their spikes <em>are</em> the heading: the contract turns them into a direction and walks.</p></div>
            <div><b style={{ color: "#d9922a" }}>PEG</b><span className="n">20</span><p>Recurrent excitation back into the same wedge. Stops the bump fading.</p></div>
            <div><b style={{ color: "#ff4a26" }}>PEN_a</b><span className="n">20</span><p>Angular velocity. Left-hemisphere cells shift the bump one way, right the other. This is what “turn” drives.</p></div>
            <div><b style={{ color: "#ff7a52" }}>PEN_b</b><span className="n">22</span><p>A second, slower rotation population with the same effect.</p></div>
            <div><b style={{ color: "#58c4f5" }}>Δ7</b><span className="n">42</span><p>Glutamatergic, inhibitory. They read the bump and suppress everything far from it. “Shock” drives all of them at once.</p></div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ImmortalitySection() {
  return (
    <section className="blk" id="immortality">
      <div className="wrap">
        <div className="head"><div><p className="lbl">Digital immortality</p><h2>It can die. It cannot be lost.</h2></div>
          <p>The organism burns one unit of energy per simulation step. At zero it dies: ticks stop, the brain is hashed, and the life is written into an on-chain lineage. Anyone can resurrect it. The same membrane potentials, the same engram, the same heading memory wake up in a new body at the origin. Generation plus one.</p></div>
        <div className="four">
          <div><span className="lbl">state</span><h3>Brain</h3><p>155 membrane potentials and every pending synaptic current, packed into storage words and updated on each tick.</p></div>
          <div><span className="lbl">memory</span><h3>Engram</h3><p>Cells that fire habitually potentiate; silent ones depress. Slow, bounded, permanent. Plus a histogram of every direction it has held.</p></div>
          <div><span className="lbl">death</span><h3>Frozen</h3><p>Energy hits zero. Birth block, death block, steps, spikes and the hash of the brain go into <code>lineage[]</code>.</p></div>
          <div><span className="lbl">rebirth</span><h3>Resurrect</h3><p>Burn $FLY. The identical brain continues from the exact state it died in. Only the body is new.</p></div>
        </div>
      </div>
    </section>
  );
}

export function VisionSection() {
  return (
    <section className="blk" id="vision">
      <div className="wrap">
        <div className="head">
          <div><p className="lbl">The vision</p><h2>From one compass to a species.</h2></div>
          <div>
            <blockquote className="quote">“Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”<cite>CZ · 15 Sep 2026, quoting Siyuan on the fly brain that escaped the computer</cite></blockquote>
            <p style={{ marginTop: 22, color: "var(--dim)", fontSize: 17 }}>We took it literally. Every other fly-brain project runs the neurons on a GPU and puts only a swap on-chain. Here the neurons themselves are the contract: identity, brain state, memory, lineage and interaction history, exactly the five things Siyuan named.</p>
            <div className="hero-cta" style={{ justifyContent: "flex-start", marginTop: 20 }}>
              <a className="btn amber" href="/docs/vision/">Read the vision</a>
              <a className="btn" href="/docs/roadmap/">Roadmap</a>
              <a className="btn quiet" href="/docs/">Documentation →</a>
            </div>
          </div>
        </div>
        <div className="phases">
          <div className="on"><span className="lbl">live now</span><h3>Genesis fly</h3><p>One brain, one body, one lineage. Feed it, steer it, keep it alive.</p></div>
          <div><span className="lbl">phase 1</span><h3>Alive</h3><p>Keepers paid to tick. Senses from the chain: transfers smell like food, dumps loom like shadows.</p></div>
          <div><span className="lbl">phase 2</span><h3>Reflexes</h3><p>The giant-fiber escape circuit and descending steering neurons. It jumps, and it steers a real body.</p></div>
          <div><span className="lbl">phase 3</span><h3>Learning</h3><p>A mushroom-body compartment with dopamine-gated plasticity. Reward is food. It learns on-chain.</p></div>
          <div><span className="lbl">phase 4 · 5</span><h3>Colony, whole brain</h3><p>Many flies, a shared world, engrams that breed. Then the full connectome, checkpointed and disputable.</p></div>
        </div>
      </div>
    </section>
  );
}

export function TokenSection() {
  return (
    <section className="blk" id="token">
      <div className="wrap">
        <div className="head"><div><p className="lbl">$FLY</p><h2>Everything the fly eats is gone forever.</h2></div>
          <p>$FLY is a plain BEP-20 on BNB Smart Chain: no tax, no owner, no mint. The only sink is the fly. Feeding, stimulating and resurrecting send tokens to the dead address, and every one of those burns is a recorded act of care in the interaction history.</p></div>
        <div className="stats">
          <div className="stat"><span className="v">1B</span><span className="lbl">total supply</span><p>1,000,000,000 FLY at 18 decimals, minted once.</p></div>
          <div className="stat"><span className="v">0%</span><span className="lbl">tax</span><p>Ownership renounced. No transfer fees, no blacklist, no pause.</p></div>
          <div className="stat"><span className="v">0.05</span><span className="lbl">gwei on BSC</span><p>A 32-step tick of the whole circuit costs about 0.0003 BNB. That is why the brain can live here.</p></div>
          <div className="stat"><span className="v">∞</span><span className="lbl">lives</span><p>Resurrection has no limit. Only a price.</p></div>
        </div>
        <div className="checks">
          <ul><li>Fixed supply, minted once</li><li>Burns go to 0x…dEaD, anyone can verify</li><li>FlyBrain has no owner and no admin functions</li></ul>
          <ul><li>Every brain parameter is immutable</li><li>Deterministic: replay the whole life from events</li><li>Open source, MIT licensed</li></ul>
          <ul><li>Anyone can tick, feed, poke or resurrect</li><li>Circuit table stored as bytecode, hash-anchored</li><li>Source verified on Sourcify, exact match</li></ul>
        </div>
      </div>
    </section>
  );
}

export function ProvenanceSection() {
  const c = circuitData as any;
  return (
    <section className="blk" id="provenance">
      <div className="wrap">
        <div className="head"><div><p className="lbl">Provenance</p><h2>Check every neuron yourself.</h2></div>
          <p>The circuit comes from FlyWire release 783, the public whole-brain connectome of an adult female <i>Drosophila</i> (Dorkenwald et al. and Schlegel et al., Nature 2024). Every on-chain neuron carries its FlyWire root ID. Each cell&apos;s angle on the ring was measured from the coordinates of its own synapses inside the ellipsoid body. The brain in the header is the same dataset: 139,248 neurons.</p></div>
        <div className="hashes">
          <div><span className="lbl">circuit table keccak256</span><span className="v">{c.meta.table_keccak256}</span></div>
          <div><span className="lbl">connections file sha256 · zenodo 10676866</span><span className="v">{c.meta.connections_file_sha256}</span></div>
          <div><span className="lbl">ring geometry</span><span className="v">{c.meta.ring_geometry}</span></div>
        </div>
        <div className="scroller">
          <table className="data"><thead><tr><th>#</th><th>type</th><th>side</th><th>wedge</th><th>out</th><th>FlyWire root id — opens Codex</th></tr></thead>
            <tbody>{c.neurons.map((n: any) => (<tr key={n.i}><td>{n.i}</td><td>{TYPE_NAMES[n.type]}</td><td>{n.side[0].toUpperCase()}</td><td>{n.wedge === null ? "—" : n.wedge}</td><td>{n.out_degree}</td>
              <td><a href={CFG.links.codex + n.root_id} target="_blank" rel="noopener">{n.root_id}</a></td></tr>))}</tbody></table>
        </div>
      </div>
    </section>
  );
}
