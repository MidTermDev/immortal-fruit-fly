#!/usr/bin/env python3
"""Converts the native page renders (firmware/screens/<page>.ppm, written by test/test_screen) into PNGs under
brand/pebble_screens/<page>.png for review, scaled up 2x (nearest neighbour) so the 320x240 pixels stay crisp.

    cd firmware && ../.venv/bin/pio test -e native -f test_screen && ../.venv/bin/python tools/ppm2png.py [--scale 2]
"""
import os, sys, glob
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FW = os.path.dirname(HERE)
SRC = os.path.join(FW, 'screens')
DST = os.path.join(os.path.dirname(FW), 'brand', 'pebble_screens')


def main():
    scale = 2
    if '--scale' in sys.argv: scale = int(sys.argv[sys.argv.index('--scale') + 1])
    files = sorted(glob.glob(os.path.join(SRC, '*.ppm')))
    if not files: sys.exit('no renders in %s (run `pio test -e native -f test_screen` first)' % SRC)
    os.makedirs(DST, exist_ok=True)
    for f in files:
        im = Image.open(f).convert('RGB')
        if scale != 1: im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
        out = os.path.join(DST, os.path.splitext(os.path.basename(f))[0] + '.png')
        im.save(out, optimize=True)
        print('%s -> %s (%dx%d)' % (os.path.relpath(f, FW), os.path.relpath(out, os.path.dirname(FW)), im.width, im.height))


if __name__ == '__main__':
    main()
