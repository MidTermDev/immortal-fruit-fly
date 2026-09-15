import circuitData from "@/data/circuit.json";
import { CFG } from "@/lib/config";
import { TYPE_NAMES } from "@/lib/flysim";

const AMBER = "#b8790a", RED = "#e2341a", ICE = "#1a6f9e", INK = "#14161a", RULE = "#c9c9c3";

export function CircuitSection() {
  return (
    <section className="sec" id="circuit">
      <div className="wrap">
        <div className="sec-t">
          <div><div className="num">Figure 3 · Table 1</div><h2>Why this circuit, and not a pile of neurons</h2></div>
          <p>A fly knows which way it is facing because about fifty EPG neurons in the ellipsoid body hold one bump of activity that points in that direction. PEN neurons shove the bump around when the animal turns. Δ7 neurons suppress everything far from it, so there is only ever one bump. PEG neurons feed it back into itself so it does not fade. It is among the best-understood circuits in any brain, its output is a single number, and a single number moves a body. That is what makes it worth running in a place as expensive as a blockchain.</p>
        </div>
        <div className="cols2">
          <div>
            <svg viewBox="0 0 540 392" style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Diagram of the ring attractor: an EPG ring in the ellipsoid body receiving sustaining input from PEG, rotational input from PEN and global inhibition from Delta7">
              <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill={INK} /></marker></defs>
              <circle cx="176" cy="206" r="104" fill="none" stroke={RULE} strokeWidth="26" />
              {Array.from({ length: 16 }, (_, w) => { const a = (w * 2 * Math.PI) / 16, on = w >= 14 || w <= 1;
                return <circle key={w} cx={176 + Math.cos(a) * 104} cy={206 - Math.sin(a) * 104} r={on ? 7.5 : 5} fill={on ? RED : AMBER} fillOpacity={on ? 1 : 0.45} />; })}
              <text x="176" y="196" textAnchor="middle" fill={INK} fontFamily="var(--font-sans)" fontWeight="600" fontSize="13">Ellipsoid body</text>
              <text x="176" y="214" textAnchor="middle" fill="#7b828c" fontFamily="var(--font-mono)" fontSize="10">51 EPG · 16 wedges</text>
              <text x="176" y="232" textAnchor="middle" fill={RED} fontFamily="var(--font-mono)" fontSize="10">the bump = the heading</text>
              {[[40, AMBER, "PEG ×20", "back to the same wedge"], [130, RED, "PEN ×42", "one wedge over, either way"], [276, ICE, "Δ7 ×42", "suppress everything else"]].map(([y, c, t, s]) => (
                <g key={t as string}>
                  <rect x="358" y={y as number} width="172" height="50" fill="none" stroke={c as string} />
                  <text x="370" y={(y as number) + 21} fill={c as string} fontFamily="var(--font-mono)" fontSize="11.5" fontWeight="600">{t}</text>
                  <text x="370" y={(y as number) + 37} fill="#7b828c" fontFamily="var(--font-mono)" fontSize="9.5">{s}</text>
                </g>))}
              <g stroke={INK} strokeWidth="1" fill="none" markerEnd="url(#ar)" opacity="0.5">
                <path d="M262 118 C 306 88, 330 72, 354 66" /><path d="M280 172 C 312 164, 334 158, 354 154" /><path d="M280 244 C 312 264, 334 282, 354 296" />
              </g>
              <g strokeWidth="1.4" fill="none" markerEnd="url(#ar)">
                <path d="M358 72 C 320 96, 300 122, 286 164" stroke={AMBER} />
                <path d="M358 160 C 330 180, 316 190, 300 198" stroke={RED} />
                <path d="M358 300 C 318 276, 300 254, 288 236" stroke={ICE} />
              </g>
              <text x="358" y="22" fill="#7b828c" fontFamily="var(--font-mono)" fontSize="9.5" letterSpacing="0.12em">PROTOCEREBRAL BRIDGE</text>
              <text x="4" y="378" fill="#7b828c" fontFamily="var(--font-mono)" fontSize="9.5">Fig. 3 | edge weights are FlyWire synapse counts; 45,961 synapses in the circuit</text>
            </svg>
          </div>
          <div>
            <table className="data"><caption>Table 1 | Cell types on-chain</caption>
              <thead><tr><th>Type</th><th className="num">n</th><th>Transmitter</th><th>What it does</th></tr></thead>
              <tbody>
                <tr><td className="mono" style={{ color: AMBER }}>EPG</td><td className="num mono">47</td><td>acetylcholine</td><td>Holds the bump. One wedge each. Its spikes are the heading.</td></tr>
                <tr><td className="mono" style={{ color: AMBER }}>EPGt</td><td className="num mono">4</td><td>acetylcholine</td><td>A tile variant of the same compass cell.</td></tr>
                <tr><td className="mono" style={{ color: AMBER }}>PEG</td><td className="num mono">20</td><td>acetylcholine</td><td>Excites the same wedge back, so the bump persists.</td></tr>
                <tr><td className="mono" style={{ color: RED }}>PEN_a</td><td className="num mono">20</td><td>acetylcholine</td><td>Angular velocity. One hemisphere shifts the bump each way.</td></tr>
                <tr><td className="mono" style={{ color: RED }}>PEN_b</td><td className="num mono">22</td><td>acetylcholine</td><td>A slower second rotation population.</td></tr>
                <tr><td className="mono" style={{ color: ICE }}>Δ7</td><td className="num mono">42</td><td>glutamate, inhibitory</td><td>Reads the bump, suppresses everything far from it.</td></tr>
              </tbody></table>
            <p className="dim serif" style={{ fontSize: 14.5, marginTop: 14, lineHeight: 1.55 }}>Every one of these 155 cells is a specific animal&apos;s neuron with a FlyWire accession number, listed in full below. The weights between them are the synapse counts measured in the electron microscopy volume, not parameters anyone chose.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function MethodsSection() {
  return (
    <section className="sec" id="methods">
      <div className="wrap">
        <div className="sec-t">
          <div><div className="num">Methods</div><h2>How a nervous system fits inside a contract</h2></div>
          <p>The model is the one the whole field uses for connectome simulation — leaky integrate-and-fire, one weight per synapse, sign from the transmitter — rewritten in integers so the Ethereum Virtual Machine computes it exactly, with no floating point and nothing to disagree about.</p>
        </div>
        <div className="steps-list">
          <div><div><h3>Each neuron is an integer</h3><p>A membrane potential that leaks toward zero, sums what arrived from the synapses that fired last step, and emits a spike when it crosses threshold. Ten storage words hold all 155.</p></div></div>
          <div><div><h3>Noise without an oracle</h3><p>Real neurons are noisy; a contract must be deterministic. The background noise is <code>keccak256(step number)</code>, so anyone can recompute the animal&apos;s entire life from its events and get the same bits. A test replays the real mainnet transactions and checks every spike count.</p></div></div>
          <div><div><h3>The wiring lives in bytecode</h3><p>The circuit table — cell types, ring positions, every synapse, every FlyWire accession number — is stored as the code of a data contract and anchored by its keccak hash, so the wiring cannot change under the animal.</p></div></div>
          <div><div><h3>It costs about a third of a milli-BNB to think</h3><p>Thirty-two steps of the whole circuit run for roughly 7 million gas. At BNB Smart Chain&apos;s 0.05 gwei that is around 0.0003 BNB. On almost any other chain this animal could not afford to be alive.</p></div></div>
        </div>
        <p style={{ marginTop: 22 }}><a className="btn sm" href="/docs/how-it-works/">Full methods, parameters and gas figures →</a></p>
      </div>
    </section>
  );
}

export function ContinuitySection() {
  return (
    <section className="sec" id="continuity">
      <div className="wrap">
        <div className="sec-t">
          <div><div className="num">Continuity</div><h2>Death is a state, not an ending</h2></div>
          <p>When energy reaches zero the animal stops. What it was at that instant — every membrane potential, the engram, the memory of every direction it has held — is hashed and written into its lineage. Resurrection does not make a copy or start over. The same brain continues from the same state, in a new body, at the origin.</p>
        </div>
        <div className="cols4">
          <div><span className="lbl">state</span><h3>Brain</h3><p>155 membrane potentials and every pending synaptic current, in storage, rewritten on each tick.</p></div>
          <div><span className="lbl">memory</span><h3>Engram</h3><p>Cells that fire habitually potentiate; silent ones depress. Bounded, permanent, and carried through death.</p></div>
          <div><span className="lbl">record</span><h3>Lineage</h3><p>Birth block, death block, steps lived, spikes fired and the hash of the brain, one row per life.</p></div>
          <div><span className="lbl">identity</span><h3>Accession</h3><p>155 FlyWire root IDs in the bytecode. The same animal, provably, in every generation.</p></div>
        </div>
      </div>
    </section>
  );
}

export function VisionSection() {
  return (
    <section className="sec" id="vision">
      <div className="wrap">
        <div className="cols2">
          <div>
            <div className="num" style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: RED, marginBottom: 14 }}>Why this exists</div>
            <blockquote className="quote">“Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”<cite>CZ · 15 September 2026, quoting Siyuan on the fly brain that escaped the computer</cite></blockquote>
          </div>
          <div>
            <p className="serif" style={{ fontSize: 16.5, lineHeight: 1.6, color: "var(--ink-2)" }}>In the week the male fruit-fly connectome was published, people put that brain in DOOM, in Beat Saber, in Minecraft, and in a walking robot. Several tokens followed. In all of them the neurons run on a graphics card and the chain only ever sees a swap.</p>
            <p className="serif" style={{ fontSize: 16.5, lineHeight: 1.6, color: "var(--ink-2)", marginTop: 14 }}>Siyuan&apos;s reply named the five things a chain could actually hold: identity, brain state, memory, lineage, interaction history. Those are exactly the things that make an organism persist. So we put the neurons themselves in the contract, and everything else followed from that.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 22 }}>
              <a className="btn" href="/docs/vision/">Read the full argument</a>
              <a className="btn plain" href="/docs/roadmap/">Where it goes next →</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function TokenSection() {
  return (
    <section className="sec" id="fly">
      <div className="wrap">
        <div className="sec-t">
          <div><div className="num">$FLY</div><h2>A token because the animal needs a metabolism</h2></div>
          <p>$FLY is a BEP-20 with a 1% transfer tax, no owner and no mint. Its purpose is to be destroyed to buy the animal time. Feeding, stimulating and resurrecting all send it to the dead address, where it can never move again, and each of those burns is stored against the address that paid it. Circulating supply only falls, and it falls in proportion to how much anyone cares. (The token&apos;s 1% transfer tax applies to those transfers too; figures on this page are the amounts sent.)</p>
        </div>
        <div className="cols3">
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>What it buys</h3>
            <table className="data" style={{ fontSize: 13 }}><tbody>
              <tr><td>1 $FLY</td><td className="num mono">1 step of life</td></tr>
              <tr><td>100 $FLY</td><td className="num mono">1 unit of stimulus</td></tr>
              <tr><td>100,000 $FLY</td><td className="num mono">one resurrection</td></tr>
            </tbody></table>
          </div>
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>The token</h3>
            <table className="data" style={{ fontSize: 13 }}><tbody>
              <tr><td>Supply</td><td className="num mono">1,000,000,000</td></tr>
              <tr><td>Decimals</td><td className="num mono">18</td></tr>
              <tr><td>Tax</td><td className="num mono">1% on transfers</td></tr>
              <tr><td>Owner</td><td className="num mono">renounced</td></tr>
            </tbody></table>
          </div>
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>What the contract cannot do</h3>
            <p className="serif dim" style={{ fontSize: 14.5, lineHeight: 1.55 }}>FlyBrain has no owner, no admin function, no upgrade path and no pause. Every dynamical parameter is immutable. FlyWorld&apos;s operator can only post checkpoints and report a death; it cannot touch anyone&apos;s tokens or change prices.</p>
            <p style={{ marginTop: 12 }}><a className="btn sm" href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener">Get $FLY</a></p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function DataSection() {
  const c = circuitData as any;
  return (
    <section className="sec" id="data" style={{ borderBottom: "1px solid var(--ink)" }}>
      <div className="wrap">
        <div className="sec-t">
          <div><div className="num">Data availability</div><h2>Every neuron, by accession number</h2></div>
          <p>Nothing here is illustrative. The circuit was extracted from FlyWire release 783, the public whole-brain connectome of an adult female <i>Drosophila</i>. Each cell&apos;s angular position on the ring was measured from the coordinates of its own synapses inside the ellipsoid body, not assigned by hand. Open any accession number below to inspect the real cell.</p>
        </div>
        <div className="avail">
          <div><span className="lbl">circuit table keccak256</span><div className="v">{c.meta.table_keccak256}</div></div>
          <div><span className="lbl">connections file sha256</span><div className="v">{c.meta.connections_file_sha256}<br />doi:10.5281/zenodo.10676866</div></div>
          <div><span className="lbl">ring geometry</span><div className="v">{c.meta.ring_geometry}</div></div>
        </div>
        <table className="data" style={{ marginBottom: 0 }}><caption>Table 3 | The 155 neurons on-chain</caption></table>
        <div className="scroller">
          <table className="data">
            <thead><tr><th className="num">#</th><th>Type</th><th>Side</th><th className="num">Wedge</th><th className="num">Out</th><th>FlyWire accession</th></tr></thead>
            <tbody>{c.neurons.map((n: any) => (<tr key={n.i}>
              <td className="num">{n.i}</td><td>{TYPE_NAMES[n.type]}</td><td>{n.side}</td>
              <td className="num">{n.wedge === null ? "—" : n.wedge}</td><td className="num">{n.out_degree}</td>
              <td><a href={CFG.links.codex + n.root_id} target="_blank" rel="noopener">{n.root_id}</a></td></tr>))}</tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
