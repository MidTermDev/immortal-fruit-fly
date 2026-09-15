"""Whole-brain leaky integrate-and-fire simulation of the FlyWire v783 connectome.

The model of Shiu et al. 2024 (Nature 634:210): every neuron is a LIF unit with
V_rest = V_reset = -52 mV, threshold -45 mV, tau_m = 20 ms, tau_syn = 5 ms,
refractory 2.2 ms, synaptic delay 1.8 ms, and each synapse adds 0.275 mV to the
postsynaptic drive (negative for GABA / glutamate). dt = 0.1 ms. Sensory neurons
are driven as Poisson spike sources. Everything is deterministic given the seed.
"""
import os, time, numpy as np
from numba import njit, prange

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
DT = 0.1            # ms
TAU_M = 20.0
TAU_S = 5.0
V0 = -52.0
VTH = -45.0
REF_STEPS = 22      # 2.2 ms
DELAY = 18          # 1.8 ms
RING = DELAY + 1
W_SYN = 0.275       # mV per synapse


NCHUNK = 64


@njit(cache=True, fastmath=True, parallel=True, nogil=True)
def _run(steps, t0, v, g, ref_until, ring, indptr, post, w, drive_ids, drive_p, counts, seed, spike_ids_out, spike_ts_out, max_out):
    """Advance the network `steps` steps starting at absolute step t0.
    drive_ids / drive_p: neurons forced to spike with probability drive_p per step.
    counts: per-neuron spike counter (accumulated). Returns (total spikes, n recorded)."""
    N = v.shape[0]
    dv = DT / TAU_M
    decay = np.exp(-DT / TAU_S)
    total = 0
    nrec = 0
    csz = (N + NCHUNK - 1) // NCHUNK
    sp_idx = np.empty((NCHUNK, csz), np.int32)
    sp_n = np.zeros(NCHUNK, np.int64)
    dr_idx = np.empty((NCHUNK, csz), np.int32)
    dr_n = np.zeros(NCHUNK, np.int64)
    for k in range(steps):
        t = t0 + k
        rs = t % RING
        ws = (t + DELAY) % RING
        # deliver delayed input, integrate, threshold — parallel over chunks
        for c in prange(NCHUNK):
            n = 0
            lo = c * csz
            hi = min(N, lo + csz)
            for i in range(lo, hi):
                gi = g[i] + ring[rs, i]
                ring[rs, i] = 0.0
                if t >= ref_until[i]:
                    vi = v[i] + dv * (V0 - v[i] + gi)
                    if vi >= VTH:
                        v[i] = V0
                        ref_until[i] = t + REF_STEPS
                        sp_idx[c, n] = i
                        n += 1
                    else:
                        v[i] = vi
                g[i] = gi * decay
            sp_n[c] = n
        # forced sensory spikes: hashed per (step, neuron) so the stream is deterministic and parallel
        nd = drive_ids.shape[0]
        dsz = (nd + NCHUNK - 1) // NCHUNK
        for c in prange(NCHUNK):
            n = 0
            lo = c * dsz
            hi = min(nd, lo + dsz)
            for d in range(lo, hi):
                i = drive_ids[d]
                h = (np.uint64(t) * np.uint64(0x9E3779B97F4A7C15) + np.uint64(i) * np.uint64(0xBF58476D1CE4E5B9) + np.uint64(seed)) & np.uint64(0xFFFFFFFFFFFFFFFF)
                h ^= h >> np.uint64(31); h *= np.uint64(0x94D049BB133111EB); h ^= h >> np.uint64(29)
                u = (h & np.uint64(0xFFFFFF)) / 16777216.0
                if u < drive_p[d]:
                    if t >= ref_until[i]:
                        v[i] = V0
                        ref_until[i] = t + REF_STEPS
                        if n < csz:
                            dr_idx[c, n] = i
                            n += 1
            dr_n[c] = n
        # propagate
        for c in range(2 * NCHUNK):
            cnt = sp_n[c] if c < NCHUNK else dr_n[c - NCHUNK]
            for q in range(cnt):
                i = sp_idx[c, q] if c < NCHUNK else dr_idx[c - NCHUNK, q]
                total += 1
                counts[i] += 1
                if nrec < max_out:
                    spike_ids_out[nrec] = i
                    spike_ts_out[nrec] = t
                    nrec += 1
                a = indptr[i]
                b = indptr[i + 1]
                for e in range(a, b):
                    ring[ws, post[e]] += w[e]
    return total, nrec


class WholeBrain:
    def __init__(self, path=None):
        z = np.load(path or os.path.join(ROOT, 'connectome_783.npz'))
        self.indptr = z['indptr'].astype(np.int64)
        self.post = z['post'].astype(np.int32)
        self.w = (z['w'] * W_SYN).astype(np.float32)
        self.cls = z['cls']; self.pos = z['pos']; self.root_id = z['root_id']; self.side = z['side']
        self.pops = {k[4:]: z[k] for k in z.files if k.startswith('pop_')}
        self.N = len(self.indptr) - 1
        self.v = np.full(self.N, V0, np.float32)
        self.g = np.zeros(self.N, np.float32)
        self.ref_until = np.zeros(self.N, np.int64)
        self.ring = np.zeros((RING, self.N), np.float32)
        self.counts = np.zeros(self.N, np.int64)
        self.t = 0
        self.total_spikes = 0
        self._ids = np.zeros(0, np.int32); self._p = np.zeros(0, np.float32)
        self._rec_ids = np.zeros(200000, np.int32); self._rec_ts = np.zeros(200000, np.int64)

    def set_drive(self, rates: dict):
        """rates: {population name: Hz}. Each neuron in the population fires as a Poisson source."""
        ids, ps = [], []
        for name, hz in rates.items():
            if hz <= 0: continue
            pop = self.pops[name]
            ids.append(pop); ps.append(np.full(len(pop), hz * DT / 1000.0, np.float32))
        self._ids = np.concatenate(ids).astype(np.int32) if ids else np.zeros(0, np.int32)
        self._p = np.concatenate(ps).astype(np.float32) if ps else np.zeros(0, np.float32)

    def run(self, ms: float, record=True):
        steps = int(round(ms / DT))
        before = self.counts.copy()
        total, nrec = _run(steps, self.t, self.v, self.g, self.ref_until, self.ring, self.indptr, self.post, self.w,
                           self._ids, self._p, self.counts, (self.t * 2654435761) & 0xFFFFFFFF, self._rec_ids, self._rec_ts, len(self._rec_ids) if record else 0)
        self.t += steps; self.total_spikes += total
        return total, self.counts - before, self._rec_ids[:nrec].copy(), self._rec_ts[:nrec].copy()

    def pop_rate(self, name, window_counts, ms):
        pop = self.pops[name]
        return float(window_counts[pop].sum()) / max(1, len(pop)) / (ms / 1000.0)

    def state_hash(self):
        import hashlib
        h = hashlib.sha256(); h.update(self.v.tobytes()); h.update(self.g.tobytes()); h.update(self.ring.tobytes()); h.update(np.int64(self.t).tobytes())
        return h.hexdigest()

    def save(self, path):
        np.savez_compressed(path, v=self.v, g=self.g, ref_until=self.ref_until, ring=self.ring, counts=self.counts, t=self.t, total=self.total_spikes)

    def load(self, path):
        z = np.load(path)
        self.v[:] = z['v']; self.g[:] = z['g']; self.ref_until[:] = z['ref_until']; self.ring[:] = z['ring']; self.counts[:] = z['counts']; self.t = int(z['t']); self.total_spikes = int(z['total'])


if __name__ == '__main__':
    b = WholeBrain()
    print('N', b.N, 'edges', len(b.post))
    b.set_drive({'ORN_DM1': 50})
    t0 = time.time(); b.run(10); print('jit + first 10 ms: %.1fs' % (time.time() - t0))
    t0 = time.time(); total, win, ids, ts = b.run(200)
    dt = time.time() - t0
    print(f'200 ms of brain in {dt:.2f}s wall -> {0.2 / dt:.2f}x real time; spikes {total}')
    for p in ['ORN_DM1', 'ALPN', 'KC', 'CX', 'DN_all', 'DNa02_left', 'DNa02_right', 'DNp09_left', 'MDN_left', 'DNp01_left']:
        print(f'  {p:12s} {b.pop_rate(p, win, 200):7.1f} Hz')
    b.set_drive({'ORN_DM1': 50, 'ORN_DM4': 50, 'ORN_VA2': 50, 'GRN_labellar': 80})
    total, win, ids, ts = b.run(300)
    print('with food odor + taste, 300 ms: spikes', total)
    for p in ['ALPN', 'KC', 'MBON', 'CX', 'DN_all', 'DNa02_left', 'DNa02_right', 'DNp09_left', 'DNp09_right', 'MDN_left', 'DNp01_left']:
        print(f'  {p:12s} {b.pop_rate(p, win, 300):7.1f} Hz')
    active = int((win > 0).sum()); print('neurons active', active, 'of', b.N)
