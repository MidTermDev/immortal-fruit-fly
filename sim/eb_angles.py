"""Anatomical ring geometry: each ring-attractor neuron's angular position in the
ellipsoid body (EB), computed from the positions of its synapses in the EB in the
FlyWire synapse table (flywire_synapses_783.feather).

  EPG / EPGt : centroid of their POSTsynaptic sites in the EB (dendrites = their wedge)
  PEG / PEN  : centroid of their PREsynaptic sites in the EB (axons = the tile they write to)
Output: data/eb_angles.json  { root_id: {angle_rad, n_syn, r} }
"""
import os, json, numpy as np, pyarrow as pa, pyarrow.compute as pc, pyarrow.feather as pf
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
circ = json.load(open(os.path.join(ROOT, 'data', 'circuit.json')))
neu = circ['neurons']
epg = [int(n['root_id']) for n in neu if n['type'] <= 1]
pp = [int(n['root_id']) for n in neu if n['type'] in (2, 3, 4)]
cols = ['pre_pt_root_id', 'post_pt_root_id', 'neuropil', 'pre_pt_position_x', 'pre_pt_position_y', 'pre_pt_position_z',
        'post_pt_position_x', 'post_pt_position_y', 'post_pt_position_z']
t = pf.read_table(os.path.join(ROOT, 'data', 'flywire_synapses_783.feather'), columns=cols, memory_map=True)
print('rows', t.num_rows)
inEB = pc.equal(t['neuropil'], 'EB')
post_epg = pc.and_(inEB, pc.is_in(t['post_pt_root_id'], value_set=pa.array(epg, pa.int64())))
pre_pp = pc.and_(inEB, pc.is_in(t['pre_pt_root_id'], value_set=pa.array(pp, pa.int64())))
a = t.filter(post_epg).to_pandas(); b = t.filter(pre_pp).to_pandas()
print('EB synapses: onto EPG', len(a), 'from PEG/PEN', len(b))
# isotropic nm
def xyz(df, p): return np.stack([df[f'{p}_pt_position_x'] * 4.0, df[f'{p}_pt_position_y'] * 4.0, df[f'{p}_pt_position_z'] * 40.0], 1)
A = xyz(a, 'post'); B = xyz(b, 'pre')
allp = np.vstack([A, B]); center = allp.mean(0)
u, s, vt = np.linalg.svd(allp - center, full_matrices=False)
e1, e2 = vt[0], vt[1]   # ring plane
print('EB extent along principal axes (um):', np.round(s / np.sqrt(len(allp)) / 1000, 1))
out = {}
def ang_of(P):
    q = P - center
    return np.arctan2(q @ e2, q @ e1), np.hypot(q @ e2, q @ e1)
for rid, grp in a.groupby('post_pt_root_id'):
    th, r = ang_of(xyz(grp, 'post'))
    z = np.exp(1j * th).mean()
    out[str(rid)] = {'angle': float(np.angle(z) % (2 * np.pi)), 'concentration': float(abs(z)), 'n_syn': int(len(grp)), 'r_um': float(r.mean() / 1000)}
for rid, grp in b.groupby('pre_pt_root_id'):
    th, r = ang_of(xyz(grp, 'pre'))
    z = np.exp(1j * th).mean()
    out[str(rid)] = {'angle': float(np.angle(z) % (2 * np.pi)), 'concentration': float(abs(z)), 'n_syn': int(len(grp)), 'r_um': float(r.mean() / 1000)}
json.dump({'center_nm': center.tolist(), 'e1': e1.tolist(), 'e2': e2.tolist(), 'angles': out}, open(os.path.join(ROOT, 'data', 'eb_angles.json'), 'w'), indent=1)
angs = sorted(out[str(r)]['angle'] for r in epg if str(r) in out)
print('EPG with EB synapses:', len(angs), '/', len(epg))
print('EPG angles (deg):', np.round(np.degrees(angs)).astype(int).tolist())
print('EPG concentration (1 = tight wedge):', np.round([out[str(r)]['concentration'] for r in epg if str(r) in out], 2).tolist())
