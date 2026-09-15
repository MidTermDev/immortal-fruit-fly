"""Build the whole-brain network from FlyWire v783 for the simulator.

Neurons: all 139,248 annotated neurons. Edges: connections with >= 5 synapses
(the Shiu et al. 2024 threshold), summed across neuropils. Sign from the
presynaptic neuron's predicted neurotransmitter (GABA, glutamate inhibitory).
Also exports the named populations the world drives and reads.
"""
import os, json, numpy as np, pandas as pd, pyarrow.feather as pf
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ann = pd.read_csv(os.path.join(ROOT, 'data', 'Supplemental_file1_neuron_annotations.tsv'), sep='\t', dtype=str, keep_default_na=False)
ann['root_id'] = ann.root_id.astype(np.int64)
ann = ann.reset_index(drop=True)
N = len(ann); idx = pd.Series(np.arange(N), index=ann.root_id.values)
print('neurons', N)

df = pf.read_table(os.path.join(ROOT, 'data', 'proofread_connections_783.feather'), columns=['pre_pt_root_id', 'post_pt_root_id', 'syn_count'], memory_map=True).to_pandas()
df = df[df.pre_pt_root_id.isin(idx.index) & df.post_pt_root_id.isin(idx.index)]
pairs = df.groupby(['pre_pt_root_id', 'post_pt_root_id'], sort=False).syn_count.sum().reset_index()
pairs = pairs[(pairs.syn_count >= 5) & (pairs.pre_pt_root_id != pairs.post_pt_root_id)]
print('edges >=5 synapses:', len(pairs), 'synapses in them:', int(pairs.syn_count.sum()))
pre = idx[pairs.pre_pt_root_id.values].values.astype(np.int32)
post = idx[pairs.post_pt_root_id.values].values.astype(np.int32)
cnt = pairs.syn_count.values.astype(np.float32)
sign = np.where(ann.top_nt.isin(['gaba', 'glutamate']).values, -1.0, 1.0).astype(np.float32)
w = (cnt * sign[pre]).astype(np.float32)   # in units of synapses; scaled by w_syn (0.275 mV) at run time

order = np.argsort(pre, kind='stable'); pre, post, w = pre[order], post[order], w[order]
indptr = np.zeros(N + 1, dtype=np.int64); np.add.at(indptr, pre + 1, 1); indptr = np.cumsum(indptr)
print('mean out-degree', len(post) / N)

# ---- named populations
side = ann.side.values
def ids(mask): return np.where(mask)[0].astype(np.int32)
pops = {}
for g in sorted(set(t[4:] for t in ann.cell_type if t.startswith('ORN_'))):
    pops[f'ORN_{g}'] = ids(ann.cell_type.values == f'ORN_{g}')
for s in ('left', 'right'):
    pops[f'R1-6_{s}'] = ids((ann.cell_type.values == 'R1-6') & (side == s))
    pops[f'R7_{s}'] = ids((ann.cell_type.values == 'R7') & (side == s))
    pops[f'R8_{s}'] = ids((ann.cell_type.values == 'R8') & (side == s))
    for t in ('LC4', 'LPLC2', 'LPLC1', 'LC6'):
        pops[f'{t}_{s}'] = ids((ann.cell_type.values == t) & (side == s))
    for t in ('DNa02', 'DNa01', 'DNa03', 'DNp09', 'MDN', 'DNp01', 'DNb02', 'DNg13', 'DNp02', 'DNp11', 'DNp04'):
        pops[f'{t}_{s}'] = ids((ann.cell_type.values == t) & (side == s))
pops['GRN_labellar'] = ids((ann.cell_class.values == 'gustatory') & pd.Series(ann.cell_type.values).str.startswith('LB').values)
pops['GRN_all'] = ids(ann.cell_class.values == 'gustatory')
pops['JO_wind'] = ids(pd.Series(ann.cell_type.values).str.startswith(('JO-A', 'JO-B')).values)
pops['DN_all'] = ids(ann.super_class.values == 'descending')
pops['KC'] = ids(ann.cell_class.values == 'Kenyon_Cell')
pops['DAN'] = ids(ann.cell_class.values == 'DAN')
pops['CX'] = ids(ann.cell_class.values == 'CX')
pops['ALPN'] = ids(ann.cell_class.values == 'ALPN')
pops['MBON'] = ids(pd.Series(ann.cell_type.values).str.startswith('MBON').values)
print({k: len(v) for k, v in pops.items() if not k.startswith('ORN_')})
print('ORN glomeruli:', len([k for k in pops if k.startswith('ORN_')]))

# class code per neuron for rendering / raster grouping
cls_names = ['optic', 'sensory', 'central', 'CX', 'MB', 'descending', 'motor/endocrine', 'ascending']
sc = ann.super_class.values; cc = ann.cell_class.values
cls = np.full(N, 2, np.uint8)
cls[np.isin(sc, ['optic', 'visual_projection', 'visual_centrifugal'])] = 0
cls[np.isin(sc, ['sensory', 'sensory_ascending'])] = 1
cls[cc == 'CX'] = 3
cls[np.isin(cc, ['Kenyon_Cell', 'DAN']) | pd.Series(ann.cell_type.values).str.startswith('MBON').values] = 4
cls[sc == 'descending'] = 5
cls[np.isin(sc, ['motor', 'endocrine'])] = 6
cls[sc == 'ascending'] = 7

pos = np.stack([ann.pos_x.replace('', 'nan').astype(float) * 4, ann.pos_y.replace('', 'nan').astype(float) * 4, ann.pos_z.replace('', 'nan').astype(float) * 40], 1).astype(np.float32)
np.savez_compressed(os.path.join(ROOT, 'brain', 'connectome_783.npz'), indptr=indptr, post=post, w=w, sign=sign, cls=cls, pos=pos, root_id=ann.root_id.values,
                    side=np.where(side == 'right', 1, np.where(side == 'left', 0, 2)).astype(np.uint8), **{f'pop_{k}': v for k, v in pops.items()})
json.dump({'N': int(N), 'E': int(len(post)), 'synapses': int(pairs.syn_count.sum()), 'threshold': 5, 'classes': cls_names,
           'class_counts': {n: int((cls == i).sum()) for i, n in enumerate(cls_names)},
           'pops': {k: int(len(v)) for k, v in pops.items()}}, open(os.path.join(ROOT, 'brain', 'connectome_783.json'), 'w'), indent=1)
print('saved')
