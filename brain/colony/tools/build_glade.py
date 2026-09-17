"""Dress the colony's world once: trees, flowers, ponds, berry bushes, hay and torches scattered over the plain, and a
campfire ring at spawn, so the overview and the flies' views show a place rather than a green void. Idempotent: a
marker block at 0 62 0 says it has been done.   ../../.venv/bin/python tools/build_glade.py [--force]"""
import os, sys, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rcon import Rcon, read_password
SURF = 64   # first air block above the superflat grass (the grass top is y=63)
r = Rcon(password=read_password()); r.connect()
done = 'stone_bricks' in r.command('execute if block 0 62 0 minecraft:stone_bricks run say glade-marker') or 'glade-marker' in r.command('execute if block 0 62 0 minecraft:stone_bricks run say glade-marker')
if done and '--force' not in sys.argv: print('glade already built (marker at 0 62 0); --force to add more'); sys.exit(0)
rng = random.Random(7919)
cmds = []
# the spawn ring: a stone circle with a campfire and hay, torches on fence posts around it
cmds += ['fill -3 63 -3 3 63 3 minecraft:cobblestone', 'setblock 0 64 0 minecraft:campfire', 'fill -1 63 -1 1 63 1 minecraft:stone_bricks',
         'setblock 3 64 3 minecraft:hay_block', 'setblock -3 64 -3 minecraft:hay_block', 'setblock -3 64 3 minecraft:cake', 'setblock 3 64 -3 minecraft:sweet_berry_bush[age=3]']
for (x, z) in [(7, 0), (-7, 0), (0, 7), (0, -7), (5, 5), (-5, -5), (5, -5), (-5, 5)]:
    cmds += [f'setblock {x} 64 {z} minecraft:oak_fence', f'setblock {x} 65 {z} minecraft:torch']
# trees, flowers, ponds, berry patches and hay scattered over the plain (the flies wander 100 blocks and more)
for _ in range(90):
    x, z = rng.randint(-110, 110), rng.randint(-110, 110)
    if abs(x) < 12 and abs(z) < 12: continue
    cmds.append(f'place feature minecraft:{rng.choice(["oak", "oak", "birch", "fancy_oak", "oak_bees"])} {x} {SURF} {z}')
for _ in range(60):
    x, z = rng.randint(-110, 110), rng.randint(-110, 110)
    cmds.append(f'place feature minecraft:{rng.choice(["flower_plain", "flower_default", "patch_grass_plain", "patch_tall_grass"])} {x} {SURF} {z}')
for _ in range(10):
    x, z = rng.randint(-100, 100), rng.randint(-100, 100)
    if abs(x) < 14 and abs(z) < 14: continue
    w = rng.randint(2, 4); cmds.append(f'fill {x-w} 63 {z-w} {x+w} 63 {z+w} minecraft:water')
for _ in range(25):
    x, z = rng.randint(-100, 100), rng.randint(-100, 100)
    for dx, dz in [(0, 0), (1, 0), (0, 1), (1, 1)]: cmds.append(f'setblock {x+dx} 64 {z+dz} minecraft:sweet_berry_bush[age={rng.randint(2, 3)}]')
for _ in range(12):
    x, z = rng.randint(-100, 100), rng.randint(-100, 100)
    cmds += [f'setblock {x} 64 {z} minecraft:hay_block', f'setblock {x} 65 {z} minecraft:torch']
cmds.append('setblock 0 62 0 minecraft:stone_bricks')   # the marker
ok = fail = 0
for c in cmds:
    out = r.command(c); ok += 1 if out and 'Unknown' not in out and 'Could not' not in out and 'Incorrect' not in out else 0
    if not (out and 'Unknown' not in out and 'Could not' not in out and 'Incorrect' not in out): fail += 1; print('  ?', c, '->', (out or '').strip()[:80])
print(f'{ok} commands ok, {fail} failed')
