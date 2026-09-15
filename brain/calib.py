"""Measure how the named descending neurons respond to odor on the left vs the right,
to choose the polarity and normalisation of the steering readout."""
import os, math, numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
from sim import WholeBrain, DT
from world import World, FOOD_GLOMERULI
b = WholeBrain(); w = World(b)
def measure(cl, cr, ms=1500):
    b.v[:] = -52; b.g[:] = 0; b.ring[:] = 0; b.ref_until[:] = 0
    ids = [w.orn_l, w.orn_r, w.orn_rest, b.pops['R1-6_left'], b.pops['R1-6_right']]
    ps = [np.full(len(w.orn_l), (2 + 110 * cl) * DT / 1000, np.float32), np.full(len(w.orn_r), (2 + 110 * cr) * DT / 1000, np.float32), np.full(len(w.orn_rest), 2 * DT / 1000, np.float32),
          np.full(len(b.pops['R1-6_left']), 8 * DT / 1000, np.float32), np.full(len(b.pops['R1-6_right']), 8 * DT / 1000, np.float32)]
    b._ids = np.concatenate(ids).astype(np.int32); b._p = np.concatenate(ps).astype(np.float32)
    b.run(300, record=False)   # settle
    tot, win, _, _ = b.run(ms, record=False)
    return {k: b.pop_rate(k, win, ms) for k in ['DNa02_left', 'DNa02_right', 'DNa01_left', 'DNa01_right', 'DNa03_left', 'DNa03_right', 'DNb02_left', 'DNb02_right', 'DNg13_left', 'DNg13_right', 'DNp09_left', 'DNp09_right', 'MDN_left', 'MDN_right', 'DN_all']}
import time; t0 = time.time()
for name, cl, cr in [('no odor', 0, 0), ('odor both 0.5', 0.5, 0.5), ('odor LEFT 0.8 / right 0.2', 0.8, 0.2), ('odor left 0.2 / RIGHT 0.8', 0.2, 0.8), ('odor both 0.9', 0.9, 0.9)]:
    r = measure(cl, cr)
    print(f'{name:28s} ' + ' '.join(f'{k.replace("_left","L").replace("_right","R")}={v:5.1f}' for k, v in r.items()))
print('wall', round(time.time() - t0, 1), 's for 9 s of brain')
