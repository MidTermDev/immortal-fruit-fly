"""The Colony supervisor: flies living together in Minecraft (COLONY.md).

Modelled on brain/flyhost.py. Every 15 s it scans FlyRegistry for alive flies whose body is the Colony (key brain/body_colony.key) or whose
pendingBody is the Colony (those it accepts itself, then hosts), keeps for each hosted fly one `server.py --colony` brain (port 9500+id, state
brain/state_colony_<id>/) and one mineflayer agent (brain/colony/agent.mjs, the bot "fly<id>", which also serves the fly's prismarine-viewer on
port 9700+id under /fly/<id>/view), up to COLONY_MAX_FLIES at once (the rest wait in a queue), summons the bread a brain's pending feeds ask for
through RCON, and serves everything on COLONY_PORT: /colony/state, /fly/<id>/{frame,ws,state,health} (HTTP and WebSocket, proxied to the brain),
/fly/<id>/view/ (the fly's viewer), /view/ (the colony camera, brain/colony/tools/camera.mjs as "flycam" on port 9700). It starts the Paper server
through `brain/colony/tools/run_server.sh start` when that exists (detached, world setup applied by the script), whitelists the bots over RCON,
gives each fly its torches, and announces PUBLIC_URL as the Colony body with registerBody when ANNOUNCE=1. No tunnel: nginx on this box
terminates TLS for https://mc.immortalfly.app and proxies to :8125.

    PUBLIC_URL=https://mc.immortalfly.app COLONY_PORT=8125 ANNOUNCE=1 ../../.venv/bin/python colony.py      (run_colony.sh)

Transactions this process sends (only with ANNOUNCE=1 / COLONY_SEND=1): registerBody (the announcement) and accept(id). Commits, interactions
and deaths are the brains' own, with the same key and the shared send lock. Nothing else.

The Node processes (agent.mjs, tools/camera.mjs: another author's, see brain/colony/README.md) get their contract by environment:
  agent:  FLY_ID, NAME=fly<id>, BRAIN_WS=ws://127.0.0.1:<9500+id>/agent, SERVER_HOST, SERVER_PORT, VIEWER_PORT=<9700+id>, VIEWER_PREFIX=/fly/<id>/view
  camera: node tools/camera.mjs --port 9700 --prefix /view --name flycam (--host, --port-mc)
RCON credentials come from brain/colony/server/server.properties (rcon.port, rcon.password) overridden by brain/colony/server/rcon.txt (the
password the script generates; JSON or key=value lines are accepted too); they are never logged.
"""
import os, sys, json, time, signal, asyncio, subprocess, re, struct, hashlib, math
HERE = os.path.dirname(os.path.abspath(__file__)); BRAIN = os.path.dirname(HERE)
sys.path.insert(0, BRAIN)
from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
from registry import Registry, RPC as _RPC

COLONY_PORT = int(os.environ.get('COLONY_PORT', '8125'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', '')
ANNOUNCE = os.environ.get('ANNOUNCE') == '1'
SEND = os.environ.get('COLONY_SEND', '1' if ANNOUNCE else '0') == '1'     # accept(id) transactions; off in every test
SCAN_EVERY = float(os.environ.get('SCAN_EVERY', '15'))
MAX_FLIES = int(os.environ.get('COLONY_MAX_FLIES', '6'))
THREAD_BUDGET = int(os.environ.get('COLONY_THREADS', '28'))                 # NUMBA_NUM_THREADS per brain = max(4, budget // n)
STATE_ROOT = os.environ.get('STATE_ROOT', BRAIN); SNAPS = os.environ.get('SNAPS', os.path.join(BRAIN, 'snapshots')); LOG_DIR = os.environ.get('LOG_DIR', HERE)
ONLY_IDS = {int(x) for x in os.environ.get('COLONY_ONLY_IDS', '').split(',') if x.strip()}   # tests / operators: restrict which flies are hosted
DEAD_GRACE = float(os.environ.get('DEAD_GRACE', '120'))    # a dead fly's brain (and its bot) stay this long after the chain agrees it is dead
STOP_WAIT = 40.0            # seconds a brain gets to save its state on SIGTERM
ACCEPT_RETRY = 90.0         # seconds between accept attempts for one fly
KEY = os.path.join(BRAIN, 'body_colony.key'); ADDR_FILE = os.path.join(BRAIN, 'body_colony.address'); ZERO = '0x0000000000000000000000000000000000000000'
ADDR = open(ADDR_FILE).read().strip() if os.path.exists(ADDR_FILE) else ''
SERVER_DIR = os.path.join(HERE, 'server'); TOOLS = os.path.join(HERE, 'tools')
RUN_SERVER = os.path.join(TOOLS, 'run_server.sh'); AGENT = os.path.join(HERE, 'agent.mjs'); CAMERA = os.path.join(TOOLS, 'camera.mjs')
CAMERA_NAME = os.environ.get('CAMERA_NAME', 'flycam'); ALLOW_PLAYERS = [x.strip() for x in os.environ.get('ALLOW_PLAYERS', '').split(',') if x.strip()]
STOP_PAPER = os.environ.get('COLONY_STOP_PAPER', '1') == '1'   # stop the Paper server we started when the supervisor shuts down
MC_HOST = os.environ.get('MC_HOST', '127.0.0.1')
NO_PAPER = os.environ.get('COLONY_NO_PAPER') == '1'         # tests: never start the Paper server or the camera (RCON is still tried when configured)
BREAD_POINTS = 5            # 1 s of life per food point; bread = 5 (COLONY.md section 2)
PUBLIC_PATHS = frozenset(('frame', 'ws', 'state', 'health'))   # what /fly/<id>/ exposes of a brain, by exact name; /agent, /pending_drops, /dropped, /admin/*, /final stay local
SNAP_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')      # one plain snapshot file name (a hash and an extension): never '.', '..', a '/', a '%' or a '\'
ALLOW_NAMES = [CAMERA_NAME] + [n for n in ALLOW_PLAYERS if n != CAMERA_NAME]   # the camera bot and the people of ALLOW_PLAYERS: whitelisted over RCON, retried until done
reg = Registry(key_path=KEY if (os.path.exists(KEY) and (ANNOUNCE or SEND)) else None)
children = {}               # fly id -> child record
names = {}                  # fly id -> name
scan = {'at': 0.0, 'total': 0, 'error': '', 'queue': [], 'accept': [], 'host': []}
accepting = {}              # fly id -> last accept attempt (wall)
world = {'time': None, 'night': None, 'mobs': None, 'players': [], 'server': False, 'at': 0.0}
paper = {'proc': None, 'started': 0.0, 'missing': False, 'fails': 0, 'next': 0.0, 'owned': False, 'up': False}
camera = {'proc': None, 'next': 0.0, 'fails': 0, 'spectator': False}
allow = {'pending': list(ALLOW_NAMES), 'done': []}   # ALLOW_NAMES not yet / already on the whitelist (whitelist_allowed, every scan while any is pending)
state_cache = {'at': 0.0, 'data': None}
SECRET = re.compile(re.escape(_RPC.rstrip('/')) + r'/?') if _RPC.startswith('http') else None
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'}


def log(*a):
    s = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a); print(SECRET.sub('<rpc>', s) if SECRET else s, flush=True)


# ------------------------------------------------------------------ RCON (the Minecraft remote console: one short connection per command)
def rcon_config():
    """{host, port, password} from server.properties, overridden by rcon.txt; None when neither says anything."""
    cfg = {'host': MC_HOST, 'port': 25575, 'password': ''}; mc_port = 25565
    props = os.path.join(SERVER_DIR, 'server.properties')
    if os.path.exists(props):
        for line in open(props, errors='replace'):
            if '=' not in line or line.startswith('#'): continue
            k, v = line.strip().split('=', 1)
            if k == 'rcon.port' and v.isdigit(): cfg['port'] = int(v)
            elif k == 'rcon.password': cfg['password'] = v
            elif k == 'server-port' and v.isdigit(): mc_port = int(v)
    p = os.path.join(SERVER_DIR, 'rcon.txt')
    if os.path.exists(p):
        raw = open(p, errors='replace').read().strip()
        try:
            j = json.loads(raw); cfg.update({k: j[k] for k in ('host', 'port', 'password') if k in j})
        except ValueError:
            lines = [l.strip() for l in raw.splitlines() if l.strip() and not l.startswith('#')]
            if len(lines) == 1 and '=' not in lines[0] and ':' not in lines[0]: cfg['password'] = lines[0]
            else:
                for l in lines:
                    if '=' in l:
                        k, v = l.split('=', 1); k = k.strip().lower().replace('rcon_', '').replace('rcon.', ''); v = v.strip()
                        if k in ('host', 'port', 'password'): cfg[k] = int(v) if k == 'port' else v
                    elif ':' in l and l.count(':') == 2: h, po, pw = l.split(':', 2); cfg.update(host=h, port=int(po), password=pw)
    cfg['port'] = int(cfg['port']); cfg['mc_port'] = mc_port
    return cfg if cfg['password'] else None


async def rcon(command, timeout=6.0):
    """Runs one console command; returns the response text, or None when the server is unreachable / RCON is not configured."""
    cfg = rcon_config()
    if not cfg: return None
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(cfg['host'], cfg['port']), timeout)
    except Exception:
        return None
    try:
        async def send(pid, ptype, body):
            b = body.encode(); w.write(struct.pack('<iii', len(b) + 10, pid, ptype) + b + b'\x00\x00'); await w.drain()

        async def recv():
            head = await asyncio.wait_for(r.readexactly(4), timeout); (n,) = struct.unpack('<i', head)
            data = await asyncio.wait_for(r.readexactly(n), timeout); pid, ptype = struct.unpack('<ii', data[:8])
            return pid, ptype, data[8:-2].decode(errors='replace')
        await send(1, 3, cfg['password']); pid, _, _ = await recv()
        if pid == -1: log('rcon: authentication refused'); return None
        await send(2, 2, command); _, _, text = await recv()
        return text
    except Exception as e:
        return None
    finally:
        w.close()


async def rcon_write(command, timeout=6.0):
    """A command that changes the world (whitelist, give, gamemode, summon): skipped under COLONY_NO_PAPER (the tests read a world they do not own)."""
    if NO_PAPER: return None
    return await rcon(command, timeout)


def mc_port():
    cfg = rcon_config(); return cfg['mc_port'] if cfg else 25565


# ------------------------------------------------------------------ registry: which flies the Colony runs
def select_flies(recs, addr, max_flies, running=()):
    """The selection rule, pure so the tests can check it. `recs`: {id: fly record}. Alive flies whose body is the Colony come first (those already
    running keep their place, then by id), then alive flies whose pendingBody is the Colony (to accept), up to max_flies; everyone else waits.
    Returns {'host': ids to run now, 'accept': ids to accept (they get a slot once accepted), 'queue': [(id, why)]}."""
    a = str(addr).lower(); running = set(running)
    mine = sorted(int(f['id']) for f in recs.values() if f['alive'] and str(f['body']).lower() == a)
    pend = sorted(int(f['id']) for f in recs.values() if f['alive'] and str(f['body']).lower() != a and str(f['pendingBody']).lower() == a)
    order = [i for i in mine if i in running] + [i for i in mine if i not in running] + pend
    slots = order[:max(0, int(max_flies))]
    return {'host': [i for i in slots if i in mine], 'accept': [i for i in slots if i in pend],
            'queue': [(i, 'waiting for a slot') for i in mine if i not in slots] + [(i, 'assigned to the Colony; waiting for a slot') for i in pend if i not in slots]}


def scan_registry():
    n = reg.total(); recs = {f['id']: f for f in reg.flies(range(1, n + 1))}
    if ONLY_IDS: recs = {k: v for k, v in recs.items() if k in ONLY_IDS}
    return n, recs


def fly_name(fid):
    """The fly's name from the registry (a read; called from the scan thread, cached for good)."""
    if fid not in names:
        try: names[fid] = reg.c.functions.flyName(fid).call()
        except Exception: return f'fly #{fid}'
    return names[fid]


def name_of(fid):
    return names.get(fid, f'fly #{fid}')


def announce_url():
    """The site and the owners find the Colony through bodies(colony).uri on the registry; keep it current (a transaction, only with ANNOUNCE=1)."""
    if not (ANNOUNCE and PUBLIC_URL): log('announce: off' + ('' if ANNOUNCE else ' (ANNOUNCE != 1)')); return
    if not reg.address: log('announce: no key'); return
    try:
        b = reg.body(reg.address)
        if b['uri'] != PUBLIC_URL: reg.register_body(b['name'] or 'Colony', PUBLIC_URL); log(f'announced {PUBLIC_URL} as the Colony body {reg.address}')
        else: log(f'registry already points at {PUBLIC_URL}')
    except Exception as e: log('announce failed:', repr(e)[:200])


def accept_fly(fid):
    """accept(id) with the Colony key: the fly becomes ours and its brain starts. Only with COLONY_SEND=1 (ANNOUNCE=1 implies it)."""
    if not SEND: log(f'fly #{fid} is assigned to the Colony; not accepting (COLONY_SEND=0)'); return False
    if not reg.address: log(f'fly #{fid}: cannot accept without the key'); return False
    try:
        rc = reg.accept(fid); log(f"accepted fly #{fid} ({fly_name(fid)}) tx {rc['transactionHash'].hex()}"); return True
    except Exception as e:
        log(f'fly #{fid}: accept failed:', repr(e)[:160]); return False


# ------------------------------------------------------------------ processes: the Paper server, the brains, the bots, the viewers
def stale_pid(state_dir):
    p = os.path.join(state_dir, 'server.pid')
    try:
        pid = int(open(p).read().strip()); cmd = open(f'/proc/{pid}/cmdline', 'rb').read()
        if b'server.py' in cmd: return pid
    except Exception: pass
    return None


def popen(args, logname, env=None, cwd=None):
    out = open(os.path.join(LOG_DIR, logname), 'ab')
    return subprocess.Popen(args, cwd=cwd or HERE, env=env or os.environ.copy(), stdout=out, stderr=subprocess.STDOUT, start_new_session=True)


def start_paper():
    """`tools/run_server.sh start`: detached (pidfile server/server.pid), returns once the world is up and set up; says "already running" when it is."""
    if not os.path.exists(RUN_SERVER):
        if not paper['missing']: paper['missing'] = True; log(f'Paper server: {os.path.relpath(RUN_SERVER, BRAIN)} is missing; the Colony serves without a world until it exists')
        return
    paper['missing'] = False; lp = os.path.join(LOG_DIR, 'colony_server.log'); paper['log_pos'] = os.path.getsize(lp) if os.path.exists(lp) else 0
    paper['proc'] = popen(['bash', RUN_SERVER, 'start'], 'colony_server.log', cwd=HERE); paper['started'] = time.time()
    log(f"Paper server: {os.path.relpath(RUN_SERVER, BRAIN)} start (pid {paper['proc'].pid})")


def paper_started():
    """Once the start script has returned: did we start the server (so we stop it on shutdown), or was it already running?"""
    try:
        with open(os.path.join(LOG_DIR, 'colony_server.log'), errors='replace') as f: f.seek(paper.get('log_pos', 0)); out = f.read()
    except Exception: out = ''
    paper['owned'] = 'already running' not in out
    log(f"Paper server: {'started by this supervisor' if paper['owned'] else 'was already running (left to its owner on shutdown)'}")


def start_brain(fid, threads):
    state_dir = os.path.join(STATE_ROOT, f'state_colony_{fid}'); os.makedirs(state_dir, exist_ok=True)
    pid = stale_pid(state_dir)
    if pid:
        log(f'fly #{fid}: stopping a stale brain (pid {pid}) first'); os.kill(pid, signal.SIGTERM)
        for _ in range(int(STOP_WAIT)):
            if not os.path.exists(f'/proc/{pid}'): break
            time.sleep(1)
    port = 9500 + fid
    env = {**os.environ, 'COLONY': '1', 'FLY_ID': str(fid), 'PORT': str(port), 'NUMBA_NUM_THREADS': str(threads), 'STATE': state_dir, 'SNAPS': SNAPS, 'PUBLIC_URL': f'{PUBLIC_URL}/fly/{fid}' if PUBLIC_URL else ''}
    for k in ('COLONY_TEST', 'COLONY_TEST_ENERGY', 'COLONY_TEST_PIN', 'REMOTE_BODY', 'REMOTE_BODY_TEST'): env.pop(k, None)
    proc = popen([sys.executable, os.path.join(BRAIN, 'server.py'), '--colony'], f'colony_{fid}.log', env=env, cwd=BRAIN)
    open(os.path.join(state_dir, 'server.pid'), 'w').write(str(proc.pid))
    log(f'fly #{fid}: brain started on :{port}, {threads} threads, pid {proc.pid}')
    return {'id': fid, 'port': port, 'proc': proc, 'started': time.time(), 'health': {}, 'health_at': 0.0, 'dead_since': None, 'fails': 0, 'next_start': 0.0, 'restarts': 0,
            'agent': None, 'agent_fails': 0, 'agent_next': 0.0, 'whitelisted': False, 'torches_given': False, 'drops': 0, 'threads': threads}


def start_agent(c):
    """The bot of one fly (agent.mjs): senses to the brain, motor back, and the fly's own viewer on 9700+id under /fly/<id>/view."""
    if not os.path.exists(AGENT): return None
    fid = c['id']
    env = {**os.environ, 'FLY_ID': str(fid), 'NAME': f'fly{fid}', 'BRAIN_WS': f"ws://127.0.0.1:{c['port']}/agent", 'SERVER_HOST': MC_HOST, 'SERVER_PORT': str(mc_port()), 'VIEWER_PORT': str(9700 + fid), 'VIEWER_PREFIX': f'/fly/{fid}/view'}
    p = popen(['node', AGENT], f'colony_{fid}_agent.log', env=env, cwd=HERE)
    log(f"fly #{fid}: agent started (bot fly{fid}, viewer :{9700 + fid}, pid {p.pid})"); return p


def start_camera():
    """The colony camera (tools/camera.mjs, bot flycam, spectator, top-down over the flies) serving /view/ on :9700."""
    if not os.path.exists(CAMERA): return None
    p = popen(['node', CAMERA, '--port', '9700', '--prefix', '/view', '--name', CAMERA_NAME, '--host', MC_HOST, '--port-mc', str(mc_port())], 'colony_camera.log', cwd=HERE)
    log(f'camera started on :9700 (bot {CAMERA_NAME}, pid {p.pid})'); return p


async def stop_proc(p, what, wait=STOP_WAIT):
    if p is None or p.poll() is not None: return
    p.send_signal(signal.SIGTERM)
    for _ in range(int(wait * 2)):
        if p.poll() is not None: return
        await asyncio.sleep(0.5)
    log(f'{what} did not exit, killing'); p.kill()


async def stop_child(c, why):
    log(f"fly #{c['id']}: stopping ({why})")
    await stop_proc(c['agent'], f"fly #{c['id']} agent", 10)
    if c['whitelisted']: await rcon_write(f"whitelist remove fly{c['id']}")   # with enforce-whitelist that also kicks a lingering bot
    await stop_proc(c['proc'], f"fly #{c['id']} brain")
    children.pop(c['id'], None)


async def child_health(session, c):
    try:
        async with session.get(f"http://127.0.0.1:{c['port']}/health", timeout=ClientTimeout(total=4)) as r: c['health'] = await r.json()
    except Exception as e:
        c['health'] = {'ok': False, 'error': repr(e)[:80]}
    c['health_at'] = time.time()


async def keep_bots(c):
    """The agent of a hosted fly: started once the brain answers and the bot is whitelisted, restarted with backoff when it exits."""
    if not c['health'].get('ok') or not c['whitelisted']: return
    now = time.time(); p = c['agent']
    if p is not None and p.poll() is None: return
    if now < c['agent_next']: return
    if p is not None:
        c['agent_fails'] += 1; c['agent_next'] = now + min(300, 5 * 2 ** (c['agent_fails'] - 1)); log(f"fly #{c['id']}: agent exited with {p.returncode}; restart {c['agent_fails']}")
    c['agent'] = start_agent(c)
    if c['agent'] is None and p is None and not c.get('agent_missing'):
        c['agent_missing'] = True; log(f"fly #{c['id']}: no agent ({os.path.relpath(AGENT, BRAIN)} is missing); the brain runs without a body")


async def whitelist(c):
    """Only the supervisor edits the whitelist (README: online-mode=false, enforce-whitelist=true); the fly gets its torches once it is in the world."""
    if not c['whitelisted']:
        r1 = await rcon_write(f"whitelist add fly{c['id']}")
        if r1 is None: return
        c['whitelisted'] = True; log(f"fly #{c['id']}: whitelisted fly{c['id']} ({r1.strip()[:60]})")
    if not c.get('torches_given') and f"fly{c['id']}" in world['players']:
        r = await rcon_write(f"give fly{c['id']} minecraft:torch 64")
        if r is not None: c['torches_given'] = True; log(f"fly #{c['id']}: 64 torches given ({r.strip()[:50]})")


async def whitelist_allowed():
    """The camera bot and ALLOW_PLAYERS. Paper boots long after start_paper() returns and RCON answers later still, so this runs every scan
    while any name is pending and only once RCON has answered (`whitelist add` is idempotent: "already whitelisted" is success too); a name
    stays pending until its own write succeeded. The camera bot is not started before its name is in (camera_due)."""
    if not allow['pending'] or not world['server']: return
    for name in list(allow['pending']):
        r = await rcon_write(f'whitelist add {name}')
        if r is None: return   # RCON went away again (or COLONY_NO_PAPER): the next scan tries again
        allow['pending'].remove(name); allow['done'].append(name); log(f'whitelisted {name} ({r.strip()[:60]})')


def rewhitelist():
    """After a Paper (re)start every name is pending again: harmless when whitelist.json survived, right when it did not."""
    allow['pending'] = list(ALLOW_NAMES); allow['done'] = []


def camera_due():
    """Start (or restart) the camera bot: a world that answers, its name on the whitelist, no camera process alive."""
    return not NO_PAPER and world['server'] and CAMERA_NAME in allow['done'] and (camera['proc'] is None or camera['proc'].poll() is not None)


async def deliver_drops(session, c):
    """A brain's pending feeds become bread near its bot: the supervisor alone can summon items (RCON). Deterministic offset from the feed's tx."""
    if not c['health'].get('ok') or not c['health'].get('hosting'): return
    try:
        async with session.get(f"http://127.0.0.1:{c['port']}/pending_drops", timeout=ClientTimeout(total=4)) as r: d = await r.json()
    except Exception: return
    for drop in d.get('drops', []):
        pos = d.get('pos') or [0, 64, 0]; h = hashlib.sha256(str(drop['tx']).encode()).digest()
        ang = int.from_bytes(h[:4], 'big') / 2 ** 32 * 2 * math.pi; rad = 5 + 5 * int.from_bytes(h[4:8], 'big') / 2 ** 32
        x, y, z = pos[0] + rad * math.cos(ang), pos[1] + 1.0, pos[2] + rad * math.sin(ang); n = int(drop.get('bread') or max(1, math.ceil(int(drop['seconds']) / BREAD_POINTS))); left = n; okc = 0
        while left > 0:
            k = min(64, left); r = await rcon_write(f'summon minecraft:item {x:.1f} {y:.1f} {z:.1f} {{Item:{{id:"minecraft:bread",count:{k}}}}}')
            if r is None or 'Unknown' in r or 'Incorrect' in r or 'Expected' in r: log(f"fly #{c['id']}: summon failed ({(r or 'no rcon')[:80]}); the drop stays pending"); break
            left -= k; okc += k
        if left > 0: return
        try:
            async with session.post(f"http://127.0.0.1:{c['port']}/dropped", json={'tx': drop['tx'], 'items': okc, 'at': [x, y, z]}, timeout=ClientTimeout(total=4)) as r: await r.read()
        except Exception: pass
        c['drops'] += 1; log(f"fly #{c['id']}: {okc} bread ({drop['seconds']} s) dropped at ({x:.0f},{y:.0f},{z:.0f}) for feed {str(drop['tx'])[:10]}")


async def read_world():
    t = await rcon('time query daytime')
    if t is None: world.update(server=False, at=time.time()); return
    m = re.search(r'(\d+)', t or ''); day = int(m.group(1)) if m else None
    world.update(server=True, time=day, night=(day is not None and 13000 <= day < 23000), at=time.time())
    lst = await rcon('list') or ''
    m = re.search(r'online:\s*(.*)$', lst.strip()); world['players'] = [p.strip() for p in m.group(1).split(',') if p.strip()] if m else []
    if CAMERA_NAME in world['players'] and not camera['spectator']:
        r = await rcon_write(f'gamemode spectator {CAMERA_NAME}')
        if r is not None: camera['spectator'] = True; log(f'{CAMERA_NAME} set to spectator')
    n = 0
    for kind in ('zombie', 'skeleton', 'spider'):
        r = await rcon(f'execute if entity @e[type=minecraft:{kind}]') or ''
        m = re.search(r'count:\s*(\d+)', r)
        if m: n += int(m.group(1))
    world['mobs'] = n


# ------------------------------------------------------------------ the supervisor loop
async def supervise(app):
    session = app['session']
    while True:
        try:
            if NO_PAPER: pass
            elif paper['proc'] is None and not paper['missing'] and time.time() >= paper['next']: start_paper()
            elif paper['proc'] is not None and paper['proc'].poll() is not None and not paper['up']:
                if paper['proc'].returncode == 0: paper['up'] = True; paper_started()
                elif time.time() >= paper['next']:
                    paper['fails'] += 1; paper['next'] = time.time() + min(600, 30 * 2 ** (paper['fails'] - 1)); log(f"Paper server start failed with {paper['proc'].returncode} (see colony_server.log); retry after {paper['next'] - time.time():.0f} s"); paper['proc'] = None
            if paper['up'] and not world['server'] and world['at'] and time.time() - world['at'] > 600 and time.time() - paper['started'] > 900:   # RCON dead for 10 min: start it again (the script says "already running" if it is)
                log('Paper server: RCON has been unreachable for 10 min; starting it again'); paper['up'] = False; paper['proc'] = None; paper['next'] = 0.0; rewhitelist()
            total, recs = await asyncio.to_thread(scan_registry); sel = select_flies(recs, ADDR, MAX_FLIES, children.keys())
            scan.update(at=time.time(), total=total, error='', queue=sel['queue'], accept=sel['accept'], host=sel['host'])
            for fid in sel['host'] + sel['accept'] + [i for i, _ in sel['queue']]:
                if fid not in names: await asyncio.to_thread(fly_name, fid)
            for fid in sel['accept']:
                if time.time() - accepting.get(fid, -1e9) < ACCEPT_RETRY: continue
                accepting[fid] = time.time()
                if await asyncio.to_thread(accept_fly, fid): recs[fid]['body'] = ADDR; sel['host'].append(fid)
            n = max(1, len(sel['host'])); threads = max(4, THREAD_BUDGET // n)
            for fid in sel['host']:
                c = children.get(fid)
                if not c: children[fid] = await asyncio.to_thread(start_brain, fid, threads); continue
                if c['proc'].poll() is not None:
                    if time.time() >= c['next_start']:
                        rc = c['proc'].returncode; c['fails'] += 1; wait = min(300, 5 * 2 ** (c['fails'] - 1))
                        log(f"fly #{fid}: brain exited with {rc}; restart {c['fails']} (next after {wait:.0f} s)")
                        await stop_proc(c['agent'], 'agent', 5)
                        nc = await asyncio.to_thread(start_brain, fid, threads); nc.update(fails=c['fails'], next_start=time.time() + wait, restarts=c['restarts'] + 1, whitelisted=c['whitelisted'], torches_given=c.get('torches_given', False)); children[fid] = nc
                elif c['fails'] and time.time() - c['started'] > 300 and c['health'].get('ok'): c['fails'] = 0
            for fid, c in list(children.items()):
                if fid in sel['host']:
                    c['dead_since'] = (c['dead_since'] or time.time()) if c['health'].get('alive') is False else None
                    continue
                f = recs.get(fid)
                if c['proc'].poll() is not None: children.pop(fid, None); log(f'fly #{fid}: brain gone, no longer wanted'); continue
                if f and f['alive'] and str(f['body']).lower() not in (ADDR.lower(), ZERO): await stop_child(c, f"the fly left for {f['body'][:10]}"); continue
                if f and f['alive'] and str(f['body']).lower() == ZERO and c['health'].get('alive') is not False: await stop_child(c, 'the fly was released'); continue
                if f and f['alive'] and str(f['body']).lower() == ADDR.lower(): await stop_child(c, 'over capacity: back to the queue'); continue
                c['dead_since'] = c['dead_since'] or time.time()
                if time.time() - c['dead_since'] > DEAD_GRACE: await stop_child(c, f'dead for {DEAD_GRACE:.0f} s')
            await asyncio.gather(*(child_health(session, c) for c in children.values()))
            await read_world()
            await whitelist_allowed()   # the camera and ALLOW_PLAYERS: retried every scan until each name is in (RCON answers well after start_paper returns)
            if camera_due() and time.time() >= camera['next']:
                if camera['proc'] is not None: camera['fails'] += 1; camera['next'] = time.time() + min(300, 5 * 2 ** (camera['fails'] - 1)); log(f"camera exited with {camera['proc'].returncode}; restart {camera['fails']}"); camera['spectator'] = False
                camera['proc'] = start_camera()
                if camera['proc'] is None and not camera.get('missing'): camera['missing'] = True; log(f'no camera ({os.path.relpath(CAMERA, BRAIN)} is missing)')
            for c in list(children.values()):
                await whitelist(c); await keep_bots(c); await deliver_drops(session, c)
        except Exception as e:
            scan['error'] = repr(e)[:160]; log('scan failed:', repr(e)[:160])
        await asyncio.sleep(SCAN_EVERY)


# ------------------------------------------------------------------ web: the state and the proxies
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding'}
NOT_PUBLIC = {'error': 'not a public path'}


def clean_path(rest):
    """No '.' or '..' segment, no '%' and no '\\' anywhere: the router hands us the path unquoted, and the client URL library would collapse
    `snapshots/../admin/commit` (or `%2e%2e`) into a child's local-only route (the child trusts 127.0.0.1, which is this proxy)."""
    return '%' not in rest and '\\' not in rest and all(s not in ('.', '..') for s in rest.split('/'))


def public_path(rest):
    """The child path a public /fly/<id>/<rest> may reach, or None: an exact member of PUBLIC_PATHS, or `snapshots/` with at most one plain
    file name after it (SNAP_NAME). Nothing else, whatever it starts with: /agent, /pending_drops, /dropped, /admin/*, /final stay local."""
    if not clean_path(rest): return None
    if rest in PUBLIC_PATHS: return rest
    if rest in ('snapshots', 'snapshots/'): return 'snapshots/'
    if rest.startswith('snapshots/') and SNAP_NAME.fullmatch(rest[len('snapshots/'):]): return rest
    return None


def forwarded(request):
    """X-Forwarded-For with this hop appended: a forwarded request is never local, and server.py's local-only routes refuse one even from 127.0.0.1."""
    prev = request.headers.get('X-Forwarded-For', '').strip()
    return (prev + ', ' if prev else '') + str(request.remote)


async def proxy_to(request, port, path):
    if not clean_path(path): return web.json_response(NOT_PUBLIC, status=404, headers=CORS)   # every caller checks first; this is the last line
    url = f'http://127.0.0.1:{port}/{path}' + (f'?{request.query_string}' if request.query_string else '')
    if request.headers.get('Upgrade', '').lower() == 'websocket': return await proxy_ws(request, url)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}; headers['X-Forwarded-For'] = forwarded(request)
    # ask the upstream for an uncompressed body: the viewer's express answers a browser's "br" with Brotli, which aiohttp
    # cannot decode (502 for the 1.2 MB viewer bundle); nginx compresses on the way out anyway
    headers['Accept-Encoding'] = 'identity'
    try:
        async with request.app['session'].request(request.method, url, headers=headers, data=await request.read(), allow_redirects=False, timeout=ClientTimeout(total=900)) as r:
            body = await r.read(); rh = {k: v for k, v in r.headers.items() if k.lower() not in HOP and k.lower() not in ('content-encoding', 'content-length')}; rh.update(CORS)
            return web.Response(status=r.status, body=body, headers=rh)
    except Exception as e:
        return web.json_response({'error': f'upstream on :{port} unreachable: {repr(e)[:80]}'}, status=502, headers=CORS)


async def proxy_ws(request, url):
    ws_in = web.WebSocketResponse(heartbeat=20); await ws_in.prepare(request)   # cross-origin upgrades are accepted: the site lives on another domain
    try:
        async with request.app['session'].ws_connect(url, heartbeat=20, headers={'X-Forwarded-For': forwarded(request)}) as ws_out:
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


async def fly_proxy(request):
    fid = int(request.match_info['id']); rest = request.match_info['rest']; c = children.get(fid)
    if not clean_path(rest): return web.json_response(NOT_PUBLIC, status=404, headers=CORS)
    if rest == 'view' or rest.startswith('view/'): return await proxy_to(request, 9700 + fid, f'fly/{fid}/{rest}')   # the viewer serves under its prefix (VIEWER_PREFIX=/fly/<id>/view)
    path = public_path(rest)   # decided before the child lookup: a refused path is 404 whether or not the fly is here
    if path is None: return web.json_response(NOT_PUBLIC, status=404, headers=CORS)
    if not c or c['proc'].poll() is not None: return web.json_response({'error': f'no brain for fly #{fid} here'}, status=502, headers=CORS)
    return await proxy_to(request, c['port'], path)


async def view_proxy(request):
    rest = request.match_info.get('rest', '')   # '/view' itself has no rest
    if not clean_path(rest): return web.json_response(NOT_PUBLIC, status=404, headers=CORS)
    return await proxy_to(request, 9700, 'view/' + rest)   # the camera serves under /view (--prefix /view)


async def colony_state(request):
    """Every fly (position, mode, energy, last event, torches…), the queue and the world, for the site's /colony page (cached 1 s)."""
    if state_cache['data'] and time.time() - state_cache['at'] < 1.0: return web.json_response(state_cache['data'], headers=CORS)
    session = request.app['session']

    async def frame(c):
        try:
            async with session.get(f"http://127.0.0.1:{c['port']}/frame", timeout=ClientTimeout(total=1.5)) as r: return await r.json()
        except Exception: return None
    kids = sorted(children.values(), key=lambda c: c['id']); frames = await asyncio.gather(*(frame(c) for c in kids))
    flies = []
    for c, fr in zip(kids, frames):
        fr = fr or {}; ev = fr.get('events') or []
        flies.append({'id': c['id'], 'name': name_of(c['id']), 'up': c['proc'].poll() is None, 'hosting': c['health'].get('hosting'), 'alive': fr.get('alive', c['health'].get('alive')), 'realtime': fr.get('realtime'),
                      'pos': fr.get('pos'), 'yaw': fr.get('yaw'), 'mode': fr.get('mode'), 'energy': fr.get('energy'), 'age_s': (fr.get('t_ms') or 0) / 1000, 'generation': fr.get('generation'),
                      'last_event': ev[-1][1] if ev else None, 'events': ev[-5:], 'torches': fr.get('torches') or [], 'food': fr.get('foodItems') or [], 'mobs': fr.get('mobs') or [], 'flies_near': fr.get('flies') or [],
                      'motor': fr.get('motor'), 'agent': fr.get('agent'), 'night': fr.get('night'), 'light': fr.get('light'), 'ate': fr.get('ate'), 'jumps': fr.get('jumps'), 'hits': fr.get('hits'), 'chain': fr.get('chain'),
                      'port': c['port'], 'viewer': f'/fly/{c["id"]}/view/', 'ws': f'/fly/{c["id"]}/ws', 'since': c['started'], 'restarts': c['restarts'], 'dead_since': c['dead_since'], 'threads': c['threads'], 'health_ok': c['health'].get('ok')})
    data = {'colony': ADDR, 'url': PUBLIC_URL, 'max_flies': MAX_FLIES, 'flies': flies, 'queue': [{'id': i, 'name': name_of(i), 'why': why} for i, why in scan['queue']] + [{'id': i, 'name': name_of(i), 'why': 'assigned to the Colony; accepting'} for i in scan['accept'] if i not in children],
            'world': {**world, 'paper': paper['up'], 'paper_owned': paper['owned'], 'camera': camera['proc'] is not None and camera['proc'].poll() is None, 'camera_whitelisted': CAMERA_NAME in allow['done'], 'viewer': '/view/'}, 'scan': {k: v for k, v in scan.items() if k in ('at', 'total', 'error')}, 'now': time.time()}
    state_cache.update(at=time.time(), data=data)
    return web.json_response(data, headers=CORS)


async def options(request):
    return web.Response(status=204, headers=CORS)


async def on_startup(app):
    app['session'] = ClientSession(); app['super'] = asyncio.create_task(supervise(app)); asyncio.get_running_loop().run_in_executor(None, announce_url)


async def on_shutdown(app):
    app['super'].cancel()
    await asyncio.gather(*(stop_child(c, 'colony shutting down') for c in list(children.values())))
    await stop_proc(camera['proc'], 'camera', 10)
    if paper['owned'] and STOP_PAPER and os.path.exists(RUN_SERVER):
        log('Paper server: stop'); p = popen(['bash', RUN_SERVER, 'stop'], 'colony_server.log', cwd=HERE); await stop_proc(p, 'Paper server stop script', 90)
    await app['session'].close()


def main():
    if not ADDR: log('no brain/body_colony.address; refusing'); sys.exit(2)
    app = web.Application(); app.on_startup.append(on_startup); app.on_shutdown.append(on_shutdown)
    app.router.add_get('/', colony_state); app.router.add_get('/colony/state', colony_state); app.router.add_route('OPTIONS', '/{tail:.*}', options)
    app.router.add_route('*', '/fly/{id:\\d+}/{rest:.*}', fly_proxy); app.router.add_route('*', '/view/{rest:.*}', view_proxy); app.router.add_route('*', '/view', view_proxy)
    log(f'Colony {ADDR} on :{COLONY_PORT}, public url {PUBLIC_URL or "(none)"}, up to {MAX_FLIES} flies, {THREAD_BUDGET} threads shared, state under {STATE_ROOT}, snapshots {SNAPS}, sends {"on" if SEND else "off"}' + (f', only flies {sorted(ONLY_IDS)}' if ONLY_IDS else ''))
    web.run_app(app, port=COLONY_PORT, print=None, shutdown_timeout=STOP_WAIT + 70)


if __name__ == '__main__':
    main()
