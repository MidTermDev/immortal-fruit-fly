"""Build the on-chain circuit table from the public FlyWire v783 connectome.

Selects the head-direction ring attractor (EPG, EPGt, PEG, PEN_a, PEN_b, Delta7),
sums synapse counts between those neurons across neuropils, recovers the ring
geometry of the EPG compass neurons from the wiring alone (spectral embedding of
the two-hop excitatory connectivity), assigns each EPG an ellipsoid-body wedge,
and packs everything into the byte table FlyBrain.sol expects.

Outputs:
  data/circuit.json            full description (neurons, synapses, angles, provenance)
  contracts/data/circuit.hex   packed table, 0x-prefixed
  site/assets/circuit.json     compact copy for the website
"""
import os, json, hashlib, struct, sys
import numpy as np, pandas as pd, pyarrow.feather as pf

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TSV = os.path.join(ROOT, 'data', 'Supplemental_file1_neuron_annotations.tsv')
FEATHER = os.path.join(ROOT, 'data', 'proofread_connections_783.feather')
TYPES = {'EPG': 0, 'EPGt': 1, 'PEG': 2, 'PEN_a(PEN1)': 3, 'PEN_b(PEN2)': 4, 'Delta7': 5}
TYPE_NAMES = ['EPG', 'EPGt', 'PEG', 'PEN_a', 'PEN_b', 'Delta7']
MAX_TABLE = 24_000
WEDGES = 16

# ---------------------------------------------------------------- neurons
ann = pd.read_csv(TSV, sep='\t', dtype=str, keep_default_na=False, usecols=['root_id', 'cell_type', 'side', 'pos_x', 'pos_y', 'pos_z', 'top_nt', 'hemibrain_type'])
ann['root_id'] = ann.root_id.astype(np.int64)
ring = ann[ann.cell_type.isin(TYPES)].copy()
ring['t'] = ring.cell_type.map(TYPES)
ring['sideb'] = (ring.side == 'right').astype(int)
ring = ring.sort_values(['t', 'sideb', 'root_id']).reset_index(drop=True)
N = len(ring)
assert N <= 255, N
idx = {r: i for i, r in enumerate(ring.root_id)}
print('neurons', N, ring.groupby(['cell_type', 'side']).size().to_dict())
print('neurotransmitter predictions:', ring.groupby('cell_type').top_nt.agg(lambda s: s.value_counts().to_dict()).to_dict())

# ------------------------------------------------------------- connections
sha = hashlib.sha256()
with open(FEATHER, 'rb') as f:
    for chunk in iter(lambda: f.read(1 << 24), b''):
        sha.update(chunk)
dataset_sha256 = sha.hexdigest()
print('dataset sha256', dataset_sha256)

tbl = pf.read_table(FEATHER, columns=['pre_pt_root_id', 'post_pt_root_id', 'syn_count'], memory_map=True)
df = tbl.to_pandas()
ids = set(idx)
sub = df[df.pre_pt_root_id.isin(ids) & df.post_pt_root_id.isin(ids)]
pairs = sub.groupby(['pre_pt_root_id', 'post_pt_root_id']).syn_count.sum().reset_index()
pairs = pairs[pairs.pre_pt_root_id != pairs.post_pt_root_id]
print('directed pairs (>=1 syn):', len(pairs), 'total synapses', int(pairs.syn_count.sum()))
for th in (1, 2, 3, 5, 10):
    print(f'  >= {th}: {int((pairs.syn_count >= th).sum())} pairs')

W = np.zeros((N, N), dtype=np.int64)
for pre, post, c in pairs.itertuples(index=False):
    W[idx[pre], idx[post]] = c

t = ring.t.values
EPG = np.where(t <= 1)[0]
PEG = np.where(t == 2)[0]
PEN = np.where((t == 3) | (t == 4))[0]
D7 = np.where(t == 5)[0]

# ------------------------------------------------ ring geometry from wiring
# Two-hop excitatory EPG->EPG connectivity via PEG (same wedge) and PEN (±1 wedge),
# plus any direct EPG->EPG synapses. Symmetrised, then Laplacian eigenmaps -> circle.
A = (W[np.ix_(EPG, PEG)] @ W[np.ix_(PEG, EPG)]).astype(float)
A += (W[np.ix_(EPG, PEN)] @ W[np.ix_(PEN, EPG)]).astype(float)
A += W[np.ix_(EPG, EPG)].astype(float) * 10
A = A + A.T
np.fill_diagonal(A, 0)
d = A.sum(1)
Dm = np.diag(1 / np.sqrt(np.maximum(d, 1e-9)))
L = np.eye(len(EPG)) - Dm @ A @ Dm
vals, vecs = np.linalg.eigh(L)
u = vecs[:, 1:3]
ang = np.arctan2(u[:, 1], u[:, 0])
rad = np.hypot(u[:, 0], u[:, 1])
print('spectral eigenvalues', np.round(vals[:5], 4), 'radial cv', round(float(rad.std() / rad.mean()), 3))

# Validate with the inhibitory pathway: EPG -> Delta7 -> EPG should target the far side of the ring.
I2 = (W[np.ix_(EPG, D7)] @ W[np.ix_(D7, EPG)]).astype(float)
dphi = np.abs(np.angle(np.exp(1j * (ang[:, None] - ang[None, :]))))
strong = I2 > np.percentile(I2, 90)
print('mean angular distance of strongest EPG->Δ7->EPG inhibition: %.1f° (expect ~180°)' % np.degrees(dphi[strong].mean()))
same = W[np.ix_(EPG, PEG)] @ W[np.ix_(PEG, EPG)] > 0
print('mean angular distance of EPG->PEG->EPG excitation: %.1f° (expect small)' % np.degrees(dphi[same & ~np.eye(len(EPG), dtype=bool)].mean()))

# Orientation: make TURN_LEFT (left-hemisphere PEN) rotate the bump counter-clockwise (increasing angle).
# Left PEN neurons read EPG at wedge w and write to wedge w+1 (in some sign). Measure the sign.
sideb = ring.sideb.values
def pen_shift(side):
    tot = 0.0
    for p in PEN:
        if sideb[p] != side: continue
        src = W[EPG, p].astype(float); dst = W[p, EPG].astype(float)
        if src.sum() == 0 or dst.sum() == 0: continue
        a_in = np.angle((src * np.exp(1j * ang)).sum()); a_out = np.angle((dst * np.exp(1j * ang)).sum())
        tot += np.angle(np.exp(1j * (a_out - a_in)))
    return tot
left_shift = pen_shift(0); right_shift = pen_shift(1)
print('PEN left shift sum %.2f, right shift sum %.2f' % (left_shift, right_shift))
if left_shift < 0:
    ang = -ang
    print('flipped ring orientation so left-PEN drive rotates the bump counter-clockwise')

# Rotate so wedge bins are as balanced as possible, then assign wedges.
best = None
for off in np.linspace(0, 2 * np.pi / WEDGES, 32, endpoint=False):
    w = np.floor(((ang - off) % (2 * np.pi)) / (2 * np.pi / WEDGES)).astype(int)
    cnt = np.bincount(w, minlength=WEDGES)
    score = (cnt.min(), -cnt.std())
    if best is None or score > best[0]:
        best = (score, off, w)
_, off, wedge_epg = best
ang = (ang - off) % (2 * np.pi)
print('EPG per wedge', np.bincount(wedge_epg, minlength=WEDGES).tolist())

wedge = np.full(N, 255, dtype=int)
angle = np.full(N, np.nan)
wedge[EPG] = wedge_epg
angle[EPG] = ang
for i in np.concatenate([PEG, PEN]):
    out = W[i, EPG]; inn = W[EPG, i]
    v = out if out.sum() > 0 else inn
    if v.sum() == 0: continue
    a = np.angle((v * np.exp(1j * ang)).sum()) % (2 * np.pi)
    angle[i] = a
    wedge[i] = int(a / (2 * np.pi / WEDGES)) % WEDGES
for i in D7:
    inn = W[EPG, i]
    if inn.sum() > 0:
        angle[i] = np.angle((inn * np.exp(1j * ang)).sum()) % (2 * np.pi)

# ------------------------------------------------------------- threshold
th = 1
while True:
    S = int((pairs.syn_count >= th).sum())
    size = 4 + 3 * N + 2 * (N + 1) + 2 * S + 8 * N
    if size <= MAX_TABLE: break
    th += 1
print(f'synapse threshold >= {th}: S = {S}, table {size} bytes')
keep = pairs[pairs.syn_count >= th]

out_syn = [[] for _ in range(N)]
for pre, post, c in keep.itertuples(index=False):
    out_syn[idx[pre]].append((idx[post], int(min(c, 255))))
for lst in out_syn: lst.sort()

# ------------------------------------------------------------------ pack
b = bytearray()
b += struct.pack('>BBH', 1, N, S)
b += bytes(int(x) for x in t)
b += bytes(int(x) for x in wedge)
b += bytes(int(x) for x in sideb)
offs = [0]
for lst in out_syn: offs.append(offs[-1] + len(lst))
assert offs[-1] == S
for o in offs: b += struct.pack('>H', o)
for lst in out_syn:
    for post, w in lst: b += struct.pack('>BB', post, w)
for r in ring.root_id: b += struct.pack('>Q', int(r))
assert len(b) == size, (len(b), size)
table_hex = '0x' + b.hex()
open(os.path.join(ROOT, 'contracts', 'data', 'circuit.hex'), 'w').write(table_hex)
from Crypto.Hash import keccak
k = keccak.new(digest_bits=256); k.update(bytes(b))
circuit_hash = '0x' + k.hexdigest()

pos = {int(r): (float(x) * 4, float(y) * 4, float(z) * 40) for r, x, y, z in ring[['root_id', 'pos_x', 'pos_y', 'pos_z']].itertuples(index=False)}
neurons = []
for i in range(N):
    r = int(ring.root_id[i])
    neurons.append({'i': i, 'root_id': str(r), 'type': int(t[i]), 'type_name': TYPE_NAMES[t[i]], 'side': 'right' if sideb[i] else 'left',
                    'wedge': int(wedge[i]) if wedge[i] != 255 else None,
                    'angle': None if np.isnan(angle[i]) else round(float(angle[i]), 4),
                    'top_nt': ring.top_nt[i], 'pos_nm': [round(v) for v in pos[r]],
                    'out_degree': len(out_syn[i])})
synapses = [[i, post, w] for i in range(N) for post, w in out_syn[i]]
meta = {
    'dataset': 'FlyWire whole-brain connectome, release 783 (Dorkenwald et al., Nature 2024; Schlegel et al., Nature 2024)',
    'connections_file': 'proofread_connections_783.feather', 'connections_file_sha256': dataset_sha256,
    'connections_doi': '10.5281/zenodo.10676866',
    'annotations_file': 'flyconnectome/flywire_annotations Supplemental_file1_neuron_annotations.tsv',
    'circuit': 'head-direction ring attractor: EPG, EPGt, PEG, PEN_a, PEN_b, Delta7',
    'N': N, 'S': S, 'synapse_threshold': th, 'total_synapses_in_circuit': int(pairs.syn_count.sum()),
    'synapses_kept': int(keep.syn_count.sum()), 'table_bytes': size, 'table_keccak256': circuit_hash,
    'ring_geometry': 'Laplacian eigenmap of symmetrised two-hop excitatory EPG->{PEG,PEN}->EPG connectivity; wedges = 16 equal angular bins',
    'wedges': WEDGES,
}
json.dump({'meta': meta, 'neurons': neurons, 'synapses': synapses}, open(os.path.join(ROOT, 'data', 'circuit.json'), 'w'), indent=1)
json.dump({'meta': meta, 'neurons': neurons, 'synapses': synapses, 'table': table_hex},
          open(os.path.join(ROOT, 'site', 'assets', 'circuit.json'), 'w'), separators=(',', ':'))
json.dump(meta, open(os.path.join(ROOT, 'contracts', 'data', 'circuit_meta.json'), 'w'), indent=1)
print('table keccak256', circuit_hash)
print('wrote data/circuit.json, contracts/data/circuit.hex, site/assets/circuit.json')
