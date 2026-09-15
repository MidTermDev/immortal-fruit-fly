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

    def log(self, text, kind=None):
        self.events.append((self.age_ms, text)); self.events = self.events[-50:]
        if kind and self.on_event:
            try: self.on_event(kind, text)
            except Exception: pass

    # ---------------------------------------------------------------- food
    FOOD_LIM = ARENA / 2 - 10   # food must be reachable: inside the walls (the fly is clamped to ±(ARENA/2 - 2))

    def place_food(self, x, y, energy, by=None, fid=None):
        x = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(x))); y = max(-self.FOOD_LIM, min(self.FOOD_LIM, float(y)))
        f = {'id': fid if fid is not None else self.next_food_id, 'x': float(x), 'y': float(y), 'energy': float(energy), 'energy0': float(energy), 'by': by}
        self.next_food_id = max(self.next_food_id, f['id'] + 1)
        self.food.append(f); self.log(f'food placed at ({x:.0f},{y:.0f}) worth {energy:.0f}s' + (f' by {by[:8]}' if by else ''))
        return f

    def odor_at(self, px, py):
        c = 0.0
        for f in self.food:
            d2 = (f['x'] - px) ** 2 + (f['y'] - py) ** 2
            frac = f['energy'] / max(1.0, f['energy0'])
            c += (0.3 + 0.7 * frac) * math.exp(-d2 / (2 * PLUME_SIGMA ** 2))
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

    # ------------------------------------------------------------- step
    def step(self, record=True):
        """Advance the world by WORLD_MS of biology. Returns spike ids recorded in this slice."""
        if not self.alive: return np.zeros(0, np.int32)
        on_food, (cl, cr) = self._drive()
        total, win, ids, ts = self.b.run(WORLD_MS, record=record)
        self.spike_ids = ids
        # rates
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
        self.heading += (math.radians(3.0) * self.steer + cast) * dt
        fwd = 0.04 * (R['DNp09_left'] + R['DNp09_right']) + ({'surge': 4.5, 'walk': 3.0, 'cast': 1.6}[self.mode] if R['DN_all'] > 1.0 else 0.0)
        back = 0.05 * (R['MDN_left'] + R['MDN_right'])
        speed = fwd - back
        if on_food: speed *= 0.15
        gf = self.b.pops['DNp01_left'].tolist() + self.b.pops['DNp01_right'].tolist()
        if win[gf].sum() > 0 and self.age_ms - getattr(self, '_last_jump', -1e9) > 500:
            self._last_jump = self.age_ms; self.jumps += 1
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
        if self.predator:
            p = self.predator; p['x'] += p['vx'] * dt; p['y'] += p['vy'] * dt
            if math.hypot(p['x'] - self.x, p['y'] - self.y) < 2.5:
                self.hits += 1; self.energy -= 60; self.log('caught by the predator: -60 s', 'caught'); self.predator = None; self.next_predator_ms = self.age_ms + 45_000 + self.rng.random() * 60_000
            elif math.hypot(p['x'], p['y']) > ARENA:
                self.predator = None; self.next_predator_ms = self.age_ms + 45_000 + self.rng.random() * 60_000
        elif self.age_ms >= self.next_predator_ms:
            ang = self.rng.random() * 2 * math.pi; r = ARENA * 0.7
            px, py = self.x + r * math.cos(ang), self.y + r * math.sin(ang); sp = 25.0
            self.predator = {'x': px, 'y': py, 'vx': -sp * math.cos(ang), 'vy': -sp * math.sin(ang), 'size': 6.0}
            self.log('a shadow approaches')
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
        d['food'] = [dict(f) for f in self.food]; d['predator'] = None if not self.predator else dict(self.predator)
        d['path'] = self.path[-600:]; d['events'] = self.events[-50:]
        d['rng'] = self.rng.bit_generator.state
        return d

    def load_state(self, d):
        for k in self.DYN:
            if k in d: setattr(self, k, tuple(d[k]) if k in ('orn_rates', 'lamp') else d[k])
        self._last_jump = d.get('_last_jump', -1e9)
        for k in ('rates', 'slow', 'base'):
            if k in d: getattr(self, k).update(d[k])
        self.food = [dict(f) for f in d.get('food', [])]; self.predator = None if not d.get('predator') else dict(d['predator'])
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
                'lamp': self.lamp, 'arena': ARENA, 'rates': {k: round(v, 2) for k, v in R.items()}, 'base': {k: round(v, 2) for k, v in self.base.items()}, 'steer': round(self.steer, 2), 'mode': self.mode, 'orn': [round(self.orn_rates[0], 1), round(self.orn_rates[1], 1)], 'events': self.events[-12:]}


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
