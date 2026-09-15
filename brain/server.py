"""Live server for the whole-brain fly.

Runs the FlyWire brain in its world at real time, streams frames to the website
over WebSocket, reads FoodPlaced / Resurrected events from FlyWorld on BNB Smart
Chain, and posts checkpoints (a hash of the entire brain state) back on-chain.
Snapshots carry the full world state and the brain step at which every chain
event was applied, so `verify.py` can replay one checkpoint into the next.

    ../.venv/bin/python server.py      (reads ../deploy.txt and rpc.txt; PUBLIC_URL from run.sh)
"""
import os, sys, json, time, math, threading, hashlib, subprocess, asyncio, base64, signal, fcntl, re
import numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim import WholeBrain
from world import World, WORLD_MS
from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'state'); SNAPS = os.path.join(HERE, 'snapshots')
os.makedirs(STATE, exist_ok=True); os.makedirs(SNAPS, exist_ok=True)
WORLD_ADDR = os.environ.get('FLYWORLD', '0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4')
WORLD_DEPLOY_BLOCK = 121981000
RPC_LOGS = os.environ.get('RPC_LOGS', 'https://bsc-rpc.publicnode.com'); RPC_SEND = os.environ.get('RPC_SEND', 'https://bsc-dataseed.bnbchain.org')
_rpcfile = os.path.join(HERE, 'rpc.txt')
if os.path.exists(_rpcfile) and 'RPC_LOGS' not in os.environ: RPC_LOGS = RPC_SEND = open(_rpcfile).read().strip()
PK = os.environ.get('PRIVATE_KEY') or ('0x' + open(os.path.join(HERE, '..', 'deploy.txt')).read().strip())
PORT = int(os.environ.get('PORT', '8123'))
CHECKPOINT_EVERY = float(os.environ.get('CHECKPOINT_EVERY', '600'))
LOCAL_SAVE_EVERY = 60.0
PUBLIC_URL = {'url': os.environ.get('PUBLIC_URL', '')}
FRAME_MS = 100
SENDLOCK = os.path.join(HERE, '.sendlock')   # one transaction at a time from the operator key, across processes

brain = WholeBrain(); world = World(brain, energy=float(os.environ.get('GENESIS_ENERGY', '3600')))
render_index = np.load(os.path.join(HERE, 'render_index.npy'))
render_pos = np.full(brain.N, -1, np.int32); render_pos[render_index] = np.arange(len(render_index))
lock = threading.Lock()
frame = {'hdr': None, 'spikes': b'', 'at': 0.0}
clients = set(); log_lines = []
chain_state = {'food_seen_block': 0, 'gen_seen': 0, 'last_checkpoint': 0.0, 'checkpoints': 0, 'alive_onchain': True, 'foods_done': [], 'applied': []}
sim_alive = {'ok': False, 'last_step_at': 0.0}
SECRET = re.compile(re.escape(RPC_SEND.rstrip('/')) + r'/?') if RPC_SEND.startswith('http') else None


def scrub(s):
    return SECRET.sub('<rpc>', s) if SECRET else s


def log(*a):
    s = time.strftime('%H:%M:%S ') + scrub(' '.join(str(x) for x in a)); print(s, flush=True); log_lines.append(s); del log_lines[:-300]


def atomic_write(path, data: bytes):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


# ------------------------------------------------------------------ persistence
def save_snapshot(tag):
    """Brain + full world state + applied-event log, content-addressed by the brain hash. Caller holds `lock`."""
    h = brain.state_hash()
    path = os.path.join(SNAPS, f'{h}.npz') if tag in ('checkpoint', 'death') else os.path.join(STATE, 'local.npz')
    world_state = world.dump_state()
    meta = {'hash': h, 'tag': tag, 'brain_step': brain.t, 'world': world_state, 'applied': chain_state['applied'][-500:], 'foods_done': chain_state['foods_done'][-2000:],
            'food_seen_block': chain_state['food_seen_block'], 'gen_seen': chain_state['gen_seen'], 'alive_onchain': chain_state['alive_onchain'], 'saved_at': time.time(), 'server': 'brain/server.py'}
    if not os.path.exists(path) or tag in ('local', 'shutdown'):
        import io
        buf = io.BytesIO(); np.savez_compressed(buf, v=brain.v, g=brain.g, ref_until=brain.ref_until, ring=brain.ring, counts=brain.counts, t=brain.t, total=brain.total_spikes, meta=json.dumps(meta)); atomic_write(path, buf.getvalue())
    meta['path'] = path
    atomic_write(os.path.join(STATE, 'latest.json'), json.dumps(meta).encode())
    return h, path


def restore():
    p = os.path.join(STATE, 'latest.json')
    if not os.path.exists(p): return False
    try:
        st = json.load(open(p)); path = st.get('path') or os.path.join(SNAPS, st['hash'] + '.npz')
        if not os.path.exists(path): log('latest.json points at a missing snapshot; starting fresh'); return False
        w = st['world']
        if 'age_ms' not in w and 't_ms' in w:   # snapshot written by the previous server version
            w = {**w, 'age_ms': w['t_ms'], 'ate_total': w.get('ate', 0.0)}
        brain.load(path); world.load_state(w)
        for k in ('food_seen_block', 'gen_seen', 'alive_onchain', 'foods_done', 'applied'): chain_state[k] = st.get(k, chain_state[k])
        log(f"restored {st['hash'][:12]} (age {world.age_ms/1000:.0f}s, gen {world.generation}, energy {world.energy:.0f}, {len(world.food)} food)")
        return True
    except Exception as e:
        log('restore failed, refusing to start from genesis silently:', repr(e)[:200]); raise


# ------------------------------------------------------------------ chain
def cast(*args, timeout=120):
    r = subprocess.run(['cast', *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0: raise RuntimeError(scrub(r.stderr.strip()[:300]))
    return r.stdout.strip()


def send(*args):
    """cast send, serialized across processes on this machine (the DOOM harness shares the key)."""
    with open(SENDLOCK, 'w') as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        out = cast('send', '--rpc-url', RPC_SEND, '--private-key', PK, *args, '--json', timeout=150)
    rc = json.loads(out)
    if rc.get('status') not in ('0x1', 1, '1'): raise RuntimeError('tx reverted ' + rc.get('transactionHash', ''))
    return rc


def poll_chain():
    """Apply FoodPlaced and Resurrected events to the world, recording the brain step of each."""
    try:
        head = int(cast('block-number', '--rpc-url', RPC_LOGS))
        frm = chain_state['food_seen_block'] or WORLD_DEPLOY_BLOCK
        if frm > head: return
        SIG_FOOD = cast('keccak', 'FoodPlaced(uint256,address,int32,int32,uint64,uint256)'); SIG_RES = cast('keccak', 'Resurrected(uint32,address,uint256,uint64)')
        s32 = lambda x: x - (1 << 256) if x >= (1 << 255) else x
        while frm <= head:
            to = min(head, frm + 1999)
            out = cast('logs', '--rpc-url', RPC_LOGS, '--from-block', str(frm), '--to-block', str(to), '--address', WORLD_ADDR, '--json')
            for l in (json.loads(out) if out else []):
                t0 = l['topics'][0]; d = l['data'][2:]; w = [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]
                if t0 == SIG_FOOD:
                    fid = int(l['topics'][1], 16); by = '0x' + l['topics'][2][-40:]; x, y, secs = s32(w[0]), s32(w[1]), w[2]
                    if fid in chain_state['foods_done']: continue
                    with lock:
                        world.place_food(x, y, secs, by, fid=fid); chain_state['foods_done'].append(fid)
                        chain_state['applied'].append({'kind': 'food', 'id': fid, 'x': x, 'y': y, 'seconds': secs, 'by': by, 'block': int(l['blockNumber'], 16), 'brain_step': brain.t})
                    log(f'on-chain food #{fid} at ({x},{y}) worth {secs}s from {by[:10]} applied at step {brain.t}')
                elif t0 == SIG_RES:
                    gen = int(l['topics'][1], 16); by = '0x' + l['topics'][2][-40:]; energy = w[1]
                    if gen <= chain_state['gen_seen']: continue
                    chain_state['gen_seen'] = gen
                    with lock:
                        if not world.alive or world.generation < gen:
                            world.resurrect(energy); world.generation = gen; chain_state['alive_onchain'] = True
                            chain_state['applied'].append({'kind': 'resurrect', 'generation': gen, 'energy': energy, 'by': by, 'block': int(l['blockNumber'], 16), 'brain_step': brain.t})
                            log(f'resurrected on-chain by {by[:10]} as generation {gen} with {world.energy:.0f}s')
            frm = to + 1
        chain_state['food_seen_block'] = head + 1
    except Exception as e:
        log('chain poll failed:', str(e)[:160])


def chain_alive():
    try: return cast('call', '--rpc-url', RPC_LOGS, WORLD_ADDR, 'alive()(bool)').strip() == 'true'
    except Exception: return None


def post_checkpoint():
    try:
        with lock: h, path = save_snapshot('checkpoint'); snap = world.snapshot()
        uri = f"{PUBLIC_URL['url']}/snapshots/{h}.npz" if PUBLIC_URL['url'] else f"snapshots/{h}.npz"
        rc = send('--gas-limit', '300000', WORLD_ADDR, 'checkpoint(uint64,uint64,bytes32,int32,int32,uint64,uint64,string)', str(snap['step']), str(int(snap['t_ms'])), '0x' + h,
                  str(int(round(snap['x']))), str(int(round(snap['y']))), str(int(snap['energy'])), str(snap['spikes_total'] % (1 << 64)), uri)
        chain_state['last_checkpoint'] = time.time(); chain_state['checkpoints'] += 1; chain_state['last_tx'] = rc['transactionHash']; chain_state['last_hash'] = h
        log(f"checkpoint {h[:12]} tx {rc['transactionHash']}")
    except Exception as e:
        log('checkpoint failed:', str(e)[:200])


def report_death():
    """Retries until the contract agrees the fly is dead."""
    with lock: h, path = save_snapshot('death'); age = world.age_ms
    uri = f"{PUBLIC_URL['url']}/snapshots/{h}.npz" if PUBLIC_URL['url'] else f"snapshots/{h}.npz"
    while True:
        oc = chain_alive()
        if oc is False: chain_state['alive_onchain'] = False; log('death recorded on-chain'); return
        try:
            rc = send('--gas-limit', '200000', WORLD_ADDR, 'reportDeath(uint64,bytes32,string)', str(int(age)), '0x' + h, uri)
            log(f"death reported {h[:12]} tx {rc['transactionHash']}")
        except Exception as e:
            log('death report failed, retrying in 20 s:', str(e)[:160]); time.sleep(20)


def chain_loop():
    time.sleep(5)
    # reconcile with the contract on boot
    oc = chain_alive()
    if oc is not None:
        chain_state['alive_onchain'] = oc
        if world.alive and not oc: log('contract says dead but world alive: waiting for a Resurrected event'); world.alive = False
        elif not world.alive and oc: threading.Thread(target=report_death, daemon=True).start()
    while True:
        poll_chain()
        if world.alive and chain_state['alive_onchain'] and time.time() - chain_state['last_checkpoint'] > CHECKPOINT_EVERY: post_checkpoint()
        time.sleep(20)


# ------------------------------------------------------------------ simulation
def sim_loop():
    restore()
    steps_per_frame = int(FRAME_MS / WORLD_MS); acc = np.zeros(len(render_index), np.uint8)
    wall0 = time.time(); bio0 = world.age_ms / 1000.0; dead_reported = not world.alive; last_local = time.time()
    while True:
        try:
            if not world.alive:
                if not dead_reported: dead_reported = True; threading.Thread(target=report_death, daemon=True).start()
                time.sleep(0.5); wall0 = time.time(); bio0 = world.age_ms / 1000.0
                with lock: hdr = {**world.snapshot(), 'wall': time.time(), 'realtime': 0.0, 'chain': public_chain_state(), 'nrender': len(render_index)}
                frame['hdr'] = hdr; frame['spikes'] = b''; frame['at'] = time.time(); sim_alive['ok'] = True; sim_alive['last_step_at'] = time.time()
                continue
            dead_reported = False
            acc[:] = 0
            with lock:
                for _ in range(steps_per_frame):
                    ids = world.step(record=True); r = render_pos[ids]; r = r[r >= 0]; acc[r] = 1
                snap = world.snapshot()
            spikes = np.where(acc)[0].astype(np.uint16)
            elapsed = time.time() - wall0; bio = world.age_ms / 1000.0 - bio0
            frame['hdr'] = {**snap, 'wall': time.time(), 'realtime': round(bio / max(1e-6, elapsed), 2), 'chain': public_chain_state(), 'nrender': len(render_index)}
            frame['spikes'] = spikes.tobytes(); frame['at'] = time.time(); sim_alive['ok'] = True; sim_alive['last_step_at'] = time.time()
            if time.time() - last_local > LOCAL_SAVE_EVERY:
                with lock: save_snapshot('local')
                last_local = time.time()
            ahead = bio - elapsed
            if ahead > 0.02: time.sleep(min(ahead, 0.1))
        except Exception as e:
            sim_alive['ok'] = False; log('sim loop error:', repr(e)[:200]); time.sleep(2)


def public_chain_state():
    return {k: v for k, v in chain_state.items() if k in ('checkpoints', 'last_checkpoint', 'last_tx', 'last_hash', 'alive_onchain', 'gen_seen')}


def on_term(*_):
    log('SIGTERM: saving state')
    try:
        with lock: save_snapshot('shutdown')
    except Exception as e: log('save on exit failed', e)
    os._exit(0)


# ------------------------------------------------------------------ web
async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20); await ws.prepare(request); clients.add(ws)
    try:
        last = None
        while not ws.closed:
            hdr = frame['hdr']
            if hdr is not None and hdr.get('wall') != last:
                last = hdr.get('wall'); await ws.send_str(json.dumps({'hdr': hdr, 'spikes': base64.b64encode(frame['spikes']).decode()}))
            await asyncio.sleep(FRAME_MS / 1000)
    finally: clients.discard(ws)
    return ws


async def state_handler(request):
    return web.json_response({'hdr': frame['hdr'], 'clients': len(clients), 'log': log_lines[-30:], 'frame_age_s': round(time.time() - frame['at'], 1)}, headers={'Access-Control-Allow-Origin': '*'})


async def health(request):
    age = time.time() - sim_alive['last_step_at']; ok = sim_alive['ok'] and age < 5
    return web.json_response({'ok': ok, 'sim_thread': sim_alive['ok'], 'frame_age_s': round(age, 1), 'alive': world.alive, 'age_ms': world.age_ms, 'last_checkpoint_age_s': round(time.time() - chain_state['last_checkpoint']) if chain_state['last_checkpoint'] else None, 'url': PUBLIC_URL['url']},
                             status=200 if ok else 503, headers={'Access-Control-Allow-Origin': '*'})


def main():
    signal.signal(signal.SIGTERM, on_term); signal.signal(signal.SIGINT, on_term)
    threading.Thread(target=sim_loop, daemon=True).start(); threading.Thread(target=chain_loop, daemon=True).start()
    app = web.Application()
    app.router.add_get('/ws', ws_handler); app.router.add_get('/state', state_handler); app.router.add_get('/health', health)
    app.router.add_static('/snapshots', SNAPS, show_index=True)
    log(f'serving on :{PORT}; world {WORLD_ADDR}')
    web.run_app(app, port=PORT, print=None)


if __name__ == '__main__':
    main()
