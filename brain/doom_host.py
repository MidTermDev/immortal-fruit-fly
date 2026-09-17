"""The DOOM body service: plays every fly its owner assigned to DOOM, one session at a time.

Every 30 s it scans FlyRegistry for alive flies whose `pendingBody` is the DOOM body (key brain/body_doom.key) or
that DOOM still holds from an interrupted session, queues them oldest assignment first, and runs `doom.py` for the
first one: doom.py takes custody (instantiates the brain from IPFS, `accept`), plays `DOOM_SESSION_MIN` minutes with
every decision on-chain and commits the brain at the end with no hand-back (`--hand-back none`: `accept` cleared
`pendingBody`, and an assign to DOOM itself would set it again, which `release` never clears). This host then posts one
`doom` interaction summarising the session and `release`s the fly: dormant, alive, no pending assignment, the owner
can assign it again. Sessions live under brain/doom_sessions/<id>_<ts>/ (doom.log, run.json, doom_fly.mp4) and are
listed in brain/doom_sessions/index.json.

Sessions before this host handed the fly back to DOOM, so their flies still carry `pendingBody == DOOM` (`release`
leaves it as it was): a pending assignment counts only when the latest `Assigned(id, DOOM)` event was not sent by
DOOM itself. The owner's assignments are taken, those leftovers are not. A fly is never accepted unless DOOM can
actually be played here and its brain can be preserved (ViZDoom, ffmpeg, cast, the core key, the circuit and the
Pinata pin path every commit goes through are checked before every session); if not, it stays pending and the reason
is logged.

    ../.venv/bin/python doom_host.py                 (run_doom_host.sh: pidfile, log)
    DOOM_DRY=1 ../.venv/bin/python doom_host.py --once   dry run: reads mainnet, says what it would take, no subprocess, no tx
"""
import os, sys, json, time, signal, subprocess, argparse, re, shutil, threading, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
sys.path.insert(0, HERE)
from registry import Registry, RPC as _RPC
from web3 import Web3

KEY = os.environ.get('DOOM_KEY', os.path.join(HERE, 'body_doom.key'))
DOOM_ADDR = Web3.to_checksum_address(os.environ.get('DOOM_ADDR') or open(os.path.join(HERE, 'body_doom.address')).read().strip())
SESSIONS = os.environ.get('DOOM_SESSIONS', os.path.join(HERE, 'doom_sessions')); INDEX = os.path.join(SESSIONS, 'index.json')
LOGFILE = os.environ.get('DOOM_LOG', os.path.join(HERE, 'doom_host.log'))
SCAN_EVERY = float(os.environ.get('DOOM_SCAN_EVERY', '30'))
SESSION_MIN = float(os.environ.get('DOOM_SESSION_MIN', '5'))
THREADS = os.environ.get('DOOM_THREADS', '12')          # the earlier sessions ran with 14; the arena and the pebble brains share the rest of the machine
DRY = os.environ.get('DOOM_DRY') == '1'
FROM_BLOCK = int(os.environ.get('DOOM_FROM_BLOCK', '122001000'))   # the registry's deploy block: Assigned events are scanned from here once, then incrementally
STOP_GRACE = float(os.environ.get('DOOM_STOP_GRACE', '120'))      # on SIGTERM, how long a running session may go on before it is terminated
SESSION_EXTRA = float(os.environ.get('DOOM_SESSION_EXTRA', '900'))   # beyond the session minutes: brain start, IPFS fetch, final commit and pins
RETRY_AFTER = float(os.environ.get('DOOM_RETRY_AFTER', '600')); MAX_FAILS = int(os.environ.get('DOOM_MAX_FAILS', '3'))
PREFLIGHT_TTL = 600.0
DOOM_SCRIPT = os.environ.get('DOOM_SCRIPT', os.path.join(HERE, 'doom.py'))   # tests only: a stub in place of doom.py
ZERO = '0x0000000000000000000000000000000000000000'
SECRET = re.compile(re.escape(_RPC.rstrip('/')) + r'/?') if _RPC.startswith('http') else None

reg = Registry(key_path=KEY if (os.path.exists(KEY) and not DRY) else None)
if reg.address and reg.address.lower() != DOOM_ADDR.lower(): raise SystemExit(f'{KEY} is not the DOOM body {DOOM_ADDR}')
stopping = threading.Event(); stop_at = {'t': 0.0}
current = {'proc': None, 'id': None}
assigned = {}               # fly id -> {block, by, tx}: the latest Assigned(id, DOOM) event
scanned = {'to': FROM_BLOCK - 1}
fails = {}                  # fly id -> consecutive failed sessions
unfinished = {}             # fly id -> index entry of a finished session whose summary/release still has to go through
blocked = {}                # fly id -> retry not before (unix s)
preflight = {'ok': None, 'why': '', 'at': 0.0}


def log(*a):
    s = time.strftime('%Y-%m-%d %H:%M:%S ') + ' '.join(str(x) for x in a)
    if SECRET: s = SECRET.sub('<rpc>', s)
    print(s, flush=True)
    if LOGFILE:
        try:
            with open(LOGFILE, 'a') as f: f.write(s + '\n')
        except Exception: pass


# ------------------------------------------------------------------ selection (pure: unit-tested with a fake snapshot)
def select_queue(recs, assigned, doom, blocked=None, now=None):
    """Which flies DOOM should play, in order: flies it still holds (an interrupted session) first, then pending assignments oldest first.
    `recs`: {id: fly record}; `assigned`: {id: {'block', 'by'}} the latest Assigned(id, DOOM) per fly. A pending fly whose latest assignment
    was sent by DOOM itself is a hand-back that `release` left behind, not a new assignment; one with no known assignment waits for the scan."""
    doom = doom.lower(); now = time.time() if now is None else now; out = []
    for fid, f in recs.items():
        if not f['alive']: continue
        if blocked and blocked.get(fid, 0) > now: continue
        if str(f['body']).lower() == doom: out.append((0, 0, fid, 'in DOOM custody (left over from an interrupted session)'))
        elif str(f['pendingBody']).lower() == doom:
            a = assigned.get(fid)
            if a is None or str(a['by']).lower() == doom: continue
            out.append((1, int(a['block']), fid, f"assigned at block {a['block']} by {str(a['by'])[:10]}"))
    out.sort(); return [(fid, why) for _, _, fid, why in out]


def session_stats(run):
    """decisions, kills across all lives, the best life (kills), lives, commits, core ticks from a doom.py run.json.
    KILLCOUNT is per life in ViZDoom (it resets when the fly dies and a new episode starts), so lives are cut where it drops."""
    decs = run.get('decisions') or []; ks = [int(d.get('kills', 0)) for d in decs] + [int(run.get('kills', 0))]
    tot = best = prev = 0
    for k in ks:
        if k < prev: tot += prev; best = max(best, prev)
        prev = k
    tot += prev; best = max(best, prev)
    return {'decisions': len(decs), 'kills': tot, 'best_life': best, 'episodes': int(run.get('episodes', 0)), 'commits': len(run.get('commits') or []), 'core_ticks': len(run.get('core_txs') or []), 'final_hash': run.get('final_hash')}


# ------------------------------------------------------------------ can DOOM be played here?
VIZDOOM_CHECK = """
import os, sys, vizdoom as vzd
g = vzd.DoomGame(); g.load_config(os.path.join(vzd.scenarios_path, 'defend_the_center.cfg'))
g.set_window_visible(False); g.set_screen_resolution(vzd.ScreenResolution.RES_640X480); g.set_screen_format(vzd.ScreenFormat.RGB24)
g.set_labels_buffer_enabled(True); g.set_render_hud(True); g.set_sound_enabled(False)
g.set_available_buttons([vzd.Button.TURN_LEFT_RIGHT_DELTA, vzd.Button.ATTACK]); g.set_mode(vzd.Mode.PLAYER); g.init(); g.new_episode()
s = g.get_state(); assert s is not None and s.screen_buffer.shape == (480, 640, 3), 'no frame'
g.close(); print('vizdoom ok')
"""


def cast_path():
    p = shutil.which('cast') or os.path.join(os.path.expanduser('~'), '.foundry', 'bin', 'cast')
    return p if os.path.exists(p) else None


PINATA_AUTH = 'https://api.pinata.cloud/data/testAuthentication'


def pinata_check(timeout=20):
    """(ok, why): the pin path every periodic commit and the final commit of a session go through (registry.Pinata.pin). A JWT must be
    configured (brain/pinata.env or PINATA_JWT) and Pinata must accept it now; otherwise every commit fails, the final commit raises, and the
    session's brain state would be discarded while its decision hashes stay on-chain. The token itself never appears in a message."""
    jwt = reg.pinata.jwt
    if not jwt: return False, 'no PINATA_JWT (brain/pinata.env): doom.py pins every commit to IPFS'
    try:
        req = urllib.request.Request(PINATA_AUTH, headers={'Authorization': f'Bearer {jwt}', 'User-Agent': 'curl/8'})
        with urllib.request.urlopen(req, timeout=timeout) as r: return (r.status == 200), ('' if r.status == 200 else f'Pinata auth answered HTTP {r.status}')
    except urllib.error.HTTPError as e: return False, f'Pinata refuses the JWT (HTTP {e.code}): commits could not be pinned'
    except Exception as e: return False, f'Pinata unreachable ({type(e).__name__}: {str(e)[:100]}): commits could not be pinned'


def check_doom(force=False):
    """(ok, why): everything a doom.py session needs, checked before a fly is accepted: ViZDoom starting headless, ffmpeg for the video,
    cast and the core key for the on-chain compass ticks, the DOOM body key, the circuit files, the fonts of the overlay, and the Pinata JWT
    accepted by Pinata (every commit pins the brain). Cached PREFLIGHT_TTL when everything passes, 120 s when not."""
    if not force and preflight['ok'] is not None and time.time() - preflight['at'] < (PREFLIGHT_TTL if preflight['ok'] else 120): return preflight['ok'], preflight['why']
    why = []
    if not os.path.exists(KEY): why.append(f'no DOOM body key {os.path.basename(KEY)}')
    if not os.path.exists(os.path.join(ROOT, 'deploy.txt')) and not os.environ.get('PRIVATE_KEY'): why.append('no ../deploy.txt (doom.py signs the FlyBrain core ticks with it)')
    for f in ('circuit.hex', 'params_v2.json'):
        if not os.path.exists(os.path.join(ROOT, 'contracts', 'data', f)): why.append(f'missing contracts/data/{f}')
    if not os.path.exists('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'): why.append('DejaVu fonts missing')
    if not shutil.which('ffmpeg'): why.append('ffmpeg not on PATH')
    if not cast_path(): why.append('cast (foundry) not found')
    pin_ok, pin_why = pinata_check()
    if not pin_ok: why.append(pin_why)
    if not why:
        try:
            pf = os.path.join(SESSIONS, '_preflight'); os.makedirs(pf, exist_ok=True)   # ViZDoom writes its ini and a _vizdoom/ dir into the cwd
            r = subprocess.run([sys.executable, '-c', VIZDOOM_CHECK], cwd=pf, capture_output=True, text=True, timeout=90)
            if r.returncode != 0 or 'vizdoom ok' not in r.stdout:
                tail = [l for l in (r.stdout + r.stderr).strip().split('\n') if l and 'pw.conf' not in l and 'ALSOFT' not in l][-3:]
                why.append('ViZDoom cannot start headless: ' + ' | '.join(tail)[:300])
        except Exception as e: why.append(f'ViZDoom check failed: {repr(e)[:160]}')
    preflight.update(ok=not why, why='; '.join(why), at=time.time())
    return preflight['ok'], preflight['why']


# ------------------------------------------------------------------ the registry
def update_assigned(head):
    """Assigned(id, DOOM, by) events since the last scan: the latest per fly decides whether a pending fly is a real assignment (and its age)."""
    frm = scanned['to'] + 1
    if frm > head: return
    for ev in reg.events('Assigned', frm, head, body=DOOM_ADDR):
        assigned[int(ev['id'])] = {'block': int(ev['block']), 'by': ev['by'], 'tx': ev['tx']}
    scanned['to'] = head


def scan():
    head = reg.w3.eth.block_number; n = reg.total()
    recs = {f['id']: f for f in reg.flies(range(1, n + 1))}
    update_assigned(head)
    return n, recs, select_queue(recs, assigned, DOOM_ADDR, {**blocked, **{fid: 10 ** 12 for fid in unfinished}})


# ------------------------------------------------------------------ the index
def load_index():
    try:
        with open(INDEX) as f: return json.load(f)
    except Exception: return []


def add_index_replace(idx):
    os.makedirs(SESSIONS, exist_ok=True); tmp = INDEX + '.tmp'
    with open(tmp, 'w') as f: json.dump(idx, f, indent=1)
    os.replace(tmp, INDEX)


def add_index(entry):
    """Appends the entry, or replaces the one with the same id and ts (a retried release updates its session)."""
    idx = load_index(); k = next((i for i, e in enumerate(idx) if e.get('id') == entry['id'] and e.get('ts') == entry['ts']), None)
    if k is None: idx.append(entry)
    else: idx[k] = entry
    add_index_replace(idx)


# ------------------------------------------------------------------ one session
def env_for_session(fid):
    env = {**os.environ, 'FLY_ID': str(fid), 'NUMBA_NUM_THREADS': str(THREADS)}
    c = cast_path()
    if c and not shutil.which('cast', path=env.get('PATH', '')): env['PATH'] = os.path.dirname(c) + os.pathsep + env.get('PATH', '')
    for k in ('DOOM_DRY',): env.pop(k, None)
    return env


def rel(path):
    """Paths in the index are relative to brain/ (the site can serve them); anything outside stays absolute."""
    r = os.path.relpath(path, HERE); return path if r.startswith('..') else r


def run_session(fid, why):
    """doom.py for one fly: custody, the session and the final commit (no hand-back) happen inside it; then the summary interaction and
    the release happen here. Returns the index entry."""
    ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()); out = os.path.join(SESSIONS, f'{fid}_{ts}'); os.makedirs(out, exist_ok=True)
    cmd = [sys.executable, DOOM_SCRIPT, '--minutes', str(SESSION_MIN), '--out', out, '--hand-back', 'none']   # the final commit only: no assign, so release leaves no pending body behind
    entry = {'id': fid, 'ts': ts, 'dir': rel(out), 'video': None, 'decisions': 0, 'kills': 0, 'best_life': 0, 'txs': 0, 'minutes': SESSION_MIN, 'why': why, 'status': 'running'}
    log(f'fly #{fid}: DOOM session starting ({why}): {SESSION_MIN:g} min, {THREADS} threads, out {entry["dir"]}')
    t0 = time.time(); logf = open(os.path.join(out, 'doom.log'), 'ab')
    proc = subprocess.Popen(cmd, cwd=HERE, env=env_for_session(fid), stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    current.update(proc=proc, id=fid); deadline = t0 + SESSION_MIN * 60 + SESSION_EXTRA; interrupted = False
    try:
        while proc.poll() is None:
            if stopping.is_set() and time.time() - stop_at['t'] > STOP_GRACE: interrupted = True; log(f'fly #{fid}: stopping: terminating the session after {STOP_GRACE:.0f} s of grace'); terminate(proc); break
            if time.time() > deadline: interrupted = True; log(f'fly #{fid}: session overran by {time.time() - deadline:.0f} s; terminating'); terminate(proc); break
            time.sleep(1)
    finally:
        current.update(proc=None, id=None); logf.close()
    rc = proc.returncode; run = None
    try:
        with open(os.path.join(out, 'run.json')) as fh: run = json.load(fh)
    except Exception: pass
    video = os.path.join(out, 'doom_fly.mp4')
    entry['video'] = rel(video) if os.path.exists(video) and os.path.getsize(video) > 0 else None
    entry['exit'] = rc; entry['seconds'] = round(time.time() - t0)
    if run: entry.update(session_stats(run)); entry['txs'] = entry['decisions'] + entry['commits'] + entry['core_ticks'] + 3 + (1 if 'assigned' in why else 0)   # + enter, final commit, leave, and accept for a pending assignment; the summary and the release are added below
    ok = rc == 0 and run is not None and not interrupted
    entry['status'] = 'ok' if ok else ('interrupted' if interrupted else f'failed (exit {rc})')
    log(f"fly #{fid}: doom.py exited {rc} after {entry['seconds']} s: {entry['status']}; decisions {entry['decisions']}, kills {entry['kills']} (best life {entry['best_life']}), video {entry['video'] or 'none'}")
    if ok: fails.pop(fid, None); blocked.pop(fid, None)
    elif not (interrupted and stopping.is_set()):
        fails[fid] = fails.get(fid, 0) + 1; blocked[fid] = time.time() + (RETRY_AFTER if fails[fid] < MAX_FAILS else 10 ** 12)
        log(f"fly #{fid}: failure {fails[fid]}/{MAX_FAILS}; " + (f'retry in {RETRY_AFTER:.0f} s' if fails[fid] < MAX_FAILS else 'parked until this host restarts'))
    if interrupted and stopping.is_set(): log(f'fly #{fid}: left in DOOM custody (host stopping); the next start resumes it as a left-over')
    elif not ok and entry['decisions'] == 0 and fails.get(fid, 0) < MAX_FAILS:
        # nothing happened for the fly: keep custody (it stays body == DOOM, a left-over the queue retries) and say nothing on-chain
        log(f'fly #{fid}: no decisions were made; keeping custody for the retry, no summary, no release')
    elif not finish_session(fid, entry, ok): unfinished[fid] = entry
    add_index(entry); return entry


def finish_session(fid, entry, ok):
    """Hand the fly back to its owner: the summary interaction while DOOM is still the body, then release. True when nothing is left to do
    (released, or not ours any more); False when the chain work failed and must be retried before any new session for this fly."""
    try:
        f = reg.fly(fid)
        if str(f['body']).lower() != DOOM_ADDR.lower():
            log(f"fly #{fid}: " + ('died during the session; nothing to release' if not f['alive'] else f"not in DOOM custody after the session (body {f['body'][:10]}, pending {f['pendingBody'][:10]}): nothing to release")); return True
        if 'summary_tx' not in entry:
            if ok: text = f"DOOM session over: {entry['episodes']} lives, {entry['kills']} kills (best life {entry['best_life']}), {entry['decisions']} decisions on-chain, {entry['commits']} brain commits, {entry['core_ticks']} core ticks in {entry['minutes']:g} min; released to its owner" + (f"; video {entry['video']}" if entry['video'] else '')
            else: text = f"DOOM session ended abnormally ({entry['status']}) after {entry['decisions']} decisions, {entry['kills']} kills; released to its owner"
            try: rc2 = reg.interaction(fid, 'doom', text[:512]); entry['summary_tx'] = rc2['transactionHash'].hex(); entry['txs'] += 1; log(f"fly #{fid}: summary interaction tx {entry['summary_tx']}")
            except Exception as e: log(f'fly #{fid}: summary interaction failed: {repr(e)[:160]}')
        rc3 = reg.release(fid); entry['release_tx'] = rc3['transactionHash'].hex(); entry['txs'] += 1
        f = reg.fly(fid); log(f"fly #{fid}: released tx {entry['release_tx']}; now body {f['body'][:10]} pending {f['pendingBody'][:10]} alive {f['alive']} energy {f['energy']}")
        if str(f['pendingBody']).lower() == DOOM_ADDR.lower(): log(f"fly #{fid}: pendingBody is still DOOM (a hand-back from a session before --hand-back none; release cannot clear it): the site shows it waiting for DOOM until its owner assigns it again")
        return True
    except Exception as e:
        log(f'fly #{fid}: post-session chain work failed: {repr(e)[:200]}; retried before any new session'); return False


def terminate(proc):
    try: os.killpg(proc.pid, signal.SIGTERM)
    except Exception: proc.terminate()
    for _ in range(30):
        if proc.poll() is not None: return
        time.sleep(0.5)
    try: os.killpg(proc.pid, signal.SIGKILL)
    except Exception: proc.kill()
    proc.wait()


# ------------------------------------------------------------------ the loop
def on_term(signum, _):
    if stopping.is_set():
        if current['proc'] is not None: log('second SIGTERM: terminating the session now'); stop_at['t'] = -1e12
        return
    stopping.set(); stop_at['t'] = time.time()
    log(f'SIGTERM: no new sessions' + (f"; fly #{current['id']}'s session may finish within {STOP_GRACE:.0f} s (a second SIGTERM ends it now)" if current['proc'] is not None else ''))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--once', action='store_true', help='one scan (and at most one session), then exit'); a = ap.parse_args()
    signal.signal(signal.SIGTERM, on_term); signal.signal(signal.SIGINT, on_term)
    os.makedirs(SESSIONS, exist_ok=True)
    log(f"DOOM host {DOOM_ADDR} ({'DRY RUN: no subprocess, no transaction' if DRY else 'key ' + os.path.basename(KEY)}): sessions of {SESSION_MIN:g} min, scan every {SCAN_EVERY:.0f} s, {THREADS} threads, sessions under {SESSIONS}, {len(load_index())} in the index")
    if DOOM_SCRIPT != os.path.join(HERE, 'doom.py'): log(f'*** TEST MODE: sessions run {DOOM_SCRIPT} instead of doom.py; never run this in production ***')
    ok, why = check_doom(force=True); log('DOOM playable here' if ok else f'DOOM unavailable: {why}')
    last_queue = None; unavailable = {'why': None, 'at': 0.0}; retry_at = {}
    while not stopping.is_set():
        try:
            for fid, e in list(unfinished.items()):   # a session ended but its summary/release did not go through: finish that first, never a new session
                if time.time() >= retry_at.get(fid, 0):
                    if finish_session(fid, e, e['status'] == 'ok'): unfinished.pop(fid, None); retry_at.pop(fid, None); add_index(e)
                    else: retry_at[fid] = time.time() + 120
            n, recs, queue = scan()
            if queue != last_queue:
                log(f'{n} flies; queue: ' + (', '.join(f'#{fid} ({why})' for fid, why in queue) if queue else 'empty')); last_queue = queue
            if queue:
                ok, why = check_doom()
                if not ok:
                    if why != unavailable['why'] or time.time() - unavailable['at'] > 600: log(f'DOOM unavailable, fly #{queue[0][0]} stays pending (never accepted): {why}'); unavailable.update(why=why, at=time.time())
                elif DRY: log(f'DRY RUN: would take fly #{queue[0][0]} ({queue[0][1]}) for a {SESSION_MIN:g} min session' + (f', then #{", #".join(str(f) for f, _ in queue[1:])}' if len(queue) > 1 else ''))
                else: run_session(*queue[0]); last_queue = None
        except Exception as e:
            log('scan failed:', repr(e)[:200])
        if a.once: break
        for _ in range(int(SCAN_EVERY * 2)):
            if stopping.is_set(): break
            time.sleep(0.5)
    log('DOOM host stopped')


if __name__ == '__main__':
    try: main()
    except SystemExit: raise
    except Exception as e:
        log('fatal:', repr(e)[:300]); raise
