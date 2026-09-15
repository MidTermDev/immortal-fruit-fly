"""Verify an on-chain checkpoint of the whole-brain fly by replaying the model.

    ../.venv/bin/python verify.py <snapshot_A.npz> <snapshot_B.npz>

Loads snapshot A (brain + full world state), applies the world events recorded in B's
metadata at the brain step each was applied, steps the world forward to B's step, and
compares the resulting brain hash with B's. Deterministic: same connectome file, same
model, same seed stream -> same bytes.

Events a body records in `applied` (server.py): `food` (a feed placed as food), `puff` and
`predator` (a pebble's senses: an odor puff, a predator from a side), `resurrect`. Snapshots
written since the events were numbered carry `applied_seq` (how many events had been applied
when the snapshot was taken) and every event its `seq`, so the interval's events are exactly
those with A.applied_seq < seq <= B.applied_seq (an event applied at A's own step but after A
was taken is replayed; one applied before A was taken is already in A's world). Older
snapshots fall back to the brain-step window.
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
if brain.t > target: print(f'A (step {brain.t:,}) is past B (step {target:,}); nothing to replay'); sys.exit(2)
recorded = mb.get('applied', [])
a_seq, b_seq = ma.get('applied_seq'), mb.get('applied_seq')
if a_seq is not None and b_seq is not None and all('seq' in e for e in recorded):
    events = sorted((e for e in recorded if a_seq < e['seq'] <= b_seq), key=lambda e: e['seq']); how = f'events {a_seq + 1}..{b_seq}'
    missing = sorted(set(range(a_seq + 1, b_seq + 1)) - {e['seq'] for e in events})
    if missing: print(f"WARNING: B's event log lacks {len(missing)} event(s) of the interval (seq {missing[:8]}{'…' if len(missing) > 8 else ''}); the replay cannot be exact")
else:
    events = sorted((e for e in recorded if int(ma['brain_step']) <= e['brain_step'] <= target), key=lambda e: e['brain_step']); how = 'brain-step window (unnumbered events)'
print(f'replaying step {brain.t:,} -> {target:,} ({(target - brain.t) * 0.1 / 1000:.1f} s of brain) with {len(events)} world events ({how}): {[e["kind"] for e in events][:20]}')


def apply(e):
    k = e['kind']
    if k == 'food': world.place_food(e['x'], e['y'], e['seconds'], e['by'], fid=e['id'])
    elif k == 'puff': world.puff(e['x'], e['y'], e.get('strength', 1.0), e.get('seconds', 8.0))
    elif k == 'predator':
        if not world.spawn_predator(e['angle']): print(f"WARNING: predator event at step {e['brain_step']:,} could not be applied (one is already about)")
    elif k == 'resurrect': world.resurrect(e['energy']); world.generation = e['generation']
    else: print(f"WARNING: unknown event kind {k!r} at step {e['brain_step']:,}; skipped")


ei = 0
while True:
    while ei < len(events) and events[ei]['brain_step'] <= brain.t: apply(events[ei]); ei += 1
    if brain.t >= target: break
    if not world.alive: print(f'the fly is dead at step {brain.t:,} and no resurrection is recorded before step {target:,}: the brain cannot reach B'); sys.exit(1)
    world.step(record=False)
h = brain.state_hash()
print('replayed hash', h); print('expected hash', mb['hash']); print('MATCH' if h == mb['hash'] else 'MISMATCH')
sys.exit(0 if h == mb['hash'] else 1)
