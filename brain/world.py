"""The world the whole-brain fly lives in.

A flat arena. Food items give off Gaussian odor plumes that drive the fly's real
olfactory receptor neurons (the vinegar/fruit-responsive glomeruli), split by
antenna. A lamp drives the photoreceptors of whichever eye faces it. Now and
then a predator looms in from an edge and drives the LC4 / LPLC2 looming
detectors on that side. Standing on food drives the labellar gustatory neurons
and restores energy. Every simulated second of life costs one unit of energy.

Behaviour is read from named descending neurons, exactly as in the published
embodiment work: DNa02 / DNa01 left-minus-right steers, DNp09 drives forward
walking, MDN drives backward walking, a giant-fiber (DNp01) spike is a jump.
"""
import os, math, time, numpy as np
from sim import WholeBrain, DT

FOOD_GLOMERULI = ['DM1', 'DM4', 'VA2', 'DM2', 'VM2', 'DP1m']   # fruit / vinegar responders (Or42b, Or59b, Or92a, Or22a, Or43b, Or1a-ish)
ARENA = 240.0             # body lengths, square, centred on 0
WORLD_MS = 10.0           # world update period (ms of biology)
ANTENNA = 3.0             # effective antenna offset from midline, body lengths (the arena is scaled so the antennae sample the plume 6 BL apart)
PLUME_SIGMA = 30.0        # body lengths
LAMP_GAIN = 0.0           # photoreceptor drive from the lamp (Hz at full facing); 0 = uniform dim light
CONTRAST_GAIN = 8.0       # bilateral odor contrast sharpening (clipped to winner-take-all): stands in for plume filaments and head-casting


class World:
    def __init__(self, brain: WholeBrain, seed=783, energy=1800.0):
        self.b = brain
        self.rng = np.random.default_rng(seed)
        self.x = 0.0; self.y = 0.0; self.heading = 0.0
        self.energy = energy; self.alive = True; self.generation = 0
        self.age_ms = 0.0; self.life_ms = 0.0
        self.food = []; self.next_food_id = 1
        self.puffs = []        # transient odor sources with nothing to eat: {x, y, strength, expires_ms}
        self.predator = None; self.next_predator_ms = 40_000.0
        self.lamp = (ARENA * 0.4, ARENA * 0.4)
        self.path = [(0.0, 0.0)]
        self.ate_total = 0.0; self.jumps = 0; self.hits = 0; self.steer = 0.0; self.orn_rates = (0.0, 0.0)
        self.odor_ema = 0.0; self.odor_trend = 0.0; self.cast_dir = 1.0; self.mode = 'walk'
        self.events = []       # (age_ms, text)
        # EMA of population rates (Hz), tau ~ 60 ms
        self.rates = {}; self.base = {}; self.slow = {}
        self._ema_a = 1 - math.exp(-WORLD_MS / 60.0)      # display rates
        self._slow_a = 1 - math.exp(-WORLD_MS / 300.0)    # rates that drive behaviour integrate ~300 ms, like odor-guided turning
        self._steer_a = 1 - math.exp(-WORLD_MS / 150.0)
        self._base_a = 1 - math.exp(-WORLD_MS / 8000.0)   # slow adaptation of each DN's baseline, tau 8 s
        self.spike_ids = np.zeros(0, np.int32)
        # side-split ORN populations for the food glomeruli
        side = brain.side
        self.orn_l = np.concatenate([brain.pops[f'ORN_{g}'][side[brain.pops[f'ORN_{g}']] == 0] for g in FOOD_GLOMERULI]).astype(np.int32)
        self.orn_r = np.concatenate([brain.pops[f'ORN_{g}'][side[brain.pops[f'ORN_{g}']] == 1] for g in FOOD_GLOMERULI]).astype(np.int32)
        self.orn_all = brain.pops['DN_all'][:0]
        allorn = np.concatenate([v for k, v in brain.pops.items() if k.startswith('ORN_')])
        self.orn_rest = np.setdiff1d(allorn, np.concatenate([self.orn_l, self.orn_r])).astype(np.int32)
        self.readouts = ['DNa02_left', 'DNa02_right', 'DNa01_left', 'DNa01_right', 'DNg13_left', 'DNg13_right', 'DNa_left', 'DNa_right', 'DNp09_left', 'DNp09_right', 'MDN_left', 'MDN_right', 'DNp01_left', 'DNp01_right', 'DN_all', 'ALPN', 'KC', 'MBON', 'CX', 'LC4_left', 'LC4_right', 'GRN_labellar']
        for r in self.readouts: self.rates[r] = 0.0; self.base[r] = 0.0; self.slow[r] = 0.0
        self.log('born')

    on_event = None   # optional hook(kind, text) for bodies that record interaction history

    def log(self, text, kind=None, data=None):
        self.events.append((self.age_ms, text)); self.events = self.events[-50:]
        if kind and self.on_event:
            try: self.on_event(kind, data if data is not None else text)
            except Exception: pass

    # ---------------------------------------------------------------- food
    FOOD_LIM = ARENA / 2 - 10   # food must be reachable: inside the walls (the fly is clamped to ±(ARENA/2 - 2))

    def place_food(self, x, y, energy, by=None, fid=None):
        x = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(x))); y = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(y)))
        f = {'id': fid if fid is not None else self.next_food_id, 'x': float(x), 'y': float(y), 'energy': float(energy), 'energy0': float(energy), 'by': by}
        self.next_food_id = max(self.next_food_id, f['id'] + 1)
        self.food.append(f); self.log(f'food placed at ({x:.0f},{y:.0f}) worth {energy:.0f}s' + (f' by {by[:8]}' if by else ''))
        return f

    def puff(self, x, y, strength=1.0, seconds=8.0):
        """A transient plume with no food in it (a pebble's landmark or cue): smells like food of amplitude `strength` (1 = a fresh item) for `seconds`, then fades out at once."""
        p = {'x': float(x), 'y': float(y), 'strength': float(strength), 'expires_ms': self.age_ms + float(seconds) * 1000.0}
        self.puffs.append(p); self.log(f'a whiff of something at ({x:.0f},{y:.0f})')
        return p

    def spawn_predator(self, angle):
        """A predator appears 0.7·ARENA away in that absolute direction, approaching now. Ignored (False) while one is already about."""
        if self.predator: return False
        r = ARENA * 0.7; px, py = self.x + r * math.cos(angle), self.y + r * math.sin(angle); sp = 25.0
        self.predator = {'x': px, 'y': py, 'vx': -sp * math.cos(angle), 'vy': -sp * math.sin(angle), 'size': 6.0}
        self.log('a shadow approaches'); return True

    def odor_at(self, px, py):
        c = 0.0
        for f in self.food:
            d2 = (f['x'] - px) ** 2 + (f['y'] - py) ** 2
            frac = f['energy'] / max(1.0, f['energy0'])
            c += (0.3 + 0.7 * frac) * math.exp(-d2 / (2 * PLUME_SIGMA ** 2))
        for p in self.puffs:
            d2 = (p['x'] - px) ** 2 + (p['y'] - py) ** 2
            c += p['strength'] * math.exp(-d2 / (2 * PLUME_SIGMA ** 2))
        return min(1.0, c)

    # ------------------------------------------------------------ senses
    def _drive(self):
        b = self.b; d = {}
        hx, hy = math.cos(self.heading), math.sin(self.heading)
        # antennae: left is +90 degrees from heading
        lx, ly = self.x - hy * ANTENNA, self.y + hx * ANTENNA
        rx, ry = self.x + hy * ANTENNA, self.y - hx * ANTENNA
        cl, cr = self.odor_at(lx, ly), self.odor_at(rx, ry)
        # ORNs respond to concentration; the bilateral contrast is amplified (CONTRAST_GAIN) because the
        # plume is a smooth Gaussian and real antennae see much steeper, filamented gradients
        cm = 0.5 * (cl + cr); k = 0.0 if cm < 1e-6 else max(-1.0, min(1.0, CONTRAST_GAIN * (cl - cr) / (cl + cr)))
        rl = max(0.0, min(150.0, 110 * cm * (1 + k))); rr = max(0.0, min(150.0, 110 * cm * (1 - k)))
        self.orn_rates = (rl, rr)
        ids = [self.orn_l, self.orn_r, self.orn_rest]; ps = [np.full(len(self.orn_l), (2 + rl) * DT / 1000, np.float32), np.full(len(self.orn_r), (2 + rr) * DT / 1000, np.float32), np.full(len(self.orn_rest), 2 * DT / 1000, np.float32)]
        # lamp: each eye looks 60 degrees off the midline
        ang = math.atan2(self.lamp[1] - self.y, self.lamp[0] - self.x)
        for s, off, pop in (('left', +1.05, 'R1-6_left'), ('right', -1.05, 'R1-6_right')):
            cos = math.cos(ang - (self.heading + off))
            hz = 3 + LAMP_GAIN * max(0.0, cos)
            ids.append(b.pops[pop]); ps.append(np.full(len(b.pops[pop]), hz * DT / 1000, np.float32))
        # looming predator
        if self.predator:
            p = self.predator; dx, dy = p['x'] - self.x, p['y'] - self.y; dist = max(1.0, math.hypot(dx, dy))
            theta = 2 * math.atan(p['size'] / (2 * dist)); dtheta = max(0.0, (theta - p.get('theta', theta)) / (WORLD_MS / 1000)); p['theta'] = theta
            rel = (math.atan2(dy, dx) - self.heading + math.pi) % (2 * math.pi) - math.pi
            side = 'left' if rel > 0 else 'right'
            lc4 = min(150.0, 400.0 * dtheta); lplc2 = min(150.0, 120.0 * theta)
            for pop, hz in ((f'LC4_{side}', lc4), (f'LPLC2_{side}', lplc2)):
                ids.append(b.pops[pop]); ps.append(np.full(len(b.pops[pop]), hz * DT / 1000, np.float32))
        # taste
        on_food = self.food_under()
        if on_food:
            ids.append(b.pops['GRN_labellar']); ps.append(np.full(len(b.pops['GRN_labellar']), 80 * DT / 1000, np.float32))
        b._ids = np.concatenate(ids).astype(np.int32); b._p = np.concatenate(ps).astype(np.float32)
        return on_food, (cl, cr)

    def food_under(self):
        for f in self.food:
            if (f['x'] - self.x) ** 2 + (f['y'] - self.y) ** 2 < 3.0 ** 2: return f
        return None

    # ----------------------------------------------------------- readout
    def _readout(self, win, cl, cr):
        """The motor readout of one world step, shared by every body built on this world (the arena, the Colony): population rates
        (EMA), the steering signal from the DNa readouts, the locomotor program from the odor trend, and the forward / backward drive.
        Returns (turn rad/s, forward BL/s, backward BL/s). The arithmetic is exactly the arena's, so replays stay bit-exact."""
        a = self._ema_a; ab = self._base_a; asl = self._slow_a
        for r in self.readouts:
            inst = self.b.pop_rate(r, win, WORLD_MS)
            self.rates[r] += a * (inst - self.rates[r])
            self.slow[r] += asl * (inst - self.slow[r])
            self.base[r] += ab * (self.slow[r] - self.base[r])
        R = self.rates; S = self.slow; B = self.base
        d = lambda k: S[k] - B[k]      # departure of a DN from its adapted baseline
        # motor: DNa02 / DNa01 and the DNa population drive ipsilateral turns (Rayshubskiy 2025; Braun 2024)
        dt = WORLD_MS / 1000
        steer = (d('DNa02_left') - d('DNa02_right')) + 0.6 * (d('DNa01_left') - d('DNa01_right')) + 12.0 * (d('DNa_left') - d('DNa_right'))
        self.steer += self._steer_a * (steer - self.steer)
        # Locomotor program (Alvarez-Salvado et al. 2018): rising odor -> surge (fast, straight);
        # falling odor -> cast (slow, sustained turning). Direction of turning comes from the DNs above.
        c_now = 0.5 * (cl + cr)
        prev = self.odor_ema; self.odor_ema += (1 - math.exp(-dt / 0.6)) * (c_now - self.odor_ema)
        trend = (self.odor_ema - prev) / dt
        self.odor_trend += (1 - math.exp(-dt / 0.4)) * (trend - self.odor_trend)
        if self.odor_trend > 0.004: self.mode = 'surge'
        elif self.odor_trend < -0.004: 
            if self.mode != 'cast': self.cast_dir = 1.0 if self.steer >= 0 else -1.0
            self.mode = 'cast'
        else: self.mode = 'walk'
        cast = math.radians(70.0) * self.cast_dir if self.mode == 'cast' else 0.0
        turn = math.radians(3.0) * self.steer + cast          # rad/s; > 0 turns left (toward the left antenna)
        fwd = 0.04 * (R['DNp09_left'] + R['DNp09_right']) + ({'surge': 4.5, 'walk': 3.0, 'cast': 1.6}[self.mode] if R['DN_all'] > 1.0 else 0.0)
        back = 0.05 * (R['MDN_left'] + R['MDN_right'])
        return turn, fwd, back

    def _gf_spike(self, win):
        """A giant fiber (DNp01) spike in this step, at most one jump per 500 ms."""
        gf = self.b.pops['DNp01_left'].tolist() + self.b.pops['DNp01_right'].tolist()
        if win[gf].sum() > 0 and self.age_ms - getattr(self, '_last_jump', -1e9) > 500:
            self._last_jump = self.age_ms; return True
        return False

    # ------------------------------------------------------------- step
    def step(self, record=True):
        """Advance the world by WORLD_MS of biology. Returns spike ids recorded in this slice."""
        if not self.alive: return np.zeros(0, np.int32)
        on_food, (cl, cr) = self._drive()
        total, win, ids, ts = self.b.run(WORLD_MS, record=record)
        self.spike_ids = ids
        turn, fwd, back = self._readout(win, cl, cr)
        dt = WORLD_MS / 1000
        self.heading += turn * dt
        speed = fwd - back
        if on_food: speed *= 0.15
        if self._gf_spike(win):
            self.jumps += 1
            away = self.heading + math.pi if not self.predator else math.atan2(self.y - self.predator['y'], self.x - self.predator['x'])
            self.x += 12 * math.cos(away); self.y += 12 * math.sin(away); self.heading = away
            self.log('giant fiber spike: jumped', 'jumped')
        self.x += speed * math.cos(self.heading) * dt; self.y += speed * math.sin(self.heading) * dt
        # walls: turn away
        lim = ARENA / 2 - 2
        if abs(self.x) > lim or abs(self.y) > lim:
            self.x = max(-lim, min(lim, self.x)); self.y = max(-lim, min(lim, self.y)); self.heading += math.pi * 0.5 * dt * 10
        if len(self.path) == 0 or (self.path[-1][0] - self.x) ** 2 + (self.path[-1][1] - self.y) ** 2 > 0.25:
            self.path.append((self.x, self.y)); self.path = self.path[-3000:]
        # eating
        if on_food:
            bite = min(on_food['energy'], 6.0 * dt)   # eats 6 s of life per second
            on_food['energy'] -= bite; self.energy += bite; self.ate_total += bite
            if on_food['energy'] <= 0.05: self.food.remove(on_food); self.log(f'finished a food item worth {on_food["energy0"]:.0f}s', 'ate')
        # predator
        self.age_ms += WORLD_MS; self.life_ms += WORLD_MS
        if self.puffs: self.puffs = [p for p in self.puffs if p['expires_ms'] > self.age_ms]
        if self.predator:
            p = self.predator; p['x'] += p['vx'] * dt; p['y'] += p['vy'] * dt
            if math.hypot(p['x'] - self.x, p['y'] - self.y) < 2.5:
                self.hits += 1; self.energy -= 60; self.log('caught by the predator: -60 s', 'caught'); self.predator = None; self.next_predator_ms = self.age_ms + 45_000 + self.rng.random() * 60_000
            elif math.hypot(p['x'], p['y']) > ARENA:
                self.predator = None; self.next_predator_ms = self.age_ms + 45_000 + self.rng.random() * 60_000
        elif self.age_ms >= self.next_predator_ms:
            self.spawn_predator(self.rng.random() * 2 * math.pi)
        # metabolism
        self.energy -= dt
        if self.energy <= 0:
            self.energy = 0; self.alive = False; self.log('died: energy exhausted', 'died')
        return ids

    def resurrect(self, energy):
        self.alive = True; self.generation += 1; self.energy = max(30.0, float(energy)); self.life_ms = 0.0   # at least 30 s to find food
        self.x = 0.0; self.y = 0.0; self.heading = 0.0; self.path = [(0.0, 0.0)]; self.log(f'resurrected as generation {self.generation}')

    # ------------------------------------------------------------ persistence
    DYN = ['x', 'y', 'heading', 'energy', 'alive', 'generation', 'age_ms', 'life_ms', 'ate_total', 'jumps', 'hits', 'steer', 'orn_rates', 'odor_ema', 'odor_trend', 'cast_dir', 'mode', 'next_predator_ms', 'next_food_id', 'lamp']

    def dump_state(self):
        """Everything that influences the next step, at full precision (for verifiable checkpoints)."""
        d = {k: getattr(self, k) for k in self.DYN}
        d['_last_jump'] = getattr(self, '_last_jump', -1e9)
        d['rates'] = dict(self.rates); d['slow'] = dict(self.slow); d['base'] = dict(self.base)
        d['food'] = [dict(f) for f in self.food]; d['predator'] = None if not self.predator else dict(self.predator); d['puffs'] = [dict(p) for p in self.puffs]
        d['path'] = self.path[-600:]; d['events'] = self.events[-50:]
        d['rng'] = self.rng.bit_generator.state
        return d

    def load_state(self, d):
        for k in self.DYN:
            if k in d: setattr(self, k, tuple(d[k]) if k in ('orn_rates', 'lamp') else d[k])
        self._last_jump = d.get('_last_jump', -1e9)
        for k in ('rates', 'slow', 'base'):
            if k in d: getattr(self, k).update(d[k])
        self.food = [dict(f) for f in d.get('food', [])]; self.predator = None if not d.get('predator') else dict(d['predator']); self.puffs = [dict(p) for p in d.get('puffs', [])]
        for f in self.food:   # food placed outside the walls by an earlier version is unreachable; pull it inside
            f['x'] = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(f['x']))); f['y'] = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(f['y'])))
        self.path = [tuple(p) for p in d.get('path', [(self.x, self.y)])] or [(self.x, self.y)]; self.events = [tuple(e) for e in d.get('events', [])]
        if 'rng' in d: self.rng.bit_generator.state = d['rng']

    def snapshot(self):
        R = self.rates
        return {'t_ms': self.age_ms, 'step': self.b.t, 'x': self.x, 'y': self.y, 'heading': self.heading, 'energy': self.energy, 'alive': self.alive, 'generation': self.generation,
                'life_ms': self.life_ms, 'spikes_total': self.b.total_spikes, 'ate': self.ate_total, 'jumps': self.jumps, 'hits': self.hits,
                'food': [{'id': f['id'], 'x': f['x'], 'y': f['y'], 'energy': f['energy'], 'energy0': f['energy0'], 'by': f['by']} for f in self.food],
                'predator': None if not self.predator else {'x': self.predator['x'], 'y': self.predator['y'], 'size': self.predator['size']},
                'puffs': [{'x': p['x'], 'y': p['y'], 'strength': p['strength'], 'expires_ms': p['expires_ms']} for p in self.puffs],
                'lamp': self.lamp, 'arena': ARENA, 'rates': {k: round(v, 2) for k, v in R.items()}, 'base': {k: round(v, 2) for k, v in self.base.items()}, 'steer': round(self.steer, 2), 'mode': self.mode, 'orn': [round(self.orn_rates[0], 1), round(self.orn_rates[1], 1)], 'events': self.events[-12:]}


# ====================================================================== the Colony: the same brain in a Minecraft body
BLOCK_BL = 4.0          # body lengths per block: sets the plume's reach in the world (sigma 30 BL = 7.5 blocks; a bread 10 blocks off smells like the arena's food 40 BL off)
EAT_RANGE = 1.5         # blocks: the bot can pick up / eat an item this close (the arena tastes food within 3 BL)
MOB_SIZE = 4.0          # blocks: what a hostile mob looks like to the looming detectors. Measured with the arena's LC4 / LPLC2 drive (400·dθ/dt, 120·θ): at
                        # a zombie's true 2 blocks the giant fiber fires only once it is already within reach; at 4 it fires at ~4.5 blocks, before the hit
FRONT_DEG = 120.0       # a mob looms when it is in the front 120°
MEET_RANGE = 6.0        # blocks: "met fly #n"
MEET_EVERY_MS = 60_000.0
SENSE_STALE_MS = 2000.0   # senses older than this (sim time) mean the body is gone: nothing to smell or see, energy still drains
HIT_COST = 60.0         # the arena's predator rule


class MinecraftWorld(World):
    """The whole brain in a Minecraft body (COLONY.md). Same senses -> ORN / LC / GRN drive, same DN readouts -> motor as the arena, but the
    fly's position and everything around it come from the mineflayer agent's senses (COLONY.md section 4, 10 Hz), and the motor is handed
    back to the agent instead of moving a point in an arena. Units: positions are blocks; the plume is the arena's Gaussian with its
    30-body-length sigma scaled by BLOCK_BL. Frame: x = Minecraft x, y = -Minecraft z (north up), heading = yaw + pi/2, so that "left" in
    this world is the bot's left (mineflayer's yaw grows counter-clockwise seen from above; forward = (-sin yaw, -cos yaw) in (x, z)).

    Senses (from the agent): {"t", "pos": [x, y, z], "yaw", "health", "onGround", "light", "night", "food": [{"dx", "dz", "dist", "points", "kind"}],
    "mobs": [{"dx", "dz", "dist", "kind", "closing"}], "flies": [{"id", "dist"}], "eating": bool, "holdingFood": <food points in the inventory>, "hit": bool}.
    Motor (to the agent): {"turn" rad/s (+ = left, clamped ±3), "forward" 0..1, "sprint", "back", "jump", "eat", "torch", "say"}; jump, torch and say are
    one-shot: take_motor() hands each out once, so the agent must act on every motor message it receives, not only the latest one per tick
    (server.py scales turn by the sim's realtime before sending and adds "realtime" to the message, so a turn per brain-second becomes a turn per wall-second).

    Eating: the pickup is the meal (Minecraft refuses to swallow when the hunger bar is full, so agent.mjs reports `picked`, the food points picked
    up since its last tick, and that is what restores energy at 1 s of life per point: the diary says "ate", the bot says "yum" and places a torch).
    Without a `picked` field (an older agent) the fallback is: a food item that vanishes within reach was picked up (its points are queued) and a drop
    in holdingFood credits one queued meal (or the drop itself). A hit (senses.hit, edge-triggered) is the arena's predator rule: -60 s, "caught".
    Another fly within MEET_RANGE is "met fly #n" once a minute per pair. `died` / `respawned` (the bot killed and back at the spawn with its
    inventory) are diary lines only: the fly's life is its energy, and the hits already cost it.

    Checkpoints of this body are trusted-body commits like DOOM's: the senses are not world events a verifier can regenerate, so they are kept out
    of the applied log and written to a sense stream (server.py: STATE/senses_<n>.jsonl, one line per adopted frame with the brain step); given
    that stream the brain is deterministic (staleness and every timer here run on sim time, never the wall clock)."""

    def __init__(self, brain, seed=783, energy=1800.0):
        self._mc_init()
        super().__init__(brain, seed, energy)
        self.x = self.pos[0]; self.y = -self.pos[2]; self.heading = self.yaw + math.pi / 2

    def _mc_init(self):
        self._incoming = None      # the latest senses from the agent (reference swap from the socket thread; adopted by step())
        self.senses = None; self.senses_at_ms = -1e9; self.senses_n = 0
        self.pos = [0.0, 64.0, 0.0]; self.yaw = 0.0; self.light = 15; self.night = False; self.health = 20.0
        self.food_items = []; self.mobs = []; self.flies = []; self.eating = False; self.holding = 0; self.hit = False
        self.torches = []; self.meetings = {}; self.meals = []
        self.prev_hit = False; self.prev_holding = 0; self.last_hit_ms = -1e9; self.smelled_ms = -1e9; self.there_ms = -1e9; self.shadow_ms = -1e9; self.hungry_ms = -1e9
        self.loom = (0.0, 0.0); self.cm = 0.0; self._prev_near = []
        self.motor = {'turn': 0.0, 'forward': 0.0, 'sprint': False, 'back': False, 'eat': False}
        self._jump_pending = 0; self._torch_pending = 0; self._say_pending = []
        import threading; self.mlock = threading.Lock()

    on_senses = None   # optional hook(brain_step, age_ms, senses) called when a frame is adopted (server.py records the stream)

    # ------------------------------------------------------------ senses in, motor out
    def set_senses(self, s):
        """From the agent socket (any thread): the newest frame replaces the last; step() adopts it."""
        self._incoming = s

    def _adopt_senses(self):
        s = self._incoming
        if s is None or s is self.senses: return
        self.senses = s; self.senses_at_ms = self.age_ms; self.senses_n += 1
        try:
            pos = s.get('pos'); yaw = s.get('yaw')
            if isinstance(pos, (list, tuple)) and len(pos) == 3: self.pos = [float(pos[0]), float(pos[1]), float(pos[2])]
            if yaw is not None: self.yaw = float(yaw)
            self.x = self.pos[0]; self.y = -self.pos[2]; self.heading = self.yaw + math.pi / 2
            self.light = int(s.get('light', self.light)); self.night = bool(s.get('night', self.night)); self.health = float(s.get('health', self.health))
            self.food_items = [f for f in (s.get('food') or []) if isinstance(f, dict)][:32]
            self.mobs = [m for m in (s.get('mobs') or []) if isinstance(m, dict)][:32]
            self.flies = [f for f in (s.get('flies') or []) if isinstance(f, dict)][:32]
            self.eating = bool(s.get('eating', False)); self.hit = bool(s.get('hit', False))
            if 'holdingFood' in s: self.holding = max(0, int(s.get('holdingFood') or 0))
        except (TypeError, ValueError):
            pass
        if self.on_senses:
            try: self.on_senses(self.b.t, self.age_ms, s)
            except Exception: pass
        if len(self.path) == 0 or (self.path[-1][0] - self.x) ** 2 + (self.path[-1][1] - self.y) ** 2 > 0.25:
            self.path.append((self.x, self.y)); self.path = self.path[-3000:]

    def agent_ok(self):
        return self.senses is not None and self.age_ms - self.senses_at_ms <= SENSE_STALE_MS

    def take_motor(self):
        """The motor frame for the agent; jump / torch / say are handed out once."""
        with self.mlock:
            m = dict(self.motor)
            m['jump'] = self._jump_pending > 0; m['torch'] = self._torch_pending > 0; m['say'] = self._say_pending.pop(0) if self._say_pending else ''
            self._jump_pending = max(0, self._jump_pending - 1); self._torch_pending = max(0, self._torch_pending - 1)
            return m

    def _say(self, line):
        with self.mlock:
            if line not in self._say_pending: self._say_pending = (self._say_pending + [line])[-4:]

    # ------------------------------------------------------------ senses -> drive
    def _food_abs(self):
        """Food items as absolute world-frame points (x, -z), blocks."""
        if not self.agent_ok(): return []
        return [(self.pos[0] + float(f.get('dx', 0.0)), -(self.pos[2] + float(f.get('dz', 0.0))), float(f.get('points', 5)), f.get('kind', 'food'), float(f.get('dist', math.hypot(float(f.get('dx', 0.0)), float(f.get('dz', 0.0)))))) for f in self.food_items]

    def odor_at(self, px, py):
        """The arena's plume (Gaussian, sigma 30 BL) from the food items the agent reports; the strongest scent wins (COLONY.md section 2)."""
        sig = PLUME_SIGMA / BLOCK_BL; c = 0.0
        for fx, fy, pts, kind, dist in self._food_abs():
            d2 = (fx - px) ** 2 + (fy - py) ** 2
            c = max(c, math.exp(-d2 / (2 * sig ** 2)))
        return min(1.0, c)

    def food_under(self):
        """The nearest food item within reach, as the arena's food_under: something to taste and eat."""
        if not self.agent_ok(): return None
        best = None
        for f in self.food_items:
            d = float(f.get('dist', 1e9))
            if d <= EAT_RANGE and (best is None or d < best[0]): best = (d, f)
        return best[1] if best else None

    def _drive(self):
        b = self.b; hx, hy = math.cos(self.heading), math.sin(self.heading); ant = ANTENNA / BLOCK_BL
        lx, ly = self.x - hy * ant, self.y + hx * ant
        rx, ry = self.x + hy * ant, self.y - hx * ant
        cl, cr = self.odor_at(lx, ly), self.odor_at(rx, ry)
        cm = 0.5 * (cl + cr); k = 0.0 if cm < 1e-6 else max(-1.0, min(1.0, CONTRAST_GAIN * (cl - cr) / (cl + cr)))
        rl = max(0.0, min(150.0, 110 * cm * (1 + k))); rr = max(0.0, min(150.0, 110 * cm * (1 - k)))
        self.orn_rates = (rl, rr); self.cm = cm
        ids = [self.orn_l, self.orn_r, self.orn_rest]; ps = [np.full(len(self.orn_l), (2 + rl) * DT / 1000, np.float32), np.full(len(self.orn_r), (2 + rr) * DT / 1000, np.float32), np.full(len(self.orn_rest), 2 * DT / 1000, np.float32)]
        for pop in ('R1-6_left', 'R1-6_right'):   # light level is not a sense in v1 (COLONY.md): the arena's dim uniform light
            ids.append(b.pops[pop]); ps.append(np.full(len(b.pops[pop]), 3 * DT / 1000, np.float32))
        # looming: hostile mobs in the front 120°, by side; angular size from MOB_SIZE, its growth from the closing speed (as DOOM read it from the engine)
        lc4 = {'left': 0.0, 'right': 0.0}; lplc2 = {'left': 0.0, 'right': 0.0}
        if self.agent_ok():
            for m in self.mobs:
                try: dx, dz = float(m.get('dx', 0.0)), float(m.get('dz', 0.0)); dist = max(0.5, float(m.get('dist', math.hypot(dx, dz)))); closing = max(0.0, float(m.get('closing', 0.0) or 0.0))
                except (TypeError, ValueError): continue
                rel = (math.atan2(-dz, dx) - self.heading + math.pi) % (2 * math.pi) - math.pi
                if abs(rel) > math.radians(FRONT_DEG / 2): continue
                theta = 2 * math.atan(MOB_SIZE / (2 * dist)); dtheta = MOB_SIZE * closing / (dist ** 2 + MOB_SIZE ** 2 / 4)
                side = 'left' if rel > 0 else 'right'
                lc4[side] += 400.0 * dtheta; lplc2[side] += 120.0 * theta
        for side in ('left', 'right'):
            for pop, hz in ((f'LC4_{side}', min(150.0, lc4[side])), (f'LPLC2_{side}', min(150.0, lplc2[side]))):
                if hz > 0: ids.append(b.pops[pop]); ps.append(np.full(len(b.pops[pop]), hz * DT / 1000, np.float32))
        self.loom = (min(150.0, lc4['left']), min(150.0, lc4['right']))
        # taste: eating or standing at food drives the labellar GRNs as the arena's food does; food in hand tastes too (tarsal contact), less
        on_food = self.food_under(); ok = self.agent_ok()
        hz = 80.0 if (on_food or (ok and self.eating)) else (40.0 if (ok and self.holding > 0) else 0.0)
        if hz > 0: ids.append(b.pops['GRN_labellar']); ps.append(np.full(len(b.pops['GRN_labellar']), hz * DT / 1000, np.float32))
        b._ids = np.concatenate(ids).astype(np.int32); b._p = np.concatenate(ps).astype(np.float32)
        return on_food, (cl, cr)

    # ------------------------------------------------------------- step
    def step(self, record=True):
        if not self.alive: return np.zeros(0, np.int32)
        self._adopt_senses()
        on_food, (cl, cr) = self._drive()
        total, win, ids, ts = self.b.run(WORLD_MS, record=record)
        self.spike_ids = ids
        # The arena's readout, sign included. Measured on this model with the arena's own drive (17 Sep 2026, fly pinned, 1-5 s after odor onset):
        # at moderate odor (cm 0.35: ORN 77 Hz on one antenna, 0 on the other) DNa02 L-R is +65 Hz for odor on the LEFT and -40 Hz for odor on the
        # RIGHT, i.e. ipsilateral here, so steer > 0 (heading += ... = a left turn) turns toward the odor; at strong odor (ORN > 130 Hz) DNa02-left
        # dominates whichever side (a left bias) and at weak odor (< 25 Hz) nothing is lateralized. DOOM's "contralateral" note was measured under
        # DOOM's drive (one antenna at ~117 Hz, light 10 Hz). BLOCK_BL is chosen so a bread 5-10 blocks off sits in the moderate range.
        turn, fwd, back = self._readout(win, cl, cr)
        dt = WORLD_MS / 1000
        speed = fwd - back
        eating = self.agent_ok() and self.eating
        if on_food or eating: speed *= 0.15
        if self._gf_spike(win):
            self.jumps += 1
            with self.mlock: self._jump_pending += 1
            self.log('giant fiber spike: jumped', 'jumped'); self._say('jumped!')
        with self.mlock:
            self.motor = {'turn': max(-3.0, min(3.0, turn)), 'forward': max(0.0, min(1.0, speed / 4.5)) if speed > 0 else 0.0, 'sprint': bool(self.mode == 'surge' and speed >= 4.5),
                          'back': bool(speed < -0.3), 'eat': bool(on_food is not None or (self.agent_ok() and self.holding > 0))}
        self._digest(on_food)
        self.age_ms += WORLD_MS; self.life_ms += WORLD_MS
        self.energy -= dt
        if self.energy < 120 and self.age_ms - self.hungry_ms > 60_000: self.hungry_ms = self.age_ms; self._say('so hungry...')
        if self.energy <= 0:
            self.energy = 0; self.alive = False; self.log('died: energy exhausted', 'died')
        return ids

    def _digest(self, on_food):
        """What the senses say happened this step: pickups and meals, hits, meetings, and the speech strip."""
        ok = self.agent_ok(); s = self.senses
        if s is None: return
        fresh = self.senses_at_ms == self.age_ms          # a frame adopted in this very step: edge-triggered things are read once
        if fresh:
            # pickups: a reachable item that is no longer reported was picked up; its points wait for the meal
            cur = self._food_abs(); gone = []
            for px, pz, pts, kind, dist in self._prev_near:
                if not any((fx - px) ** 2 + (fy - pz) ** 2 < 0.75 ** 2 for fx, fy, _, _, _ in cur): gone.append((pts, kind))
            for pts, kind in gone:
                self.meals.append([pts, kind]); self.meals = self.meals[-16:]
            self._prev_near = [(fx, fy, pts, kind, dist) for fx, fy, pts, kind, dist in cur if dist <= EAT_RANGE + 1.0]
            # a meal: the points the agent picked up this tick (the pickup is the meal), else the fallback: its food points went down
            pts = kind = None
            if 'picked' in s:
                try: picked = max(0, int(s.get('picked') or 0))
                except (TypeError, ValueError): picked = 0
                if picked > 0: pts = picked; kind = (self.meals.pop(0)[1] if self.meals else 'food'); self.meals = []
            elif self.holding < self.prev_holding:
                drop = self.prev_holding - self.holding
                pts, kind = self.meals.pop(0) if self.meals else (drop, 'food')
            if pts:
                pts = max(1.0, float(pts))
                self.energy += pts; self.ate_total += pts
                self.log(f'ate {kind} worth {pts:.0f}s', 'ate'); self._say('yum')
                with self.mlock: self._torch_pending += 1
                self.torches.append([round(self.pos[0], 1), round(self.pos[1], 1), round(self.pos[2], 1)]); self.torches = self.torches[-200:]
            self.prev_holding = self.holding
            if s.get('died'): self.log('knocked out in the world: it wakes at the spawn')
            # a hit: the arena's predator rule
            if self.hit and not self.prev_hit and self.age_ms - self.last_hit_ms > 500:
                self.last_hit_ms = self.age_ms; self.hits += 1; self.energy -= HIT_COST
                self.log(f'caught: hit by a mob, -{HIT_COST:.0f} s', 'caught'); self._say('ouch')
            self.prev_hit = self.hit
            # meetings
            for f in self.flies:
                try: fid = int(f.get('id')); d = float(f.get('dist', 1e9))
                except (TypeError, ValueError): continue
                if fid > 0 and d <= MEET_RANGE and self.age_ms - self.meetings.get(str(fid), -1e9) >= MEET_EVERY_MS:
                    self.meetings[str(fid)] = self.age_ms; self.log(f'met fly #{fid}', 'met', data=f'fly #{fid}')
        # the speech strip
        if ok and self.mode == 'surge' and self.cm > 0.05 and self.age_ms - self.smelled_ms > 15_000:
            self.smelled_ms = self.age_ms; self.log('smelled food'); self._say('I smell something...')
        if ok and any(float(f.get('dist', 1e9)) <= 3.0 for f in self.food_items) and self.age_ms - self.there_ms > 10_000:
            self.there_ms = self.age_ms; self._say('there!')
        if ok and max(self.loom) > 30.0 and self.age_ms - self.shadow_ms > 5_000:
            self.shadow_ms = self.age_ms; self.log('a shadow approaches'); self._say('a shadow!')

    def resurrect(self, energy):
        super().resurrect(energy)
        self.meals = []; self.prev_holding = self.holding; self.prev_hit = self.hit

    # ------------------------------------------------------------ persistence
    MC_DYN = ['senses_at_ms', 'senses_n', 'pos', 'yaw', 'light', 'night', 'health', 'food_items', 'mobs', 'flies', 'eating', 'holding', 'hit', 'torches', 'meetings', 'meals',
              'prev_hit', 'prev_holding', 'last_hit_ms', 'smelled_ms', 'there_ms', 'shadow_ms', 'hungry_ms', 'loom', 'cm', 'motor']

    def dump_state(self):
        d = super().dump_state()
        d['mc'] = {k: getattr(self, k) for k in self.MC_DYN}
        d['mc']['senses'] = self.senses; d['mc']['prev_near'] = [list(p) for p in self._prev_near]
        with self.mlock: d['mc']['pending'] = {'jump': self._jump_pending, 'torch': self._torch_pending, 'say': list(self._say_pending)}
        return d

    def load_state(self, d):
        super().load_state(d)
        self.food = []; self.predator = None; self.puffs = []   # an arena snapshot's food and predator have no place here: the world around the bot is the agent's
        m = d.get('mc') or {}
        if not m:
            self._mc_init(); self.x = self.pos[0]; self.y = -self.pos[2]; self.heading = self.yaw + math.pi / 2; self.path = [(self.x, self.y)]; return
        for k in self.MC_DYN:
            if k in m: setattr(self, k, m[k])
        self.pos = [float(v) for v in self.pos]; self.loom = tuple(self.loom); self.meetings = {str(k): v for k, v in (self.meetings or {}).items()}; self.meals = [list(x) for x in (self.meals or [])]
        self.torches = [list(t) for t in (self.torches or [])]; self.motor = dict(self.motor)
        self.senses = m.get('senses'); self._incoming = None; self._prev_near = [tuple(p) for p in m.get('prev_near', [])]
        pend = m.get('pending') or {}
        with self.mlock: self._jump_pending = int(pend.get('jump', 0)); self._torch_pending = int(pend.get('torch', 0)); self._say_pending = list(pend.get('say', []))

    def snapshot(self):
        d = super().snapshot(); ok = self.agent_ok()
        d.update({'body': 'colony', 'pos': [round(v, 2) for v in self.pos], 'yaw': round(self.yaw, 3), 'light': self.light, 'night': self.night, 'health': self.health,
                  'mobs': [{k: m.get(k) for k in ('dx', 'dz', 'dist', 'kind', 'closing')} for m in self.mobs] if ok else [],
                  'foodItems': [{k: f.get(k) for k in ('dx', 'dz', 'dist', 'points', 'kind')} for f in self.food_items] if ok else [],
                  'flies': [{k: f.get(k) for k in ('id', 'dist')} for f in self.flies] if ok else [], 'torches': self.torches[-60:], 'holding': self.holding if ok else 0, 'eating': bool(ok and self.eating),
                  'motor': {k: (round(v, 3) if isinstance(v, float) else v) for k, v in self.motor.items()}, 'loom': [round(self.loom[0], 1), round(self.loom[1], 1)],
                  'agent': {'ok': ok, 'age_ms': round(self.age_ms - self.senses_at_ms, 0) if self.senses is not None else None, 'frames': self.senses_n}})
        return d


if __name__ == '__main__':
    import os
    os.environ.setdefault('NUMBA_NUM_THREADS', '16')
    b = WholeBrain(); w = World(b)
    w.place_food(45, 30, 300); w.place_food(-70, -40, 300)
    t0 = time.time(); secs = 150
    for k in range(secs * 100):
        w.step(record=False)
        if k % 1000 == 0:
            R = w.rates; dmin = min(math.hypot(f['x'] - w.x, f['y'] - w.y) for f in w.food) if w.food else 0
            print(f"t={w.age_ms/1000:5.1f}s pos=({w.x:6.1f},{w.y:6.1f}) hd={math.degrees(w.heading)%360:5.0f} dist_food={dmin:5.1f} E={w.energy:6.1f} steer={w.steer:6.1f} "
                  f"DNa02 L/R={R['DNa02_left']:5.1f}/{R['DNa02_right']:5.1f} DNa01 L/R={R['DNa01_left']:4.1f}/{R['DNa01_right']:4.1f} odor={w.odor_at(w.x,w.y):.2f} ate={w.ate_total:.0f}")
    print(f'{secs} s of embodied brain in {time.time()-t0:.1f}s wall; ate {w.ate_total:.1f}; events: {[e[1] for e in w.events]}')
