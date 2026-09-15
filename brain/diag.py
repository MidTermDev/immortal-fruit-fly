import os, math, numpy as np
os.environ.setdefault('NUMBA_NUM_THREADS', '16')
from sim import WholeBrain
from world import World
b = WholeBrain(); w = World(b); w.next_predator_ms = 1e12
w.place_food(45, 30, 300)
print(' t   bearing  ornL  ornR | DNa02L slow/base  DNa02R slow/base | DNaL-R d | steer  hd')
for k in range(4000):
    w.step(record=False)
    if k % 150 == 0:
        f = w.food[0]; bearing = (math.degrees(math.atan2(f['y'] - w.y, f['x'] - w.x) - w.heading) + 540) % 360 - 180
        S, B = w.slow, w.base
        print(f"{w.age_ms/1000:5.1f} {bearing:+7.0f} {w.orn_rates[0]:5.1f} {w.orn_rates[1]:5.1f} | {S['DNa02_left']:6.1f}/{B['DNa02_left']:5.1f}  {S['DNa02_right']:6.1f}/{B['DNa02_right']:5.1f} | {(S['DNa_left']-B['DNa_left'])-(S['DNa_right']-B['DNa_right']):+5.2f} | {w.steer:+6.1f} {math.degrees(w.heading)%360:4.0f} dist={math.hypot(f['x']-w.x, f['y']-w.y):5.1f}")
