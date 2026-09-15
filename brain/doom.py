"""DOOM, played by the whole fly brain, with every decision anchored on BNB Smart Chain.

  THE PLAYER  — all 139,248 neurons of the FlyWire connectome, the Shiu et al. 2024 model,
                running at real time. Enemies are presented to the brain the way the arena
                presents food and predators: an enemy's bearing drives the fruit-odor
                olfactory neurons of that antenna (the fly hunts it by scent), its looming
                drives the LC4 / LPLC2 detectors of that eye. Turning is read from DNa02 /
                DNa01 / the DNa population (left minus right); a giant-fiber (DNp01) or
                take-off (DNp02 / DNp11) spike pulls the trigger.
  THE CHAIN   — about once a second the FlyArcade contract records a hash of the entire
                brain state with the action it produced (turn, fire, kills, health), and
                the 155-neuron compass core (FlyBrain, fully on-chain) is cued with the
                same enemy bearing so real neurons fire inside the EVM in sync with the
                game; its bump is replayed locally, bit for bit, to draw the raster.

    ../.venv/bin/python doom.py --minutes 6 --out doom_run
"""
import os, sys, json, time, math, subprocess, argparse, threading, queue, re
import numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '14')
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, 'sim'))
import vizdoom as vzd
from PIL import Image, ImageDraw, ImageFont
from flysim import Circuit, FlyBrain as CoreSim, CH_CUE
from sim import WholeBrain, DT

BRAIN = '0xee80f8cB5309C572343c38b5D717283BBBb517c5'
ARCADE = os.environ.get('FLYARCADE', '0x3dE4fe3535dd9E1CC17b6718B985593e3E463279')
RPC = (open(os.path.join(HERE, 'rpc.txt')).read().strip() if os.path.exists(os.path.join(HERE, 'rpc.txt')) else 'https://bsc-dataseed.bnbchain.org')
PK = os.environ.get('PRIVATE_KEY') or ('0x' + open(os.path.join(ROOT, 'deploy.txt')).read().strip())
STEPS = 16; FPS = 10; W_VID, H_VID = 1280, 720
FOOD_GLOMERULI = ['DM1', 'DM4', 'VA2', 'DM2', 'VM2', 'DP1m']


def cast(*a, timeout=90):
    r = subprocess.run(['cast', *a], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0: raise RuntimeError(r.stderr.strip()[:240])
    return r.stdout.strip()


def s256(x): x = int(x); return x - (1 << 256) if x >= (1 << 255) else x


# ------------------------------------------------------------------ the whole brain as the player
class Player:
    def __init__(self):
        self.b = b = WholeBrain(); p = b.pops; side = b.side
        self.orn_l = np.concatenate([p[f'ORN_{g}'][side[p[f'ORN_{g}']] == 0] for g in FOOD_GLOMERULI]).astype(np.int32)
        self.orn_r = np.concatenate([p[f'ORN_{g}'][side[p[f'ORN_{g}']] == 1] for g in FOOD_GLOMERULI]).astype(np.int32)
        allorn = np.concatenate([v for k, v in p.items() if k.startswith('ORN_')]); self.orn_rest = np.setdiff1d(allorn, np.concatenate([self.orn_l, self.orn_r])).astype(np.int32)
        self.trigger = np.concatenate([p['DNp01_left'], p['DNp01_right'], p['DNp02_left'], p['DNp02_right'], p['DNp11_left'], p['DNp11_right']])
        self.readouts = ['DNa02_left', 'DNa02_right', 'DNa01_left', 'DNa01_right', 'DNa_left', 'DNa_right', 'DN_all', 'DNp01_left', 'DNp01_right', 'LC4_left', 'LC4_right', 'ALPN', 'KC', 'MBON']
        self.rates = {k: 0.0 for k in self.readouts}; self.slow = dict(self.rates); self.base = dict(self.rates)
        self.scene = {'scent_l': 0.0, 'scent_r': 0.0, 'loomL': 0.0, 'loomR': 0.0, 'sizeL': 0.0, 'sizeR': 0.0, 'lightL': 0.3, 'lightR': 0.3}
        self.steer = 0.0; self.fire_pending = 0; self.trigger_spikes = 0; self.chunk_ms = 50
        self.lock = threading.Lock(); self.running = True; self.hash_req = None
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        b = self.b; ms = self.chunk_ms
        a = 1 - math.exp(-ms / 60.0); asl = 1 - math.exp(-ms / 300.0); ab = 1 - math.exp(-ms / 8000.0); ast = 1 - math.exp(-ms / 150.0)
        while self.running:
            with self.lock: sc = dict(self.scene)
            rl, rr = 110 * sc['scent_l'], 110 * sc['scent_r']
            ids = [self.orn_l, self.orn_r, self.orn_rest, b.pops['R1-6_left'], b.pops['R1-6_right'], b.pops['LC4_left'], b.pops['LC4_right'], b.pops['LPLC2_left'], b.pops['LPLC2_right']]
            hz = [2 + rl, 2 + rr, 2, 3 + 25 * sc['lightL'], 3 + 25 * sc['lightR'], min(150, sc['loomL']), min(150, sc['loomR']), min(150, sc['sizeL']), min(150, sc['sizeR'])]
            b._ids = np.concatenate(ids).astype(np.int32); b._p = np.concatenate([np.full(len(i), h * DT / 1000, np.float32) for i, h in zip(ids, hz)]).astype(np.float32)
            tot, win, _, _ = b.run(ms, record=False)
            for r in self.readouts:
                inst = b.pop_rate(r, win, ms); self.rates[r] += a * (inst - self.rates[r]); self.slow[r] += asl * (inst - self.slow[r]); self.base[r] += ab * (self.slow[r] - self.base[r])
            d = lambda k: self.slow[k] - self.base[k]
            st = (d('DNa02_left') - d('DNa02_right')) + 0.6 * (d('DNa01_left') - d('DNa01_right')) + 12.0 * (d('DNa_left') - d('DNa_right'))
            self.steer += ast * (st - self.steer)
            g = int(win[self.trigger].sum()); self.trigger_spikes += g
            if g > 0: self.fire_pending += 1
            if self.hash_req is not None:
                self.hash_req['hash'] = b.state_hash(); self.hash_req['step'] = b.t; self.hash_req['spikes'] = b.total_spikes; self.hash_req = None

    def set_scene(self, enemies, light_l, light_r):
        """enemies: list of (bearing_rad [+ = left], size_deg, dsize_deg_per_s)."""
        cl = cr = loomL = loomR = sizeL = sizeR = 0.0
        for br, sz, dsz in enemies:
            w = min(1.0, sz / 12.0)                       # closer enemies smell stronger
            # bilateral scent, sharpened as in the arena (gain 8, clipped)
            k = max(-1.0, min(1.0, 8.0 * math.sin(br)))
            cl += w * (1 + k) / 2; cr += w * (1 - k) / 2
            if br > 0: loomL += 6.0 * max(0.0, dsz); sizeL += 4.0 * sz
            else: loomR += 6.0 * max(0.0, dsz); sizeR += 4.0 * sz
        with self.lock: self.scene.update(scent_l=min(1.2, cl), scent_r=min(1.2, cr), loomL=loomL, loomR=loomR, sizeL=sizeL, sizeR=sizeR, lightL=light_l, lightR=light_r)

    def take_fire(self):
        f = self.fire_pending > 0; self.fire_pending = 0; return f

    def snapshot_hash(self):
        req = {}; self.hash_req = req
        for _ in range(200):
            if self.hash_req is None and req: return req
            time.sleep(0.01)
        return req or {'hash': '0' * 64, 'step': self.b.t, 'spikes': self.b.total_spikes}


# ------------------------------------------------------------------ the chain: arcade log + on-chain compass core
class ChainLog:
    def __init__(self, player: Player):
        self.player = player
        self.circuit = Circuit.load(os.path.join(ROOT, 'contracts', 'data', 'circuit.hex'))
        self.core = CoreSim(self.circuit, json.load(open(os.path.join(ROOT, 'contracts', 'data', 'params_v2.json'))), energy=10**9); self.core.record_ids = True
        self.TICKED = cast('keccak', 'Ticked(address,uint64,uint16,uint32,int32,int32,int64,int64,uint64)')
        self.sync_core()
        self.q = queue.Queue(); self.decisions = []; self.core_txs = []; self.mismatch = 0; self.session = None; self.last_decision = None; self.last_core = None
        self.raster = []
        threading.Thread(target=self._worker, daemon=True).start()

    def sync_core(self):
        out = cast('call', '--rpc-url', RPC, BRAIN, 'brainState()(int16[],int8[],uint16[16],int32[],uint64,uint64,bool,uint32,int64,int64,int32,int32)').split('\n')
        arr = lambda s: [int(x) for x in re.findall(r'-?\d+', s)]
        c = self.core; c.v, c.bias, c.hist, c.inp = arr(out[0]), arr(out[1]), arr(out[2]), arr(out[3])
        c.step, c.energy = int(out[4].split()[0]), int(out[5].split()[0]); c.alive = out[6].strip() == 'true'; c.generation = int(out[7].split()[0])
        c.posX, c.posY, c.headX, c.headY = [int(out[i].split()[0]) for i in (8, 9, 10, 11)]
        st = cast('call', '--rpc-url', RPC, BRAIN, 'activeStimulus()(uint8,uint8,uint16,uint64,bool)').split('\n')
        c.stimChannel, c.stimParam, c.stimStrength, c.stimUntil = int(st[0]), int(st[1]), int(st[2]), int(st[3].split()[0])

    def start(self, game):
        h = self.player.snapshot_hash()
        out = cast('send', '--rpc-url', RPC, '--private-key', PK, ARCADE, 'startSession(string,bytes32,uint64)', game, '0x' + h['hash'], str(h['step']), '--json', timeout=120)
        rc = json.loads(out); self.session = int(cast('call', '--rpc-url', RPC, ARCADE, 'sessionCount()(uint256)').split()[0]) - 1
        print('session', self.session, 'started in block', int(rc['blockNumber'], 16))

    def _worker(self):
        while True:
            job = self.q.get()
            try:
                if job['kind'] == 'decision':
                    h = self.player.snapshot_hash()
                    out = cast('send', '--rpc-url', RPC, '--private-key', PK, '--gas-limit', '200000', ARCADE, 'decide(uint256,bytes32,uint64,int16,bool,uint32,uint16,uint16,uint32)',
                               str(self.session), '0x' + h['hash'], str(h['step']), str(job['turn']), 'true' if job['fire'] else 'false', str(h['spikes'] % (1 << 32)), str(job['kills']), str(max(0, job['health'])), str(job['tic']), '--json', timeout=120)
                    rc = json.loads(out); d = {'n': len(self.decisions) + 1, 'tx': rc['transactionHash'], 'block': int(rc['blockNumber'], 16), 'hash': h['hash'], 'step': h['step'], 'turn': job['turn'], 'fire': job['fire'], 'kills': job['kills'], 'health': job['health'], 'gas': int(rc['gasUsed'], 16)}
                    self.decisions.append(d); self.last_decision = d
                elif job['kind'] == 'core':
                    wedge = job['wedge']; n0 = len(self.core.spike_lists)
                    if wedge is None: out = cast('send', '--rpc-url', RPC, '--private-key', PK, '--gas-limit', '9500000', BRAIN, 'tick(uint16)', str(STEPS), '--json', timeout=120)
                    else: out = cast('send', '--rpc-url', RPC, '--private-key', PK, '--gas-limit', '9500000', BRAIN, 'stimulate(uint8,uint8,uint8,uint16)', '1', str(wedge), '4', str(STEPS), '--json', timeout=120)
                    rc = json.loads(out); ev = None
                    if rc.get('status') not in ('0x1', 1, '1'):
                        print('core tx reverted; resyncing local replay'); self.sync_core(); self.core.spike_lists = self.core.spike_lists[:n0]; continue
                    for l in rc.get('logs', []):
                        if l['topics'][0] == self.TICKED:
                            dd = l['data'][2:]; w = [int(dd[i:i + 64], 16) for i in range(0, len(dd), 64)]
                            ev = {'spikes': w[2], 'headX': s256(w[3]), 'headY': s256(w[4]), 'energy': w[7]}
                    if wedge is not None: self.core.stimulate(CH_CUE, wedge, 4)
                    self.core.tick(STEPS); local_spikes = sum(len(s) for s in self.core.spike_lists[n0:])
                    ok = ev is not None and ev['headX'] == self.core.headX and ev['headY'] == self.core.headY and ev['spikes'] == local_spikes
                    if not ok: self.mismatch += 1
                    self.raster += self.core.spike_lists[n0:]; self.raster = self.raster[-160:]
                    hx, hy = (ev['headX'], ev['headY']) if ev else (self.core.headX, self.core.headY)
                    t = {'tx': rc['transactionHash'], 'block': int(rc['blockNumber'], 16), 'gas': int(rc['gasUsed'], 16), 'wedge': wedge, 'spikes': ev['spikes'] if ev else 0, 'energy': ev['energy'] if ev else 0, 'ok': ok, 'angle': math.atan2(hy, hx) if (hx or hy) else None, 'mag': math.hypot(hx, hy)}
                    self.core_txs.append(t); self.last_core = t
            except Exception as e:
                print('chain job failed:', job['kind'], str(e)[:160])
            finally:
                self.q.task_done()

    def end(self):
        try: cast('send', '--rpc-url', RPC, '--private-key', PK, ARCADE, 'endSession(uint256)', str(self.session), '--json', timeout=120)
        except Exception as e: print('endSession failed', e)


# ------------------------------------------------------------------ video
class Recorder:
    def __init__(self, out_dir, circuit):
        os.makedirs(out_dir, exist_ok=True); self.dir = out_dir
        f = lambda n, s: ImageFont.truetype(f'/usr/share/fonts/truetype/dejavu/DejaVuSansMono{"-Bold" if n else ""}.ttf', s)
        self.F, self.FB, self.FS, self.FH = f(0, 14), f(1, 17), f(0, 11.5), f(1, 22)
        c = circuit; grp = lambda i: 0 if c.type[i] <= 1 else 1 if c.type[i] == 2 else 2 if c.type[i] <= 4 else 3
        order_list = sorted(range(c.N), key=lambda i: (grp(i), 99 if c.wedge[i] == 255 else c.wedge[i], c.side[i]))
        self.order = [0] * c.N; self.types = c.type
        for k, n in enumerate(order_list): self.order[n] = k
        self.proc = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W_VID}x{H_VID}', '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', os.path.join(out_dir, 'doom_fly.mp4')], stdin=subprocess.PIPE)
        self.n = 0

    def bar(self, d, x, y, w, label, v, mx, col):
        d.text((x, y - 1), label, font=self.FS, fill=(139, 145, 156)); d.rectangle([x + 128, y + 3, x + 128 + w, y + 11], fill=(24, 27, 32))
        d.rectangle([x + 128, y + 3, x + 128 + w * max(0, min(1, v / mx)), y + 11], fill=col); d.text((x + 134 + w, y - 1), f'{v:5.1f}', font=self.FS, fill=(232, 230, 224))

    def frame(self, screen, pl: Player, ch: ChainLog, stats):
        img = Image.new('RGB', (W_VID, H_VID), (8, 10, 13)); d = ImageDraw.Draw(img)
        img.paste(Image.fromarray(screen).resize((800, 600)), (0, 58))
        d.rectangle([0, 0, W_VID, 58], fill=(13, 15, 18)); d.line([0, 58, W_VID, 58], fill=(50, 54, 60))
        d.text((16, 9), 'THE WHOLE FLY BRAIN PLAYS DOOM', font=self.FH, fill=(232, 230, 224))
        d.text((16, 36), '139,248 neurons · FlyWire connectome · every decision hashed to BNB Smart Chain · a 155-neuron core fires inside the EVM in sync', font=self.FS, fill=(139, 145, 156))
        x0 = 816; R = pl.rates
        # --- the player
        d.text((x0, 70), 'THE PLAYER · whole brain, real time', font=self.FB, fill=(240, 180, 41))
        y = 96
        for lab, v, mx, col in [('DNa02 L / R', R['DNa02_left'], 120, (255, 90, 53)), ('', R['DNa02_right'], 120, (255, 90, 53)), ('DNa01 L / R', R['DNa01_left'], 120, (255, 122, 82)), ('', R['DNa01_right'], 120, (255, 122, 82)),
                               ('DNa population L / R', R['DNa_left'], 30, (255, 154, 122)), ('', R['DNa_right'], 30, (255, 154, 122)), ('giant fiber DNp01', R['DNp01_left'] + R['DNp01_right'], 60, (88, 196, 245)), ('LC4 looming', (R['LC4_left'] + R['LC4_right']) / 2, 150, (88, 196, 245)),
                               ('olfactory PNs', R['ALPN'], 120, (66, 184, 158)), ('Kenyon cells', R['KC'], 40, (217, 115, 191)), ('all 1,303 DNs', R['DN_all'], 20, (217, 146, 42))]:
            self.bar(d, x0, y, 230, lab, v, mx, col); y += 17
        d.text((x0, y + 4), f"steer {pl.steer:+.1f}  →  {'TURN LEFT' if stats['turn'] > 0 else 'TURN RIGHT' if stats['turn'] < 0 else 'hold'}     scent L {pl.scene['scent_l']:.2f} / R {pl.scene['scent_r']:.2f}", font=self.FS, fill=(232, 230, 224))
        if stats.get('fire_flash', 0) > 0: d.text((x0 + 300, 70), '▶ FIRE  (giant fiber)', font=self.FB, fill=(255, 90, 53))
        d.text((x0, y + 22), f"enemies in sight {stats['enemies']}   kills {stats['kills']}   health {stats['health']:.0f}   trigger spikes {pl.trigger_spikes}", font=self.FS, fill=(139, 145, 156))
        # --- the chain
        cy = y + 52; d.line([x0, cy - 8, W_VID - 16, cy - 8], fill=(40, 44, 50))
        d.text((x0, cy), 'ON BNB SMART CHAIN', font=self.FB, fill=(226, 52, 26))
        ld = ch.last_decision
        if ld:
            d.text((x0, cy + 24), f"decision #{ld['n']}  block {ld['block']}", font=self.F, fill=(232, 230, 224))
            d.text((x0, cy + 42), f"brain hash {ld['hash'][:20]}…  step {ld['step']:,}", font=self.FS, fill=(139, 145, 156))
            d.text((x0, cy + 57), f"tx {ld['tx'][:30]}…   turn {ld['turn']:+d}  fire {'yes' if ld['fire'] else 'no'}  kills {ld['kills']}", font=self.FS, fill=(139, 145, 156))
        else: d.text((x0, cy + 24), 'starting session…', font=self.F, fill=(139, 145, 156))
        lc = ch.last_core
        d.text((x0, cy + 80), 'COMPASS CORE · 155 neurons firing inside the EVM', font=self.FS, fill=(240, 180, 41))
        if lc:
            d.text((x0, cy + 96), f"block {lc['block']}  {('cue wedge ' + str(lc['wedge'])) if lc['wedge'] is not None else 'tick'}  {lc['spikes']} spikes  {lc['gas']:,} gas  replay {'✓' if lc['ok'] else '✗'}", font=self.FS, fill=(232, 230, 224))
            d.text((x0, cy + 111), f"tx {lc['tx'][:30]}…", font=self.FS, fill=(139, 145, 156))
        # raster
        ry0, rh, rw = cy + 132, H_VID - (cy + 132) - 40, 400
        d.rectangle([x0, ry0, x0 + rw, ry0 + rh], fill=(12, 14, 18))
        cols = ch.raster[-128:]; n = len(cols); cw = rw / 128; rowh = rh / 155
        colors = [(240, 180, 41), (240, 180, 41), (217, 146, 42), (255, 90, 53), (255, 122, 82), (88, 196, 245)]
        for k, spikes in enumerate(cols):
            x = x0 + rw - (n - k) * cw
            for i in spikes: d.rectangle([x, ry0 + self.order[i] * rowh, x + max(1, cw * 0.85), ry0 + self.order[i] * rowh + max(1, rowh * 0.9)], fill=colors[self.types[i]])
        d.text((x0 + rw + 6, ry0), 'compass', font=self.FS, fill=(90, 96, 106)); d.text((x0 + rw + 6, ry0 + rh - 14), 'inhibit', font=self.FS, fill=(90, 96, 106))
        d.text((16, H_VID - 30), f"on-chain: {len(ch.decisions)} decisions, {len(ch.core_txs)} core ticks, {sum(t['gas'] for t in ch.core_txs) + sum(x['gas'] for x in ch.decisions):,} gas, {400 * sum(1 for t in ch.core_txs if t['wedge'] is not None):,} $FLY burned   ·   {stats['elapsed']:.0f} s   ·   FlyArcade {ARCADE[:10]}…  FlyBrain {BRAIN[:10]}…", font=self.FS, fill=(139, 145, 156))
        self.proc.stdin.write(img.tobytes()); self.n += 1

    def close(self): self.proc.stdin.close(); self.proc.wait()


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--minutes', type=float, default=5); ap.add_argument('--out', default=os.path.join(HERE, 'doom_run')); ap.add_argument('--scenario', default='defend_the_center.cfg'); ap.add_argument('--no-chain', action='store_true'); ap.add_argument('--decision-every', type=float, default=1.2); ap.add_argument('--core-every', type=float, default=1.5)
    a = ap.parse_args()
    pl = Player(); print('whole brain up'); time.sleep(2)
    ch = None if a.no_chain else ChainLog(pl)
    rec = Recorder(a.out, ch.circuit if ch else Circuit.load(os.path.join(ROOT, 'contracts', 'data', 'circuit.hex')))
    if ch: ch.start('DOOM · ' + a.scenario.replace('.cfg', ''))

    g = vzd.DoomGame(); g.load_config(os.path.join(vzd.scenarios_path, a.scenario))
    g.set_window_visible(False); g.set_screen_resolution(vzd.ScreenResolution.RES_640X480); g.set_screen_format(vzd.ScreenFormat.RGB24)
    g.set_labels_buffer_enabled(True); g.set_render_hud(True); g.set_sound_enabled(False)
    g.set_available_game_variables([vzd.GameVariable.HEALTH, vzd.GameVariable.KILLCOUNT, vzd.GameVariable.ANGLE, vzd.GameVariable.POSITION_X, vzd.GameVariable.POSITION_Y])
    g.set_available_buttons([vzd.Button.TURN_LEFT_RIGHT_DELTA, vzd.Button.ATTACK]); g.set_episode_timeout(100000); g.set_mode(vzd.Mode.PLAYER); g.init(); g.new_episode(); g.send_game_command('give ammo')

    t0 = time.time(); prev = {}; stats = {'turn': 0, 'fire_flash': 0, 'enemies': 0, 'kills': 0, 'health': 100.0, 'elapsed': 0}; episodes = 1
    next_dec = time.time() + 2; next_core = time.time() + 3; fired_since = False; turn_acc = 0
    while time.time() - t0 < a.minutes * 60:
        if g.is_episode_finished(): episodes += 1; g.new_episode(); g.send_game_command('give ammo'); prev.clear(); continue
        if int((time.time() - t0) * FPS) % (FPS * 15) == 0: g.send_game_command('give ammo')
        frame_due = t0 + rec.n / FPS
        if time.time() < frame_due: time.sleep(frame_due - time.time())
        s = g.get_state()
        if s is None: continue
        ang = math.radians(g.get_game_variable(vzd.GameVariable.ANGLE)); px, py = g.get_game_variable(vzd.GameVariable.POSITION_X), g.get_game_variable(vzd.GameVariable.POSITION_Y)
        en = []
        for l in s.labels:
            if l.object_name == 'DoomPlayer': continue
            dx, dy = l.object_position_x - px, l.object_position_y - py; dist = max(1.0, math.hypot(dx, dy))
            bearing = (math.atan2(dy, dx) - ang + math.pi) % (2 * math.pi) - math.pi
            size = math.degrees(2 * math.atan(40 / dist)); dsz = (size - prev.get(l.object_id, size)) / 0.1; prev[l.object_id] = size
            en.append((bearing, size, dsz))
        fr = s.screen_buffer; pl.set_scene(en, float(fr[:, :320].mean()) / 255, float(fr[:, 320:].mean()) / 255)
        stats.update(enemies=len(en), kills=int(g.get_game_variable(vzd.GameVariable.KILLCOUNT)), health=g.get_game_variable(vzd.GameVariable.HEALTH), elapsed=time.time() - t0)
        # --- act: turning from the DNa readout, firing from the giant fiber
        st = pl.steer; delta = max(-3.5, min(3.5, -0.25 * st))       # degrees per tic (max ~120 deg/s); positive turns right in ViZDoom, steer > 0 means left
        turn = 1 if delta < -0.5 else -1 if delta > 0.5 else 0
        fire = 1 if pl.take_fire() else 0
        if fire: stats['fire_flash'] = 4; fired_since = True
        stats['turn'] = turn; stats['fire_flash'] = max(0, stats['fire_flash'] - 1); turn_acc += int(round(-delta * 3))   # degrees turned this frame, left positive
        g.make_action([delta, fire], 3)
        # --- chain
        if ch:
            now = time.time()
            if now >= next_dec and ch.session is not None:
                ch.q.put({'kind': 'decision', 'turn': max(-32768, min(32767, turn_acc)), 'fire': fired_since, 'kills': stats['kills'], 'health': int(stats['health']), 'tic': s.number}); turn_acc = 0; fired_since = False; next_dec = now + a.decision_every
            if now >= next_core:
                threat = max(en, key=lambda e: e[1]) if en else None
                ch.q.put({'kind': 'core', 'wedge': None if threat is None else int(round(threat[0] / (2 * math.pi / 16))) % 16}); next_core = now + a.core_every
        rec.frame(s.screen_buffer, pl, ch or _NoChain(), stats)
    g.close(); rec.close(); pl.running = False
    if ch: ch.q.join(); ch.end()
    summary = {'minutes': a.minutes, 'episodes': episodes, 'kills': stats['kills'], 'trigger_spikes': pl.trigger_spikes, 'decisions': ch.decisions if ch else [], 'core_txs': ch.core_txs if ch else [], 'core_replay_mismatches': ch.mismatch if ch else None, 'session': ch.session if ch else None, 'arcade': ARCADE, 'brain': BRAIN}
    json.dump(summary, open(os.path.join(a.out, 'run.json'), 'w'), indent=1)
    print(f"done: kills {stats['kills']}, {len(summary['decisions'])} decisions on-chain, {len(summary['core_txs'])} core ticks ({summary['core_replay_mismatches']} replay mismatches), video {os.path.join(a.out, 'doom_fly.mp4')}")


class _NoChain:
    decisions = []; core_txs = []; last_decision = None; last_core = None; raster = []


if __name__ == '__main__':
    main()
