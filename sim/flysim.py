"""Bit-exact Python replica of FlyBrain.sol's simulation.

Used to calibrate the dynamics parameters before deployment and to generate
differential-test fixtures for the Solidity tests. Every operation mirrors the
contract: int32 arithmetic with truncating division, keccak256(step) noise,
synchronous spikes, engram plasticity at the end of each tick, walking.
"""
import json, os, struct, math
from Crypto.Hash import keccak

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
COS16 = [125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25, 25, 71, 106, 125]
SIN16 = [25, 71, 106, 125, 125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25]
CH_NONE, CH_CUE, CH_TURN_LEFT, CH_TURN_RIGHT, CH_SHOCK = 0, 1, 2, 3, 4
T_EPG, T_EPGT, T_PEG, T_PEN_A, T_PEN_B, T_DELTA7 = range(6)
BIAS_MAX = 24
STRIDE = 16
WEDGES = 16

DEFAULT_PARAMS = dict(leak=120, thresh=1000, reset=-300, vMin=-2000, gains=[40, 40, 40, 40, 40, -40], gBias=8,
                      noise=120, stimGain=40, stimTTL=64, walkThreshold=100, maxSteps=64)


def keccak256(b: bytes) -> int:
    k = keccak.new(digest_bits=256); k.update(b); return int.from_bytes(k.digest(), 'big')


def tdiv(a, b):  # Solidity int division truncates toward zero
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def isqrt(x):
    if x == 0: return 0
    z = (x + 1) // 2; y = x
    while z < y:
        y = z; z = (x // z + z) // 2
    return y


class Circuit:
    def __init__(self, table: bytes):
        assert table[0] == 1
        self.N = table[1]; self.S = struct.unpack('>H', table[2:4])[0]
        N, S = self.N, self.S
        o = 4
        self.type = list(table[o:o + N]); o += N
        self.wedge = list(table[o:o + N]); o += N
        self.side = list(table[o:o + N]); o += N
        self.offsets = [struct.unpack('>H', table[o + 2 * i:o + 2 * i + 2])[0] for i in range(N + 1)]; o += 2 * (N + 1)
        self.syn = [(table[o + 2 * j], table[o + 2 * j + 1]) for j in range(S)]; o += 2 * S
        self.root = [struct.unpack('>Q', table[o + 8 * i:o + 8 * i + 8])[0] for i in range(N)]
        self.out = [self.syn[self.offsets[i]:self.offsets[i + 1]] for i in range(N)]

    @classmethod
    def load(cls, path=None):
        path = path or os.path.join(ROOT, 'contracts', 'data', 'circuit.hex')
        return cls(bytes.fromhex(open(path).read().strip()[2:]))


class FlyBrain:
    def __init__(self, circuit: Circuit, params=None, energy=10**9):
        self.c = circuit; self.p = dict(DEFAULT_PARAMS, **(params or {}))
        N = circuit.N
        self.v = [0] * N; self.bias = [0] * N; self.inp = [0] * N
        self.hist = [0] * WEDGES
        self.step = 0; self.energy = energy; self.alive = True; self.generation = 0
        self.posX = 0; self.posY = 0; self.headX = 0; self.headY = 0
        self.stimChannel = CH_NONE; self.stimParam = 0; self.stimStrength = 0; self.stimUntil = 0
        self.totalSpikes = 0
        self.log = []  # per-step (spikes, epg spikes by wedge)

    # ------------------------------------------------------------ actions
    def stimulate(self, channel, param, strength):
        assert self.alive and 1 <= channel <= 4 and 1 <= strength <= 255
        self.stimChannel, self.stimParam, self.stimStrength = channel, param, strength
        self.stimUntil = self.step + self.p['stimTTL']

    def _build_stim(self):
        c, p = self.c, self.p
        amp = self.stimStrength * p['stimGain']
        stim = [0] * c.N
        ch, param = self.stimChannel, self.stimParam
        for i in range(c.N):
            t = c.type[i]
            if ch == CH_CUE:
                if t <= T_EPGT and c.wedge[i] != 255:
                    dist = (c.wedge[i] + WEDGES - param) % WEDGES
                    if dist == 0: stim[i] = amp
                    elif dist in (1, WEDGES - 1): stim[i] = tdiv(amp, 2)
            elif ch in (CH_TURN_LEFT, CH_TURN_RIGHT):
                if t in (T_PEN_A, T_PEN_B) and ((ch == CH_TURN_LEFT and c.side[i] == 0) or (ch == CH_TURN_RIGHT and c.side[i] == 1)):
                    stim[i] = amp
            elif ch == CH_SHOCK:
                if t == T_DELTA7: stim[i] = amp
        return stim

    def tick(self, steps):
        assert self.alive and 1 <= steps <= self.p['maxSteps']
        c, p = self.c, self.p
        N = c.N
        stimActive = self.stimChannel != CH_NONE and self.step < self.stimUntil
        stimI = self._build_stim() if stimActive else [0] * N
        spk = [0] * N; bins = [0] * WEDGES; hx = hy = 0; tickSpikes = 0
        s0 = self.step; ran = 0
        while ran < steps and self.energy > 0:
            sn = s0 + ran
            stimNow = stimActive and sn < self.stimUntil
            rnd = keccak256(sn.to_bytes(8, 'big'))
            spikeList = []
            for i in range(N):
                if (i & 31) == 0 and i != 0:
                    rnd = keccak256(rnd.to_bytes(32, 'big'))
                nz = ((rnd >> ((i & 31) * 8)) & 0xFF) - 128
                x = self.v[i]
                x -= tdiv(x * p['leak'], 1024)
                x += self.inp[i] + tdiv(nz * p['noise'], 128) + self.bias[i] * p['gBias']
                if stimNow: x += stimI[i]
                self.inp[i] = 0
                if x < p['vMin']: x = p['vMin']
                if x >= p['thresh']:
                    x = p['reset']
                    spikeList.append(i); spk[i] += 1
                    if c.type[i] <= T_EPGT and c.wedge[i] != 255:
                        hx += COS16[c.wedge[i]]; hy += SIN16[c.wedge[i]]; bins[c.wedge[i]] += 1
                self.v[i] = x
            tickSpikes += len(spikeList)
            stepbins = [0] * WEDGES
            for i in spikeList:
                g = p['gains'][c.type[i]]
                for post, w in c.out[i]:
                    self.inp[post] += tdiv(w * g, 16)
                if c.type[i] <= T_EPGT and c.wedge[i] != 255: stepbins[c.wedge[i]] += 1
            self.log.append((len(spikeList), stepbins))
            ran += 1; self.energy -= 1
        # plasticity
        for i in range(N):
            b = self.bias[i]
            if spk[i] * 8 >= ran:
                if b < BIAS_MAX: b += 1
            elif spk[i] == 0:
                if b > -BIAS_MAX: b -= 1
            self.bias[i] = b
        # heading memory + walk
        best, bestCount = 0, 0
        for w in range(WEDGES):
            if bins[w] > bestCount: bestCount, best = bins[w], w
        if bestCount > 0 and self.hist[best] < 0xFFFF: self.hist[best] += 1
        mag = isqrt(hx * hx + hy * hy)
        if mag > 0 and mag >= p['walkThreshold'] * ran:
            self.posX += tdiv(hx * STRIDE * ran, mag)
            self.posY += tdiv(hy * STRIDE * ran, mag)
        self.headX, self.headY = hx, hy
        self.last_spk = spk
        self.step = s0 + ran
        self.totalSpikes += tickSpikes
        if stimActive and self.step >= self.stimUntil: self.stimChannel = CH_NONE
        if self.energy == 0: self.alive = False
        return dict(steps=ran, spikes=tickSpikes, headX=hx, headY=hy, posX=self.posX, posY=self.posY)

    # ------------------------------------------------------------ analysis
    def bump(self, last=1):
        """Population vector of EPG activity over the last `last` logged steps: (angle_rad, magnitude, total_epg_spikes)."""
        bins = [0] * WEDGES
        for _, sb in self.log[-last:]:
            for w in range(WEDGES): bins[w] += sb[w]
        x = sum(bins[w] * math.cos((w + 0.5) * 2 * math.pi / WEDGES) for w in range(WEDGES))
        y = sum(bins[w] * math.sin((w + 0.5) * 2 * math.pi / WEDGES) for w in range(WEDGES))
        tot = sum(bins)
        return math.atan2(y, x), math.hypot(x, y), tot

    def state_dict(self):
        return dict(v=list(self.v), bias=list(self.bias), hist=list(self.hist), step=self.step, energy=self.energy,
                    posX=self.posX, posY=self.posY, headX=self.headX, headY=self.headY, alive=self.alive)


if __name__ == '__main__':
    c = Circuit.load()
    print('N', c.N, 'S', c.S, 'types', {t: c.type.count(t) for t in range(6)})
    b = FlyBrain(c)
    b.stimulate(CH_CUE, 4, 4)
    for k in range(8):
        r = b.tick(32)
        a, m, tot = b.bump(8)
        print(f'tick {k}: spikes={r["spikes"]:4d} bump angle={math.degrees(a):6.1f}° mag={m:6.1f} epg={tot:4d} pos=({r["posX"]},{r["posY"]})')
