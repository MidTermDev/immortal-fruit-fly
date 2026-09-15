"""Calibrate FlyBrain dynamics parameters (per-presynaptic-type gains).

Protocol (deterministic, mirrors what a user can do on-chain):
  A  CUE at wedge 4 for 64 steps          -> EPG neurons of that wedge fire
  B  128 free steps                        -> a bump must persist without input: concentrated + stable
  C  TURN_LEFT for 64 steps               -> the active population must move
  D  64 free steps                         -> the moved bump must persist
  E  SHOCK for 32 steps                    -> activity must collapse
  F  64 free steps                         -> activity may recover (bonus)
Metrics are geometry-free (which EPG neurons fire), so they hold regardless of
how the ring is unrolled for display.
"""
import json, os, sys, random, math
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flysim import Circuit, FlyBrain, CH_CUE, CH_TURN_LEFT, CH_SHOCK, COS16, SIN16

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CIRC = Circuit.load()
EPG = [i for i in range(CIRC.N) if CIRC.type[i] <= 1]
NEPG = len(EPG)
TOPK = 13  # a bump ~ a quarter of the ring
WEDGE = [CIRC.wedge[i] for i in EPG]


def popvec(counts):
    x = sum(c * COS16[w] for c, w in zip(counts, WEDGE) if w != 255)
    y = sum(c * SIN16[w] for c, w in zip(counts, WEDGE) if w != 255)
    t = sum(c for c, w in zip(counts, WEDGE) if w != 255)
    return (math.atan2(y, x), math.hypot(x, y) / (125 * t) if t else 0.0, t)


def dang(a, b):
    return math.atan2(math.sin(b - a), math.cos(b - a))


def cos(a, b):
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb) if na > 0 and nb > 0 else 0.0


def run_protocol(p, want_trace=False):
    b = FlyBrain(CIRC, p, energy=10**9)
    wins = {}
    trace = []

    def run(tag, steps, ch=None, param=0, strength=0):
        if ch: b.stimulate(ch, param, strength)
        spk = [0] * CIRC.N; tot = 0; done = 0
        while done < steps:
            s = min(32, steps - done)
            r = b.tick(s); tot += r['spikes']; done += s
            for i, c in enumerate(b.last_spk): spk[i] += c
            if want_trace: trace.append((tag, list(b.last_spk)))
        wins[tag] = ([spk[i] for i in EPG], tot / steps, steps)

    run('A', 64, CH_CUE, 4, 4)
    run('B1', 32); run('B2', 32); run('B3', 32); run('B4', 32)
    run('C1', 32, CH_TURN_LEFT, 0, 4); run('C2', 32)
    run('D', 64)
    run('E', 32, CH_SHOCK, 0, 4)
    run('F', 64)

    def rate(tag): return sum(wins[tag][0]) / wins[tag][2]
    def conc(tag):
        c = sorted(wins[tag][0], reverse=True); t = sum(c)
        return sum(c[:TOPK]) / t if t > 0 else 0.0
    m = {}
    m['rateA'] = rate('A'); m['concA'] = conc('A')
    m['rateB'] = sum(rate(k) for k in ('B1', 'B2', 'B3', 'B4')) / 4
    m['concB'] = sum(conc(k) for k in ('B1', 'B2', 'B3', 'B4')) / 4
    m['simB'] = cos(wins['B1'][0], wins['B4'][0])
    aB, rB, _ = popvec(wins['B4'][0]); aC, rC, _ = popvec(wins['C2'][0]); aD, rD, _ = popvec(wins['D'][0])
    m['RB'] = sum(popvec(wins[k][0])[1] for k in ('B1', 'B2', 'B3', 'B4')) / 4  # mean resultant length: 1 = one wedge
    m['rateC'] = (rate('C1') + rate('C2')) / 2; m['concC'] = conc('C2'); m['RC'] = rC
    m['turnC'] = math.degrees(dang(aB, aC))  # + = counter-clockwise (what TURN_LEFT should do)
    m['rateD'] = rate('D'); m['concD'] = conc('D'); m['RD'] = rD; m['simD'] = cos(wins['C2'][0], wins['D'][0])
    m['driftD'] = abs(math.degrees(dang(aC, aD)))
    m['rateE'] = rate('E'); m['rateF'] = rate('F'); m['concF'] = conc('F')
    m['allRateB'] = sum(wins[k][1] for k in ('B1', 'B2', 'B3', 'B4')) / 4

    def inrange(x, lo, hi):
        if lo <= x <= hi: return 1.0
        d = (lo - x) / lo if x < lo else (x - hi) / hi
        return max(0.0, 1 - d)
    def atleast(x, lo): return min(1.0, x / lo)

    alive = 1.0 if m['rateB'] >= 1.0 else 0.0
    score = 0.0
    score += 2 * inrange(m['rateB'], 1.0, 10.0)
    score += 2 * atleast(m['concB'], 0.75) * alive
    score += 2 * atleast(m['RB'], 0.6) * alive
    score += 2 * m['simB'] * alive
    score += 3 * min(1.0, max(0.0, m['turnC'] / 60.0)) * atleast(m['RC'], 0.45) * alive * (1 if m['rateC'] >= 1 else 0)
    score += 1 * atleast(m['RD'], 0.5) * (1 if m['rateD'] >= 1 else 0) * (1 if m['driftD'] < 45 else 0.3)
    score += 1 * (1 if m['rateE'] < 0.25 * max(m['rateB'], 0.4) else 0)
    score += 0.5 * (1 if m['rateF'] > 0.5 and m['concF'] > 0.6 else 0)
    if m['rateB'] > 20 or m['allRateB'] > 70: score -= 5
    m['score'] = score
    return (m, trace) if want_trace else m


def logu(rng, lo, hi): return int(math.exp(rng.uniform(math.log(lo), math.log(hi))))


def sample(rng):
    # gains per presynaptic type: EPG, EPGt, PEG, PEN_a, PEN_b, Delta7(-)
    return dict(leak=int(rng.choice([30, 45, 60, 80, 100, 130, 170, 220])),
                thresh=1000, reset=int(rng.choice([-200, -500, -1000, -1500])), vMin=-4000,
                gains=[logu(rng, 8, 250), logu(rng, 8, 250), logu(rng, 4, 250), logu(rng, 8, 250), logu(rng, 8, 250), -logu(rng, 8, 400)],
                gBias=4, noise=int(rng.choice([20, 40, 70, 100, 140])),
                stimGain=int(rng.choice([40, 70, 100, 150])), stimTTL=64, walkThreshold=100, maxSteps=64)


def mutate(p, rng, scale=0.3):
    q = json.loads(json.dumps(p))
    q['gains'] = [max(2, int(abs(g) * math.exp(rng.uniform(-scale, scale)))) * (1 if g > 0 else -1) for g in q['gains']]
    q['leak'] = max(10, int(q['leak'] * math.exp(rng.uniform(-scale, scale))))
    q['noise'] = max(5, int(q['noise'] * math.exp(rng.uniform(-scale, scale))))
    q['stimGain'] = max(10, int(q['stimGain'] * math.exp(rng.uniform(-scale, scale))))
    if rng.random() < 0.2: q['reset'] = int(rng.choice([-200, -500, -1000, -1500]))
    return q


def evaluate(p):
    try:
        return p, run_protocol(p)
    except Exception as e:  # noqa
        return p, {'score': -99, 'err': str(e)}


def show(p, m):
    print(round(m['score'], 2), 'leak', p['leak'], 'reset', p['reset'], 'noise', p['noise'], 'stim', p['stimGain'], 'gains', p['gains'],
          {k: round(v, 2) for k, v in m.items() if k != 'score'})


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    rng = random.Random(783)
    with Pool() as pool:
        results = pool.map(evaluate, [sample(rng) for _ in range(n)], chunksize=16)
    results.sort(key=lambda r: -r[1]['score'])
    print('top 10 of random search:')
    for p, m in results[:10]: show(p, m)
    seeds = [p for p, _ in results[:16]]
    best = results[0]
    for rnd in range(4):
        cands = [mutate(p, rng, 0.35 if rnd < 2 else 0.15) for p in seeds for _ in range(60)]
        with Pool() as pool:
            ref = pool.map(evaluate, cands, chunksize=16)
        ref.sort(key=lambda r: -r[1]['score'])
        if ref[0][1]['score'] > best[1]['score']: best = ref[0]
        seeds = [p for p, _ in (ref[:12] + [best])]
        print(f'refine {rnd}:', end=' '); show(*ref[0])
    print('BEST'); show(*best)
    json.dump(best[0], open(os.path.join(ROOT, 'contracts', 'data', 'params.json'), 'w'))
    json.dump({'params': best[0], 'metrics': best[1]}, open(os.path.join(ROOT, 'sim', 'calibration_report.json'), 'w'), indent=1)
    print('wrote contracts/data/params.json')
