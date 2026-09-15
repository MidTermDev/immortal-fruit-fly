import os, math, numpy as np, pandas as pd
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
from sim import WholeBrain, DT
from world import World
b = WholeBrain(); w = World(b)
ann = pd.read_csv('../data/Supplemental_file1_neuron_annotations.tsv', sep='\t', dtype=str, keep_default_na=False)
ct = ann.cell_type.values; sc = ann.super_class.values; side = b.side
pops = {}
for s, si in (('L', 0), ('R', 1)):
    pops[f'DN_all_{s}'] = np.where((sc == 'descending') & (side == si))[0]
    pops[f'DNa_{s}'] = np.where(pd.Series(ct).str.startswith('DNa').values & (side == si))[0]
    pops[f'DNb_{s}'] = np.where(pd.Series(ct).str.startswith('DNb').values & (side == si))[0]
    pops[f'DNg_{s}'] = np.where(pd.Series(ct).str.startswith('DNg').values & (side == si))[0]
    pops[f'DNp_{s}'] = np.where(pd.Series(ct).str.startswith('DNp').values & (side == si))[0]
    pops[f'DNa02_{s}'] = b.pops[f'DNa02_{"left" if si==0 else "right"}']
    pops[f'LAL_{s}'] = np.where(pd.Series(ct).str.startswith('LAL').values & (side == si))[0]
print({k: len(v) for k, v in pops.items()})
def measure(cl, cr, ms=1200, reps=3):
    out = {k: [] for k in pops}
    for r in range(reps):
        b.v[:] = -52; b.g[:] = 0; b.ring[:] = 0; b.ref_until[:] = 0; b.t += 7919 * (r + 1)  # different noise stream
        cm = 0.5 * (cl + cr); k = 0 if cm < 1e-6 else 4.0 * (cl - cr) / (cl + cr)
        rl = max(0, min(150, 110 * cm * (1 + k))); rr = max(0, min(150, 110 * cm * (1 - k)))
        ids = [w.orn_l, w.orn_r, w.orn_rest, b.pops['R1-6_left'], b.pops['R1-6_right']]
        ps = [np.full(len(w.orn_l), (2 + rl) * DT / 1000, np.float32), np.full(len(w.orn_r), (2 + rr) * DT / 1000, np.float32), np.full(len(w.orn_rest), 2 * DT / 1000, np.float32),
              np.full(len(b.pops['R1-6_left']), 8 * DT / 1000, np.float32), np.full(len(b.pops['R1-6_right']), 8 * DT / 1000, np.float32)]
        b._ids = np.concatenate(ids).astype(np.int32); b._p = np.concatenate(ps).astype(np.float32)
        b.run(300, record=False); tot, win, _, _ = b.run(ms, record=False)
        for k2, p in pops.items(): out[k2].append(float(win[p].sum()) / max(1, len(p)) / (ms / 1000))
    return {k: (np.mean(v), np.std(v)) for k, v in out.items()}
res = {}
for name, cl, cr in [('sym', 0.3, 0.3), ('LEFT', 0.36, 0.24), ('RIGHT', 0.24, 0.36), ('LEFT+', 0.45, 0.15), ('RIGHT+', 0.15, 0.45)]:
    res[name] = measure(cl, cr)
for grp in ['DN_all', 'DNa', 'DNb', 'DNg', 'DNp', 'DNa02', 'LAL']:
    print(f'\n{grp}:')
    for name in res:
        L, R = res[name][f'{grp}_L'], res[name][f'{grp}_R']
        print(f'  {name:7s} L={L[0]:6.2f}±{L[1]:4.2f}  R={R[0]:6.2f}±{R[1]:4.2f}  L-R={L[0]-R[0]:+6.2f}')
