"""Builds data/fly1_replay.json: a replay fixture for test/FlyCore.t.sol on fly #1's real compass state.

The state (data/fly1_v2_state.json) is FlyBrain v2's brainState() read from BSC mainnet: a mature
engram (every bias at +/-24) after ~21k steps of the live keeper. The fixture applies the pebble's
kind of stimuli (strong gyro turns, hall-sensor cues, a spider shock) through sim/flysim.py, the
reference replica, and records the core hash after every action, so the test checks FlyCore against
a third implementation on the state that matters, not on a fresh core. It also records the expected
propagation table hash (the constructor's derived table) built independently here.

    ../.venv/bin/python data/make_fly1_replay.py
"""
import json, os, struct, sys
from Crypto.Hash import keccak

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'sim'))
from flysim import Circuit, FlyBrain  # noqa: E402


def kec(b: bytes) -> str:
    k = keccak.new(digest_bits=256); k.update(b); return '0x' + k.hexdigest()


def lanes(values, bits, per_word, words):
    out = []
    mask = (1 << bits) - 1
    for w in range(words):
        x = 0
        for k in range(per_word):
            i = w * per_word + k
            if i < len(values):
                x |= (values[i] & mask) << (k * bits)
        out.append(x)
    return out


def core_hash(b):
    """keccak256(abi.encodePacked(uint256[16] v, uint256[32] inp, uint256[8] bias, uint256 hist, uint64 step))"""
    words = lanes(b.v, 16, 16, 16) + lanes(b.inp, 32, 8, 32) + lanes(b.bias, 8, 32, 8) + lanes(b.hist, 16, 16, 1)
    return kec(b''.join(w.to_bytes(32, 'big') for w in words) + b.step.to_bytes(8, 'big'))


def propagation_table(c, gains):
    """FlyCore._buildPropagation: header of uint16 group offsets, 15-byte groups of five (post, int16 w*g/16), 17 zero bytes."""
    hdr = 2 * (c.N + 1)
    groups = [(len(c.out[i]) + 4) // 5 for i in range(c.N)]
    total = sum(groups)
    buf = bytearray(hdr + 15 * total + 17)
    g0 = 0
    for i in range(c.N):
        struct.pack_into('>H', buf, 2 * i, g0)
        g = gains[c.type[i]]
        for e, (post, w) in enumerate(c.out[i]):
            q = abs(w * g) // 16
            contrib = q if (w * g) >= 0 else -q  # truncating division, like sdiv
            assert -32768 <= contrib <= 32767
            pos = hdr + 15 * g0 + 3 * e
            buf[pos] = post
            struct.pack_into('>h', buf, pos + 1, contrib)
        g0 += groups[i]
    struct.pack_into('>H', buf, 2 * c.N, g0)
    return bytes(buf)


def main():
    c = Circuit.load(os.path.join(HERE, 'circuit.hex'))
    params = json.load(open(os.path.join(HERE, 'params.json')))
    st = json.load(open(os.path.join(HERE, 'fly1_v2_state.json')))
    assert not st['stimulus']['active'], 'seed state must have no active stimulus (seed() does not carry one)'
    b = FlyBrain(c, params)
    b.v = list(st['v']); b.bias = list(st['bias']); b.inp = list(st['inp']); b.hist = list(st['hist'])
    b.step = st['step']; b.headX = st['headX']; b.headY = st['headY']

    # the pebble's day: gyro turns up to TURN_STRENGTH_MAX (40), hall cues (8), a spider shock (20),
    # the site's pokes and quiet keeper ticks; stimuli expiring mid-tick; 1-, 16-, 32- and 64-step ticks
    actions = [
        ('stimulate', 3, 0, 40, 16), ('tick', 16), ('stimulate', 2, 0, 40, 16), ('tick', 32),
        ('stimulate', 1, 4, 8, 16), ('tick', 16), ('stimulate', 1, 12, 8, 16), ('tick', 64),
        ('stimulate', 4, 0, 20, 16), ('tick', 16), ('tick', 64), ('stimulate', 1, 0, 2, 1),
        ('tick', 63), ('stimulate', 3, 0, 7, 64), ('tick', 64), ('stimulate', 1, 9, 5, 0),
        ('tick', 16), ('tick', 16), ('stimulate', 2, 0, 3, 32), ('stimulate', 4, 0, 2, 8), ('tick', 64),
    ]
    steps = []
    for a in actions:
        if a[0] == 'stimulate':
            _, ch, param, strength, n = a
            b.stimulate(ch, param, strength)
            r = b.tick(n) if n > 0 else dict(steps=0, spikes=0, headX=b.headX, headY=b.headY, posX=b.posX, posY=b.posY)
        else:
            _, n = a
            ch = param = strength = 0
            r = b.tick(n)
        active = b.stimChannel != 0 and b.step < b.stimUntil
        steps.append(dict(op=a[0], channel=ch, param=param, strength=strength, steps=n,
                          expect=dict(step=b.step, spikes=r['spikes'], headX=b.headX, headY=b.headY,
                                      posX=b.posX, posY=b.posY, coreHash=core_hash(b), totalSpikes=b.totalSpikes,
                                      stimChannel=b.stimChannel if active else 0, stimUntil=b.stimUntil, stimActive=active)))
    out = dict(
        source=st['source'], block=st['block'], brainStateHash=st['brainStateHash'],
        seed=dict(v=st['v'], bias=st['bias'], hist=st['hist'], inp=st['inp'], step=st['step'], headX=st['headX'], headY=st['headY']),
        seedCoreHash=core_hash(FlyBrainSeed(st)),
        propagationHash=kec(propagation_table(c, params['gains'])),
        propagationLength=len(propagation_table(c, params['gains'])),
        actionCount=len(steps),
        actions=steps,
    )
    json.dump(out, open(os.path.join(HERE, 'fly1_replay.json'), 'w'), separators=(',', ':'))
    print('actions', len(steps), 'final step', b.step, 'final hash', steps[-1]['expect']['coreHash'])
    print('propagation table', out['propagationLength'], 'bytes', out['propagationHash'])


class FlyBrainSeed:
    def __init__(self, st):
        self.v = st['v']; self.inp = st['inp']; self.bias = st['bias']; self.hist = st['hist']; self.step = st['step']


if __name__ == '__main__':
    main()
