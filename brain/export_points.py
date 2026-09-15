"""Render subset of the whole brain for the website: ~45k somata with their simulator index,
so live spikes can be mapped onto the point cloud."""
import numpy as np, struct, os
z = np.load('connectome_783.npz'); pos = z['pos']; cls = z['cls']
rng = np.random.default_rng(783)
keep = np.where(np.isfinite(pos).all(1) & (rng.random(len(pos)) < np.where(cls == 0, 0.18, 0.5)))[0].astype(np.uint32)
mn, mx = np.nanmin(pos[keep], 0), np.nanmax(pos[keep], 0)
q = ((pos[keep] - mn) / (mx - mn) * 65535).astype(np.uint16)
out = os.path.join('..', 'web', 'public', 'assets', 'brain_points_v2.bin')
with open(out, 'wb') as f:
    f.write(struct.pack('<I', len(keep))); f.write(struct.pack('<6f', *mn, *mx))
    for i in range(len(keep)): f.write(struct.pack('<HHHBI', q[i, 0], q[i, 1], q[i, 2], int(cls[keep[i]]), int(keep[i])))
np.save('render_index.npy', keep)
print('points', len(keep), 'bytes', os.path.getsize(out))
