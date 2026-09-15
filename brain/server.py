"""Live server for the whole-brain fly.

Runs the FlyWire brain in its world at real time, streams frames to the website
over WebSocket, reads FoodPlaced / Resurrected events from FlyWorld on BNB Smart
Chain, and posts checkpoints (a hash of the entire brain state) back on-chain.
Snapshots are served so anyone can verify a checkpoint by re-running the model.

    PRIVATE_KEY=0x.. ../.venv/bin/python server.py
"""
import os, sys, json, time, math, threading, hashlib, subprocess, asyncio, base64
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
RPC_LOGS = os.environ.get('RPC_LOGS', 'https://bsc-rpc.publicnode.com')
RPC_SEND = os.environ.get('RPC_SEND', 'https://bsc-rpc.publicnode.com')
PK = os.environ.get('PRIVATE_KEY') or ('0x' + open(os.path.join(HERE, '..', 'deploy.txt')).read().strip())
_rpcfile = os.path.join(HERE, 'rpc.txt')
if os.path.exists(_rpcfile) and 'RPC_LOGS' not in os.environ: RPC_LOGS = RPC_SEND = open(_rpcfile).read().strip()
PORT = int(os.environ.get('PORT', '8123'))
CHECKPOINT_EVERY = float(os.environ.get('CHECKPOINT_EVERY', '600'))   # seconds
PUBLIC_URL = {'url': os.environ.get('PUBLIC_URL', '')}
FRAME_MS = 100

brain = WholeBrain(); world = World(brain, energy=float(os.environ.get('GENESIS_ENERGY', '3600')))
render_index = np.load(os.path.join(HERE, 'render_index.npy'))
render_pos = np.full(brain.N, -1, np.int32); render_pos[render_index] = np.arange(len(render_index))
lock = threading.Lock()
frame = {'hdr': None, 'spikes': b''}
clients = set()
log_lines = []


def log(*a):
    s = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(s, flush=True); log_lines.append(s); del log_lines[:-200]


# ------------------------------------------------------------------ persistence
def save_snapshot(tag):
    h = brain.state_hash()
    path = os.path.join(SNAPS, f'{h}.npz')
    if not os.path.exists(path):
        np.savez_compressed(path, v=brain.v, g=brain.g, ref_until=brain.ref_until, ring=brain.ring, counts=brain.counts, t=brain.t, total=brain.total_spikes,
                            world=json.dumps({k: v for k, v in world.snapshot().items() if k != 'events'}))
    with open(os.path.join(STATE, 'latest.json'), 'w') as f:
        json.dump({'hash': h, 'tag': tag, 'world': world.snapshot(), 'food_seen_block': chain_state['food_seen_block'], 'gen_seen': chain_state['gen_seen']}, f)
    return h, path


def restore():
    p = os.path.join(STATE, 'latest.json')
    if not os.path.exists(p): return False
    st = json.load(open(p)); path = os.path.join(SNAPS, st['hash'] + '.npz')
    if not os.path.exists(path): return False
    brain.load(path); w = st['world']
    world.x, world.y, world.heading, world.energy, world.alive, world.generation = w['x'], w['y'], w['heading'], w['energy'], w['alive'], w['generation']
    world.age_ms, world.life_ms, world.ate_total, world.jumps, world.hits = w['t_ms'], w['life_ms'], w['ate'], w['jumps'], w['hits']
    for f in w['food']: world.place_food(f['x'], f['y'], f['energy'], f['by'], fid=f['id']); world.food[-1]['energy0'] = f['energy0']
    chain_state['food_seen_block'] = st.get('food_seen_block', 0); chain_state['gen_seen'] = st.get('gen_seen', 0)
    log(f'restored from {st["hash"][:12]} (age {w["t_ms"]/1000:.0f}s, gen {w["generation"]}, energy {w["energy"]:.0f})')
    return True


# ------------------------------------------------------------------ chain
chain_state = {'food_seen_block': 0, 'gen_seen': 0, 'last_checkpoint': 0.0, 'checkpoints': 0, 'alive_onchain': True}


def cast(*args, timeout=120):
    r = subprocess.run(['cast', *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0: raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout.strip()


def poll_chain():
    """Read FoodPlaced and Resurrected events; apply them to the world."""
    try:
        head = int(cast('block-number', '--rpc-url', RPC_LOGS))
        frm = chain_state['food_seen_block'] or max(0, head - 4000)
        if frm > head: return
        logs = []
        while frm <= head:
            to = min(head, frm + 1999)
            out = cast('logs', '--rpc-url', RPC_LOGS, '--from-block', str(frm), '--to-block', str(to), '--address', WORLD_ADDR, '--json')
            logs += json.loads(out) if out else []
            frm = to + 1
        SIG_FOOD = cast('keccak', 'FoodPlaced(uint256,address,int32,int32,uint64,uint256)')
        SIG_RES = cast('keccak', 'Resurrected(uint32,address,uint256,uint64)')
        s32 = lambda x: x - (1 << 256) if x >= (1 << 255) else x
        for l in logs:
            t0 = l['topics'][0]; d = l['data'][2:]; w = [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]
            if t0 == SIG_FOOD:
                fid = int(l['topics'][1], 16); by = '0x' + l['topics'][2][-40:]
                x, y, secs = s32(w[0]), s32(w[1]), w[2]
                with lock:
                    if not any(f['id'] == fid for f in world.food) and fid not in chain_state.setdefault('foods_done', set()):
                        world.place_food(x, y, secs, by, fid=fid); chain_state['foods_done'].add(fid)
                log(f'on-chain food #{fid} at ({x},{y}) worth {secs}s from {by[:10]}')
            elif t0 == SIG_RES:
                gen = int(l['topics'][1], 16); by = '0x' + l['topics'][2][-40:]; energy = w[1]
                if gen > chain_state['gen_seen']:
                    chain_state['gen_seen'] = gen
                    with lock:
                        if not world.alive:
                            world.resurrect(energy); world.generation = gen; chain_state['alive_onchain'] = True
                            log(f'resurrected on-chain by {by[:10]} as generation {gen} with {energy}s')
        chain_state['food_seen_block'] = head + 1
    except Exception as e:
        log('chain poll failed:', str(e)[:160])


def post_checkpoint(death=False):
    try:
        with lock:
            h, path = save_snapshot('death' if death else 'checkpoint'); snap = world.snapshot()
        uri = f"{PUBLIC_URL['url']}/snapshots/{h}.npz" if PUBLIC_URL['url'] else f"snapshots/{h}.npz"
        if death:
            tx = cast('send', '--rpc-url', RPC_SEND, '--private-key', PK, WORLD_ADDR, 'reportDeath(uint64,bytes32,string)', str(int(snap['t_ms'])), '0x' + h, uri, '--json')
            chain_state['alive_onchain'] = False
        else:
            tx = cast('send', '--rpc-url', RPC_SEND, '--private-key', PK, WORLD_ADDR, 'checkpoint(uint64,uint64,bytes32,int32,int32,uint64,uint64,string)',
                      str(snap['step']), str(int(snap['t_ms'])), '0x' + h, str(int(round(snap['x']))), str(int(round(snap['y']))), str(int(snap['energy'])), str(snap['spikes_total']), uri, '--json')
        txh = json.loads(tx).get('transactionHash') if tx.startswith('{') else tx[:80]
        chain_state['last_checkpoint'] = time.time(); chain_state['checkpoints'] += 1; chain_state['last_tx'] = txh; chain_state['last_hash'] = h
        log(('death reported' if death else 'checkpoint') + f' {h[:12]} tx {txh}')
    except Exception as e:
        log('checkpoint failed:', str(e)[:200])


def chain_loop():
    time.sleep(5)
    while True:
        poll_chain()
        if world.alive and chain_state['alive_onchain'] and time.time() - chain_state['last_checkpoint'] > CHECKPOINT_EVERY:
            post_checkpoint()
        time.sleep(20)


# ------------------------------------------------------------------ simulation
def sim_loop():
    restore()
    steps_per_frame = int(FRAME_MS / WORLD_MS)
    acc = np.zeros(len(render_index), np.uint8)
    wall0 = time.time(); bio0 = world.age_ms / 1000.0
    last_dead_report = world.alive
    while True:
        if not world.alive:
            if last_dead_report:
                post_checkpoint(death=True); last_dead_report = False
            time.sleep(0.5); wall0 = time.time(); bio0 = world.age_ms / 1000.0
            with lock:
                frame['hdr'] = {**world.snapshot(), 'wall': time.time(), 'realtime': 0.0, 'chain': {k: v for k, v in chain_state.items() if k != 'foods_done'}}
            if world.alive: last_dead_report = True
            continue
        last_dead_report = True
        acc[:] = 0
        with lock:
            for _ in range(steps_per_frame):
                ids = world.step(record=True)
                r = render_pos[ids]; r = r[r >= 0]; acc[r] = 1
            snap = world.snapshot()
        spikes = np.where(acc)[0].astype(np.uint16)
        elapsed = time.time() - wall0; bio = world.age_ms / 1000.0 - bio0
        frame['hdr'] = {**snap, 'wall': time.time(), 'realtime': round(bio / max(1e-6, elapsed), 2), 'chain': {k: v for k, v in chain_state.items() if k != 'foods_done'}, 'nrender': len(render_index)}
        frame['spikes'] = spikes.tobytes()
        # pace to real time
        ahead = bio - elapsed
        if ahead > 0.02: time.sleep(min(ahead, 0.1))


# ------------------------------------------------------------------ web
async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20); await ws.prepare(request); clients.add(ws)
    try:
        last = None
        while not ws.closed:
            hdr = frame['hdr']
            if hdr is not None and hdr.get('wall') != last:
                last = hdr.get('wall')
                await ws.send_str(json.dumps({'hdr': hdr, 'spikes': base64.b64encode(frame['spikes']).decode()}))
            await asyncio.sleep(FRAME_MS / 1000)
    finally:
        clients.discard(ws)
    return ws


async def state_handler(request):
    return web.json_response({'hdr': frame['hdr'], 'clients': len(clients), 'log': log_lines[-30:]}, headers={'Access-Control-Allow-Origin': '*'})


async def health(request):
    return web.json_response({'ok': True, 'alive': world.alive, 'age_ms': world.age_ms, 'url': PUBLIC_URL['url']}, headers={'Access-Control-Allow-Origin': '*'})


def main():
    threading.Thread(target=sim_loop, daemon=True).start()
    threading.Thread(target=chain_loop, daemon=True).start()
    app = web.Application()
    app.router.add_get('/ws', ws_handler); app.router.add_get('/state', state_handler); app.router.add_get('/health', health)
    app.router.add_static('/snapshots', SNAPS, show_index=True)
    log(f'serving on :{PORT}; world {WORLD_ADDR}')
    web.run_app(app, port=PORT, print=None)


if __name__ == '__main__':
    main()
