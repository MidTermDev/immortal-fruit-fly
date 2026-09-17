"""The brain host: a whole brain for every fly whose body is a pebble (brain/HOST_PROTOCOL.md), and for every fly
the Arena hosts beyond fly #1.

Every 15 s it scans FlyRegistry and keeps one `server.py` per fly of two classes, proxying /fly/<id>/… (HTTP and
WebSocket) to each. Only the protocol's public paths are proxied (PUBLIC below: ws, frame, state, health, sense,
checkpoint, final); a child's local-only routes (server.py's /admin/commit, which makes the Arena key commit) see this
proxy as 127.0.0.1 and are therefore never reachable through it. A child listens on 9000 + id when that port is free,
else on the first free port from 19001 (Tor's SOCKS listener sits on 127.0.0.1:9050 = 9000 + 50); the proxy follows the
child record, never the formula.
  pebble: alive flies whose body is a registered body named "Pebble …" → server.py REMOTE_BODY=1 (no key; the pebble
          signs everything itself);
  arena:  alive flies whose body is the Arena (brain/body_arena.address) except fly #1 (brain/run.sh serves it on :8123),
          plus flies whose pendingBody is the Arena → server.py in arena mode (BODY_KEY body_arena.key, STATE state_<id>/,
          no PUBLIC_URL so the child never re-registers the Arena's uri). The child accepts the pending assignment itself
          (server.py poll_chain), commits and logs with the arena key through the shared send lock (registry.py reads
          the pending nonce inside the lock, so it never races the :8123 server). At most HOST_ARENA_MAX at once.
Threads per child: max(4, HOST_THREADS // children) over both classes. It announces its public origin as the body
"Brain host" (key brain/body_host.key) so the pebbles and the site can find it; it never sends a transaction itself
except that announcement, and only with ANNOUNCE=1.

    ANNOUNCE=1 PUBLIC_URL=https://… ../.venv/bin/python flyhost.py      (run_host.sh: with a cloudflared tunnel)
"""
import os, sys, json, time, signal, asyncio, subprocess, re, socket
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
from registry import Registry, RPC as _RPC

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_PORT = int(os.environ.get('HOST_PORT', '8124'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', '')
ANNOUNCE = os.environ.get('ANNOUNCE') == '1'
SCAN_EVERY = float(os.environ.get('SCAN_EVERY', '15'))
STATE_ROOT = os.environ.get('STATE_ROOT', HERE); SNAPS = os.environ.get('SNAPS', os.path.join(HERE, 'snapshots')); LOG_DIR = os.environ.get('LOG_DIR', HERE)
ONLY_IDS = {int(x) for x in os.environ.get('HOST_ONLY_IDS', '').split(',') if x.strip()}   # tests: restrict which flies are hosted
TEST_FLIES = os.environ.get('HOST_TEST_FLIES', '')   # tests only: a JSON file {id: body} of flies hosted as if that body were their pebble, re-read every scan
DEAD_GRACE = 600.0          # a dead fly's brain stays up this long so the pebble can fetch /final
ARENA_DEAD_GRACE = 60.0     # an arena child reports its own death; once the chain agrees it only has to go
STOP_WAIT = 40.0            # seconds a child gets to save its state on SIGTERM
KEY = os.environ.get('HOST_KEY', os.path.join(HERE, 'body_host.key')); ZERO = '0x0000000000000000000000000000000000000000'
_arena_file = os.path.join(HERE, 'body_arena.address')
ARENA_ADDR = (os.environ.get('HOST_ARENA_ADDR') or (open(_arena_file).read().strip() if os.path.exists(_arena_file) else '')).lower()
ARENA_SKIP = {int(x) for x in os.environ.get('HOST_ARENA_SKIP', '1').split(',') if x.strip()}   # served elsewhere: fly #1 by brain/run.sh on :8123
ARENA_MAX = int(os.environ.get('HOST_ARENA_MAX', '6'))          # arena-class children at once; the rest wait, lowest id first
THREADS = int(os.environ.get('HOST_THREADS', '24'))              # thread budget shared by every child: max(4, THREADS // children)
CHILD_SCRIPT = os.environ.get('HOST_CHILD_SCRIPT', '')           # tests only: run this instead of server.py (a stub that answers /health)
PUBLIC = frozenset(('ws', 'frame', 'state', 'health', 'sense', 'checkpoint', 'final'))   # HOST_PROTOCOL.md: the only child paths the world may reach; everything else (server.py's local-only /admin/*, /snapshots/…) is refused here
PORT_BASE = 9000; PORT_SPARE = (19001, 20000)   # a child's port: PORT_BASE + id when free, else the first free port in PORT_SPARE (above every id's port, below the ephemeral range)
ARENA_OFF_REASON = ''
if (TEST_FLIES or CHILD_SCRIPT) and not os.environ.get('HOST_ARENA_ADDR'):   # a test hook never lets the registry scan spawn a real arena child: that child is the Arena body and sends transactions
    ARENA_ADDR = ''; ARENA_OFF_REASON = 'test hooks set and no explicit HOST_ARENA_ADDR'
reg = Registry(key_path=KEY if os.path.exists(KEY) else None)
children = {}               # fly id -> child record
body_names = {}             # body address -> (name, read at)
scan = {'at': 0.0, 'total': 0, 'error': ''}
SECRET = re.compile(re.escape(_RPC.rstrip('/')) + r'/?') if _RPC.startswith('http') else None


def log(*a):
    s = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(SECRET.sub('<rpc>', s) if SECRET else s, flush=True)


# ------------------------------------------------------------------ registry
def body_name(addr):
    n, at = body_names.get(addr.lower(), ('', 0.0))
    if time.time() - at > 300:
        n = reg.body(addr)['name']; body_names[addr.lower()] = (n, time.time())
    return n


def select_wanted(recs, name_of, arena=ARENA_ADDR, skip=ARENA_SKIP, cap=ARENA_MAX, only=ONLY_IDS, running=(), extra=None):
    """Which flies this host runs: {id: (body, name, class)}. Pure (unit-tested with a fake snapshot).
    pebble: alive, body a registered body whose name starts with "Pebble". arena: alive, body == the Arena (not in `skip`) or pendingBody == the
    Arena; at most `cap`, children already `running` keep their place, then lowest id first. `extra` (tests): {id: body | {body, class}}."""
    wanted = {}; arena_c = []
    for fid, f in sorted(recs.items()):
        if not f['alive'] or (only and fid not in only): continue
        body, pend = str(f['body']).lower(), str(f['pendingBody']).lower()
        if arena and fid not in skip and (body == arena or pend == arena): arena_c.append((fid, f['body'] if body == arena else f['pendingBody'])); continue
        if body == ZERO: continue
        name = name_of(f['body'])
        if name.startswith('Pebble'): wanted[fid] = (f['body'], name, 'pebble')
    arena_c.sort(key=lambda t: (0 if t[0] in running else 1, t[0]))
    for fid, body in arena_c[:cap]: wanted[fid] = (body, 'Arena', 'arena')
    for k, v in (extra or {}).items():
        fid = int(k)
        if fid not in recs or not recs[fid]['alive']: continue
        if isinstance(v, dict): wanted[fid] = (v['body'], v.get('name', 'Arena (test)' if v.get('class') == 'arena' else 'Pebble (test)'), v.get('class', 'pebble'))
        else: wanted[fid] = (v, 'Pebble (test)', 'pebble')
    return wanted


def scan_registry():
    """Every fly's record, and which of them this host runs: {id: (body, name, class)}."""
    n, rows = reg.all_flies(); recs = {f['id']: f for f in rows}; extra = None   # the registry index when it is fresh, else the chain
    if TEST_FLIES:
        try: extra = json.load(open(TEST_FLIES))
        except Exception: extra = {}
    running = {fid for fid, c in children.items() if c['cls'] == 'arena' and c['proc'].poll() is None}
    return n, recs, select_wanted(recs, body_name, running=running, extra=extra)


def announce_url():
    """The pebbles find this host through bodies(host).uri on the registry; keep it current (a transaction, only with ANNOUNCE=1)."""
    if not (ANNOUNCE and PUBLIC_URL): log('announce: off' + ('' if ANNOUNCE else ' (ANNOUNCE != 1)')); return
    try:
        b = reg.body(reg.address)
        if b['uri'] != PUBLIC_URL: reg.register_body(b['name'] or 'Brain host', PUBLIC_URL); log(f'announced {PUBLIC_URL} as the Brain host body {reg.address}')
        else: log(f'registry already points at {PUBLIC_URL}')
    except Exception as e: log('announce failed:', repr(e)[:200])


# ------------------------------------------------------------------ children
def stale_pid(state_dir):
    """A server.py left behind by a previous host (pidfile in the fly's state dir): stop it before starting a new one on the same port."""
    p = os.path.join(state_dir, 'server.pid')
    try:
        pid = int(open(p).read().strip()); cmd = open(f'/proc/{pid}/cmdline', 'rb').read()
        if b'server.py' in cmd: return pid
    except Exception: pass
    return None


def port_free(port):
    """Could a child bind this port the way aiohttp does (every interface, SO_REUSEADDR)? False for any port something on this box listens on,
    whichever interface it chose (Tor's 127.0.0.1:9050 blocks 0.0.0.0:9050 too)."""
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try: s.bind(('0.0.0.0', port)); return True
    except OSError: return False
    finally: s.close()


def pick_port(fid, taken=(), free=port_free):
    """The port for fly `fid`'s child: PORT_BASE + id when free and not `taken` (the ports of the other children, bound or still loading their
    brain), else the first such port in PORT_SPARE. A child that could not bind would exit and be restarted with backoff forever, loading the
    whole brain each time, and the fly would never be hosted (fly #50 with Tor on 9050)."""
    p = PORT_BASE + fid
    if p not in taken and free(p): return p
    for p in range(*PORT_SPARE):
        if p not in taken and free(p): return p
    raise RuntimeError(f'no free port for fly #{fid} in {PORT_BASE + fid} or {PORT_SPARE}')


def child_env(fid, body, cls, threads, state_dir, port=None):
    """The child's environment. pebble: server.py as a remote body (no key). arena: server.py as the Arena body itself (BODY_KEY body_arena.key,
    hard-wired in server.py) with its own state dir and port and NO public url, so it never announces itself as the Arena's uri.
    `port` is what pick_port chose (PORT_BASE + id by default)."""
    port = port or PORT_BASE + fid
    env = {**os.environ, 'FLY_ID': str(fid), 'PORT': str(port), 'NUMBA_NUM_THREADS': str(threads), 'STATE': state_dir, 'SNAPS': SNAPS}
    for k in ('REMOTE_BODY', 'REMOTE_BODY_TEST', 'FLYHOST_TEST_BODY', 'FLYHOST_TEST_ENERGY', 'BODY_ADDR', 'ANNOUNCE', 'HOST_TEST_FLIES', 'HOST_CHILD_SCRIPT'): env.pop(k, None)
    if cls == 'arena': env['PUBLIC_URL'] = ''
    else: env.update({'REMOTE_BODY': '1', 'BODY_ADDR': body, 'PUBLIC_URL': f'{PUBLIC_URL}/fly/{fid}' if PUBLIC_URL else ''})
    return env, port


def start_child(fid, body, name, threads, cls='pebble'):
    state_dir = os.path.join(STATE_ROOT, f'state_{fid}'); os.makedirs(state_dir, exist_ok=True)
    pid = stale_pid(state_dir)
    if pid:
        log(f'fly #{fid}: stopping a stale brain (pid {pid}) first'); os.kill(pid, signal.SIGTERM)
        for _ in range(int(STOP_WAIT)):
            if not os.path.exists(f'/proc/{pid}'): break
            time.sleep(1)
    taken = {c['port'] for c in children.values() if c['id'] != fid and c['proc'].poll() is None}   # the other children's ports, bound or not yet (still loading the brain)
    port = pick_port(fid, taken); env, port = child_env(fid, body, cls, threads, state_dir, port)
    out = open(os.path.join(LOG_DIR, f'host_{fid}.log'), 'ab')
    proc = subprocess.Popen([sys.executable, CHILD_SCRIPT or os.path.join(HERE, 'server.py')], cwd=HERE, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    open(os.path.join(state_dir, 'server.pid'), 'w').write(str(proc.pid))
    log(f'fly #{fid}: {cls} brain started for {name} ({body[:10]}) on :{port}' + (f' ({PORT_BASE + fid} is taken)' if port != PORT_BASE + fid else '') + f', {threads} threads, pid {proc.pid}' + (' [stub child]' if CHILD_SCRIPT else ''))
    return {'id': fid, 'body': body, 'name': name, 'cls': cls, 'port': port, 'proc': proc, 'started': time.time(), 'health': {}, 'health_at': 0.0, 'dead_since': None, 'fails': 0, 'next_start': 0.0, 'restarts': 0}


async def stop_child(c, why):
    p = c['proc']
    if p.poll() is None:
        log(f"fly #{c['id']}: stopping the brain ({why})"); p.send_signal(signal.SIGTERM)
        for _ in range(int(STOP_WAIT * 2)):
            if p.poll() is not None: break
            await asyncio.sleep(0.5)
        if p.poll() is None: log(f"fly #{c['id']}: did not exit, killing"); p.kill()
    children.pop(c['id'], None)


async def child_health(session, c):
    try:
        async with session.get(f"http://127.0.0.1:{c['port']}/health", timeout=ClientTimeout(total=4)) as r: c['health'] = await r.json()
    except Exception as e:
        c['health'] = {'ok': False, 'error': repr(e)[:80]}
    c['health_at'] = time.time()


async def supervise(app):
    session = app['session']
    while True:
        try:
            total, recs, wanted = await asyncio.to_thread(scan_registry); scan.update(at=time.time(), total=total, error='')
            threads = max(4, THREADS // max(1, len(wanted)))
            for fid, (body, name, cls) in wanted.items():
                c = children.get(fid)
                if c and (c['body'].lower() != body.lower() or c['cls'] != cls): await stop_child(c, f'now the body is {body[:10]} ({cls})'); c = None
                if not c: children[fid] = await asyncio.to_thread(start_child, fid, body, name, threads, cls); continue
                if c['proc'].poll() is not None:   # crashed: restart with backoff
                    if time.time() >= c['next_start']:
                        rc = c['proc'].returncode; c['fails'] += 1; wait = min(300, 5 * 2 ** (c['fails'] - 1))
                        log(f"fly #{fid}: brain exited with {rc}; restart {c['fails']} (next after {wait:.0f} s)")
                        n = await asyncio.to_thread(start_child, fid, body, name, threads, cls); n.update(fails=c['fails'], next_start=time.time() + wait, restarts=c['restarts'] + 1); children[fid] = n
                elif c['fails'] and time.time() - c['started'] > 300 and c['health'].get('ok'): c['fails'] = 0
            for fid, c in list(children.items()):
                if fid in wanted:
                    if c['health'].get('alive') is False: c['dead_since'] = c['dead_since'] or time.time()
                    else: c['dead_since'] = None
                    continue
                f = recs.get(fid)
                if c['proc'].poll() is not None: children.pop(fid, None); log(f'fly #{fid}: brain gone, no longer wanted'); continue
                if f and f['alive'] and f['body'] != ZERO: await stop_child(c, f"the fly left for {f['body'][:10]}"); continue
                if f and f['alive'] and f['body'] == ZERO and c['health'].get('alive') is not False: await stop_child(c, 'the fly was released'); continue
                c['dead_since'] = c['dead_since'] or time.time()   # dead on chain (or the pebble released a dead one): keep /final around; an arena child reported the death itself
                grace = DEAD_GRACE if c['cls'] == 'pebble' else ARENA_DEAD_GRACE
                if time.time() - c['dead_since'] > grace: await stop_child(c, f'dead for {grace:.0f} s')
            await asyncio.gather(*(child_health(session, c) for c in children.values()))
        except Exception as e:
            scan['error'] = repr(e)[:160]; log('scan failed:', repr(e)[:160])
        await asyncio.sleep(SCAN_EVERY)


# ------------------------------------------------------------------ web: the proxy
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding'}


async def proxy(request):
    """/fly/<id>/<rest> → the child's /<rest>, for the protocol's public paths only. A child sees this proxy as 127.0.0.1, which is exactly what
    server.py's local-only routes (/admin/commit: a checkpoint and a commit transaction with the Arena key) trust, so anything outside PUBLIC is
    refused here and never reaches a child, whatever the method."""
    fid = int(request.match_info['id']); rest = request.match_info['rest']; c = children.get(fid)
    if rest not in PUBLIC: return web.json_response({'error': f'/{rest.split("/")[0]} is not a public path of a hosted fly'}, status=404, headers={'Access-Control-Allow-Origin': '*'})
    if not c or c['proc'].poll() is not None: return web.json_response({'error': f'no brain for fly #{fid} here'}, status=502, headers={'Access-Control-Allow-Origin': '*'})
    url = f"http://127.0.0.1:{c['port']}/{rest}" + (f'?{request.query_string}' if request.query_string else '')
    if rest == 'ws' and request.headers.get('Upgrade', '').lower() == 'websocket': return await proxy_ws(request, url)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    try:
        async with request.app['session'].request(request.method, url, headers=headers, data=await request.read(), allow_redirects=False, timeout=ClientTimeout(total=900)) as r:
            body = await r.read(); rh = {k: v for k, v in r.headers.items() if k.lower() not in HOP}
            return web.Response(status=r.status, body=body, headers=rh)
    except Exception as e:
        return web.json_response({'error': f'brain for fly #{fid} unreachable: {repr(e)[:80]}'}, status=502)


async def proxy_ws(request, url):
    ws_in = web.WebSocketResponse(heartbeat=20); await ws_in.prepare(request)
    try:
        async with request.app['session'].ws_connect(url, heartbeat=20) as ws_out:
            async def pump(src, dst):
                async for m in src:
                    if m.type == WSMsgType.TEXT: await dst.send_str(m.data)
                    elif m.type == WSMsgType.BINARY: await dst.send_bytes(m.data)
                    else: break
                await dst.close()
            await asyncio.gather(pump(ws_in, ws_out), pump(ws_out, ws_in), return_exceptions=True)
    except Exception as e:
        await ws_in.close(code=1011, message=repr(e)[:100].encode())
    return ws_in


async def index(request):
    flies = [{'id': c['id'], 'class': c['cls'], 'body': c['body'], 'name': c['name'], 'port': c['port'], 'up': c['proc'].poll() is None, 'since': c['started'], 'restarts': c['restarts'], 'dead_since': c['dead_since'], 'health': c['health'], 'health_at': c['health_at']} for c in sorted(children.values(), key=lambda c: c['id'])]
    classes = {k: sum(1 for c in children.values() if c['cls'] == k) for k in ('pebble', 'arena')}
    return web.json_response({'flies': flies, 'classes': classes, 'arena': ARENA_ADDR, 'arena_max': ARENA_MAX, 'url': PUBLIC_URL, 'host': reg.address, 'scan': scan, 'now': time.time()}, headers={'Access-Control-Allow-Origin': '*'})


async def on_startup(app):
    app['session'] = ClientSession(); app['super'] = asyncio.create_task(supervise(app)); asyncio.get_running_loop().run_in_executor(None, announce_url)


async def on_shutdown(app):
    app['super'].cancel()
    await asyncio.gather(*(stop_child(c, 'host shutting down') for c in list(children.values())))
    await app['session'].close()


def main():
    app = web.Application(); app.on_startup.append(on_startup); app.on_shutdown.append(on_shutdown)
    app.router.add_get('/', index); app.router.add_route('*', '/fly/{id:\\d+}/{rest:.*}', proxy)
    log(f'brain host {reg.address or "(no key)"} on :{HOST_PORT}, public url {PUBLIC_URL or "(none)"}, state under {STATE_ROOT}, snapshots {SNAPS}, arena {ARENA_ADDR[:10] if ARENA_ADDR else "(off)"} (skip {sorted(ARENA_SKIP)}, max {ARENA_MAX}), {THREADS} threads shared' + (f', only flies {sorted(ONLY_IDS)}' if ONLY_IDS else ''))
    if ARENA_OFF_REASON: log(f'arena class off ({ARENA_OFF_REASON}); only the HOST_TEST_FLIES hook can name an arena-class fly')
    if TEST_FLIES: log(f'*** TEST MODE: flies listed in {TEST_FLIES} are hosted as if a pebble (or the arena) had them; never run this in production ***')
    if CHILD_SCRIPT: log(f'*** TEST MODE: children run {CHILD_SCRIPT} instead of server.py; never run this in production ***')
    web.run_app(app, port=HOST_PORT, print=None, shutdown_timeout=STOP_WAIT + 5)


if __name__ == '__main__':
    main()
