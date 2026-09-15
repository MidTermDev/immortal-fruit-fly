"""Live server for the whole-brain fly.

Runs the FlyWire brain in its world at real time, streams frames to the website
over WebSocket, reads FoodPlaced / Resurrected events from FlyWorld on BNB Smart
Chain, and posts checkpoints (a hash of the entire brain state) back on-chain.
Snapshots carry the full world state and the brain step at which every chain
event was applied, so `verify.py` can replay one checkpoint into the next.

    ../.venv/bin/python server.py      (reads ../deploy.txt and rpc.txt; PUBLIC_URL from run.sh)

Remote-body mode (REMOTE_BODY=1, started by flyhost.py; brain/HOST_PROTOCOL.md): the fly's body on the
registry is a pebble (BODY_ADDR) that cannot run 139,248 neurons. This process runs the brain and the world
for it, never holds a key and never sends a transaction: the pebble streams /ws?lite=1, posts its senses to
/sense, and fetches the signed-nothing /checkpoint and /final payloads it then commits itself.
"""
import os, sys, json, time, math, threading, hashlib, subprocess, asyncio, base64, signal, fcntl, re, copy
import numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim import WholeBrain, V0
from world import World, WORLD_MS
from aiohttp import web
from registry import Registry, sha256_file, IDENTITY, REGISTRY
from web3 import Web3
from eth_account import Account

HERE = os.path.dirname(os.path.abspath(__file__))
FLY_ID = int(os.environ.get('FLY_ID', '1'))
REMOTE = os.environ.get('REMOTE_BODY') == '1' or '--remote-body' in sys.argv
TEST_BODY = os.environ.get('FLYHOST_TEST_BODY', '') if (REMOTE and os.environ.get('REMOTE_BODY_TEST') == '1') else ''
BODY_ADDR = os.environ.get('BODY_ADDR', '') if REMOTE else ''
STATE = os.environ.get('STATE') or os.path.join(HERE, f'state_{FLY_ID}' if REMOTE else 'state'); SNAPS = os.environ.get('SNAPS') or os.path.join(HERE, 'snapshots')
os.makedirs(STATE, exist_ok=True); os.makedirs(SNAPS, exist_ok=True)
REGISTRY_DEPLOY_BLOCK = int(os.environ.get('REGISTRY_DEPLOY_BLOCK', '122001000'))
BODY_KEY = os.path.join(HERE, 'body_arena.key')
RPC_LOGS = os.environ.get('RPC_LOGS', 'https://bsc-rpc.publicnode.com'); RPC_SEND = os.environ.get('RPC_SEND', 'https://bsc-dataseed.bnbchain.org')
_rpcfile = os.path.join(HERE, 'rpc.txt')
if os.path.exists(_rpcfile) and 'RPC_LOGS' not in os.environ: RPC_LOGS = RPC_SEND = open(_rpcfile).read().strip()
reg = Registry() if REMOTE else Registry(key_path=BODY_KEY)   # a remote body reads and pins only: no key, ever
PORT = int(os.environ.get('PORT', '8123'))
CHECKPOINT_EVERY = float(os.environ.get("CHECKPOINT_EVERY", "600"))
LOCAL_SAVE_EVERY = 60.0
PUBLIC_URL = {'url': os.environ.get('PUBLIC_URL', '')}
FRAME_MS = 100
SENDLOCK = os.path.join(HERE, '.sendlock')   # one transaction at a time from the operator key, across processes
GENESIS_STATE = IDENTITY['genesis_state_sha256']
AUTH_SKEW = 120.0; FLY_TTL = 15.0; SENSE_GAP = 1.0
APPLIED_MAX = 5000            # applied events kept in memory / in a snapshot's meta, beyond those since the chain's last committed step (a verifier needs every event of the interval)
FINAL_FILE = os.path.join(STATE, 'final.json')   # the death payload, kept across restarts until the pebble has reported the death (HOST_PROTOCOL.md: /final waits for it)

brain = WholeBrain(); world = World(brain, energy=float(os.environ.get('GENESIS_ENERGY', '3600')))
GENESIS_WORLD = copy.deepcopy(world.dump_state())   # the world as it is born, for a genesis instantiation
world.on_event = lambda kind, text: note(kind, text) if kind != 'died' else None
render_index = np.load(os.path.join(HERE, 'render_index.npy'))
render_pos = np.full(brain.N, -1, np.int32); render_pos[render_index] = np.arange(len(render_index))
lock = threading.Lock()
frame = {'hdr': None, 'spikes': b'', 'at': 0.0}
clients = set(); log_lines = []
chain_state = {'seen_block': 0, 'last_checkpoint': 0.0, 'checkpoints': 0, 'alive_onchain': True, 'feeds_done': [], 'applied': [], 'applied_seq': 0, 'committed_step': 0, 'hosting': False, 'last_uri': '', 'interactions': [], 'known_roots': {}}
sim_alive = {'ok': False, 'last_step_at': 0.0}
fly_cache = {'at': 0.0, 'rec': None}; pebble = {'name': ''}
final = {'payload': None, 'death_at': None}; final_lock = threading.Lock(); checkpoint_lock = threading.Lock(); sense_state = {'last': 0.0}
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


def applied(ev):
    """Records a world event a verifier must replay (food, puff, predator, resurrect), numbered in the order it was applied. Caller holds `lock`."""
    chain_state['applied_seq'] += 1; ev['seq'] = chain_state['applied_seq']; chain_state['applied'].append(ev); return ev


# ------------------------------------------------------------------ persistence
def save_snapshot(tag):
    """Brain + full world state + applied-event log, content-addressed by the brain hash. Caller holds `lock`."""
    h = brain.state_hash()
    path = os.path.join(SNAPS, f'{h}.npz') if tag in ('checkpoint', 'death') else os.path.join(STATE, 'local.npz')
    world_state = world.dump_state()
    floor = int(chain_state.get('committed_step') or 0)   # events before the chain's last commit are in that commit's snapshot already; everything since must stay for the verifier
    chain_state['applied'] = [e for e in chain_state['applied'] if int(e.get('brain_step', 0)) >= floor][-APPLIED_MAX:]
    meta = {'hash': h, 'tag': tag, 'brain_step': brain.t, 'world': world_state, 'applied': chain_state['applied'], 'applied_seq': chain_state['applied_seq'], 'committed_step': floor, 'feeds_done': chain_state['feeds_done'][-2000:],
            'seen_block': chain_state['seen_block'], 'alive_onchain': chain_state['alive_onchain'], 'fly_id': FLY_ID, 'registry': REGISTRY, 'body': pebble_name() if REMOTE else 'arena', 'connectome_sha256': IDENTITY['connectome_sha256'], 'saved_at': time.time(), 'server': 'brain/server.py'}
    if REMOTE: meta.update({'body_addr': BODY_ADDR, 'host': True, 'known_roots': dict(list(chain_state['known_roots'].items())[-20:]), 'last_uri': chain_state['last_uri']})
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
        for k in ('seen_block', 'alive_onchain', 'feeds_done', 'applied', 'applied_seq', 'committed_step', 'known_roots', 'last_uri'): chain_state[k] = st.get(k, chain_state[k])
        log(f"restored {st['hash'][:12]} (age {world.age_ms/1000:.0f}s, gen {world.generation}, energy {world.energy:.0f}, {len(world.food)} food)")
        if REMOTE and not world.alive: restore_final()
        return True
    except Exception as e:
        log('restore failed, refusing to start from genesis silently:', repr(e)[:200]); raise


def restore_final():
    """The death payload prepared before a restart, if it is for exactly the brain we hold (the fly died in our world and the pebble has not reported it yet)."""
    try:
        if not os.path.exists(FINAL_FILE): return False
        d = json.load(open(FINAL_FILE)); p = d.get('payload') or {}
        if d.get('fly_id') != FLY_ID or p.get('stateRoot') != '0x' + brain.state_hash() or world.alive: log('final.json is not for this brain state; ignored'); return False
        final['payload'] = p; final['death_at'] = d.get('death_at') or time.time()
        log(f"death payload {p['stateRoot'][2:14]} restored: the fly died here {time.time() - final['death_at']:.0f} s ago and the pebble has not reported it yet; /final waits for it")
        return True
    except Exception as e:
        log('final.json unreadable; ignored:', repr(e)[:120]); return False


def clear_final():
    """No death payload applies any more (the world is alive: resurrected, or a live state was loaded)."""
    final['payload'] = None; final['death_at'] = None
    try: os.remove(FINAL_FILE)
    except FileNotFoundError: pass
    except Exception as e: log('final.json not removed:', repr(e)[:120])


# ------------------------------------------------------------------ chain (FlyRegistry)
def fetch_state(uri, root):
    """The snapshot behind an ipfs:// stateURI, cached content-addressed in SNAPS."""
    cid = uri.replace('ipfs://', ''); path = os.path.join(SNAPS, f'{root}.npz')
    if not os.path.exists(path):
        log(f"fetching brain state {root[:12]} from {uri}")
        r = subprocess.run(['curl', '-sL', '-m', '600', '-o', path + '.tmp', f'https://gateway.pinata.cloud/ipfs/{cid}'], capture_output=True)
        if r.returncode != 0 or not os.path.exists(path + '.tmp'): raise RuntimeError('fetch failed')
        os.replace(path + '.tmp', path)
    return path


def instantiate_from_chain():
    """If the registry holds a newer state for our fly (it lived in another body), fetch it and continue from it."""
    f = reg.fly(FLY_ID)
    if f['stateURI'] and f['stateURI'] != chain_state.get('last_uri') and f['stateRoot'] != brain.state_hash():
        path = fetch_state(f['stateURI'], f['stateRoot'])
        with lock:
            brain.load(path); z = np.load(path); m = json.loads(str(z['meta']))
            if brain.state_hash() != f['stateRoot']: raise RuntimeError('fetched state does not match the committed root')
            if 'world' in m: world.load_state(m['world'])
            world.energy = float(f['energy']); world.alive = f['alive']; world.generation = f['generation']
            chain_state['applied_seq'] = max(int(chain_state['applied_seq']), int(m.get('applied_seq', 0))); chain_state['committed_step'] = brain.t
        chain_state['last_uri'] = f['stateURI']
        log(f"instantiated fly #{FLY_ID} from {f['stateURI']} (age {world.age_ms/1000:.0f}s, from body {m.get('body', '?')})")
    return f


def fly_record(force=False):
    """The registry's record of our fly, cached FLY_TTL seconds (the pebble's auth and the hosting check both read it)."""
    if force or fly_cache['rec'] is None or time.time() - fly_cache['at'] > FLY_TTL:
        fly_cache['rec'] = reg.fly(FLY_ID); fly_cache['at'] = time.time()
    return fly_cache['rec']


def body_of(f):
    return TEST_BODY or f['body']


def pebble_name():
    if not pebble['name'] and BODY_ADDR:
        try: pebble['name'] = reg.body(BODY_ADDR)['name'] or f'pebble {BODY_ADDR[:10]}'
        except Exception as e: log('bodies() read failed:', str(e)[:120]); return f'pebble {BODY_ADDR[:10]}'
    return pebble['name']


def reset_to_genesis():
    """The canonical resting state, exactly what WholeBrain() is born as (hash GENESIS_STATE), in a newborn world. Caller holds `lock`."""
    brain.v[:] = V0; brain.g[:] = 0; brain.ref_until[:] = 0; brain.ring[:] = 0; brain.counts[:] = 0; brain.t = 0; brain.total_spikes = 0
    world.load_state(copy.deepcopy(GENESIS_WORLD))


def left_since(frm, head):
    """Did another body accept the fly between our last saved block and now (so our local continuation is not the fly's life)?"""
    if not frm: return False
    return any(ev['body'].lower() != BODY_ADDR.lower() for ev in reg.events('Accepted', frm, head, id=FLY_ID))


def instantiate_remote(f, head, fresh):
    """Make the world the state the registry says the fly is in. At process start (`fresh`) a local continuation is kept when the chain's
    root is one we produced or started from, our state is at or past it, the record's generation is still our world's (no death and
    resurrection on the chain since) and no other body had the fly meanwhile; otherwise the chain's state is loaded: a genesis fly is a
    fresh WholeBrain() (whose hash must equal stateRoot), anything else is fetched and hash-checked, and energy, alive and generation come
    from the record. Feeds up to `head` are already banked in the record's energy, so the event scan resumes there.

    A kept continuation whose fly is dead while the record still says alive is a death the pebble has not reported yet: the fly stays dead,
    its death payload stays (restored from final.json, or prepared again) and /final waits for the pebble (HOST_PROTOCOL.md, failure modes).
    The record alone never resurrects such a fly: only a generation the chain advanced (a Resurrected event) does, and then from the chain's state."""
    root = f['stateRoot']; uri = f['stateURI']; known = chain_state['known_roots'].get(root)
    ours = fresh and known is not None and brain.t >= known and int(f['generation']) == int(world.generation) and not left_since(chain_state['seen_block'], head)
    if not ours and not uri and root != GENESIS_STATE: raise RuntimeError(f'genesis fly (empty stateURI) with stateRoot {root[:12]} != GENESIS_STATE; refusing')
    path = fetch_state(uri, root) if (not ours and uri) else None
    with lock:
        if ours:
            log(f"continuing our own state at step {brain.t:,} (chain: {root[:12]} at step {known:,})")
            if not world.alive: log(f"the fly died here at step {brain.t:,} (generation {world.generation}) and the registry still says alive: staying dead, /final waits for the pebble")
        else:
            m = {}
            if not uri:
                reset_to_genesis()
                if brain.state_hash() != root: raise RuntimeError('a fresh brain does not hash to GENESIS_STATE; refusing')
            else:
                brain.load(path); z = np.load(path); m = json.loads(str(z['meta']))
                if brain.state_hash() != root: raise RuntimeError('fetched state does not match the committed root')
                if 'world' in m: world.load_state(m['world'])
            mine = m.get('fly_id') == FLY_ID and str(m.get('body_addr', '')).lower() == BODY_ADDR.lower()
            chain_state['applied'] = list(m.get('applied', [])) if mine else []; chain_state['feeds_done'] = list(m.get('feeds_done', [])) if mine else chain_state['feeds_done']
            chain_state['applied_seq'] = max(int(chain_state['applied_seq']), int(m.get('applied_seq', 0)))   # the numbering continues from the snapshot's (a verifier replays (A.seq, B.seq])
            chain_state['known_roots'] = {root: brain.t}; chain_state['committed_step'] = brain.t; chain_state['last_uri'] = uri; chain_state['seen_block'] = head + 1
            world.energy = float(f['energy']); world.generation = int(f['generation'])
            if TEST_BODY and os.environ.get('FLYHOST_TEST_ENERGY'): world.energy = float(os.environ['FLYHOST_TEST_ENERGY']); log(f'*** TEST MODE: starting energy overridden to {world.energy:.0f} s ***')
            if not f['alive']: world.alive = False
            log(f"instantiated fly #{FLY_ID} from {uri or 'genesis'} (step {brain.t:,}, age {world.age_ms/1000:.0f}s, energy {world.energy:.0f}, gen {world.generation}, from body {m.get('body', 'none')})")
            if f['alive'] and not world.alive:   # the chain's state is a death snapshot and the record says alive: resurrected since it was written; applied like a Resurrected event, so a replay can follow
                world.resurrect(int(f['energy'])); world.generation = int(f['generation'])
                applied({'kind': 'resurrect', 'generation': world.generation, 'energy': int(f['energy']), 'by': 'record', 'block': head, 'brain_step': brain.t})
                log(f"resurrected per the record as generation {world.generation} with {f['energy']} s")
        if world.alive: clear_final()


def poll_chain():
    """Accept assignments, apply feeds (as food to find), notice resurrections."""
    try:
        f = fly_record(force=True) if REMOTE else reg.fly(FLY_ID)
        head = reg.w3.eth.block_number
        if REMOTE:
            hosting = body_of(f).lower() == BODY_ADDR.lower() and f['alive']
            if hosting and not chain_state['hosting']:
                instantiate_remote(f, head, fresh=not chain_state.get('hosted_once')); chain_state['hosted_once'] = True; log(f"hosting fly #{FLY_ID} for {pebble_name()} ({BODY_ADDR})")
            if chain_state['known_roots'].get(f['stateRoot']) is not None: chain_state['committed_step'] = int(chain_state['known_roots'][f['stateRoot']])
        else:
            if f['pendingBody'].lower() == reg.address.lower():
                instantiate_from_chain(); reg.accept(FLY_ID); log('accepted custody of fly #%d' % FLY_ID); f = reg.fly(FLY_ID)
            hosting = f['body'].lower() == reg.address.lower()
        chain_state['hosting'] = hosting; chain_state['alive_onchain'] = f['alive']
        if not hosting:
            chain_state['seen_block'] = head + 1; return
        frm = chain_state['seen_block'] or REGISTRY_DEPLOY_BLOCK
        for ev in reg.events('Fed', frm, head, id=FLY_ID):
            key = ev['tx']
            if key in chain_state['feeds_done']: continue
            secs = int(ev['seconds_']); frng = np.random.default_rng(int.from_bytes(hashlib.sha256(str(key).encode()).digest()[:8], 'big'))   # from the feed's tx, not world.rng: the world's own draws stay replayable
            ang = frng.random() * 2 * math.pi; r = 40 + frng.random() * 70
            with lock:
                fd = world.place_food(world.x + r * math.cos(ang), world.y + r * math.sin(ang), secs, ev['by']); chain_state['feeds_done'].append(key)
                applied({'kind': 'food', 'id': fd['id'], 'x': fd['x'], 'y': fd['y'], 'seconds': secs, 'by': ev['by'], 'block': ev['block'], 'brain_step': brain.t})
            log(f"fed {secs}s by {ev['by'][:10]}: food placed at ({fd['x']:.0f},{fd['y']:.0f}) — it has to find it")
        for ev in reg.events('Resurrected', frm, head, id=FLY_ID):
            if not world.alive:
                with lock:
                    world.resurrect(int(ev['energy'])); world.generation = int(ev['generation'])
                    applied({'kind': 'resurrect', 'generation': int(ev['generation']), 'energy': int(ev['energy']), 'by': ev['by'], 'block': ev['block'], 'brain_step': brain.t})
                if REMOTE: clear_final()
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
        chain_state['last_checkpoint'] = time.time(); chain_state['checkpoints'] += 1; chain_state['last_tx'] = rc['transactionHash'].hex(); chain_state['last_hash'] = h; chain_state['last_uri'] = uri; chain_state['committed_step'] = step
        log(f"commit {h[:12]} {uri} tx {chain_state['last_tx']} ({len(ints)} interactions)")
        reg.market_refresh(FLY_ID)
    except Exception as e:
        log('commit failed:', str(e)[:200])


def note(kind, data):
    """An interaction: recorded in the interval's history root and, for notable ones, as an on-chain event (the pebble sends those itself for a remote body)."""
    chain_state['interactions'].append({'t_ms': world.age_ms, 'kind': kind, 'data': data})
    if REMOTE: return
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


# ------------------------------------------------------------------ remote body: payloads the pebble signs (HOST_PROTOCOL.md)
def payload(h, uri, muri, step, energy, hr, ints, snap):
    return {'stateRoot': '0x' + h, 'memoryRoot': '0x' + MEMORY_ROOT, 'stateURI': uri, 'metadataURI': muri, 'brainStep': int(step), 'energy': int(energy), 'historyRoot': '0x' + hr,
            'interactions': ints, 'age_s': int(snap['t_ms'] / 1000), 'spikes': int(snap['spikes_total']), 'generation': int(snap['generation'])}


def make_checkpoint():
    """Saves + pins the snapshot and fresh token metadata for the state being committed; returns the commit payload (the pebble sends commit + interactions)."""
    with checkpoint_lock:
        with lock: h, path = save_snapshot('checkpoint'); snap = world.snapshot(); step = brain.t; chain_state['known_roots'][h] = step
        cid, uri = reg.pin_snapshot(path)
        hr, ints = history_root()
        if not chain_state.get('portrait'): chain_state['portrait'] = reg.portrait_uri(FLY_ID)
        muri, _ = reg.pin_metadata(FLY_ID, chain_state.get('portrait', ''), {'Age (s)': int(snap['t_ms'] / 1000), 'Spikes': snap['spikes_total'], 'Eaten (s)': int(snap['ate']), 'Jumps': snap['jumps']}, body_name=pebble_name(),
                                   state={'stateRoot': h, 'stateURI': uri, 'brainStep': step, 'energy': int(snap['energy']), 'alive': True})
        chain_state['last_checkpoint'] = time.time(); chain_state['checkpoints'] += 1; chain_state['last_hash'] = h; chain_state['last_uri'] = uri
        log(f"checkpoint {h[:12]} {uri} step {step:,} energy {int(snap['energy'])} handed to the pebble ({len(ints)} interactions)")
        return payload(h, uri, muri, step, snap['energy'], hr, ints, snap)


def prepare_final():
    """After the death in the world: the death snapshot + metadata (Status dead, deaths + 1), as the payload for died(). Idempotent."""
    with final_lock:
        if final['payload']: return final['payload']
        with lock: h, path = save_snapshot('death'); snap = world.snapshot(); step = brain.t; chain_state['known_roots'][h] = step
        cid, uri = reg.pin_snapshot(path)
        hr, ints = history_root(); f = fly_record(); cause = f'starved in {pebble_name()}'
        if not chain_state.get('portrait'): chain_state['portrait'] = reg.portrait_uri(FLY_ID)
        muri, _ = reg.pin_metadata(FLY_ID, chain_state.get('portrait', ''), {'Age (s)': int(snap['t_ms'] / 1000), 'Spikes': snap['spikes_total'], 'Eaten (s)': int(snap['ate']), 'Jumps': snap['jumps'], 'Cause of death': cause}, body_name='none',
                                   state={'stateRoot': h, 'stateURI': uri, 'brainStep': step, 'energy': 0, 'alive': False, 'deaths': int(f['deaths']) + 1})
        chain_state['last_hash'] = h; chain_state['last_uri'] = uri
        final['payload'] = {**payload(h, uri, muri, step, 0, hr, ints, snap), 'cause': cause}; final['death_at'] = final['death_at'] or time.time()
        try: atomic_write(FINAL_FILE, json.dumps({'fly_id': FLY_ID, 'body_addr': BODY_ADDR, 'death_at': final['death_at'], 'payload': final['payload']}).encode())   # survives a restart: /final waits for the pebble however long it takes
        except Exception as e: log('final.json not written:', repr(e)[:120])
        log(f"final {h[:12]} {uri} step {step:,} ready for the pebble: {cause}")
        return final['payload']


def on_death():
    final['death_at'] = final['death_at'] or time.time()
    if not REMOTE: report_death(); return
    try: prepare_final()
    except Exception as e: log('final payload failed (retried on /final):', str(e)[:160])


def apply_sense(s):
    """A pebble sense as a world event. Sides are relative to the fly's heading (left = heading + 90°)."""
    kind = s.get('kind'); side = s.get('side', 'left')
    if kind == 'turn': return 'wind rotation is v2: ignored'
    if kind in ('landmark', 'shock'):
        if side not in ('left', 'right'): raise ValueError('side must be left or right')
    elif kind == 'cue': wedge = int(s.get('wedge', 0)) % 16
    else: raise ValueError('kind must be landmark, shock, cue or turn')
    with lock:
        ang = (wedge + 0.5) * 2 * math.pi / 16 if kind == 'cue' else world.heading + (math.pi / 2 if side == 'left' else -math.pi / 2)
        if kind == 'shock':
            if not world.spawn_predator(ang): return 'a predator is already about; nothing added'
            applied({'kind': 'predator', 'angle': ang, 'brain_step': brain.t}); return f'a predator approaches from the {side}'
        x, y = world.x + 40 * math.cos(ang), world.y + 40 * math.sin(ang); p = world.puff(x, y, 1.0, 8.0)
        applied({'kind': 'puff', 'x': p['x'], 'y': p['y'], 'strength': p['strength'], 'seconds': 8.0, 'brain_step': brain.t})
        return f"an odor puff at ({x:.0f},{y:.0f}), 40 body lengths {'to the ' + side if kind == 'landmark' else 'toward wedge %d' % wedge}, for 8 s"


def chain_loop():
    if REMOTE: restored.wait()
    else: time.sleep(5)
    while True:
        poll_chain()
        if not REMOTE and chain_state['hosting'] and world.alive and time.time() - chain_state['last_checkpoint'] > CHECKPOINT_EVERY: post_checkpoint()
        time.sleep(20)


# ------------------------------------------------------------------ simulation
restored = threading.Event()


def sim_loop():
    restore(); restored.set()
    steps_per_frame = int(FRAME_MS / WORLD_MS); acc = np.zeros(len(render_index), np.uint8)
    wall0 = time.time(); bio0 = world.age_ms / 1000.0; dead_reported = not world.alive and (not REMOTE or final['payload'] is not None); last_local = time.time()
    while True:
        try:
            if not chain_state['hosting']:
                time.sleep(1); wall0 = time.time(); bio0 = world.age_ms / 1000.0
                with lock: hdr = {**world.snapshot(), 'wall': time.time(), 'realtime': 0.0, 'chain': public_chain_state(), 'nrender': len(render_index)}
                frame['hdr'] = hdr; frame['spikes'] = b''; frame['at'] = time.time(); sim_alive['ok'] = True; sim_alive['last_step_at'] = time.time()
                continue
            if not world.alive:
                if not dead_reported: dead_reported = True; threading.Thread(target=on_death, daemon=True).start()
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
CORS = {'Access-Control-Allow-Origin': '*'}


async def ws_handler(request):
    lite = request.query.get('lite') in ('1', 'true')
    ws = web.WebSocketResponse(heartbeat=20); await ws.prepare(request); clients.add(ws)
    try:
        last = None
        while not ws.closed:
            hdr = frame['hdr']
            if lite:   # the pebble's stream: the hdr alone, five times a second
                if hdr is not None: await ws.send_str(json.dumps(hdr))
                await asyncio.sleep(0.2); continue
            if hdr is not None and hdr.get('wall') != last:
                last = hdr.get('wall'); await ws.send_str(json.dumps({'hdr': hdr, 'spikes': base64.b64encode(frame['spikes']).decode()}))
            await asyncio.sleep(FRAME_MS / 1000)
    finally: clients.discard(ws)
    return ws


async def frame_handler(request):
    return web.json_response(frame['hdr'], headers=CORS)


async def state_handler(request):
    return web.json_response({'hdr': frame['hdr'], 'clients': len(clients), 'log': log_lines[-30:], 'frame_age_s': round(time.time() - frame['at'], 1)}, headers=CORS)


async def admin_commit(request):
    if request.remote not in ('127.0.0.1', '::1'): return web.Response(status=403)
    threading.Thread(target=post_checkpoint, daemon=True).start(); return web.json_response({'ok': True})


async def health(request):
    age = time.time() - sim_alive['last_step_at']; ok = sim_alive['ok'] and age < 5; hdr = frame['hdr'] or {}
    d = {'ok': ok, 'sim_thread': sim_alive['ok'], 'frame_age_s': round(age, 1), 'alive': world.alive, 'age_ms': world.age_ms, 'last_checkpoint_age_s': round(time.time() - chain_state['last_checkpoint']) if chain_state['last_checkpoint'] else None, 'url': PUBLIC_URL['url']}
    if REMOTE: d.update({'realtime': hdr.get('realtime', 0.0), 'body': BODY_ADDR, 'fly': FLY_ID, 'hosting': chain_state['hosting'], 'test_mode': bool(TEST_BODY), 'dead_since': final['death_at'], 'final_ready': final['payload'] is not None})
    return web.json_response(d, status=200 if ok else 503, headers=CORS)


def check_auth(request):
    """The pebble proves it is the body: X-Fly-Ts / X-Fly-Sig over keccak256("flyhost|<id>|<ts>"), signer == fly(id).body, 120 s of skew."""
    try:
        ts = int(request.headers['X-Fly-Ts']); sig = request.headers['X-Fly-Sig']
        if abs(time.time() - ts) > AUTH_SKEW: return False
        signer = Account._recover_hash(Web3.keccak(text=f'flyhost|{FLY_ID}|{ts}'), signature=sig)
        return signer.lower() == body_of(fly_record()).lower()
    except Exception as e:
        return False


def authed(fn):
    async def h(request):
        if not await asyncio.to_thread(check_auth, request): return web.json_response({'error': 'not the body'}, status=403)
        return await fn(request)
    return h


@authed
async def sense_handler(request):
    try: s = await request.json(); assert isinstance(s, dict)
    except Exception: return web.json_response({'ok': False, 'error': 'json body expected'}, status=400)
    now = time.time()
    if s.get('kind') != 'turn' and now - sense_state['last'] < SENSE_GAP: return web.json_response({'ok': False, 'error': 'one sense per second'}, status=429)
    try: effect = apply_sense(s)
    except (ValueError, TypeError) as e: return web.json_response({'ok': False, 'error': str(e)[:120]}, status=400)
    if s.get('kind') != 'turn': sense_state['last'] = now
    log(f"sense {s.get('kind')} {s.get('side', s.get('wedge', ''))}: {effect}")
    return web.json_response({'ok': True, 'effect': effect})


@authed
async def checkpoint_handler(request):
    if not chain_state['hosting']: return web.json_response({'error': 'not hosting this fly'}, status=409)
    if not world.alive: return web.json_response({'error': 'dead: fetch /final'}, status=409)
    try: p = await asyncio.to_thread(make_checkpoint)
    except Exception as e: log('checkpoint failed:', str(e)[:200]); return web.json_response({'error': str(e)[:200]}, status=503)
    return web.json_response(p)


@authed
async def final_handler(request):
    """The death payload, for as long as this process lives: while the registry still says alive, the death is unreported and the pebble may be
    away for hours (HOST_PROTOCOL.md: /final waits for it); once it is reported, flyhost keeps the process for 10 more minutes and that is the end."""
    if world.alive: return web.json_response({'error': 'alive'}, status=409)
    try: p = await asyncio.to_thread(prepare_final)
    except Exception as e: log('final failed:', str(e)[:200]); return web.json_response({'error': str(e)[:200]}, status=503)
    return web.json_response(p)


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
    if REMOTE and not Web3.is_address(BODY_ADDR): log('REMOTE_BODY=1 needs BODY_ADDR (the pebble address)'); sys.exit(2)
    if not REMOTE: threading.Thread(target=announce_url, daemon=True).start()
    threading.Thread(target=sim_loop, daemon=True).start(); threading.Thread(target=chain_loop, daemon=True).start()
    app = web.Application()
    app.router.add_get('/ws', ws_handler); app.router.add_get('/state', state_handler); app.router.add_get('/health', health); app.router.add_get('/frame', frame_handler)
    if REMOTE: app.router.add_post('/sense', sense_handler); app.router.add_get('/checkpoint', checkpoint_handler); app.router.add_get('/final', final_handler)
    else: app.router.add_post('/admin/commit', admin_commit)
    app.router.add_static('/snapshots', SNAPS, show_index=True)
    if REMOTE:
        log(f'remote body {BODY_ADDR} ({pebble_name()}): running the whole brain of fly #{FLY_ID} on registry {REGISTRY}; serving on :{PORT}; state {STATE}')
        if TEST_BODY: log(f'*** TEST MODE (REMOTE_BODY_TEST=1): the body check is overridden, {TEST_BODY} passes as the body of fly #{FLY_ID}; never run this in production ***')
    else: log(f'arena body {reg.address} hosting fly #{FLY_ID} on registry {REGISTRY}; serving on :{PORT}')
    web.run_app(app, port=PORT, print=None, handle_signals=False)   # aiohttp would replace the SIGTERM handler above with its own, and the state would not be saved


if __name__ == '__main__':
    main()
