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
from registry import Registry, sha256_file, IDENTITY, REGISTRY

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'state'); SNAPS = os.path.join(HERE, 'snapshots')
os.makedirs(STATE, exist_ok=True); os.makedirs(SNAPS, exist_ok=True)
FLY_ID = int(os.environ.get('FLY_ID', '1'))
REGISTRY_DEPLOY_BLOCK = int(os.environ.get('REGISTRY_DEPLOY_BLOCK', '122001000'))
BODY_KEY = os.path.join(HERE, 'body_arena.key')
RPC_LOGS = os.environ.get('RPC_LOGS', 'https://bsc-rpc.publicnode.com'); RPC_SEND = os.environ.get('RPC_SEND', 'https://bsc-dataseed.bnbchain.org')
_rpcfile = os.path.join(HERE, 'rpc.txt')
if os.path.exists(_rpcfile) and 'RPC_LOGS' not in os.environ: RPC_LOGS = RPC_SEND = open(_rpcfile).read().strip()
reg = Registry(key_path=BODY_KEY)
PORT = int(os.environ.get('PORT', '8123'))
CHECKPOINT_EVERY = float(os.environ.get("CHECKPOINT_EVERY", "600"))
LOCAL_SAVE_EVERY = 60.0
PUBLIC_URL = {'url': os.environ.get('PUBLIC_URL', '')}
FRAME_MS = 100
SENDLOCK = os.path.join(HERE, '.sendlock')   # one transaction at a time from the operator key, across processes

brain = WholeBrain(); world = World(brain, energy=float(os.environ.get('GENESIS_ENERGY', '3600')))
world.on_event = lambda kind, text: note(kind, text) if kind != 'died' else None
render_index = np.load(os.path.join(HERE, 'render_index.npy'))
render_pos = np.full(brain.N, -1, np.int32); render_pos[render_index] = np.arange(len(render_index))
lock = threading.Lock()
frame = {'hdr': None, 'spikes': b'', 'at': 0.0}
clients = set(); log_lines = []
chain_state = {'seen_block': 0, 'last_checkpoint': 0.0, 'checkpoints': 0, 'alive_onchain': True, 'feeds_done': [], 'applied': [], 'hosting': False, 'last_uri': '', 'interactions': []}
sim_alive = {'ok': False, 'last_step_at': 0.0}
from registry import RPC as _RPC
SECRET = re.compile(re.escape(_RPC.rstrip('/')) + r'/?') if _RPC.startswith('http') else None


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
    meta = {'hash': h, 'tag': tag, 'brain_step': brain.t, 'world': world_state, 'applied': chain_state['applied'][-500:], 'feeds_done': chain_state['feeds_done'][-2000:],
            'seen_block': chain_state['seen_block'], 'alive_onchain': chain_state['alive_onchain'], 'fly_id': FLY_ID, 'registry': REGISTRY, 'body': 'arena', 'connectome_sha256': IDENTITY['connectome_sha256'], 'saved_at': time.time(), 'server': 'brain/server.py'}
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
        for k in ('seen_block', 'alive_onchain', 'feeds_done', 'applied'): chain_state[k] = st.get(k, chain_state[k])
        log(f"restored {st['hash'][:12]} (age {world.age_ms/1000:.0f}s, gen {world.generation}, energy {world.energy:.0f}, {len(world.food)} food)")
        return True
    except Exception as e:
        log('restore failed, refusing to start from genesis silently:', repr(e)[:200]); raise


# ------------------------------------------------------------------ chain (FlyRegistry)
def instantiate_from_chain():
    """If the registry holds a newer state for our fly (it lived in another body), fetch it and continue from it."""
    f = reg.fly(FLY_ID)
    if f['stateURI'] and f['stateURI'] != chain_state.get('last_uri') and f['stateRoot'] != brain.state_hash():
        cid = f['stateURI'].replace('ipfs://', ''); path = os.path.join(SNAPS, f"{f['stateRoot']}.npz")
        if not os.path.exists(path):
            log(f"fetching brain state {f['stateRoot'][:12]} from {f['stateURI']}")
            r = subprocess.run(['curl', '-sL', '-m', '600', '-o', path + '.tmp', f'https://gateway.pinata.cloud/ipfs/{cid}'], capture_output=True)
            if r.returncode != 0 or not os.path.exists(path + '.tmp'): raise RuntimeError('fetch failed')
            os.replace(path + '.tmp', path)
        with lock:
            brain.load(path); z = np.load(path); m = json.loads(str(z['meta']))
            if brain.state_hash() != f['stateRoot']: raise RuntimeError('fetched state does not match the committed root')
            if 'world' in m: world.load_state(m['world'])
            world.energy = float(f['energy']); world.alive = f['alive']; world.generation = f['generation']
        chain_state['last_uri'] = f['stateURI']
        log(f"instantiated fly #{FLY_ID} from {f['stateURI']} (age {world.age_ms/1000:.0f}s, from body {m.get('body', '?')})")
    return f


def poll_chain():
    """Accept assignments, apply feeds (as food to find), notice resurrections."""
    try:
        f = reg.fly(FLY_ID)
        head = reg.w3.eth.block_number; frm = chain_state['seen_block'] or REGISTRY_DEPLOY_BLOCK
        if f['pendingBody'].lower() == reg.address.lower():
            instantiate_from_chain(); reg.accept(FLY_ID); log('accepted custody of fly #%d' % FLY_ID); f = reg.fly(FLY_ID)
        chain_state['hosting'] = f['body'].lower() == reg.address.lower(); chain_state['alive_onchain'] = f['alive']
        if not chain_state['hosting']:
            chain_state['seen_block'] = head + 1; return
        for ev in reg.events('Fed', frm, head, id=FLY_ID):
            key = ev['tx']
            if key in chain_state['feeds_done']: continue
            secs = int(ev['seconds_']); ang = world.rng.random() * 2 * math.pi; r = 40 + world.rng.random() * 70
            with lock:
                fd = world.place_food(world.x + r * math.cos(ang), world.y + r * math.sin(ang), secs, ev['by']); chain_state['feeds_done'].append(key)
                chain_state['applied'].append({'kind': 'food', 'id': fd['id'], 'x': fd['x'], 'y': fd['y'], 'seconds': secs, 'by': ev['by'], 'block': ev['block'], 'brain_step': brain.t})
            log(f"fed {secs}s by {ev['by'][:10]}: food placed at ({fd['x']:.0f},{fd['y']:.0f}) — it has to find it")
        for ev in reg.events('Resurrected', frm, head, id=FLY_ID):
            if not world.alive:
                with lock: world.resurrect(int(ev['energy'])); world.generation = int(ev['generation'])
                chain_state['applied'].append({'kind': 'resurrect', 'generation': int(ev['generation']), 'energy': int(ev['energy']), 'by': ev['by'], 'block': ev['block'], 'brain_step': brain.t})
                log(f"resurrected by {ev['by'][:10]} as generation {ev['generation']}")
        chain_state['seen_block'] = head + 1
    except Exception as e:
        log('chain poll failed:', str(e)[:160])


def history_root():
    ints = chain_state['interactions']; chain_state['interactions'] = []
    return hashlib.sha256(json.dumps(ints, sort_keys=True).encode()).hexdigest(), ints


MEMORY_ROOT = hashlib.sha256(b'').hexdigest()   # the whole-brain model has no plastic weights yet; memory lives in the on-chain core


def post_checkpoint():
    try:
        with lock: h, path = save_snapshot('checkpoint'); snap = world.snapshot(); step = brain.t   # the step the hash belongs to
        cid, uri = reg.pin_snapshot(path)
        hr, ints = history_root()
        if not chain_state.get('portrait'): chain_state['portrait'] = reg.portrait_uri(FLY_ID)
        muri, _ = reg.pin_metadata(FLY_ID, chain_state.get('portrait', ''), {'Age (s)': int(snap['t_ms'] / 1000), 'Spikes': snap['spikes_total'], 'Eaten (s)': int(snap['ate']), 'Jumps': snap['jumps']}, body_name='Arena',
                                   state={'stateRoot': h, 'stateURI': uri, 'brainStep': step, 'energy': int(snap['energy']), 'alive': True})
        rc = reg.commit(FLY_ID, h, MEMORY_ROOT, uri, muri, step, int(snap['energy']), hr)
        chain_state['last_checkpoint'] = time.time(); chain_state['checkpoints'] += 1; chain_state['last_tx'] = rc['transactionHash'].hex(); chain_state['last_hash'] = h; chain_state['last_uri'] = uri
        log(f"commit {h[:12]} {uri} tx {chain_state['last_tx']} ({len(ints)} interactions)")
        reg.market_refresh(FLY_ID)
    except Exception as e:
        log('commit failed:', str(e)[:200])


def note(kind, data):
    """An interaction: recorded in the interval's history root and, for notable ones, as an on-chain event."""
    chain_state['interactions'].append({'t_ms': world.age_ms, 'kind': kind, 'data': data})
    try: reg.interaction(FLY_ID, kind, data)
    except Exception as e: log('interaction failed:', str(e)[:120])


def report_death():
    """Retries until the registry agrees the fly is dead."""
    with lock: h, path = save_snapshot('death'); step = brain.t; snap = world.snapshot()
    try: cid, uri = reg.pin_snapshot(path)
    except Exception as e: log('pin failed', e); uri = f"snapshots/{h}.npz"
    muri = ''
    while True:
        f = reg.fly(FLY_ID)
        if not f['alive']: chain_state['alive_onchain'] = False; log('death recorded on-chain'); return
        try:
            if not muri:
                if not chain_state.get('portrait'): chain_state['portrait'] = reg.portrait_uri(FLY_ID)
                muri, _ = reg.pin_metadata(FLY_ID, chain_state.get('portrait', ''), {'Age (s)': int(snap['t_ms'] / 1000), 'Spikes': snap['spikes_total'], 'Eaten (s)': int(snap['ate']), 'Jumps': snap['jumps'], 'Cause of death': 'starved in the arena'}, body_name='none',
                                           state={'stateRoot': h, 'stateURI': uri, 'brainStep': step, 'energy': 0, 'alive': False, 'deaths': int(f['deaths']) + 1})
            rc = reg.died(FLY_ID, h, MEMORY_ROOT, uri, muri, step, 'starved in the arena'); log(f"death reported {h[:12]} tx {rc['transactionHash'].hex()}"); reg.market_refresh(FLY_ID)
        except Exception as e:
            log('death report failed, retrying in 20 s:', str(e)[:160]); time.sleep(20)


def chain_loop():
    time.sleep(5)
    while True:
        poll_chain()
        if chain_state['hosting'] and world.alive and time.time() - chain_state['last_checkpoint'] > CHECKPOINT_EVERY: post_checkpoint()
        time.sleep(20)


# ------------------------------------------------------------------ simulation
def sim_loop():
    restore()
    steps_per_frame = int(FRAME_MS / WORLD_MS); acc = np.zeros(len(render_index), np.uint8)
    wall0 = time.time(); bio0 = world.age_ms / 1000.0; dead_reported = not world.alive; last_local = time.time()
    while True:
        try:
            if not chain_state['hosting']:
                time.sleep(1); wall0 = time.time(); bio0 = world.age_ms / 1000.0
                with lock: hdr = {**world.snapshot(), 'wall': time.time(), 'realtime': 0.0, 'chain': public_chain_state(), 'nrender': len(render_index)}
                frame['hdr'] = hdr; frame['spikes'] = b''; frame['at'] = time.time(); sim_alive['ok'] = True; sim_alive['last_step_at'] = time.time()
                continue
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
    return {k: v for k, v in chain_state.items() if k in ('checkpoints', 'last_checkpoint', 'last_tx', 'last_hash', 'alive_onchain', 'hosting', 'last_uri')}


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


async def admin_commit(request):
    if request.remote not in ('127.0.0.1', '::1'): return web.Response(status=403)
    threading.Thread(target=post_checkpoint, daemon=True).start(); return web.json_response({'ok': True})


async def health(request):
    age = time.time() - sim_alive['last_step_at']; ok = sim_alive['ok'] and age < 5
    return web.json_response({'ok': ok, 'sim_thread': sim_alive['ok'], 'frame_age_s': round(age, 1), 'alive': world.alive, 'age_ms': world.age_ms, 'last_checkpoint_age_s': round(time.time() - chain_state['last_checkpoint']) if chain_state['last_checkpoint'] else None, 'url': PUBLIC_URL['url']},
                             status=200 if ok else 503, headers={'Access-Control-Allow-Origin': '*'})


def announce_url():
    """The site finds this body's live stream through bodies(arena).uri on the registry; keep it current."""
    url = PUBLIC_URL['url']
    if not url: return
    try:
        b = reg.c.functions.bodies(reg.address).call()
        if b[1] != url:
            reg.register_body(b[0] or 'Arena', url); log(f'announced live url {url} on the registry')
    except Exception as e:
        log('announce url failed:', repr(e)[:200])


def main():
    signal.signal(signal.SIGTERM, on_term); signal.signal(signal.SIGINT, on_term)
    threading.Thread(target=announce_url, daemon=True).start()
    threading.Thread(target=sim_loop, daemon=True).start(); threading.Thread(target=chain_loop, daemon=True).start()
    app = web.Application()
    app.router.add_get('/ws', ws_handler); app.router.add_get('/state', state_handler); app.router.add_get('/health', health); app.router.add_post('/admin/commit', admin_commit)
    app.router.add_static('/snapshots', SNAPS, show_index=True)
    log(f'arena body {reg.address} hosting fly #{FLY_ID} on registry {REGISTRY}; serving on :{PORT}')
    web.run_app(app, port=PORT, print=None)


if __name__ == '__main__':
    main()
