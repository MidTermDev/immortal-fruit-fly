"""Tests for the Colony body (COLONY.md) without a Paper server. Mainnet is only read; nothing is pinned or sent.

Part 1 starts server.py --colony in COLONY_TEST=1 for fly #2 (a dormant, alive genesis fly on mainnet; the test mode lets it run as if the
Colony had it) on a scratch port with scratch STATE/SNAPS, and a mock agent (an aiohttp WebSocket client playing the bot: it integrates the
motor frames into a position and a yaw and streams synthetic senses at 10 Hz): a bread item 6 blocks ahead-left, a passing fly, later a zombie
closing from the right that hits once. It asserts that the brain surges toward the food (turn toward it and forward > 0 within 20 s of sim
time), that eat turns on within 1.5 blocks and the meal restores the item's points, that the closing zombie makes the giant fiber fire (a jump
and "a shadow!") and that the hit costs 60 s, that /frame carries the Colony fields, that /ws?lite=1 streams, that the feed-drop path works,
that a checkpoint saves a snapshot whose hash equals stateRoot (with the sense stream rotated; nothing pinned or sent), that the supervisor's
proxy (colony.fly_proxy, run in this process in front of the brain) reaches only the public paths and one plain snapshot name and refuses every
traversal (`snapshots/../admin/commit`, `%2e%2e`, double encoding, `view/../..`) before the brain sees it, that the brain itself refuses a
local-only route carrying a forwarding header, the SIGTERM save and the restart, then (a second process with 5 s of energy) that the death
produces the final payload.
Part 2 is the supervisor without a world: colony.py's selection rule against a fake registry snapshot, its RCON config parser, its public-path
rule, the retried camera/ALLOW_PLAYERS whitelist against a fake RCON, and a short run of colony.py itself (no Paper server, no sends) for
/colony/state, the proxy's answers (traversals 404 before the child lookup) and CORS.

    NUMBA_NUM_THREADS=6 ../.venv/bin/python test_colony.py [--no-server] [--no-death] [--no-super]      (TEST_DIR=… for the scratch directory)
"""
import os, sys, json, time, socket, signal, subprocess, hashlib, asyncio, tempfile, threading, urllib.request, urllib.error, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, 'colony'))
import numpy as np

PY = sys.executable; FLY = int(os.environ.get('TEST_FLY_ID', '2')); THREADS = os.environ.get('NUMBA_NUM_THREADS', '6')
os.environ.setdefault('COLONY_NO_PAPER', '1')   # colony.py is imported below (its proxy handlers and pure rules); it must never start a Paper server
TEST_DIR = os.environ.get('TEST_DIR') or tempfile.mkdtemp(prefix='colony_test_')
NO_SERVER = '--no-server' in sys.argv; NO_DEATH = '--no-death' in sys.argv; NO_SUPER = '--no-super' in sys.argv
passed = []


def ok(name, cond, detail=''):
    if not cond: raise AssertionError(f'{name}: {detail}')
    passed.append(name); print(f'  ok  {name}' + (f'  ({detail})' if detail else ''), flush=True)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def http(method, url, body=None, headers=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, json.loads(r.read() or b'null'), dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw), dict(e.headers)
        except Exception: return e.code, raw.decode(errors='replace'), dict(e.headers)


def raw(method, port, path, body=None, headers=None, timeout=120):
    """A request whose path goes on the wire exactly as written: http.client does not collapse '..' (urllib and aiohttp's client would)."""
    import http.client
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout); c.request(method, path, body=body, headers={'Content-Type': 'application/json', **(headers or {})})
    r = c.getresponse(); data = r.read(); hd = dict(r.getheaders()); c.close()
    try: return r.status, json.loads(data), hd
    except Exception: return r.status, data, hd


def start_proxy(child_port, child_proc):
    """colony.fly_proxy and view_proxy in this process (their own loop in a thread) in front of the test brain: the supervisor's public surface
    without the supervisor. Returns {port, stop}."""
    import colony
    from aiohttp import web, ClientSession
    colony.children[FLY] = {'id': FLY, 'port': child_port, 'proc': child_proc}
    port = free_port(); ready = threading.Event(); box = {}

    async def run():
        app = web.Application(); app['session'] = ClientSession()
        app.router.add_route('*', '/fly/{id:\\d+}/{rest:.*}', colony.fly_proxy); app.router.add_route('*', '/view/{rest:.*}', colony.view_proxy); app.router.add_route('*', '/view', colony.view_proxy)
        runner = web.AppRunner(app); await runner.setup(); await web.TCPSite(runner, '127.0.0.1', port).start()
        box['stop'] = asyncio.Event(); ready.set(); await box['stop'].wait(); await app['session'].close(); await runner.cleanup()

    def thread():
        box['loop'] = asyncio.new_event_loop(); box['loop'].run_until_complete(run())
    th = threading.Thread(target=thread, daemon=True); th.start(); ready.wait(10)
    return {'port': port, 'stop': lambda: (box['loop'].call_soon_threadsafe(box['stop'].set), th.join(10), colony.children.pop(FLY, None))}


async def ws_frames(url, n, timeout=20):
    from aiohttp import ClientSession
    out = []; t = []
    async with ClientSession() as s:
        async with s.ws_connect(url) as ws:
            while len(out) < n:
                m = await asyncio.wait_for(ws.receive(), timeout); out.append(json.loads(m.data)); t.append(time.time())
    return out, t


def wait_health(url, seconds, proc=None, cond=None):
    t0 = time.time(); last = None
    while time.time() - t0 < seconds:
        if proc is not None and proc.poll() is not None: raise RuntimeError(f'process exited with {proc.returncode}')
        try:
            st, h, _ = http('GET', url, timeout=5); last = (st, h)
            if isinstance(h, dict) and (cond(h) if cond else h.get('ok')): return h
        except Exception as e: last = repr(e)[:80]
        time.sleep(1)
    raise RuntimeError(f'no answer satisfying the condition from {url} in {seconds}s: {last}')


def frame(base):
    st, fr, _ = http('GET', f'{base}/frame'); assert st == 200 and fr, (st, fr); return fr


def state_hash_of(path):
    z = np.load(path); h = hashlib.sha256()
    h.update(z['v'].tobytes()); h.update(z['g'].tobytes()); h.update(z['ring'].tobytes()); h.update(z['ref_until'].tobytes()); h.update(np.int64(int(z['t'])).tobytes())
    return h.hexdigest(), int(z['t'])


def stop(proc, seconds=90):
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        for _ in range(seconds * 2):
            if proc.poll() is not None: break
            time.sleep(0.5)
        if proc.poll() is None: proc.kill()
    return proc.returncode


# ------------------------------------------------------------------ the mock agent: a bot made of arithmetic
class MockBot:
    """Plays brain/colony/agent.mjs: integrates the motor frame (turn rad/s, forward 0..1 at 4.3 blocks/s, 5.6 sprinting, back at 1.5) into
    pos / yaw in mineflayer's convention (yaw 0 = north (-z), growing counter-clockwise seen from above; forward = (-sin yaw, -cos yaw)),
    and reports the senses of COLONY.md section 4 at 10 Hz. The bread lies 6 blocks ahead-left of the start; `eat` within 1.5 blocks picks it
    up (`picked` = 5 on that tick, as agent.mjs reports, holdingFood = 5, eating for 1.6 s, then holdingFood = 0: the pickup is the meal, the
    swallow must not count twice). In the zombie phase a zombie walks in from the right at 2.5 blocks/s and hits once at 2 blocks. A passing
    fly #3 is reported 4 blocks away for one second early on."""

    def __init__(self):
        self.pos = [0.0, 64.0, 0.0]; self.yaw = 0.0; self.t0 = time.time()
        self.items = [{'kind': 'bread', 'points': 5, 'x': -6 * math.sin(math.radians(45)), 'z': -6 * math.cos(math.radians(45))}]   # ahead-left of a bot facing north
        self.holding = 0; self.picked = 0; self.eating_until = -1.0; self.zombie = None; self.phase = 'food'; self.hit_at = None; self.hit_sent = False
        self.motor = None; self.motors = []; self.said = []; self.first_eat = None; self.picked_at = None; self.ate_at = None; self.jump_at = None; self.zombie_at = None
        self.frames = 0; self.stop = False; self.connected = False; self.error = ''

    def bearing_of(self, x, z):
        """Relative bearing of a world point, radians, > 0 = on the bot's left."""
        fx, fz = -math.sin(self.yaw), -math.cos(self.yaw); lx, lz = fz, -fx
        dx, dz = x - self.pos[0], z - self.pos[2]
        return math.atan2(dx * lx + dz * lz, dx * fx + dz * fz)

    def senses(self):
        now = time.time() - self.t0; food = []
        for it in self.items:
            dx, dz = it['x'] - self.pos[0], it['z'] - self.pos[2]; food.append({'dx': round(dx, 3), 'dz': round(dz, 3), 'dist': round(math.hypot(dx, dz), 3), 'points': it['points'], 'kind': it['kind']})
        mobs = []; hit = False
        if self.zombie:
            dx, dz = self.zombie[0] - self.pos[0], self.zombie[1] - self.pos[2]; d = math.hypot(dx, dz)
            mobs.append({'dx': round(dx, 3), 'dz': round(dz, 3), 'dist': round(d, 3), 'kind': 'zombie', 'closing': 2.5})
            if d < 2.0 and not self.hit_sent: hit = True; self.hit_sent = True; self.hit_at = now
        flies = [{'id': 3, 'dist': 4.0}] if 2.0 < now < 3.0 else []
        picked, self.picked = self.picked, 0
        return {'t': round(time.time(), 3), 'pos': [round(v, 3) for v in self.pos], 'yaw': round(self.yaw, 4), 'health': 20, 'onGround': True, 'light': 15, 'night': False,
                'food': food, 'mobs': mobs, 'flies': flies, 'eating': now < self.eating_until, 'holdingFood': self.holding, 'picked': picked, 'ate': 0, 'hit': hit}

    def apply(self, m, dt):
        now = time.time() - self.t0
        self.yaw += float(m.get('turn', 0.0)) * dt
        sp = -1.5 if m.get('back') else (5.6 if m.get('sprint') else 4.3) * float(m.get('forward', 0.0))
        self.pos[0] += -math.sin(self.yaw) * sp * dt; self.pos[2] += -math.cos(self.yaw) * sp * dt
        if m.get('eat') and self.items:
            d = min(math.hypot(it['x'] - self.pos[0], it['z'] - self.pos[2]) for it in self.items)
            if self.first_eat is None: self.first_eat = (now, d)
            if d <= 1.5 and self.eating_until < 0: self.items.pop(0); self.holding = 5; self.picked = 5; self.eating_until = now + 1.6; self.picked_at = now
        if self.eating_until > 0 and now >= self.eating_until and self.holding: self.holding = 0; self.eating_until = -1.0; self.ate_at = now
        if self.zombie and self.hit_at is None:
            dx, dz = self.pos[0] - self.zombie[0], self.pos[2] - self.zombie[1]; d = math.hypot(dx, dz)
            if d > 0.3: self.zombie[0] += dx / d * 2.5 * dt; self.zombie[1] += dz / d * 2.5 * dt
        elif self.zombie and self.hit_at is not None and now - self.hit_at > 1.0: self.zombie = None   # it wandered off after the hit
        if self.phase == 'zombie' and self.zombie is None and self.zombie_at is None:
            fx, fz = -math.sin(self.yaw), -math.cos(self.yaw); rx, rz = -fz, fx
            self.zombie = [self.pos[0] + rx * 12, self.pos[2] + rz * 12]; self.zombie_at = now

    async def run(self, url):
        from aiohttp import ClientSession, WSMsgType
        try:
            async with ClientSession() as s:
                async with s.ws_connect(url) as ws:
                    self.connected = True; self.t0 = time.time()

                    async def rx():
                        async for msg in ws:   # every motor message counts: jump / torch / say are one-shots
                            if msg.type == WSMsgType.TEXT:
                                m = json.loads(msg.data); self.motor = m; now = time.time() - self.t0
                                self.motors.append((now, m, self.bearing_of(self.items[0]['x'], self.items[0]['z']) if self.items else None))
                                if m.get('jump') and self.jump_at is None: self.jump_at = now
                                if m.get('say'): self.said.append((round(now, 1), m['say']))
                            else: break
                    task = asyncio.create_task(rx()); last = time.time()
                    while not self.stop and not ws.closed:
                        await asyncio.sleep(0.1); now = time.time(); dt = min(0.3, now - last); last = now
                        if self.motor: self.apply(self.motor, dt)
                        await ws.send_str(json.dumps(self.senses())); self.frames += 1
                    task.cancel()
        except Exception as e:
            self.error = repr(e)[:200]
        self.connected = False


# ------------------------------------------------------------------ part 1: server.py --colony with the mock agent
def test_server():
    port = free_port(); state = os.path.join(TEST_DIR, f'state_colony_{FLY}'); snaps = os.path.join(TEST_DIR, 'snapshots'); os.makedirs(state, exist_ok=True); os.makedirs(snaps, exist_ok=True)
    env = {**os.environ, 'COLONY': '1', 'COLONY_TEST': '1', 'FLY_ID': str(FLY), 'PORT': str(port), 'STATE': state, 'SNAPS': snaps, 'NUMBA_NUM_THREADS': THREADS, 'COLONY_TEST_ENERGY': '600'}
    env.pop('COLONY_TEST_PIN', None)
    logf = open(os.path.join(TEST_DIR, 'colony_server.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py'), '--colony'], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'server.py --colony pid {proc.pid} on {base}, fly #{FLY}, dir {TEST_DIR}', flush=True)
    bot = MockBot(); th = None
    try:
        h = wait_health(f'{base}/health', 300, proc, lambda h: h.get('ok') and h.get('hosting'))
        ok('health ok, hosting fly in the Colony (test mode)', h['ok'] and h['fly'] == FLY and h['colony'] is True and h['test_mode'] is True and h['body'].lower() == open(os.path.join(HERE, 'body_colony.address')).read().strip().lower(), f"agent {h['agent']}")
        t0 = time.time()
        while time.time() - t0 < 90:
            fr = frame(base)
            if fr.get('realtime', 0) > 0 and fr.get('step', 0) > 0: break
            time.sleep(1)
        ok('frame runs in real time before any agent', fr['realtime'] > 0 and fr['agent']['ok'] is False, f"realtime {fr['realtime']} step {fr['step']:,} energy {fr['energy']:.0f}")
        need = ['pos', 'yaw', 'light', 'night', 'mobs', 'foodItems', 'torches', 'mode', 'motor', 'agent', 'flies', 'body', 'rates', 'events', 'energy', 'alive', 'realtime', 'chain']
        missing = [k for k in need if k not in fr]
        ok('frame has the Colony fields', not missing and fr['body'] == 'colony' and 'spikes' not in fr, f'missing={missing}')
        st, r, hd = http('GET', f'{base}/pending_drops'); ok('pending_drops empty', st == 200 and r['drops'] == [] and r['fly'] == FLY)
        # the mock agent joins
        th = threading.Thread(target=lambda: asyncio.run(bot.run(f'ws://127.0.0.1:{port}/agent')), daemon=True); th.start()
        t0 = time.time()
        while time.time() - t0 < 20 and not (bot.connected and bot.motor): time.sleep(0.2)
        ok('agent connected and receives motor frames', bot.connected and bot.motor is not None and all(k in bot.motor for k in ('turn', 'forward', 'sprint', 'back', 'jump', 'eat', 'torch', 'say', 'realtime')), json.dumps(bot.motor))
        fr = frame(base); t_start = fr['t_ms']; budget0 = fr['energy'] + fr['t_ms'] / 1000   # energy + age is conserved except by meals and hits
        h = wait_health(f'{base}/health', 20, proc, lambda h: h['agent']['connected'] and h['agent']['frames'] > 0); ok('health sees the agent', h['agent']['connected'] and h['agent']['frames'] > 0, f"frames {h['agent']['frames']}")
        # 1. the brain surges toward the food
        seen = {'surge': False, 'toward': False, 'forward': False}; t0 = time.time(); fr = None
        while time.time() - t0 < 60:
            fr = frame(base)
            if fr['agent']['ok'] and fr['foodItems']: seen['surge'] |= fr['mode'] == 'surge'
            for w, m, bearing in bot.motors:
                if bearing is not None and m['forward'] > 0: seen['forward'] = True
                if bearing is not None and bearing > math.radians(10) and m['turn'] > 0 and m['forward'] > 0: seen['toward'] = True
            if all(seen.values()) or bot.picked_at is not None: break
            if fr['t_ms'] - t_start > 20_000 and not all(seen.values()): break
            time.sleep(0.3)
        ok('frame sees the bread through the agent', fr['agent']['ok'] and (fr['foodItems'] or bot.picked_at is not None), f"foodItems {fr['foodItems'][:1]} orn {fr['orn']}")
        ok('the brain surges toward the food within 20 s of sim time', all(seen.values()) and fr['t_ms'] - t_start <= 20_000, f"mode surge={seen['surge']}, turn toward the bread with forward>0={seen['toward']}, sim {(fr['t_ms'] - t_start) / 1000:.1f} s")
        # 2. it gets there and eats
        t0 = time.time()
        while time.time() - t0 < 300 and bot.ate_at is None: time.sleep(0.5)
        ok('eat turned on within 1.5 blocks and the bread was picked up', bot.picked_at is not None and bot.first_eat is not None and bot.first_eat[1] <= 2.0, f"first eat at {bot.first_eat[1]:.2f} blocks, picked up at {bot.picked_at:.1f} s wall" if bot.first_eat else 'never ate')
        ok('the meal finished (agent reports holdingFood back to 0)', bot.ate_at is not None, f'{bot.ate_at:.1f} s wall' if bot.ate_at else '')
        time.sleep(2.0); fr = frame(base); budget1 = fr['energy'] + fr['t_ms'] / 1000
        ok('energy rose by the bread\'s 5 points', abs(budget1 - budget0 - 5.0) < 0.6, f'delta {budget1 - budget0:+.2f} s, ate {fr["ate"]}')
        ok('diary: ate, and the speech strip said yum', any('ate bread worth 5s' in e[1] for e in fr['events']) and any(s == 'yum' for _, s in bot.said), f'said {bot.said}')
        ok('a torch was placed once per meal', any(m.get('torch') for _, m, _ in bot.motors) and sum(1 for _, m, _ in bot.motors if m.get('torch')) == 1 and len(fr['torches']) == 1, f"torches {fr['torches']}")
        ok('smelled food / there! in the strip', any(s.startswith('I smell') for _, s in bot.said) and any(s == 'there!' for _, s in bot.said), f'{[s for _, s in bot.said]}')
        ok('met fly #3 once', sum(1 for e in fr['events'] if e[1] == 'met fly #3') == 1, '')
        # 3. a zombie closes from the right
        budget2 = budget1; bot.phase = 'zombie'; t0 = time.time()
        while time.time() - t0 < 30 and (bot.jump_at is None or bot.hit_at is None): time.sleep(0.3)
        fr = frame(base)
        ok('the closing zombie makes the giant fiber fire: a jump within a few seconds', bot.jump_at is not None and bot.jump_at - bot.zombie_at < 12, f'jump {bot.jump_at - bot.zombie_at:.1f} s after the zombie appeared; jumps {fr["jumps"]}' if bot.jump_at else 'no jump')
        ok('a shadow! and jumped! in the strip; events say so', any(s == 'a shadow!' for _, s in bot.said) and any(s == 'jumped!' for _, s in bot.said) and any('giant fiber spike: jumped' in e[1] for e in fr['events']), f'{[s for _, s in bot.said]}')
        ok('the zombie hit landed', bot.hit_at is not None, '')
        time.sleep(2.5); fr = frame(base); budget3 = fr['energy'] + fr['t_ms'] / 1000
        ok('a hit costs 60 s', abs(budget3 - budget2 + 60.0) < 0.6 and fr['hits'] == 1, f'delta {budget3 - budget2:+.2f} s, hits {fr["hits"]}')
        ok('diary: caught, and the strip said ouch', any(e[1].startswith('caught') for e in fr['events']) and any(s == 'ouch' for _, s in bot.said))
        # 4. streams
        frames, ts = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/ws?lite=1', 3))
        ok('ws?lite=1 streams Colony frames', all('pos' in f and 'mode' in f and 'spikes' not in f and 'hdr' not in f for f in frames), f'gaps {[round(b - a, 2) for a, b in zip(ts, ts[1:])]} s')
        full, _ = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/ws', 1)); ok('ws without lite keeps hdr + spikes', 'hdr' in full[0] and 'spikes' in full[0] and 'pos' in full[0]['hdr'])
        st, r, hd = http('GET', f'{base}/frame'); ok('JSON answers carry Access-Control-Allow-Origin: *', hd.get('Access-Control-Allow-Origin') == '*')
        # 5. the feed-drop path (a feed as the chain would report it, in test mode)
        st, r, _ = http('POST', f'{base}/admin/drop', {'seconds': 12, 'by': '0xfeeder'}); ok('test feed becomes a pending drop', st == 200 and r['drop']['bread'] == 3, json.dumps(r['drop']))
        st, r, _ = http('GET', f'{base}/pending_drops'); ok('pending_drops lists it with the bot position', st == 200 and len(r['drops']) == 1 and r['drops'][0]['seconds'] == 12 and isinstance(r['pos'], list), f"pos {r['pos']}")
        st, r2, _ = http('POST', f'{base}/dropped', {'tx': r['drops'][0]['tx'], 'items': 3, 'at': [1, 64, 2]}); ok('dropped clears it', st == 200 and r2['ok'] and r2['left'] == 0)
        st, r3, _ = http('POST', f'{base}/dropped', {'tx': 'nope'}); ok('dropped for an unknown tx -> 404', st == 404)
        time.sleep(0.6); fr = frame(base); ok('diary says the bread was dropped', any('fed 12s' in e[1] and '3 bread' in e[1] for e in fr['events']), fr['events'][-1][1])
        # 6. a checkpoint in test mode: snapshot saved and hashed, sense stream rotated, nothing sent
        st, h, _ = http('GET', f'{base}/health'); sfile = h['senses_file']
        ok('the sense stream is being written', sfile.endswith('senses_0.jsonl') and os.path.exists(sfile) and os.path.getsize(sfile) > 0, sfile)
        t0 = time.time(); st, cp, _ = http('POST', f'{base}/admin/commit'); dt = time.time() - t0
        ok('checkpoint payload (test mode) -> 200', st == 200 and isinstance(cp, dict), f'{dt:.1f} s {str(cp)[:80]}')
        need = ['stateRoot', 'memoryRoot', 'stateURI', 'metadataURI', 'brainStep', 'energy', 'historyRoot', 'interactions', 'age_s', 'spikes', 'generation']
        ok('payload fields', all(k in cp for k in need), json.dumps({k: cp[k] for k in ('stateRoot', 'brainStep', 'energy', 'stateURI')}))
        root = cp['stateRoot']; path = os.path.join(snaps, root[2:] + '.npz'); ok('snapshot saved content-addressed', os.path.exists(path), path)
        hh, step = state_hash_of(path); ok('stateRoot == sha256 of the saved brain state', hh == root[2:] and step == cp['brainStep'], f'step {step:,}')
        hr = hashlib.sha256(json.dumps(cp['interactions'], sort_keys=True).encode()).hexdigest(); kinds = [i['kind'] for i in cp['interactions']]
        ok('historyRoot == sha256(json(interactions))', cp['historyRoot'] == '0x' + hr, f'{kinds}')
        ok('interactions: ate, jumped, caught and met fly #3', {'ate', 'jumped', 'caught', 'met'} <= set(kinds) and any(i['kind'] == 'met' and i['data'] == 'fly #3' for i in cp['interactions']), '')
        ok('nothing was pinned or sent in test mode', cp['stateURI'].startswith('snapshots/') and cp['metadataURI'] == '', cp['stateURI'])
        meta = json.loads(str(np.load(path)['meta']))
        ok('snapshot meta: Colony body, applied log without senses, sense stream named', meta['body'] == 'Colony' and meta['colony'] is True and all(e['kind'] != 'sense' for e in meta['applied']) and meta['senses_file'].endswith('senses_0.jsonl') and 'mc' in meta['world'], f"applied {[e['kind'] for e in meta['applied']]}, senses_lines {meta['senses_lines']}")
        import gzip
        for _ in range(50):   # the finished stream is gzipped in the background right after the rotation
            if os.path.exists(sfile + '.gz') and not os.path.exists(sfile): break
            time.sleep(0.2)
        ok('the finished sense stream is gzipped', os.path.exists(sfile + '.gz') and not os.path.exists(sfile), sfile + '.gz')
        lines = [json.loads(l) for l in gzip.open(sfile + '.gz', 'rt')]
        ok('sense stream lines carry the brain step and the frame', len(lines) > 20 and all('step' in l and 's' in l and 'pos' in l['s'] for l in lines) and lines[-1]['step'] <= cp['brainStep'] and lines[0]['step'] < lines[-1]['step'], f'{len(lines)} frames, steps {lines[0]["step"]:,}..{lines[-1]["step"]:,}')
        time.sleep(1.5); st, h, _ = http('GET', f'{base}/health'); ok('a new sense stream after the checkpoint (no checkpoint at startup)', h['senses_file'].endswith('senses_1.jsonl') and h['checkpoints'] == 1, h['senses_file'])
        st, r, _ = http('GET', f'{base}/final'); ok('final while alive -> 409', st == 409)
        # 6b. the supervisor's public surface in front of this brain: the public paths and one plain snapshot name pass, nothing else does,
        #     and no traversal reaches the brain's local-only routes (the review's `snapshots/../admin/commit` forced a real commit before)
        pp = start_proxy(port, proc); pport = pp['port']
        try:
            st, r, hd = raw('GET', pport, f'/fly/{FLY}/health'); ok('proxy: /health reaches the brain, with CORS', st == 200 and r.get('fly') == FLY and r.get('colony') is True and hd.get('Access-Control-Allow-Origin') == '*', str(r)[:60])
            st, r, _ = raw('GET', pport, f'/fly/{FLY}/frame'); ok('proxy: /frame', st == 200 and r.get('body') == 'colony')
            st, r, _ = raw('GET', pport, f'/fly/{FLY}/state'); ok('proxy: /state', st == 200 and 'hdr' in r)
            fr2, _ = asyncio.run(ws_frames(f'ws://127.0.0.1:{pport}/fly/{FLY}/ws?lite=1', 2)); ok('proxy: /ws?lite=1 streams through', len(fr2) == 2 and fr2[0].get('body') == 'colony')
            snap = cp['stateURI'].split('/')[-1]; st, r, _ = raw('GET', pport, f'/fly/{FLY}/snapshots/{snap}')
            ok('proxy: snapshots/<one plain name> serves the checkpoint bytes', st == 200 and isinstance(r, bytes) and len(r) == os.path.getsize(path), f'{snap}: {len(r) if isinstance(r, bytes) else r} bytes')
            st, r, _ = raw('GET', pport, f'/fly/{FLY}/snapshots/'); ok('proxy: the snapshots index is served', st == 200 and isinstance(r, bytes) and snap.encode() in r)
            st, r, _ = http('POST', f'{base}/admin/drop', {'seconds': 5}); tx = r['drop']['tx']; payload = json.dumps({'tx': tx}).encode()
            st, h0, _ = http('GET', f'{base}/health'); ok('before the attack: one checkpoint, one pending drop', h0['checkpoints'] == 1 and h0['pending_drops'] == 1)
            bad = [('POST', f'/fly/{FLY}/snapshots/../admin/commit'), ('GET', f'/fly/{FLY}/snapshots/../admin/commit'), ('POST', f'/fly/{FLY}/snapshots/%2e%2e/admin/commit'), ('POST', f'/fly/{FLY}/snapshots/%2E%2E/admin/commit'),
                   ('POST', f'/fly/{FLY}/snapshots/%252e%252e/admin/commit'), ('POST', f'/fly/{FLY}/snapshots/x/../../admin/commit'), ('POST', f'/fly/{FLY}/snapshots/..%2Fadmin%2Fcommit'), ('POST', f'/fly/{FLY}/snapshots/..%5Cadmin/commit'),
                   ('GET', f'/fly/{FLY}/snapshots/../pending_drops'), ('POST', f'/fly/{FLY}/snapshots/../dropped'), ('POST', f'/fly/{FLY}/snapshots/../admin/drop'), ('GET', f'/fly/{FLY}/snapshots/../agent'), ('GET', f'/fly/{FLY}/snapshots/../final'),
                   ('GET', f'/fly/{FLY}/snapshots/..'), ('GET', f'/fly/{FLY}/snapshots/../'), ('GET', f'/fly/{FLY}/snapshots/./health'), ('GET', f'/fly/{FLY}/snapshots/a/b.npz'), ('GET', f'/fly/{FLY}/health/../pending_drops'), ('GET', f'/fly/{FLY}/frame/'),
                   ('GET', f'/fly/{FLY}/view/../../../pending_drops'), ('GET', f'/fly/{FLY}/view/%2e%2e/%2e%2e/%2e%2e/pending_drops'), ('POST', f'/view/../fly/{FLY}/snapshots/../admin/commit'),
                   ('POST', f'/fly/{FLY}/admin/commit'), ('POST', f'/fly/{FLY}/admin/drop'), ('GET', f'/fly/{FLY}/pending_drops'), ('POST', f'/fly/{FLY}/dropped'), ('GET', f'/fly/{FLY}/agent'), ('GET', f'/fly/{FLY}/final'), ('GET', f'/fly/{FLY}/'), ('GET', f'/fly/{FLY}/Health')]
            for meth, pth in bad:
                st, r, hd = raw(meth, pport, pth, body=payload)
                ok(f'proxy refuses {meth} {pth}', st == 404 and isinstance(r, dict) and r.get('error') == 'not a public path' and hd.get('Access-Control-Allow-Origin') == '*', f'{st} {str(r)[:80]}')
            time.sleep(1.0); st, h1, _ = http('GET', f'{base}/health'); st, d1, _ = http('GET', f'{base}/pending_drops')
            ok('the brain saw none of it: still one checkpoint, the drop still pending, the agent still the mock bot', h1['checkpoints'] == 1 and h1['pending_drops'] == 1 and d1['drops'][0]['tx'] == tx and bot.connected and h1['agent']['connected'], f"checkpoints {h1['checkpoints']} drops {h1['pending_drops']}")
            # the second line: the brain refuses a local-only route that carries a forwarding header, even from 127.0.0.1 (the proxy marks everything it forwards)
            for meth, pth, hdrs in (('GET', '/pending_drops', {'X-Forwarded-For': '203.0.113.7'}), ('POST', '/admin/commit', {'X-Forwarded-For': '203.0.113.7'}), ('POST', '/dropped', {'X-Real-IP': '203.0.113.7'}), ('POST', '/admin/drop', {'Forwarded': 'for=203.0.113.7'}), ('GET', '/final', {'Cf-Connecting-Ip': '203.0.113.7'})):
                st, r, _ = raw(meth, port, pth, body=payload, headers=hdrs); ok(f'brain refuses forwarded {meth} {pth} -> 403', st == 403 and r.get('error') == 'local only', f'{st} {str(r)[:60]}')
            st, r, _ = raw('GET', port, '/pending_drops'); ok('brain still answers the same route unforwarded', st == 200 and len(r['drops']) == 1)
            st, h2, _ = http('GET', f'{base}/health'); ok('no checkpoint was forced', h2['checkpoints'] == 1)
            st, r, _ = http('POST', f'{base}/dropped', {'tx': tx, 'items': 1}); ok('the test drop cleared afterwards', st == 200 and r['left'] == 0)
        finally:
            pp['stop']()
        # 7. SIGTERM save and restart
        bot.stop = True; time.sleep(0.5); fr = frame(base); last_step = fr['step']
        rc = stop(proc); ok('SIGTERM exits', rc is not None, f'rc {rc}')
        latest = json.load(open(os.path.join(state, 'latest.json')))
        ok('state saved on SIGTERM with the Minecraft-side state', latest['tag'] == 'shutdown' and latest['colony'] is True and latest['brain_step'] >= last_step and latest['senses_n'] == 1 and latest['world']['mc']['torches'] == fr['torches'] and latest['world']['mc']['meetings'] == {'3': latest['world']['mc']['meetings'].get('3')}, f"step {latest['brain_step']:,} torches {latest['world']['mc']['torches']}")
        proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py'), '--colony'], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
        h = wait_health(f'{base}/health', 300, proc, lambda h: h.get('ok') and h.get('hosting')); t0 = time.time()
        while time.time() - t0 < 90:
            fr = frame(base)
            if fr.get('realtime', 0) > 0: break
            time.sleep(1)
        ok('restart continues the local state (torches, hits, meal kept)', fr['step'] >= latest['brain_step'] and fr['realtime'] > 0 and fr['torches'] == latest['world']['mc']['torches'] and fr['hits'] == 1 and fr['ate'] == 5.0, f"step {fr['step']:,} >= {latest['brain_step']:,}, senses file {h['senses_file'][-16:]}")
        ok('the sense stream continues in the checkpoint\'s interval (file opened at the first frame)', h['senses_n'] == 1 and h['senses_file'] == '', f"senses_n {h['senses_n']}")
        stop(proc)
    finally:
        bot.stop = True; stop(proc); logf.close()
        print('--- colony_server.log (tail) ---'); print(''.join(open(os.path.join(TEST_DIR, 'colony_server.log'), errors='replace').readlines()[-25:]))


def test_death():
    port = free_port(); state = os.path.join(TEST_DIR, f'death_state_{FLY}'); snaps = os.path.join(TEST_DIR, 'snapshots'); os.makedirs(state, exist_ok=True); os.makedirs(snaps, exist_ok=True)
    env = {**os.environ, 'COLONY': '1', 'COLONY_TEST': '1', 'FLY_ID': str(FLY), 'PORT': str(port), 'STATE': state, 'SNAPS': snaps, 'NUMBA_NUM_THREADS': THREADS, 'COLONY_TEST_ENERGY': '5'}
    logf = open(os.path.join(TEST_DIR, 'colony_death.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py'), '--colony'], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'server.py --colony pid {proc.pid} on {base}, fly #{FLY} with 5 s of energy (test override)', flush=True)
    try:
        wait_health(f'{base}/health', 300, proc, lambda h: h.get('ok') and h.get('hosting'))
        t0 = time.time(); fr = None
        while time.time() - t0 < 120:
            fr = frame(base)
            if fr['alive'] is False: break
            time.sleep(0.5)
        time.sleep(1.5); fr2 = frame(base)
        ok('frame says dead once the energy is gone', fr['alive'] is False and fr['energy'] == 0 and fr2['alive'] is False and fr2['realtime'] == 0.0, f"age {fr['t_ms'] / 1000:.1f} s, last diary line {fr['events'][-1][1]!r}")
        h = wait_health(f'{base}/health', 120, proc, lambda h: h.get('final_ready')); ok('health: dead, final payload ready', h['alive'] is False and h['final_ready'] is True and h['dead_since'])
        st, fp, _ = http('GET', f'{base}/final'); ok('final -> 200', st == 200, f"cause {fp.get('cause')!r}")
        need = ['stateRoot', 'memoryRoot', 'stateURI', 'metadataURI', 'brainStep', 'energy', 'historyRoot', 'interactions', 'age_s', 'spikes', 'generation', 'cause']
        ok('final payload fields, cause starved in the Colony, energy 0, not reported', all(k in fp for k in need) and fp['energy'] == 0 and fp['cause'] == 'starved in the Colony' and fp['reported'] is False, json.dumps({k: fp[k] for k in ('stateRoot', 'brainStep', 'energy', 'stateURI')}))
        path = os.path.join(snaps, fp['stateRoot'][2:] + '.npz'); hh, step = state_hash_of(path)
        ok('death snapshot saved and hashed', hh == fp['stateRoot'][2:] and step == fp['brainStep'], f'step {step:,}')
        st, r, _ = http('POST', f'{base}/admin/commit'); ok('checkpoint after death -> 409', st == 409, str(r))
        ok('final.json kept for a restart', os.path.exists(os.path.join(state, 'final.json')))
    finally:
        stop(proc); logf.close()
        print('--- colony_death.log (tail) ---'); print(''.join(open(os.path.join(TEST_DIR, 'colony_death.log'), errors='replace').readlines()[-12:]))


# ------------------------------------------------------------------ part 2: the supervisor
def test_supervisor():
    os.environ.setdefault('COLONY_NO_PAPER', '1')
    import colony
    C = '0x95187D9dBaF262aB3e1de52b71a20Ef171aEb3c5'; A = '0x47005543c06246124480D196a275327325695BEd'; Z = '0x' + '0' * 40
    mk = lambda i, alive, body, pending=Z: {'id': i, 'alive': alive, 'body': body, 'pendingBody': pending}
    recs = {1: mk(1, True, A), 2: mk(2, True, Z), 3: mk(3, True, C), 4: mk(4, True, C.lower()), 5: mk(5, False, C), 6: mk(6, True, Z, C), 7: mk(7, True, Z, C.lower()), 8: mk(8, True, C), 9: mk(9, True, A, C), 10: mk(10, False, Z, C)}
    s = colony.select_flies(recs, C, 6); ok('selection: body == Colony hosted, pending == Colony accepted, dead and others out', s['host'] == [3, 4, 8] and s['accept'] == [6, 7, 9] and s['queue'] == [], json.dumps(s))
    s = colony.select_flies(recs, C, 4, running=[8]); ok('cap 4: running first, then by id, one pending accepted, the rest queued', s['host'] == [8, 3, 4] and s['accept'] == [6] and [i for i, _ in s['queue']] == [7, 9] and all('slot' in w for _, w in s['queue']), json.dumps(s))
    s = colony.select_flies(recs, C, 2, running=[4, 99]); ok('cap 2: ours before pending; queue names the reason', s['host'] == [4, 3] and s['accept'] == [] and [i for i, _ in s['queue']] == [8, 6, 7, 9] and s['queue'][1][1].startswith('assigned'), json.dumps(s))
    s = colony.select_flies(recs, C, 0); ok('cap 0: nothing hosted, everything queued', s['host'] == [] and s['accept'] == [] and len(s['queue']) == 6)
    s = colony.select_flies({}, C, 6); ok('empty registry', s == {'host': [], 'accept': [], 'queue': []})
    # the RCON config parser
    d = os.path.join(TEST_DIR, 'server'); os.makedirs(d, exist_ok=True); colony.SERVER_DIR = d
    ok('rcon: none configured -> None', colony.rcon_config() is None)
    open(os.path.join(d, 'server.properties'), 'w').write('enable-rcon=true\nrcon.port=25599\nrcon.password=pw-props\nserver-port=25566\n')
    c = colony.rcon_config(); ok('rcon: server.properties', c['port'] == 25599 and c['password'] == 'pw-props' and c['mc_port'] == 25566 and colony.mc_port() == 25566)
    open(os.path.join(d, 'rcon.txt'), 'w').write('pw-txt\n'); c = colony.rcon_config(); ok('rcon.txt: bare password overrides', c['password'] == 'pw-txt' and c['port'] == 25599)
    open(os.path.join(d, 'rcon.txt'), 'w').write('RCON_PORT=25600\nRCON_PASSWORD=pw-kv\n'); c = colony.rcon_config(); ok('rcon.txt: key=value', c['password'] == 'pw-kv' and c['port'] == 25600)
    open(os.path.join(d, 'rcon.txt'), 'w').write(json.dumps({'host': '127.0.0.1', 'port': 25601, 'password': 'pw-json'})); c = colony.rcon_config(); ok('rcon.txt: json', c['password'] == 'pw-json' and c['port'] == 25601)
    os.remove(os.path.join(d, 'rcon.txt')); os.remove(os.path.join(d, 'server.properties'))
    # the public-path rule of the proxy: exact public names, `snapshots/` plus one plain file name, nothing a URL library could collapse
    good = {'frame': 'frame', 'ws': 'ws', 'state': 'state', 'health': 'health', 'snapshots': 'snapshots/', 'snapshots/': 'snapshots/', 'snapshots/9ab6c2ab.npz': 'snapshots/9ab6c2ab.npz', 'snapshots/a-b_c.9.json': 'snapshots/a-b_c.9.json'}
    for k, v in good.items(): ok(f'public_path({k!r}) -> {v!r}', colony.public_path(k) == v, repr(colony.public_path(k)))
    bad = ['', '/', 'health/', 'frame/x', 'Health', 'admin/commit', 'admin/drop', 'admin', 'agent', 'pending_drops', 'dropped', 'final', 'sense', 'checkpoint', 'snapshots/..', 'snapshots/../', 'snapshots/../admin/commit', 'snapshots/./health',
           'snapshots/a/../../agent', 'snapshots/a/b.npz', 'snapshots/%2e%2e/agent', 'snapshots/%2E%2E/agent', 'snapshots/a%2Fb', 'snapshots/..\\agent', 'snapshots/.hidden', 'snapshots/-x', 'snapshots/a b', 'snapshots/' + 'a' * 129, 'Snapshots/x', 'snapshotsx/y', 'snapshots//x', '../health', './health']
    for k in bad: ok(f'public_path({k!r}) -> None', colony.public_path(k) is None, repr(colony.public_path(k)))
    ok('clean_path: dot segments, %, \\ refused; plain viewer paths pass', all(not colony.clean_path(x) for x in ('..', 'a/..', 'view/../x', 'view/./x', 'view/%2e%2e', 'view/a\\..', '%')) and all(colony.clean_path(x) for x in ('', 'view', 'view/', 'view/socket.io/', 'view/textures/1.21.1.png', 'fly/2/view/index.js')))
    # the camera / ALLOW_PLAYERS whitelist: retried every scan until RCON answers (Paper boots after start_paper() returns; this was a one-shot before)
    calls = []; answer = {'r': None}
    async def fake_rcon_write(cmd, timeout=6.0): calls.append(cmd); return answer['r']
    real_rcon_write = colony.rcon_write; colony.rcon_write = fake_rcon_write
    try:
        cam = colony.CAMERA_NAME; colony.allow['pending'] = [cam, 'pete']; colony.allow['done'] = []; colony.world['server'] = False
        asyncio.run(colony.whitelist_allowed()); ok('whitelist: nothing tried while RCON has not answered', calls == [] and colony.allow['pending'] == [cam, 'pete'])
        ok('camera not due before its name is in', not colony.camera_due())
        colony.world['server'] = True; asyncio.run(colony.whitelist_allowed()); ok('whitelist: the write failed -> both names still pending', calls == [f'whitelist add {cam}'] and colony.allow['pending'] == [cam, 'pete'] and colony.allow['done'] == [])
        asyncio.run(colony.whitelist_allowed()); ok('whitelist: tried again on the next scan', calls == [f'whitelist add {cam}'] * 2)
        answer['r'] = f'Added {cam} to the whitelist'; asyncio.run(colony.whitelist_allowed())
        ok('whitelist: once RCON answers every pending name is added', calls[2:] == [f'whitelist add {cam}', 'whitelist add pete'] and colony.allow['pending'] == [] and colony.allow['done'] == [cam, 'pete'], str(calls))
        asyncio.run(colony.whitelist_allowed()); ok('whitelist: done means no more writes', len(calls) == 4)
        colony.NO_PAPER = False; ok('camera due once whitelisted, the world up and no camera process', colony.camera_due()); colony.NO_PAPER = True; ok('camera never due under COLONY_NO_PAPER', not colony.camera_due())
        colony.rewhitelist(); ok('a Paper restart makes every name pending again', colony.allow['pending'] == colony.ALLOW_NAMES and colony.allow['done'] == [] and colony.ALLOW_NAMES[0] == colony.CAMERA_NAME)
    finally:
        colony.rcon_write = real_rcon_write; colony.world['server'] = False; colony.allow['pending'] = list(colony.ALLOW_NAMES); colony.allow['done'] = []
    # a short run of colony.py: no Paper server, no sends, nothing hosted (fly #2 is nobody's), the proxy and CORS
    port = free_port(); root = os.path.join(TEST_DIR, 'super'); os.makedirs(root, exist_ok=True)
    env = {**os.environ, 'COLONY_PORT': str(port), 'STATE_ROOT': root, 'SNAPS': os.path.join(TEST_DIR, 'snapshots'), 'LOG_DIR': root, 'SCAN_EVERY': '5', 'COLONY_NO_PAPER': '1', 'COLONY_ONLY_IDS': str(FLY), 'NUMBA_NUM_THREADS': THREADS}
    for k in ('ANNOUNCE', 'COLONY_SEND', 'PUBLIC_URL'): env.pop(k, None)
    logf = open(os.path.join(root, 'colony_super.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'colony', 'colony.py')], cwd=os.path.join(HERE, 'colony'), env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'colony.py pid {proc.pid} on {base} (no Paper server, no sends, only fly #{FLY} considered)', flush=True)
    try:
        t0 = time.time(); st = None
        while time.time() - t0 < 120:
            if proc.poll() is not None: raise RuntimeError(f'colony.py exited with {proc.returncode}')
            try:
                st, cs, hd = http('GET', f'{base}/colony/state', timeout=5)
                if st == 200 and cs['scan']['at'] > 0: break
            except Exception: pass
            time.sleep(1)
        ok('/colony/state answers after a registry scan', st == 200 and cs['flies'] == [] and cs['max_flies'] == 6 and cs['colony'].lower() == C.lower() and 'world' in cs and 'queue' in cs and cs['scan']['total'] >= FLY, f"scan total {cs['scan']['total']}, world {cs['world']}")
        ok('/colony/state has CORS', hd.get('Access-Control-Allow-Origin') == '*')
        st, r, hd = http('GET', f'{base}/fly/{FLY}/health'); ok('proxy for a fly not hosted -> 502 with CORS', st == 502 and hd.get('Access-Control-Allow-Origin') == '*', str(r))
        st, r, hd = raw('GET', port, f'/fly/{FLY}/snapshots/abc.npz'); ok('a plain snapshot name for a fly not hosted -> 502', st == 502, str(r))
        for meth, pth in (('POST', f'/fly/{FLY}/snapshots/../admin/commit'), ('GET', f'/fly/{FLY}/snapshots/%2e%2e/pending_drops'), ('POST', f'/fly/{FLY}/admin/commit'), ('GET', f'/fly/{FLY}/agent'), ('GET', f'/fly/{FLY}/view/../../agent'), ('GET', '/view/../fly/2/agent')):
            st, r, hd = raw(meth, port, pth); ok(f'supervisor refuses {meth} {pth} -> 404 before the child lookup', st == 404 and r.get('error') == 'not a public path' and hd.get('Access-Control-Allow-Origin') == '*', f'{st} {str(r)[:60]}')
        st, r, hd = http('GET', f'{base}/view/'); ok('camera viewer proxy without a viewer -> 502', st == 502, str(r)[:60])
        req = urllib.request.Request(f'{base}/colony/state', method='OPTIONS')
        with urllib.request.urlopen(req, timeout=5) as r: ok('OPTIONS preflight -> 204 with CORS', r.status == 204 and r.headers.get('Access-Control-Allow-Origin') == '*')
        logt = open(os.path.join(root, 'colony_super.log'), errors='replace').read()
        ok('log: no Paper server started, no RCON writes, sends off, no accept sent', 'sends off' in logt and 'accepted fly' not in logt and 'run_server.sh start' not in logt and 'whitelisted' not in logt and 'spectator' not in logt and 'camera started' not in logt)
        ok('/colony/state says the camera is not whitelisted yet', cs['world'].get('camera_whitelisted') is False and cs['world'].get('camera') is False, str(cs['world']))
        rc = stop(proc, 120); ok('colony.py SIGTERM exits', rc is not None, f'rc {rc}')
    finally:
        stop(proc, 120); logf.close()
        print('--- colony_super.log ---'); print(open(os.path.join(root, 'colony_super.log'), errors='replace').read()[-1500:])


if __name__ == '__main__':
    t0 = time.time()
    try:
        if not NO_SERVER: test_server()
        if not NO_DEATH: test_death()
        if not NO_SUPER: test_supervisor()
    except Exception as e:
        print(f'\nFAILED after {len(passed)} checks: {e!r}', flush=True); sys.exit(1)
    print(f'\nALL {len(passed)} CHECKS PASSED in {time.time() - t0:.0f} s (scratch dir {TEST_DIR})', flush=True)
