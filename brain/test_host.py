"""Tests for the brain host (brain/HOST_PROTOCOL.md). Mainnet is only read; no transaction is ever sent.

Part 1 starts server.py as a remote body in TEST mode for fly #2 (a genesis fly) on a scratch port with scratch
STATE/SNAPS, the body check overridden to a throwaway key generated here, and exercises /health, /frame, /ws?lite=1,
/sense, the auth, /checkpoint (a real snapshot is pinned to IPFS), /final, the SIGTERM save and restart, verify.py across two
consecutive checkpoints whose interval contains pebble senses, and (with a test-only starting energy) the death, its /final payload and a
restart while the death is still unreported (the fly must stay dead and /final must still answer). Part 2 starts flyhost.py (no ANNOUNCE)
restricted to one real pebble-bodied fly and checks the supervisor, the HTTP and WebSocket proxy and the shutdown.

    ../.venv/bin/python test_host.py [--no-host] [--no-verify] [--only-host]      (TEST_DIR=… to choose the scratch directory)
"""
import os, sys, json, time, socket, signal, subprocess, hashlib, asyncio, tempfile, urllib.request, urllib.error, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from web3 import Web3
from eth_account import Account
from registry import Registry

PY = sys.executable; FLY = int(os.environ.get('TEST_FLY_ID', '2')); HOST_FLY = int(os.environ.get('TEST_HOST_FLY_ID', '65')); THREADS = os.environ.get('TEST_THREADS', '8')
TEST_DIR = os.environ.get('TEST_DIR') or tempfile.mkdtemp(prefix='flyhost_test_')
NO_HOST = '--no-host' in sys.argv; NO_VERIFY = '--no-verify' in sys.argv; ONLY_HOST = '--only-host' in sys.argv
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
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode(errors='replace')


def sign(acct, fid, ts=None):
    ts = int(time.time()) if ts is None else ts
    sig = acct.unsafe_sign_hash(Web3.keccak(text=f'flyhost|{fid}|{ts}')).signature.hex()
    return {'X-Fly-Ts': str(ts), 'X-Fly-Sig': sig if sig.startswith('0x') else '0x' + sig}


async def ws_frames(url, n, timeout=20):
    from aiohttp import ClientSession
    out = []; t = []
    async with ClientSession() as s:
        async with s.ws_connect(url) as ws:
            while len(out) < n:
                m = await asyncio.wait_for(ws.receive(), timeout); out.append(json.loads(m.data)); t.append(time.time())
    return out, t


def wait_health(url, seconds, proc=None, want_ok=True):
    t0 = time.time(); last = None
    while time.time() - t0 < seconds:
        if proc is not None and proc.poll() is not None: raise RuntimeError(f'process exited with {proc.returncode}')
        try:
            st, h = http('GET', url, timeout=5); last = (st, h)
            if isinstance(h, dict) and (h.get('ok') or not want_ok): return h
        except Exception as e: last = repr(e)[:80]
        time.sleep(1)
    raise RuntimeError(f'no healthy answer from {url} in {seconds}s: {last}')


def frame_until(base, cond, seconds=5):
    """The next frame that satisfies `cond` (the sim publishes a frame every 100 ms of biology, so a sense shows up a beat later)."""
    t0 = time.time()
    while True:
        st, fr = http('GET', f'{base}/frame')
        if st == 200 and fr and cond(fr) or time.time() - t0 > seconds: return fr
        time.sleep(0.1)


def state_hash_of(path):
    """What brain.state_hash() is for the arrays saved in a snapshot: the registry's stateRoot."""
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


# ------------------------------------------------------------------ part 1: server.py as a remote body
def test_server():
    key = Account.create(); other = Account.create(); port = free_port()
    state = os.path.join(TEST_DIR, f'state_{FLY}'); snaps = os.path.join(TEST_DIR, 'snapshots'); os.makedirs(state, exist_ok=True); os.makedirs(snaps, exist_ok=True)
    env = {**os.environ, 'REMOTE_BODY': '1', 'REMOTE_BODY_TEST': '1', 'FLY_ID': str(FLY), 'BODY_ADDR': key.address, 'FLYHOST_TEST_BODY': key.address, 'PORT': str(port), 'STATE': state, 'SNAPS': snaps, 'NUMBA_NUM_THREADS': THREADS}
    logf = open(os.path.join(TEST_DIR, 'server_test.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py')], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'server.py pid {proc.pid} on {base}, fly #{FLY}, test body {key.address}, dir {TEST_DIR}', flush=True)
    paths = []
    try:
        h = wait_health(f'{base}/health', 240, proc)
        ok('health ok', h['ok'] and h['fly'] == FLY and h['body'].lower() == key.address.lower() and h['test_mode'] is True, f"alive={h['alive']} hosting={h['hosting']}")
        t0 = time.time(); fr = None
        while time.time() - t0 < 90:
            st, fr = http('GET', f'{base}/frame'); assert st == 200
            if fr and fr.get('realtime', 0) > 0 and fr.get('step', 0) > 0: break
            time.sleep(1)
        fields = ['t_ms', 'step', 'x', 'y', 'heading', 'energy', 'alive', 'generation', 'life_ms', 'spikes_total', 'ate', 'jumps', 'hits', 'food', 'predator', 'lamp', 'arena', 'rates', 'steer', 'mode', 'orn', 'events', 'wall', 'realtime', 'chain', 'nrender', 'puffs']
        missing = [k for k in fields if k not in fr]
        ok('frame has the protocol fields', not missing and 'spikes' not in fr, f'missing={missing}')
        ok('frame realtime > 0', fr['realtime'] > 0 and fr['step'] > 0, f"realtime {fr['realtime']} step {fr['step']:,} energy {fr['energy']:.0f} gen {fr['generation']} mode {fr['mode']}")
        for k in ('DNa02_left', 'DNa02_right', 'ALPN', 'KC', 'MBON', 'LC4_left', 'GRN_labellar', 'DNp01_left', 'MDN_left'): assert k in fr['rates'], k
        ok('frame rates cover the regions the pebble draws', True)
        frames, ts = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/ws?lite=1', 3))
        gaps = [round(b - a, 2) for a, b in zip(ts, ts[1:])]
        ok('ws?lite=1 gives hdr-only frames', all('t_ms' in f and 'spikes' not in f and 'hdr' not in f for f in frames), f'3 frames, gaps {gaps} s')
        full, _ = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/ws', 1))
        ok('ws without lite keeps the arena shape', 'hdr' in full[0] and 'spikes' in full[0])
        # senses
        st, r = http('POST', f'{base}/sense', {'kind': 'landmark', 'side': 'left'}); ok('sense unsigned -> 403', st == 403, str(r))
        st, r = http('POST', f'{base}/sense', {'kind': 'landmark', 'side': 'left'}, sign(key, FLY)); ok('sense landmark left', st == 200 and r['ok'], r.get('effect'))
        fr = frame_until(base, lambda f: f['puffs']); p = fr['puffs']
        ok('frame shows the puff', len(p) == 1 and all(k in p[0] for k in ('x', 'y', 'strength', 'expires_ms')), json.dumps(p))
        hx, hy = math.cos(fr['heading']), math.sin(fr['heading']); lx, ly = -hy, hx; dx, dy = p[0]['x'] - fr['x'], p[0]['y'] - fr['y']
        ok('puff is on the fly\'s left, ~40 body lengths', dx * lx + dy * ly > 20 and abs(math.hypot(dx, dy) - 40) < 8, f'left-dot {dx * lx + dy * ly:.1f} dist {math.hypot(dx, dy):.1f}')
        st, r = http('POST', f'{base}/sense', {'kind': 'shock', 'side': 'right'}, sign(key, FLY)); ok('second sense within 1 s dropped', st == 429 and r['ok'] is False, str(r))
        time.sleep(1.1)
        st, r = http('POST', f'{base}/sense', {'kind': 'shock', 'side': 'right'}, sign(key, FLY)); ok('sense shock right', st == 200 and r['ok'], r.get('effect'))
        fr = frame_until(base, lambda f: f['predator']); pr = fr['predator']
        ok('frame shows the predator', pr is not None and 'x' in pr and 'size' in pr, json.dumps(pr))
        if r['effect'].startswith('a predator is already'): print('  --  the world had spawned its own predator already; side check skipped')
        else:
            hx, hy = math.cos(fr['heading']), math.sin(fr['heading']); rx, ry = hy, -hx; dx, dy = pr['x'] - fr['x'], pr['y'] - fr['y']
            ok('predator came from the right, ~0.7 arena away', dx * rx + dy * ry > 0 and abs(math.hypot(dx, dy) - 0.7 * fr['arena']) < 30, f'dist {math.hypot(dx, dy):.0f}')
        time.sleep(1.1)
        st, r = http('POST', f'{base}/sense', {'kind': 'cue', 'wedge': 4}, sign(key, FLY)); ok('sense cue wedge 4', st == 200 and r['ok'], r.get('effect'))
        st, r = http('POST', f'{base}/sense', {'kind': 'turn', 'deg': -35.0}, sign(key, FLY)); ok('sense turn accepted (ignored)', st == 200 and r['ok'], r.get('effect'))
        time.sleep(1.1)
        st, r = http('POST', f'{base}/sense', {'kind': 'bogus'}, sign(key, FLY)); ok('unknown sense -> 400', st == 400, str(r))
        # auth on /checkpoint
        st, r = http('GET', f'{base}/checkpoint'); ok('checkpoint unsigned -> 403', st == 403 and r.get('error') == 'not the body', str(r))
        st, r = http('GET', f'{base}/checkpoint', headers=sign(other, FLY)); ok('checkpoint signed by another key -> 403', st == 403, str(r))
        st, r = http('GET', f'{base}/checkpoint', headers=sign(key, FLY, int(time.time()) - 300)); ok('checkpoint with a stale timestamp -> 403', st == 403, str(r))
        st, r = http('GET', f'{base}/checkpoint', headers=sign(key, FLY + 1)); ok('checkpoint signed for another fly id -> 403', st == 403, str(r))
        t0 = time.time(); st, cp = http('GET', f'{base}/checkpoint', headers=sign(key, FLY)); dt = time.time() - t0
        ok('checkpoint signed correctly -> 200', st == 200, f'{dt:.1f} s')
        need = ['stateRoot', 'memoryRoot', 'stateURI', 'metadataURI', 'brainStep', 'energy', 'historyRoot', 'interactions', 'age_s', 'spikes', 'generation']
        ok('checkpoint payload fields', all(k in cp for k in need), json.dumps({k: cp[k] for k in need if k != 'interactions'}))
        ok('stateURI and metadataURI are ipfs://', cp['stateURI'].startswith('ipfs://') and cp['metadataURI'].startswith('ipfs://'))
        root = cp['stateRoot']; ok('stateRoot is 0x + 32 bytes', root.startswith('0x') and len(root) == 66)
        path = os.path.join(snaps, root[2:] + '.npz'); ok('snapshot saved content-addressed', os.path.exists(path), path)
        h, step = state_hash_of(path); ok('stateRoot == sha256 of the saved state', h == root[2:] and step == cp['brainStep'], f'step {step:,}')
        hr = hashlib.sha256(json.dumps(cp['interactions'], sort_keys=True).encode()).hexdigest()
        ok('historyRoot == sha256(json(interactions))', cp['historyRoot'] == '0x' + hr, f"{len(cp['interactions'])} interactions: {[i['kind'] for i in cp['interactions']]}")
        ok('interactions carry only ate/jumped/caught', all(i['kind'] in ('ate', 'jumped', 'caught') for i in cp['interactions']))
        ok('energy and generation match the world', cp['generation'] == fr['generation'] and fr['energy'] - 200 < cp['energy'] <= fr['energy'] + 1, f"energy {cp['energy']} (frame had {fr['energy']:.0f})")
        st, r = http('GET', f'{base}/state'); ok('/state like the arena', st == 200 and all(k in r for k in ('hdr', 'log', 'frame_age_s')))
        # the pinned metadata says what is being committed
        try:
            m = json.load(urllib.request.urlopen(urllib.request.Request(f"https://gateway.pinata.cloud/ipfs/{cp['metadataURI'][7:]}", headers={'User-Agent': 'curl/8'}), timeout=60))
            attrs = {a['trait_type']: a['value'] for a in m['attributes']}
            ok('metadata carries the committed state and the pebble body', attrs['Brain step'] == cp['brainStep'] and attrs['Status'] == 'alive' and attrs['Body'].startswith('pebble') and root[2:12] in m['description'], f"Body={attrs['Body']!r} step={attrs['Brain step']:,}")
        except Exception as e: print('  --  metadata gateway read skipped:', repr(e)[:100])
        paths.append(path)
        st, r = http('GET', f'{base}/final', headers=sign(key, FLY)); ok('final while alive -> 409', st == 409, str(r))
        st, r = http('GET', f'{base}/final'); ok('final unsigned -> 403', st == 403)
        # senses inside the interval: the verifier must replay them (a puff is always recorded; a predator when none is about)
        time.sleep(1.1)
        st, r = http('POST', f'{base}/sense', {'kind': 'cue', 'wedge': 9}, sign(key, FLY)); ok('sense cue inside the checkpoint interval', st == 200 and r['ok'], r.get('effect'))
        time.sleep(1.1)
        st, r = http('POST', f'{base}/sense', {'kind': 'shock', 'side': 'left'}, sign(key, FLY)); ok('sense shock inside the checkpoint interval', st == 200 and r['ok'], r.get('effect'))
        time.sleep(4)
        st, cp2 = http('GET', f'{base}/checkpoint', headers=sign(key, FLY)); ok('second checkpoint', st == 200 and cp2['brainStep'] > cp['brainStep'] and cp2['stateRoot'] != root, f"step {cp['brainStep']:,} -> {cp2['brainStep']:,}")
        paths.append(os.path.join(snaps, cp2['stateRoot'][2:] + '.npz'))
        ma, mb = (json.loads(str(np.load(q)['meta'])) for q in paths)
        ev = [e for e in mb['applied'] if ma['applied_seq'] < e['seq'] <= mb['applied_seq']]
        ok('checkpoint 2 records the interval\'s senses for the verifier', 'puff' in [e['kind'] for e in ev] and all(ma['brain_step'] <= e['brain_step'] <= mb['brain_step'] for e in ev) and 'seq' in mb['applied'][-1], f"{[(e['kind'], e['brain_step']) for e in ev]}")
        st, fr = http('GET', f'{base}/frame'); last_step = fr['step']
        rc = stop(proc); ok('SIGTERM exits', rc is not None, f'rc {rc}')
        latest = json.load(open(os.path.join(state, 'latest.json')))
        ok('state saved on SIGTERM', latest['tag'] == 'shutdown' and os.path.exists(os.path.join(state, 'local.npz')) and latest['brain_step'] >= last_step and latest['fly_id'] == FLY, f"step {latest['brain_step']:,}, known roots {len(latest['known_roots'])}")
        h2, s2 = state_hash_of(os.path.join(state, 'local.npz')); ok('local.npz is the saved brain', h2 == latest['hash'] and s2 == latest['brain_step'])
        # restart: the local state must be continued, not rewound
        proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py')], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
        h = wait_health(f'{base}/health', 240, proc); t0 = time.time()
        while time.time() - t0 < 90:
            st, fr = http('GET', f'{base}/frame')
            if fr and fr.get('realtime', 0) > 0: break
            time.sleep(1)
        ok('restart continues the local state', fr['step'] >= latest['brain_step'] and fr['realtime'] > 0, f"step {fr['step']:,} >= {latest['brain_step']:,}")
        stop(proc)
    finally:
        stop(proc); logf.close()
        print('--- server_test.log (tail) ---'); print(''.join(open(os.path.join(TEST_DIR, 'server_test.log'), errors='replace').readlines()[-25:]))
    return paths


def test_death():
    """A starving fly on the host: the frame says dead, /final hands the death payload (Status dead, deaths + 1, cause) and keeps it, across
    a restart of the brain process too (the registry still says alive: the death is the pebble's to report, however long it is away)."""
    key = Account.create(); port = free_port(); state = os.path.join(TEST_DIR, f'death_state_{FLY}'); snaps = os.path.join(TEST_DIR, 'snapshots'); os.makedirs(state, exist_ok=True)
    env = {**os.environ, 'REMOTE_BODY': '1', 'REMOTE_BODY_TEST': '1', 'FLY_ID': str(FLY), 'BODY_ADDR': key.address, 'FLYHOST_TEST_BODY': key.address, 'FLYHOST_TEST_ENERGY': '4', 'PORT': str(port), 'STATE': state, 'SNAPS': snaps, 'NUMBA_NUM_THREADS': THREADS}
    logf = open(os.path.join(TEST_DIR, 'server_death.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py')], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'server.py pid {proc.pid} on {base}, fly #{FLY} with 4 s of energy (test override)', flush=True)
    try:
        wait_health(f'{base}/health', 240, proc)
        fr = frame_until(base, lambda f: f['alive'] is False, 120); time.sleep(1.5); st, fr2 = http('GET', f'{base}/frame')
        ok('frame says dead once the energy is gone', fr['alive'] is False and fr['energy'] == 0 and fr2['alive'] is False and fr2['realtime'] == 0.0, f"age {fr['t_ms']/1000:.1f} s, last diary line {fr['events'][-1][1]!r}")
        st, h = http('GET', f'{base}/health'); ok('health says dead', st == 200 and h['alive'] is False)
        st, r = http('GET', f'{base}/final'); ok('final unsigned -> 403', st == 403)
        st, fp = http('GET', f'{base}/final', headers=sign(key, FLY)); ok('final signed -> 200', st == 200, f"cause {fp.get('cause')!r}")
        need = ['stateRoot', 'memoryRoot', 'stateURI', 'metadataURI', 'brainStep', 'energy', 'historyRoot', 'interactions', 'age_s', 'spikes', 'generation', 'cause']
        ok('final payload fields', all(k in fp for k in need) and fp['energy'] == 0 and fp['cause'].startswith('starved in pebble') and fp['stateURI'].startswith('ipfs://'), json.dumps({k: fp[k] for k in ('stateRoot', 'stateURI', 'brainStep', 'energy')}))
        path = os.path.join(snaps, fp['stateRoot'][2:] + '.npz'); h, step = state_hash_of(path)
        ok('death snapshot saved and hashed', h == fp['stateRoot'][2:] and step == fp['brainStep'], f'step {step:,}')
        st, fp2 = http('GET', f'{base}/final', headers=sign(key, FLY)); ok('final is kept and stable', st == 200 and fp2 == fp)
        st, r = http('GET', f'{base}/checkpoint', headers=sign(key, FLY)); ok('checkpoint after death -> 409 (fetch /final)', st == 409, str(r))
        try:
            m = json.load(urllib.request.urlopen(urllib.request.Request(f"https://gateway.pinata.cloud/ipfs/{fp['metadataURI'][7:]}", headers={'User-Agent': 'curl/8'}), timeout=60))
            attrs = {a['trait_type']: a['value'] for a in m['attributes']}
            ok('death metadata: Status dead, deaths + 1, cause', attrs['Status'].startswith('dead') and attrs['Deaths'] >= 1 and attrs['Cause of death'] == fp['cause'] and attrs['Body'] == 'none', f"Deaths={attrs['Deaths']}")
        except Exception as e: print('  --  metadata gateway read skipped:', repr(e)[:100])
        st, h = http('GET', f'{base}/health'); ok('health shows the unreported death', h['alive'] is False and h['final_ready'] is True and h['dead_since'], f"dead for {time.time() - h['dead_since']:.0f} s")
        # the pebble has not reported the death (the registry still says alive): a restart of the brain must not bring the fly back
        rc = stop(proc); ok('SIGTERM while dead exits', rc is not None and os.path.exists(os.path.join(state, 'final.json')), f'rc {rc}, final.json kept')
        env2 = {k: v for k, v in env.items() if k != 'FLYHOST_TEST_ENERGY'}   # no energy override: the record's energy is what a restart would see
        proc = subprocess.Popen([PY, os.path.join(HERE, 'server.py')], cwd=HERE, env=env2, stdout=logf, stderr=subprocess.STDOUT)
        h = wait_health(f'{base}/health', 240, proc); t0 = time.time()
        while time.time() - t0 < 120 and not h.get('hosting'):
            time.sleep(1); st, h = http('GET', f'{base}/health')
        time.sleep(3); st, fr = http('GET', f'{base}/frame')
        ok('restart keeps the unreported death', h['hosting'] and fr['alive'] is False and fr['energy'] == 0 and fr['step'] == fp['brainStep'] and fr['generation'] == fp['generation'] and fr['realtime'] == 0.0, f"step {fr['step']:,} gen {fr['generation']} energy {fr['energy']}")
        ok('no resurrection in the diary', not any('resurrected' in e[1] for e in fr['events']), str([e[1] for e in fr['events'][-2:]]))
        st, fp3 = http('GET', f'{base}/final', headers=sign(key, FLY)); ok('final after the restart -> 200, the same payload', st == 200 and fp3 == fp, f"restored: {h.get('final_ready')}")
        st, r = http('GET', f'{base}/checkpoint', headers=sign(key, FLY)); ok('checkpoint after the restart -> 409', st == 409, str(r))
        logt = open(os.path.join(TEST_DIR, 'server_death.log'), errors='replace').read()
        ok('the log says the death waits for the pebble', 'staying dead, /final waits for the pebble' in logt and 'resurrected per the record' not in logt)
    finally:
        stop(proc); logf.close()
        print('--- server_death.log (tail) ---'); print(''.join(open(os.path.join(TEST_DIR, 'server_death.log'), errors='replace').readlines()[-14:]))


def test_verify(paths):
    a, b = paths; t0 = time.time()
    r = subprocess.run([PY, os.path.join(HERE, 'verify.py'), a, b], cwd=HERE, env={**os.environ, 'NUMBA_NUM_THREADS': THREADS}, capture_output=True, text=True, timeout=900)
    print(r.stdout.strip()); print(r.stderr.strip()[-500:] if r.returncode else '', end='')
    ok('verify.py replays checkpoint 1 -> 2 (MATCH)', r.returncode == 0 and '\nMATCH' in r.stdout, f'{time.time() - t0:.0f} s')
    ok('the replay applied the interval\'s senses', 'with 0 world events' not in r.stdout and 'WARNING' not in r.stdout, r.stdout.splitlines()[0][-80:])


# ------------------------------------------------------------------ part 2: flyhost.py
def test_host():
    reg = Registry(); n = reg.total(); zero = '0x' + '0' * 40; real = None
    for f in reg.flies(range(1, n + 1)):
        if f['alive'] and f['body'] != zero and reg.body(f['body'])['name'].startswith('Pebble'): real = f; break
    port = free_port(); root = os.path.join(TEST_DIR, 'host'); os.makedirs(root, exist_ok=True)
    env = {**os.environ, 'HOST_PORT': str(port), 'STATE_ROOT': root, 'SNAPS': os.path.join(TEST_DIR, 'snapshots'), 'LOG_DIR': root, 'SCAN_EVERY': '5', 'NUMBA_NUM_THREADS': THREADS}
    env.pop('ANNOUNCE', None); env.pop('HOST_TEST_FLIES', None); env.pop('HOST_ONLY_IDS', None)
    if real:
        fid, body, expect_hosting = real['id'], real['body'], True; env['HOST_ONLY_IDS'] = str(fid); how = f"the real pebble fly #{fid} ({reg.body(body)['name']})"
    else:   # no fly is in a pebble right now: the test hook makes flyhost treat a throwaway address as fly #FLY's pebble (its brain idles: not the body on chain)
        fid, body, expect_hosting = FLY, Account.create().address, False; env['HOST_TEST_FLIES'] = os.path.join(root, 'test_flies.json'); json.dump({str(fid): body}, open(env['HOST_TEST_FLIES'], 'w')); how = f'no fly is in a pebble now; fly #{fid} via HOST_TEST_FLIES with a throwaway body'
    logf = open(os.path.join(root, 'host_test.log'), 'ab')
    proc = subprocess.Popen([PY, os.path.join(HERE, 'flyhost.py')], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'; print(f'flyhost.py pid {proc.pid} on {base}: {how}', flush=True)
    try:
        t0 = time.time(); idx = None
        while time.time() - t0 < 300:
            if proc.poll() is not None: raise RuntimeError(f'flyhost exited with {proc.returncode}')
            try:
                st, idx = http('GET', base, timeout=5)
                if st == 200 and any(x['id'] == fid and x['health'].get('ok') for x in idx['flies']): break
            except Exception: pass
            time.sleep(2)
        me = [x for x in idx['flies'] if x['id'] == fid][0]
        ok('flyhost runs a brain for the pebble fly', me['up'] and me['health'].get('ok') and me['name'].startswith('Pebble') and me['body'].lower() == body.lower() and me['port'] == 9000 + fid, f"port {me['port']} body {me['body'][:10]} {me['name']}")
        ok('GET / lists flies and url', 'flies' in idx and 'url' in idx and idx['scan']['total'] >= fid)
        st, h = http('GET', f'{base}/fly/{fid}/health'); ok('proxy GET /fly/<id>/health', st == 200 and h['fly'] == fid and h['body'].lower() == body.lower() and h['test_mode'] is False and h['hosting'] == expect_hosting, f"ok={h['ok']} hosting={h['hosting']}")
        t0 = time.time()
        while time.time() - t0 < 120:
            st, fr = http('GET', f'{base}/fly/{fid}/frame')
            if st == 200 and fr and (fr.get('realtime', 0) > 0 or not expect_hosting): break
            time.sleep(2)
        ok('proxy GET /fly/<id>/frame', st == 200 and 'puffs' in fr and 'rates' in fr and (fr['realtime'] > 0) == expect_hosting, f"realtime {fr['realtime']} step {fr['step']:,} energy {fr['energy']:.0f}")
        frames, ts = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/fly/{fid}/ws?lite=1', 2))
        ok('proxy WebSocket /fly/<id>/ws?lite=1', all('t_ms' in x and 'spikes' not in x for x in frames), f'gap {ts[1] - ts[0]:.2f} s')
        st, r = http('POST', f'{base}/fly/{fid}/sense', {'kind': 'landmark', 'side': 'left'}); ok('proxy POST unsigned /sense -> 403', st == 403, str(r))
        st, r = http('GET', f'{base}/fly/9999/health'); ok('unknown fly -> 502', st == 502, str(r))
        pid = int(open(os.path.join(root, f'state_{fid}', 'server.pid')).read())
        if not real:   # the fly leaves the pebble: the supervisor must stop its brain
            json.dump({}, open(env['HOST_TEST_FLIES'], 'w')); t0 = time.time()
            while time.time() - t0 < 90:
                st, idx = http('GET', base, timeout=5)
                if not any(x['id'] == fid for x in idx['flies']): break
                time.sleep(2)
            ok('child stopped when the fly left the pebble', not any(x['id'] == fid for x in idx['flies']) and not os.path.exists(f'/proc/{pid}'), f'{time.time() - t0:.0f} s')
            st, r = http('GET', f'{base}/fly/{fid}/health'); ok('proxy -> 502 once the brain is gone', st == 502)
        rc = stop(proc, 120); ok('flyhost SIGTERM exits', rc is not None, f'rc {rc}')
        for _ in range(60):
            if not os.path.exists(f'/proc/{pid}'): break
            time.sleep(1)
        ok('child stopped with the host', not os.path.exists(f'/proc/{pid}'), f'child pid {pid}')
        latest = json.load(open(os.path.join(root, f'state_{fid}', 'latest.json')))
        ok('child saved its state on the way out', latest['tag'] == 'shutdown' and latest['fly_id'] == fid and latest.get('host') is True and latest['body_addr'].lower() == body.lower(), f"step {latest['brain_step']:,} body {latest['body']}")
    finally:
        stop(proc, 120); logf.close()
        print('--- host_test.log ---'); print(open(os.path.join(root, 'host_test.log'), errors='replace').read()[-3000:])
        try: print(f'--- host_{fid}.log (tail) ---'); print(''.join(open(os.path.join(root, f'host_{fid}.log'), errors='replace').readlines()[-12:]))
        except Exception: pass


if __name__ == '__main__':
    t0 = time.time()
    try:
        if not ONLY_HOST:
            paths = test_server()
            if not NO_VERIFY: test_verify(paths)
            test_death()
        if not NO_HOST: test_host()
    except Exception as e:
        print(f'\nFAILED after {len(passed)} checks: {e!r}', flush=True); sys.exit(1)
    print(f'\nall {len(passed)} checks passed in {time.time() - t0:.0f} s; scratch dir {TEST_DIR}')
