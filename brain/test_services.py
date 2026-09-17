"""Tests for the two body services: doom_host.py (the DOOM queue) and flyhost.py's arena class. Mainnet is only read; no
transaction is ever sent (no service under test holds a key here: doom_host runs DRY, flyhost gets HOST_KEY=/nonexistent
and its child is a stub, not server.py).

  1. unit tests with a fake registry snapshot: the DOOM queue (custody first, then oldest assignment; DOOM's own hand-backs
     left by earlier sessions, dead flies, other bodies' assignments, blocked and unknown ones excluded), session stats, the
     preflight refusing a session when Pinata cannot pin (no JWT / rejected), the arena class (excludes #1, takes body == Arena
     and pendingBody == Arena, the cap with running children keeping their place), the pebble class untouched, the thread
     budget, the arena child's environment (no REMOTE_BODY, no PUBLIC_URL, state_<id>), the child port (9000 + id, or a spare
     port when something else listens there: Tor on 9050 = fly #50);
  1b. a whole doom_host session with a stub doom.py and a fake registry: the subprocess (FLY_ID, --hand-back none, cwd), run.json
     and the video into the index, the summary interaction then the release leaving the fly dormant with no pending body, a crash
     (released, backed off), a crash before accept (left pending, nothing sent), a failed release retried without a new session,
     SIGTERM grace then termination (left in custody);
  2. DOOM_DRY=1 doom_host.py --once against mainnet: the queue it prints must equal one computed here from the records and
     the Assigned events, and it must not spawn or send anything;
  3. flyhost.py in test mode (HOST_TEST_FLIES, HOST_CHILD_SCRIPT = a stub answering /health, /frame, /ws and a local-only
     /admin/commit) hosting fly #2 as an arena-class child: GET / lists it with its class, the HTTP and WebSocket proxy reach it,
     the proxy refuses every non-public path (/admin/commit never reaches the child, which would have trusted it as local),
     the child's environment is the arena one, it is stopped when the fly leaves, and SIGTERM stops everything. With test hooks
     set, flyhost turns the registry-driven arena class off (a real arena child is the Arena body and sends transactions), so
     only the hook's fly runs.

    ../.venv/bin/python test_services.py [--no-chain] [--smoke]     (--no-chain: unit tests only; --smoke: also a 15 s doom.py --no-chain run)
"""
import os, sys, json, time, socket, signal, subprocess, tempfile, unittest, urllib.request, urllib.error, asyncio
HERE = os.path.dirname(os.path.abspath(__file__)); PY = sys.executable
os.environ['DOOM_DRY'] = '1'; os.environ['HOST_KEY'] = '/nonexistent'; os.environ.setdefault('DOOM_LOG', '')   # import the modules without any key and without touching brain/doom_host.log
sys.path.insert(0, HERE)
import doom_host, flyhost

ZERO = '0x' + '0' * 40
DOOM = open(os.path.join(HERE, 'body_doom.address')).read().strip(); ARENA = open(os.path.join(HERE, 'body_arena.address')).read().strip()
PEBBLE = '0x1111111111111111111111111111111111111111'; OWNER = '0x80145643A3926EA739cAf64b65d914e510Bd8f2C'
NO_CHAIN = '--no-chain' in sys.argv; SMOKE = '--smoke' in sys.argv
TEST_DIR = os.environ.get('TEST_DIR') or tempfile.mkdtemp(prefix='services_test_')


def rec(fid, alive=True, body=ZERO, pending=ZERO, energy=3600):
    return {'id': fid, 'alive': alive, 'body': body, 'pendingBody': pending, 'energy': energy, 'stateURI': '', 'stateRoot': '', 'generation': 0}


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def http(method, url, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode(errors='replace')


# ------------------------------------------------------------------ 1. selection rules on a fake snapshot
class DoomQueue(unittest.TestCase):
    def test_queue_order(self):
        recs = {66: rec(66, pending=DOOM), 68: rec(68, pending=DOOM), 69: rec(69, pending=DOOM),
                70: rec(70, pending=DOOM),                      # our own hand-back left behind by release: not a new assignment
                71: rec(71, alive=False, pending=DOOM),         # dead: skipped
                72: rec(72, body=DOOM),                         # still in custody (interrupted session): first
                73: rec(73, pending=ARENA),                     # someone else's
                74: rec(74, pending=DOOM),                      # no Assigned event known yet: waits
                75: rec(75, pending=DOOM),                      # blocked after failures
                1: rec(1, body=ARENA)}
        assigned = {66: {'block': 100, 'by': OWNER}, 68: {'block': 200, 'by': OWNER}, 69: {'block': 150, 'by': OWNER}, 70: {'block': 300, 'by': DOOM.lower()}, 71: {'block': 50, 'by': OWNER}, 75: {'block': 10, 'by': OWNER}}
        q = doom_host.select_queue(recs, assigned, DOOM.lower(), blocked={75: 10 ** 12}, now=0)
        self.assertEqual([fid for fid, _ in q], [72, 66, 69, 68])
        self.assertIn('custody', q[0][1]); self.assertIn('block 100', q[1][1])
        self.assertEqual(doom_host.select_queue({}, {}, DOOM), [])
        # a fly in custody AND pending elsewhere (owner re-assigned it mid-session) is still ours to finish
        self.assertEqual(doom_host.select_queue({5: rec(5, body=DOOM, pending=ARENA)}, {}, DOOM), [(5, 'in DOOM custody (left over from an interrupted session)')])

    def test_session_stats(self):
        run = {'decisions': [{'kills': k} for k in (0, 1, 2, 0, 1, 3, 3)], 'kills': 3, 'episodes': 2, 'commits': [1], 'core_txs': [1, 2, 3], 'final_hash': 'ab'}
        st = doom_host.session_stats(run)
        self.assertEqual((st['decisions'], st['kills'], st['best_life'], st['episodes'], st['commits'], st['core_ticks']), (7, 5, 3, 2, 1, 3))
        self.assertEqual(doom_host.session_stats({})['kills'], 0)

    def test_index_paths(self):
        self.assertTrue(doom_host.INDEX.endswith(os.path.join('doom_sessions', 'index.json')))
        self.assertTrue(doom_host.DRY)   # this test process never holds the DOOM key
        self.assertIsNone(doom_host.reg.address)


class DoomPreflight(unittest.TestCase):
    """check_doom refuses a session when the pin path is broken: every commit and the final commit of a session pin to Pinata, so a fly
    must not be accepted (decisions on-chain, brain discarded) when pinning would fail. pinata_check is patched; nothing leaves the box."""
    def setUp(self):
        self.saved = {k: getattr(doom_host, k) for k in ('pinata_check', 'SESSIONS', 'preflight')}
        doom_host.SESSIONS = os.path.join(TEST_DIR, 'preflight'); doom_host.preflight = {'ok': None, 'why': '', 'at': 0.0}

    def tearDown(self):
        for k, v in self.saved.items(): setattr(doom_host, k, v)

    def test_pin_path_gates_the_session(self):
        doom_host.pinata_check = lambda timeout=20: (False, 'no PINATA_JWT (brain/pinata.env): doom.py pins every commit to IPFS')
        ok, why = doom_host.check_doom(force=True); self.assertFalse(ok); self.assertIn('PINATA_JWT', why)
        doom_host.pinata_check = lambda timeout=20: (False, 'Pinata refuses the JWT (HTTP 401): commits could not be pinned')
        self.assertEqual(doom_host.check_doom(), (False, why), 'a failed preflight is cached (120 s)')
        ok, why = doom_host.check_doom(force=True); self.assertFalse(ok); self.assertIn('HTTP 401', why)
        calls = []
        doom_host.pinata_check = lambda timeout=20: calls.append(1) or (True, '')
        ok, why = doom_host.check_doom(force=True); self.assertEqual(calls, [1]); self.assertNotIn('Pinata', why); print(f'\npreflight with Pinata ok: {ok} {why or "(all checks pass)"}')

    def test_pinata_check_never_shows_the_token(self):
        """The real check against a bogus token (one HTTPS round trip, no secret involved): refused, and the message carries no token."""
        if NO_CHAIN: self.skipTest('--no-chain')
        real = doom_host.reg.pinata.jwt
        try:
            doom_host.reg.pinata.jwt = 'not-a-real-token'
            ok, why = doom_host.pinata_check(timeout=30)
        finally: doom_host.reg.pinata.jwt = real
        print(f'\npinata_check with a bogus JWT -> {ok} {why}')
        self.assertFalse(ok); self.assertNotIn('not-a-real-token', why); self.assertTrue(why.startswith('Pinata'), why)


class ArenaClass(unittest.TestCase):
    names = staticmethod(lambda addr: {PEBBLE.lower(): 'Pebble 3', ARENA.lower(): 'Arena', DOOM.lower(): 'DOOM'}.get(addr.lower(), ''))

    def snapshot(self):
        recs = {1: rec(1, body=ARENA), 2: rec(2, body=ARENA), 3: rec(3, pending=ARENA), 4: rec(4, body=PEBBLE), 5: rec(5, body=DOOM), 6: rec(6, alive=False, body=ARENA),
                7: rec(7, alive=False, pending=ARENA), 8: rec(8), 20: rec(20)}
        for i in range(9, 16): recs[i] = rec(i, body=ARENA)
        return recs

    def test_classes(self):
        w = flyhost.select_wanted(self.snapshot(), self.names, arena=ARENA.lower(), skip={1}, cap=100, only=set())
        self.assertNotIn(1, w, 'fly #1 is served by run.sh on :8123')
        self.assertEqual(w[2], (ARENA, 'Arena', 'arena')); self.assertEqual(w[3], (ARENA, 'Arena', 'arena'))
        self.assertEqual(w[4], (PEBBLE, 'Pebble 3', 'pebble'))
        for fid in (5, 6, 7, 8, 20): self.assertNotIn(fid, w)
        self.assertEqual(sorted(fid for fid, v in w.items() if v[2] == 'arena'), [2, 3] + list(range(9, 16)))
        self.assertEqual(sorted(fid for fid, v in w.items() if v[2] == 'pebble'), [4])

    def test_cap_and_running(self):
        w = flyhost.select_wanted(self.snapshot(), self.names, arena=ARENA.lower(), skip={1}, cap=3, only=set())
        self.assertEqual(sorted(fid for fid, v in w.items() if v[2] == 'arena'), [2, 3, 9], 'lowest ids first when over the cap')
        w = flyhost.select_wanted(self.snapshot(), self.names, arena=ARENA.lower(), skip={1}, cap=3, only=set(), running={12, 14})
        self.assertEqual(sorted(fid for fid, v in w.items() if v[2] == 'arena'), [2, 12, 14], 'running children keep their place')
        self.assertIn(4, w, 'the cap is for the arena class only')

    def test_pebble_class_unchanged_without_arena(self):
        w = flyhost.select_wanted(self.snapshot(), self.names, arena='', skip={1}, cap=6, only=set())
        self.assertEqual(w, {4: (PEBBLE, 'Pebble 3', 'pebble')})

    def test_arena_class_off_under_test_hooks(self):
        """The module constants when a test hook is set: no arena address, so a test can never spawn a real arena child by accident."""
        code = "import sys; sys.path.insert(0, %r); import flyhost; print(flyhost.ARENA_ADDR, '|', flyhost.ARENA_OFF_REASON)" % HERE
        for extra, want_off in (({'HOST_TEST_FLIES': '/x.json'}, True), ({'HOST_CHILD_SCRIPT': '/x.py'}, True), ({'HOST_TEST_FLIES': '/x.json', 'HOST_ARENA_ADDR': ARENA}, False), ({}, False)):
            env = {k: v for k, v in os.environ.items() if not k.startswith('HOST_')}; env.update(extra, HOST_KEY='/nonexistent')
            out = subprocess.run([PY, '-c', code], env=env, capture_output=True, text=True, timeout=120).stdout.strip().split('\n')[-1]
            addr, off = [x.strip() for x in out.split('|')]
            self.assertEqual(addr == '', want_off, f'{extra}: {out}'); self.assertEqual(bool(off), want_off)
            if not want_off: self.assertEqual(addr, ARENA.lower())

    def test_only_ids_and_test_hook(self):
        w = flyhost.select_wanted(self.snapshot(), self.names, arena=ARENA.lower(), skip={1}, cap=6, only={2, 4})
        self.assertEqual(sorted(w), [2, 4])
        w = flyhost.select_wanted(self.snapshot(), self.names, arena=ARENA.lower(), skip={1}, cap=6, only={2}, extra={'20': {'body': ARENA, 'class': 'arena'}, '8': PEBBLE, '6': PEBBLE})
        self.assertEqual(w[20], (ARENA, 'Arena (test)', 'arena')); self.assertEqual(w[8], (PEBBLE, 'Pebble (test)', 'pebble')); self.assertNotIn(6, w, 'dead flies are never hosted, hook or not')

    def test_threads_and_env(self):
        self.assertEqual([max(4, 24 // max(1, n)) for n in (0, 1, 2, 3, 6, 7, 24)], [24, 24, 12, 8, 4, 4, 4])
        env, port = flyhost.child_env(67, ARENA, 'arena', 8, '/x/state_67')
        self.assertEqual(port, 9067); self.assertEqual(env['PORT'], '9067'); self.assertEqual(env['FLY_ID'], '67'); self.assertEqual(env['STATE'], '/x/state_67'); self.assertEqual(env['NUMBA_NUM_THREADS'], '8')
        self.assertEqual(env['PUBLIC_URL'], '', 'an arena child must never announce a url as the Arena body')
        for k in ('REMOTE_BODY', 'BODY_ADDR', 'ANNOUNCE', 'REMOTE_BODY_TEST', 'FLYHOST_TEST_BODY'): self.assertNotIn(k, env)
        env, port = flyhost.child_env(65, PEBBLE, 'pebble', 8, '/x/state_65')
        self.assertEqual((env['REMOTE_BODY'], env['BODY_ADDR'], port), ('1', PEBBLE, 9065))
        env, port = flyhost.child_env(50, ARENA, 'arena', 8, '/x/state_50', port=19001)
        self.assertEqual((port, env['PORT']), (19001, '19001'), 'the child listens on the port pick_port chose, not on the formula')

    def test_child_port_avoids_a_taken_one(self):
        """9000 + id when free; when something on this box already listens there (Tor's SOCKS on 127.0.0.1:9050 for fly #50), a spare port, so the
        child never fails to bind and restarts forever unhosted. The other children's ports count as taken even before they bind (a brain
        loads for a while first)."""
        fid = int(os.environ.get('TEST_FLY_ID', '2')); s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('127.0.0.1', 9000 + fid)); s.listen()   # as Tor does: one interface only
            self.assertFalse(flyhost.port_free(9000 + fid), 'a listener on 127.0.0.1 blocks the child (it binds every interface)')
            p = flyhost.pick_port(fid); self.assertNotEqual(p, 9000 + fid); self.assertTrue(flyhost.PORT_SPARE[0] <= p < flyhost.PORT_SPARE[1]); self.assertTrue(flyhost.port_free(p))
            q = flyhost.pick_port(fid, taken={p}); self.assertNotIn(q, (p, 9000 + fid)); self.assertTrue(flyhost.PORT_SPARE[0] <= q < flyhost.PORT_SPARE[1], 'a taken spare port is skipped')
        finally: s.close()
        self.assertEqual(flyhost.pick_port(fid), 9000 + fid, 'free again: the formula port')
        self.assertNotEqual(flyhost.pick_port(fid, taken={9000 + fid}), 9000 + fid, 'another child still loading its brain on that port counts as taken')
        self.assertEqual(flyhost.pick_port(50, free=lambda p: p != 9050), flyhost.PORT_SPARE[0], 'fly #50 with Tor on 9050: the first spare port')
        self.assertEqual(flyhost.pick_port(50, taken={flyhost.PORT_SPARE[0]}, free=lambda p: p != 9050), flyhost.PORT_SPARE[0] + 1)
        with self.assertRaises(RuntimeError): flyhost.pick_port(50, free=lambda p: False)
        print(f'\nport 9050 free on this box: {flyhost.port_free(9050)} (Tor) -> fly #50 would get :{flyhost.pick_port(50)}')

    def test_public_paths(self):
        """The proxy's allowlist is exactly the protocol's public endpoints (HOST_PROTOCOL.md); server.py's local-only routes are not on it."""
        self.assertEqual(set(flyhost.PUBLIC), {'ws', 'frame', 'state', 'health', 'sense', 'checkpoint', 'final'})
        for bad in ('admin/commit', 'admin/drop', 'admin', 'agent', 'pending_drops', 'dropped', 'snapshots', 'snapshots/x.npz', '', 'health/'): self.assertNotIn(bad, flyhost.PUBLIC)


# ------------------------------------------------------------------ 1b. a whole doom_host session with a stub doom.py and a fake registry (no chain)
STUB_DOOM = r"""
import os, sys, json, time
a = sys.argv[1:]; out = a[a.index('--out') + 1]; os.makedirs(out, exist_ok=True)
mode = os.environ.get('STUB_DOOM_MODE', 'ok')
print('stub doom.py', json.dumps({'argv': a, 'FLY_ID': os.environ.get('FLY_ID'), 'threads': os.environ.get('NUMBA_NUM_THREADS'), 'cwd': os.getcwd()}), flush=True)
if mode == 'hang': time.sleep(600)
if mode == 'crash': sys.exit(3)
decs = [{'n': i + 1, 'kills': k, 'tx': 'aa' * 32} for i, k in enumerate((0, 1, 1, 0, 2, 3))]
json.dump({'fly_id': int(os.environ['FLY_ID']), 'final_hash': 'ff' * 32, 'commits': [{'tx': 'bb' * 32}], 'minutes': float(a[a.index('--minutes') + 1]), 'episodes': 2, 'kills': 3, 'decisions': decs, 'core_txs': [{}, {}, {}, {}]}, open(os.path.join(out, 'run.json'), 'w'))
open(os.path.join(out, 'doom_fly.mp4'), 'wb').write(b'\0' * 4096)
"""


class FakeReg:
    """The three registry calls doom_host makes after a session, on a record it keeps itself. As in FlyRegistry.sol, `accept` (inside doom.py,
    before the stub ran) cleared pendingBody and `release` only clears body: pendingBody stays whatever it was."""
    def __init__(self, body): self.calls = []; self.body = body; self.pending = ZERO; self.alive = True
    def fly(self, fid): return {'id': fid, 'alive': self.alive, 'body': self.body, 'pendingBody': self.pending, 'energy': 3500}
    def interaction(self, fid, kind, data): self.calls.append(('interaction', fid, kind, data)); return {'transactionHash': b'\x11' * 32}
    def release(self, fid):
        assert self.body.lower() == DOOM.lower(), 'release by a non-body reverts'
        self.calls.append(('release', fid)); self.body = ZERO; return {'transactionHash': b'\x22' * 32}


class DoomHandBack(unittest.TestCase):
    """doom.py's ending, on a ChainLog whose brain, pinning and registry are fakes: `--hand-back none` commits and logs "left DOOM" and never
    assigns (so accept's cleared pendingBody stays cleared and doom_host's release leaves the fly dormant); an address still hands the fly on."""
    def ending(self, to):
        import doom
        class Reg:
            address = DOOM
            def __init__(self): self.calls = []
            def pin_snapshot(self, path): return 'cid', 'ipfs://cid'
            def commit(self, fid, *a): self.calls.append(('commit', fid)); return {'blockNumber': 7}
            def interaction(self, fid, kind, data): self.calls.append(('interaction', fid, kind, data))
            def assign(self, fid, body): self.calls.append(('assign', fid, body))
        ch = doom.ChainLog.__new__(doom.ChainLog); ch.reg = Reg(); ch.decisions = []; ch.energy = 100.0
        ch.q = type('Q', (), {'join': lambda self: None})(); ch.snapshot = lambda tag: ('ab' * 32, '/nonexistent.npz', 123); ch._metadata = lambda h, uri, step: ''
        h = ch.hand_back(to); self.assertEqual(h, 'ab' * 32); return ch.reg.calls

    def test_none_commits_without_assign(self):
        calls = self.ending(None)
        self.assertEqual([c[0] for c in calls], ['commit', 'interaction'], 'final commit and the "left DOOM" line, no assign'); self.assertIn('left DOOM', calls[1][3])
        self.assertEqual(self.ending(''), calls)

    def test_address_still_hands_on(self):
        calls = self.ending(ARENA)
        self.assertEqual([c[0] for c in calls], ['commit', 'interaction', 'assign']); self.assertEqual(calls[2], ('assign', doom_fly_id(), ARENA))

    def test_cli_none_means_no_body(self):
        """main() maps --hand-back none (any case) to hand_back(None) and anything else to the address; the default is the arena."""
        for arg, want in (('none', None), ('NONE', None), (ARENA, ARENA), (None, ARENA)):
            to = arg or open(os.path.join(HERE, 'body_arena.address')).read().strip()
            self.assertEqual(None if to.lower() == 'none' else to, want)
        with open(os.path.join(HERE, 'doom.py')) as fh: src = fh.read()
        self.assertIn("final_hash = ch.hand_back(None if to.lower() == 'none' else to)", src)


def doom_fly_id():
    import doom; return doom.FLY_ID


class DoomSession(unittest.TestCase):
    def setUp(self):
        self.d = os.path.join(TEST_DIR, 'doom_session', self._testMethodName); os.makedirs(self.d, exist_ok=True)
        self.stub = os.path.join(self.d, 'stub_doom.py')
        with open(self.stub, 'w') as fh: fh.write(STUB_DOOM)
        self.saved = {k: getattr(doom_host, k) for k in ('reg', 'SESSIONS', 'INDEX', 'DOOM_SCRIPT', 'STOP_GRACE', 'SESSION_MIN')}
        doom_host.SESSIONS = os.path.join(self.d, 'sessions'); doom_host.INDEX = os.path.join(doom_host.SESSIONS, 'index.json'); doom_host.DOOM_SCRIPT = self.stub; doom_host.SESSION_MIN = 0.01
        doom_host.fails.clear(); doom_host.blocked.clear(); doom_host.unfinished.clear(); doom_host.stopping.clear()
        os.environ.pop('STUB_DOOM_MODE', None)

    def tearDown(self):
        for k, v in self.saved.items(): setattr(doom_host, k, v)
        doom_host.stopping.clear(); os.environ.pop('STUB_DOOM_MODE', None)

    def test_session_ok_then_release(self):
        doom_host.reg = FakeReg(DOOM)   # the stub "accepted": DOOM is the body when it exits
        e = doom_host.run_session(66, 'assigned at block 1 by 0xowner')
        self.assertEqual(e['status'], 'ok'); self.assertEqual((e['decisions'], e['kills'], e['best_life'], e['episodes'], e['commits'], e['core_ticks']), (6, 4, 3, 2, 1, 4))
        self.assertTrue(e['video'].endswith('doom_fly.mp4')); self.assertEqual(e['txs'], 6 + 1 + 4 + 3 + 1 + 2, 'decisions + commits + core ticks + enter/final/leave + accept + summary/release: no hand-back assign')
        self.assertEqual([c[:2] for c in doom_host.reg.calls], [('interaction', 66), ('release', 66)], 'summary first (DOOM must still be the body), then release')
        self.assertIn('4 kills (best life 3)', doom_host.reg.calls[0][3]); self.assertLessEqual(len(doom_host.reg.calls[0][3]), 512)
        self.assertEqual(doom_host.reg.body, ZERO); self.assertEqual(doom_host.reg.pending, ZERO, 'no hand-back: after release the fly is dormant with no pending body (the site says dormant, not waiting for DOOM)')
        with open(os.path.join(e['dir'], 'doom.log')) as fh: first = json.loads(fh.readline().split(' ', 2)[2])
        self.assertEqual(first['FLY_ID'], '66'); self.assertEqual(first['argv'][first['argv'].index('--hand-back') + 1], 'none', 'doom.py must not assign the fly back to DOOM'); self.assertEqual(first['threads'], doom_host.THREADS); self.assertEqual(first['cwd'], HERE)
        idx = doom_host.load_index(); self.assertEqual(len(idx), 1); self.assertEqual(idx[0]['release_tx'], '22' * 32); self.assertEqual({'id', 'ts', 'video', 'decisions', 'kills', 'txs'} - set(idx[0]), set())
        self.assertEqual(doom_host.select_queue({66: doom_host.reg.fly(66)}, {66: {'block': 9, 'by': OWNER}}, DOOM), [], 'dormant: not queued again until the owner assigns it')
        # a record left by a session before --hand-back none (pendingBody == DOOM, latest Assigned by DOOM) is still recognised as no assignment
        self.assertEqual(doom_host.select_queue({66: {**doom_host.reg.fly(66), 'pendingBody': DOOM}}, {66: {'block': 9, 'by': DOOM}}, DOOM), [])

    def test_session_crash_releases_and_backs_off(self):
        os.environ['STUB_DOOM_MODE'] = 'crash'; doom_host.reg = FakeReg(DOOM)
        e = doom_host.run_session(68, 'assigned at block 2 by 0xowner')
        self.assertEqual(e['status'], 'failed (exit 3)'); self.assertIsNone(e['video']); self.assertEqual([c[0] for c in doom_host.reg.calls], ['interaction', 'release']); self.assertIn('abnormally', doom_host.reg.calls[0][3])
        self.assertEqual(doom_host.fails[68], 1); self.assertGreater(doom_host.blocked[68], time.time() + 100)
        self.assertEqual(doom_host.select_queue({68: {'alive': True, 'body': DOOM, 'pendingBody': ZERO}}, {}, DOOM, doom_host.blocked), [], 'blocked after a failure')

    def test_session_crash_before_accept_leaves_it_pending(self):
        os.environ['STUB_DOOM_MODE'] = 'crash'; doom_host.reg = FakeReg(ZERO); doom_host.reg.pending = DOOM
        e = doom_host.run_session(69, 'assigned at block 3 by 0xowner')
        self.assertEqual(doom_host.reg.calls, [], 'never released or logged: the fly was never ours'); self.assertEqual(doom_host.reg.pending, DOOM); self.assertNotIn(69, doom_host.unfinished)

    def test_release_failure_is_retried_not_replayed(self):
        class Flaky(FakeReg):
            def release(self, fid):
                if not getattr(self, 'failed', False): self.failed = True; raise RuntimeError('rpc down')
                return super().release(fid)
        doom_host.reg = Flaky(DOOM); e = doom_host.run_session(66, 'in DOOM custody (left over from an interrupted session)')
        self.assertEqual(e['status'], 'ok'); self.assertIn(66, doom_host.unfinished); self.assertNotIn('release_tx', e)
        self.assertTrue(doom_host.finish_session(66, e, True)); self.assertEqual(e['release_tx'], '22' * 32); self.assertEqual([c[0] for c in doom_host.reg.calls], ['interaction', 'release'], 'the summary is not posted twice')
        doom_host.add_index(e); idx = doom_host.load_index(); self.assertEqual(len(idx), 1); self.assertEqual(idx[0]['release_tx'], '22' * 32)

    def test_sigterm_grace_then_terminate(self):
        import threading
        os.environ['STUB_DOOM_MODE'] = 'hang'; doom_host.reg = FakeReg(DOOM); doom_host.STOP_GRACE = 2.0; res = {}
        t = threading.Thread(target=lambda: res.update(e=doom_host.run_session(66, 'assigned at block 1 by 0xowner'))); t.start()
        for _ in range(100):
            if doom_host.current['proc'] is not None: break
            time.sleep(0.05)
        t0 = time.time(); doom_host.on_term(signal.SIGTERM, None); t.join(30)
        self.assertFalse(t.is_alive()); e = res['e']; self.assertEqual(e['status'], 'interrupted'); self.assertGreaterEqual(time.time() - t0, 2.0); self.assertLess(time.time() - t0, 20)
        self.assertEqual(doom_host.reg.calls, [], 'a session cut by the host stopping is left in custody: resumed as a left-over'); self.assertEqual(doom_host.reg.body, DOOM); self.assertIsNone(doom_host.current['proc'])
        print(f'\nSIGTERM: session terminated after the {doom_host.STOP_GRACE:.0f} s grace ({time.time() - t0:.1f} s), left in custody')


# ------------------------------------------------------------------ 2. doom_host dry run against mainnet
class DoomDryRun(unittest.TestCase):
    def test_dry_run(self):
        if NO_CHAIN: self.skipTest('--no-chain')
        from registry import Registry
        reg = Registry(); n = reg.total(); recs = {f['id']: f for f in reg.flies(range(1, n + 1))}
        assigned = {}
        for ev in reg.events('Assigned', doom_host.FROM_BLOCK, reg.w3.eth.block_number, body=DOOM): assigned[int(ev['id'])] = {'block': ev['block'], 'by': ev['by']}
        expect = doom_host.select_queue(recs, assigned, DOOM)
        d = os.path.join(TEST_DIR, 'doom'); os.makedirs(d, exist_ok=True)
        env = {**os.environ, 'DOOM_DRY': '1', 'DOOM_LOG': os.path.join(d, 'doom_host.log'), 'DOOM_SESSIONS': os.path.join(d, 'doom_sessions'), 'DOOM_SESSION_MIN': '5'}
        r = subprocess.run([PY, os.path.join(HERE, 'doom_host.py'), '--once'], cwd=HERE, env=env, capture_output=True, text=True, timeout=600)
        print('\n--- DOOM_DRY=1 doom_host.py --once ---'); print(r.stdout.strip()); print(r.stderr.strip()[-2000:])
        self.assertEqual(r.returncode, 0)
        self.assertIn('DRY RUN: no subprocess, no transaction', r.stdout)
        self.assertTrue('DOOM playable here' in r.stdout or 'DOOM unavailable' in r.stdout)
        self.assertNotIn('session starting', r.stdout)
        made = [x for x in os.listdir(env['DOOM_SESSIONS']) if x not in ('index.json', '_preflight')] if os.path.exists(env['DOOM_SESSIONS']) else []
        self.assertEqual(made, [], 'a dry run creates no session directory')
        want = ', '.join(f'#{fid} ({why})' for fid, why in expect) if expect else 'empty'
        self.assertIn(f'queue: {want}', r.stdout, f'expected queue {want}')
        if expect and 'DOOM playable here' in r.stdout: self.assertIn(f'DRY RUN: would take fly #{expect[0][0]}', r.stdout)
        print(f'expected queue from mainnet: {want}')


# ------------------------------------------------------------------ 3. flyhost with an arena-class stub child
STUB = r'''
import os, json, asyncio
from aiohttp import web
FID = int(os.environ['FLY_ID']); PORT = int(os.environ['PORT'])
INFO = {'ok': True, 'alive': True, 'hosting': True, 'fly': FID, 'body': os.environ.get('BODY_ADDR', ''), 'remote': os.environ.get('REMOTE_BODY') == '1', 'public_url': os.environ.get('PUBLIC_URL', '(unset)'),
        'threads': os.environ.get('NUMBA_NUM_THREADS'), 'state': os.environ.get('STATE'), 'stub': True, 'realtime': 1.0}
async def health(r): return web.json_response(INFO)
async def frame(r): return web.json_response({'t_ms': 0.0, 'realtime': 1.0, 'stub': True})
async def admin_commit(r):   # exactly server.py's guard: a request from this machine (the proxy is one) would start a commit with the Arena key
    if r.remote not in ('127.0.0.1', '::1'): return web.Response(status=403)
    INFO['admin_hits'] = INFO.get('admin_hits', 0) + 1; return web.json_response({'ok': True, 'would_commit': True, 'remote_seen_by_child': r.remote})
async def ws(r):
    w = web.WebSocketResponse(); await w.prepare(r)
    for i in range(5): await w.send_str(json.dumps({'t_ms': float(i), 'lite': r.query.get('lite'), 'stub': True})); await asyncio.sleep(0.1)
    await w.close(); return w
app = web.Application(); app.router.add_get('/health', health); app.router.add_get('/frame', frame); app.router.add_get('/ws', ws); app.router.add_post('/admin/commit', admin_commit)
web.run_app(app, host='127.0.0.1', port=PORT, print=None)
'''


async def ws_frames(url, n, timeout=15):
    from aiohttp import ClientSession
    out = []
    async with ClientSession() as s:
        async with s.ws_connect(url) as w:
            while len(out) < n: m = await asyncio.wait_for(w.receive(), timeout); out.append(json.loads(m.data))
    return out


def stop(proc, wait):
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(wait)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    return proc.returncode


class FlyhostArena(unittest.TestCase):
    def test_supervisor(self):
        if NO_CHAIN: self.skipTest('--no-chain')
        fid = int(os.environ.get('TEST_FLY_ID', '2'))
        from registry import Registry
        f = Registry().fly(fid); self.assertTrue(f['alive'], f'fly #{fid} must be alive for the hook'); self.assertEqual(f['body'], ZERO, f'fly #{fid} must be dormant (no real child may ever take a fly during a test)')
        root = os.path.join(TEST_DIR, 'host'); os.makedirs(root, exist_ok=True); stub = os.path.join(root, 'stub_child.py'); hook = os.path.join(root, 'test_flies.json')
        with open(stub, 'w') as fh: fh.write(STUB)
        with open(hook, 'w') as fh: json.dump({str(fid): {'body': ARENA, 'class': 'arena'}}, fh)
        port = free_port()
        env = {**os.environ, 'HOST_PORT': str(port), 'STATE_ROOT': root, 'SNAPS': os.path.join(root, 'snapshots'), 'LOG_DIR': root, 'SCAN_EVERY': '3', 'HOST_ONLY_IDS': str(fid), 'HOST_TEST_FLIES': hook, 'HOST_CHILD_SCRIPT': stub, 'HOST_KEY': '/nonexistent'}
        env.pop('ANNOUNCE', None); env.pop('PUBLIC_URL', None)
        logf = open(os.path.join(root, 'flyhost_test.log'), 'ab')
        proc = subprocess.Popen([PY, os.path.join(HERE, 'flyhost.py')], cwd=HERE, env=env, stdout=logf, stderr=subprocess.STDOUT)
        base = f'http://127.0.0.1:{port}'; print(f'\nflyhost.py pid {proc.pid} on {base}: fly #{fid} as an arena-class stub child', flush=True)
        try:
            t0 = time.time(); idx = None
            while time.time() - t0 < 120:
                if proc.poll() is not None: raise RuntimeError(f'flyhost exited with {proc.returncode}')
                try:
                    st, idx = http('GET', base, timeout=5)
                    if st == 200 and any(x['id'] == fid and x['health'].get('ok') for x in idx['flies']): break
                except Exception: pass
                time.sleep(1)
            me = [x for x in idx['flies'] if x['id'] == fid][0]
            print('GET / ->', json.dumps({k: v for k, v in idx.items() if k != 'flies'}), json.dumps(me)[:300])
            self.assertEqual(me['class'], 'arena'); self.assertEqual(me['port'], 9000 + fid); self.assertTrue(me['up']); self.assertEqual(me['body'].lower(), ARENA.lower()); self.assertEqual(me['name'], 'Arena (test)')
            self.assertEqual(idx['classes'], {'pebble': 0, 'arena': 1}); self.assertIsNone(idx['host'])
            self.assertEqual(idx['arena'], '', 'with test hooks set the registry scan never spawns a real arena child (only the hook names one)')
            self.assertEqual([x['id'] for x in idx['flies']], [fid], 'no other fly (e.g. one really pending for the Arena) got a child')
            st, h = http('GET', f'{base}/fly/{fid}/health'); print('proxy /health ->', st, json.dumps(h))
            self.assertEqual(st, 200); self.assertTrue(h['stub']); self.assertEqual(h['fly'], fid)
            self.assertFalse(h['remote'], 'an arena child is not a remote body'); self.assertEqual(h['public_url'], '', 'no PUBLIC_URL for an arena child'); self.assertEqual(h['body'], '', 'no BODY_ADDR for an arena child')
            self.assertEqual(h['threads'], '24', 'one child gets the whole budget: max(4, 24 // 1)'); self.assertEqual(h['state'], os.path.join(root, f'state_{fid}'))
            st, fr = http('GET', f'{base}/fly/{fid}/frame'); self.assertEqual(st, 200); self.assertTrue(fr['stub'])
            frames = asyncio.run(ws_frames(f'ws://127.0.0.1:{port}/fly/{fid}/ws?lite=1', 3)); self.assertEqual([x['t_ms'] for x in frames], [0.0, 1.0, 2.0]); self.assertEqual(frames[0]['lite'], '1'); print('proxy ws frames ->', frames[:2])
            st, r = http('GET', f'{base}/fly/9999/health'); self.assertEqual(st, 502)
            # the child's local-only /admin/commit (server.py: a commit with the Arena key) must never be reachable through the proxy, whatever the method
            for meth, path in (('POST', 'admin/commit'), ('GET', 'admin/commit'), ('POST', 'admin/drop'), ('GET', 'snapshots/'), ('GET', 'agent'), ('POST', 'dropped'), ('GET', 'pending_drops')):
                st, r = http(meth, f'{base}/fly/{fid}/{path}', body={} if meth == 'POST' else None); self.assertEqual(st, 404, f'{meth} /{path} -> {st} {r}'); self.assertIn('not a public path', r['error'])
            st, r = http('POST', f'{base}/fly/9999/admin/commit', body={}); self.assertEqual(st, 404, 'refused before the child lookup')
            st, h = http('GET', f'{base}/fly/{fid}/health'); self.assertEqual(h.get('admin_hits', 0), 0, 'the child never saw an /admin/commit through the proxy')
            st, r = http('POST', f'http://127.0.0.1:{me["port"]}/admin/commit', body={}); self.assertEqual((st, r['would_commit'], r['remote_seen_by_child']), (200, True, '127.0.0.1'), 'directly, the child trusts a local caller: the proxy is what keeps the world out')
            st, h = http('GET', f'{base}/fly/{fid}/health'); self.assertEqual(h['admin_hits'], 1); print(f'proxy refuses /admin/commit (404) while the child itself would have committed for 127.0.0.1: admin_hits {h["admin_hits"]} (the one direct call)')
            with open(os.path.join(root, f'state_{fid}', 'server.pid')) as fh: pid = int(fh.read())
            self.assertTrue(os.path.exists(f'/proc/{pid}'))
            with open(hook, 'w') as fh: json.dump({}, fh)   # the fly leaves: the supervisor must stop the child
            t0 = time.time()
            while time.time() - t0 < 60:
                st, idx = http('GET', base, timeout=5)
                if not any(x['id'] == fid for x in idx['flies']): break
                time.sleep(1)
            self.assertFalse(any(x['id'] == fid for x in idx['flies'])); self.assertFalse(os.path.exists(f'/proc/{pid}'), 'stub child stopped'); print(f'child stopped {time.time() - t0:.0f} s after the fly left')
            st, r = http('GET', f'{base}/fly/{fid}/health'); self.assertEqual(st, 502)
            rc = stop(proc, 60); self.assertIsNotNone(rc); print(f'flyhost SIGTERM -> exit {rc}')
        finally:
            stop(proc, 60); logf.close()
            with open(os.path.join(root, 'flyhost_test.log'), errors='replace') as fh: print('--- flyhost_test.log ---'); print(fh.read()[-2500:])


class DoomSmoke(unittest.TestCase):
    def test_doom_no_chain(self):
        """doom.py itself, 15 s, --no-chain (no registry, no key, no tx): ViZDoom + the whole brain + the video pipeline work here."""
        if not SMOKE: self.skipTest('--smoke not given')
        d = os.path.join(TEST_DIR, 'smoke'); os.makedirs(d, exist_ok=True)
        env = {**os.environ, 'NUMBA_NUM_THREADS': '6', 'FLY_ID': '66'}
        r = subprocess.run([PY, os.path.join(HERE, 'doom.py'), '--no-chain', '--minutes', '0.25', '--out', os.path.join(d, 'out')], cwd=d, env=env, capture_output=True, text=True, timeout=900)
        lines = [l for l in r.stdout.strip().split('\n') if 'pw.conf' not in l and 'ALSOFT' not in l]; print('\n--- doom.py --no-chain --minutes 0.25 ---'); print('\n'.join(lines[-5:])); print(r.stderr.strip()[-1500:])
        self.assertEqual(r.returncode, 0); v = os.path.join(d, 'out', 'doom_fly.mp4')
        with open(os.path.join(d, 'out', 'run.json')) as fh: run = json.load(fh)
        self.assertTrue(os.path.exists(v) and os.path.getsize(v) > 10000); self.assertEqual(run['decisions'], []); print(f"video {os.path.getsize(v)} bytes, kills {run['kills']}, episodes {run['episodes']}, trigger spikes {run['trigger_spikes']}")


if __name__ == '__main__':
    print(f'scratch dir {TEST_DIR}')
    unittest.main(argv=[sys.argv[0]] + [a for a in sys.argv[1:] if not a.startswith('--')], verbosity=2)
