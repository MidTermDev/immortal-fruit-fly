"""Verify an on-chain checkpoint of the whole-brain fly by replaying the model.

    ../.venv/bin/python verify.py <snapshot_A.npz> <snapshot_B.npz>

Loads snapshot A (brain + full world state), applies the chain events recorded in B's
metadata at the brain step each was applied, steps the world forward to B's step, and
compares the resulting brain hash with B's. Deterministic: same connectome file, same
model, same seed stream -> same bytes.
"""
import os, sys, json, numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim import WholeBrain
from world import World, WORLD_MS

a_path, b_path = sys.argv[1], sys.argv[2]
za, zb = np.load(a_path), np.load(b_path)
ma, mb = json.loads(str(za['meta'])), json.loads(str(zb['meta']))
brain = WholeBrain(); world = World(brain)
brain.load(a_path); world.load_state(ma['world'])
target = int(mb['brain_step']); steps_per_world = int(WORLD_MS / 0.1)
events = [e for e in mb.get('applied', []) if int(ma['brain_step']) <= e['brain_step'] <= target]
events.sort(key=lambda e: e['brain_step'])
print(f'replaying step {brain.t:,} -> {target:,} ({(target - brain.t) * 0.1 / 1000:.1f} s of brain) with {len(events)} chain events')
ei = 0
while brain.t < target:
    while ei < len(events) and events[ei]['brain_step'] <= brain.t:
        e = events[ei]; ei += 1
        if e['kind'] == 'food': world.place_food(e['x'], e['y'], e['seconds'], e['by'], fid=e['id'])
        elif e['kind'] == 'resurrect': world.resurrect(e['energy']); world.generation = e['generation']
    world.step(record=False)
h = brain.state_hash()
print('replayed hash', h); print('expected hash', mb['hash']); print('MATCH' if h == mb['hash'] else 'MISMATCH')
sys.exit(0 if h == mb['hash'] else 1)
