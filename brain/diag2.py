import os, sys, time, math
os.environ.setdefault('NUMBA_NUM_THREADS', '12')
sys.path.insert(0, '.')
from doom import Player
pl = Player(); time.sleep(1)
print('side  t   steer  DNa02L  DNa02R  DNa01L DNa01R  DNaL   DNaR')
for side in ['L', 'R', 'L', 'R', 'L', 'R']:
    for t in range(12):   # 6 s per side, sample every 0.5 s
        pl.set_scene([(math.radians(60 if side == 'L' else -60), 8.0, 0.0)], 0.3, 0.3)
        time.sleep(0.5); S = pl.slow
        print(f"{side}  {t*0.5:4.1f}  {pl.steer:+6.1f}  {S['DNa02_left']:6.1f}  {S['DNa02_right']:6.1f}  {S['DNa01_left']:6.1f} {S['DNa01_right']:6.1f}  {S['DNa_left']:5.1f}  {S['DNa_right']:5.1f}")
pl.running = False
