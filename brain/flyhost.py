"""The brain host: a whole brain for every fly whose body is a pebble (brain/HOST_PROTOCOL.md).

Every 15 s it scans FlyRegistry for alive flies whose body is a registered body named "Pebble …", keeps one
`server.py` (REMOTE_BODY=1) per such fly, proxies /fly/<id>/… (HTTP and WebSocket) to it, and announces its
public origin as the body "Brain host" (key brain/body_host.key) so the pebbles and the site can find it.
It never sends a transaction except that announcement, and only with ANNOUNCE=1.

    ANNOUNCE=1 PUBLIC_URL=https://… ../.venv/bin/python flyhost.py      (run_host.sh: with a cloudflared tunnel)
"""
import os, sys, json, time, signal, asyncio, subprocess, re
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
STOP_WAIT = 40.0            # seconds a child gets to save its state on SIGTERM
KEY = os.path.join(HERE, 'body_host.key'); ZERO = '0x0000000000000000000000000000000000000000'
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


def scan_registry():
    """Every fly's record, and which of them a pebble is running: {id: (body, pebble name)}."""
    n = reg.total(); recs = {f['id']: f for f in reg.flies(range(1, n + 1))}; wanted = {}
    for fid, f in recs.items():
        if not f['alive'] or f['body'] == ZERO or (ONLY_IDS and fid not in ONLY_IDS): continue
        name = body_name(f['body'])
        if name.startswith('Pebble'): wanted[fid] = (f['body'], name)
    if TEST_FLIES:
        try: extra = json.load(open(TEST_FLIES))
        except Exception: extra = {}
        for k, body in extra.items():
            if int(k) in recs and recs[int(k)]['alive']: wanted[int(k)] = (body, 'Pebble (test)')
    return n, recs, wanted


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


def start_child(fid, body, name, threads):
    state_dir = os.path.join(STATE_ROOT, f'state_{fid}'); os.makedirs(state_dir, exist_ok=True)
    pid = stale_pid(state_dir)
    if pid:
        log(f'fly #{fid}: stopping a stale brain (pid {pid}) first'); os.kill(pid, signal.SIGTERM)
        for _ in range(int(STOP_WAIT)):
            if not os.path.exists(f'/proc/{pid}'): break
            time.sleep(1)
    port = 9000 + fid
    env = {**os.environ, 'REMOTE_BODY': '1', 'FLY_ID': str(fid), 'BODY_ADDR': body, 'PORT': str(port), 'NUMBA_NUM_THREADS': str(threads), 'STATE': state_dir, 'SNAPS': SNAPS, 'PUBLIC_URL': f'{PUBLIC_URL}/fly/{fid}' if PUBLIC_URL else ''}
    env.pop('REMOTE_BODY_TEST', None); env.pop('FLYHOST_TEST_BODY', None)
    out = open(os.path.join(LOG_DIR, f'host_{fid}.log'), 'ab')
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py')], cwd=HERE, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    open(os.path.join(state_dir, 'server.pid'), 'w').write(str(proc.pid))
    log(f'fly #{fid}: brain started for {name} ({body[:10]}) on :{port}, {threads} threads, pid {proc.pid}')
    return {'id': fid, 'body': body, 'name': name, 'port': port, 'proc': proc, 'started': time.time(), 'health': {}, 'health_at': 0.0, 'dead_since': None, 'fails': 0, 'next_start': 0.0, 'restarts': 0}


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
            threads = max(4, 16 // max(1, len(wanted)))
            for fid, (body, name) in wanted.items():
                c = children.get(fid)
                if c and c['body'].lower() != body.lower(): await stop_child(c, f'now the body is {body[:10]}'); c = None
                if not c: children[fid] = await asyncio.to_thread(start_child, fid, body, name, threads); continue
                if c['proc'].poll() is not None:   # crashed: restart with backoff
                    if time.time() >= c['next_start']:
                        rc = c['proc'].returncode; c['fails'] += 1; wait = min(300, 5 * 2 ** (c['fails'] - 1))
                        log(f"fly #{fid}: brain exited with {rc}; restart {c['fails']} (next after {wait:.0f} s)")
                        n = await asyncio.to_thread(start_child, fid, body, name, threads); n.update(fails=c['fails'], next_start=time.time() + wait, restarts=c['restarts'] + 1); children[fid] = n
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
                c['dead_since'] = c['dead_since'] or time.time()   # dead on chain (or the pebble released a dead one): keep /final around
                if time.time() - c['dead_since'] > DEAD_GRACE: await stop_child(c, f'dead for {DEAD_GRACE:.0f} s')
            await asyncio.gather(*(child_health(session, c) for c in children.values()))
        except Exception as e:
            scan['error'] = repr(e)[:160]; log('scan failed:', repr(e)[:160])
        await asyncio.sleep(SCAN_EVERY)


# ------------------------------------------------------------------ web: the proxy
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding'}


async def proxy(request):
    fid = int(request.match_info['id']); rest = request.match_info['rest']; c = children.get(fid)
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
    flies = [{'id': c['id'], 'body': c['body'], 'name': c['name'], 'port': c['port'], 'up': c['proc'].poll() is None, 'since': c['started'], 'restarts': c['restarts'], 'dead_since': c['dead_since'], 'health': c['health'], 'health_at': c['health_at']} for c in sorted(children.values(), key=lambda c: c['id'])]
    return web.json_response({'flies': flies, 'url': PUBLIC_URL, 'host': reg.address, 'scan': scan, 'now': time.time()}, headers={'Access-Control-Allow-Origin': '*'})


async def on_startup(app):
    app['session'] = ClientSession(); app['super'] = asyncio.create_task(supervise(app)); asyncio.get_running_loop().run_in_executor(None, announce_url)


async def on_shutdown(app):
    app['super'].cancel()
    await asyncio.gather(*(stop_child(c, 'host shutting down') for c in list(children.values())))
    await app['session'].close()


def main():
    app = web.Application(); app.on_startup.append(on_startup); app.on_shutdown.append(on_shutdown)
    app.router.add_get('/', index); app.router.add_route('*', '/fly/{id:\\d+}/{rest:.*}', proxy)
    log(f'brain host {reg.address or "(no key)"} on :{HOST_PORT}, public url {PUBLIC_URL or "(none)"}, state under {STATE_ROOT}, snapshots {SNAPS}' + (f', only flies {sorted(ONLY_IDS)}' if ONLY_IDS else ''))
    if TEST_FLIES: log(f'*** TEST MODE: flies listed in {TEST_FLIES} are hosted as if a pebble had them; never run this in production ***')
    web.run_app(app, port=HOST_PORT, print=None, shutdown_timeout=STOP_WAIT + 5)


if __name__ == '__main__':
    main()
