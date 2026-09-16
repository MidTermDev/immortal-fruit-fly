# Pebble screen design: the fly is the screen

320 × 240, 16-bit colour, M5GFX on the CoreS3. Every page is built around one animated creature: the fly. The compass
dial is retired as the main page; the on-chain neurons get a page that looks alive.

## Palette (the site's, on the dark ground)

| name | hex | use |
|---|---|---|
| bg | #0d0f12 | ground |
| bg2 | #161a1f | panels, world grid |
| ink | #e8e6e0 | text, the fly's body outline |
| dim | #8a919c | captions, grid, trail |
| amber | #f0b429 | food, scent particles, energy, EPG neurons |
| red | #ff5a35 | the fly's accent, alerts, PEN neurons |
| ice | #58c4f5 | predator, Δ7 neurons, chain |
| green | #42b89e | alive dot, fed |
| violet | #d973bf | memory (KC/MBON) |

Fonts: M5GFX built-ins only. `Font0` (5×7) for captions, `Font2` (16 px) for words, `FreeSansBold12pt7b` for the one big
word. Everything else is drawn.

## The creature

A fly drawn from primitives (ellipses, lines, circles) in its own coordinate frame, then rotated by heading and scaled,
so it renders identically on the device and in the native renderer. Body length 1.0 = 28 px at zoom 1.

Parts: abdomen (ellipse, striped), thorax (ellipse), head (circle) with two large compound eyes (red-tinted circles with a
1-px highlight), two antennae (short lines from the head, angle animated), six legs (three per side, 2-segment lines),
two wings (translucent ellipses swept back; drawn as outlines to keep it cheap), a proboscis (a short line, only when
eating).

States and animation (10 fps animation clock, driven by the real signals):

| state | trigger | animation |
|---|---|---|
| idle | mode walk, speed ≈ 0 | body "breathes" (±3 % scale, 1 Hz), antennae drift |
| walking | mode walk | legs cycle (4 frames), antennae drift |
| smelling | ALPN rate above baseline | antennae twitch fast; amber particles drift toward the head from the plume side |
| following a scent | mode surge | walking, faster legs, antennae forward |
| casting | mode cast | head yaws left/right (±25°, 0.7 Hz), legs slow |
| eating | GRN rate high / on food | proboscis down, tiny amber crumbs fall from the mouth, body still |
| jump | event "jumped" (giant fiber) | wings blur (three quick alternating outlines), body hops 6 px for 300 ms |
| fleeing | predator within 40 body lengths | fast legs, red tint on the body, eyes wide (bigger circles) |
| caught | event "caught" | red flash of the whole panel 120 ms, body shakes ±3 px for 600 ms |
| starving | energy < 5 min | animation at half speed, body drawn in dim |
| dead | alive false | on its back: body rotated 180°, legs up, eyes as × |
| egg | no fly hosted | a pale ellipse pulsing 0.5 Hz, a small crack appears when an assignment is pending |
| hatching | first frames after accept | crack widens over 1.5 s, the fly steps out, then walking |

## Pages

### Life (default when a host stream is fresh)

```
┌───────────────────────────── 200 ──────────┬────── 120 ───────┐
│ world viewport, camera on the fly           │ #65 Big brainny  │
│ zoom: 70 body lengths across                │ ● alive · gen 1  │
│ faint grid every 10 BL, arena wall if near  │                  │
│ trail: 120 fading dim dots                  │ FOLLOWING A      │  ← the one big word, amber
│ plume: amber particles drifting downwind    │ SCENT            │
│ from each food (12 per food, seeded by id)  │                  │
│ food: amber blob + "600 s"                  │ belly ▮▮▮▮▮▯▯ 1h22│  ← energy bar + hms + hunger word
│ puffs: fainter amber particle bursts        │ hungry           │
│ predator: ice shadow, soft edge, size ×2    │ smell  ▮▮▮▮▯     │  ← five thought bars, tiny
│ the fly: centred, rotated to heading        │ memory ▮▯▯▯▯     │
│                                             │ sight  ▮▮▯▯▯     │
│                                             │ steer  ▮▮▮▯▯     │
│                                             │ taste  ▯▯▯▯▯     │
│ "brain on host · 0.8×"  (Font0, bottom-left)│ ⛓ 122,097,417 ♥ │  ← last anchor block; ♥ pulses when a tx is in flight
├─────────────────────────────────────────────┴──────────────────┤
│ ❝ I smell something…                                    (24 px)│  ← speech strip, first person
└────────────────────────────────────────────────────────────────┘
```

Speech lines (newest wins, each shown ≥ 2.5 s):
- mode surge: "I smell something…" then, when the food is within 10 BL, "there!"
- mode cast: "where did it go?"
- eating: "yum" / "600 s of life, nice"
- event jumped: "jumped!"
- predator near: "a shadow!" ; caught: "ouch"
- energy < 20 min: "getting hungry…" ; < 5 min: "so hungry…"
- fed: "fed 600 s by 0x8a… thanks"
- anchored (tx receipt): "anchored my neurons on-chain · block N"
- poked by a stranger (Stimulated event from a non-body): "0x8a… poked me: shock!"
- host offline: "my brain host is away; my compass still works"

### Neurons (button B, or automatic when the host is offline)

```
┌──────────── 220: live raster ───────────────┬──── 100 ────────┐
│ 155 rows (1 px each), scrolling left, one   │ the fly's head   │
│ column per replica step; spikes as 1-px dots│ from above, with │
│ coloured by cell type: EPG/EPGt amber,      │ a 16-wedge halo  │
│ PEG dim amber, PEN red, Δ7 ice              │ glowing by EPG   │
│ rows grouped by type with 1-px gaps         │ activity; needle │
│                                             │ = heading        │
│ "155 real neurons · on-chain" (Font0)       │ chain 210°       │
│                                             │ local 212°       │
│                                             │ FlyCore #65      │
├─────────────────────────────────────────────┴──────────────────┤
│ ❝ anchored my neurons on-chain · block 122,097,417             │
└────────────────────────────────────────────────────────────────┘
```

### Waiting (no fly)

The egg, centred left, pulsing; right: the pebble's name, "send 0.05 BNB to register" or "assign a fly to me" with the
address, QR of the address at the bottom right (as today). Speech: "waiting for a fly…". Hatch button hint.

### Dead

The fly on its back in the world (grey), everything dim, big word "DEAD", "brain preserved · block N", QR to the
fly page, speech "resurrect me?".

### Boot

As today: the ASCII fly, "joining Wi-Fi", "the fly is waking up".

## Moments (2 s overlays, drawn last)

- fed: amber sparkles fall around the fly, speech line.
- anchored: the halo (Neurons page) or a thin ring around the fly (Life page) flashes ice for 300 ms.
- poked: an ice bolt from the top edge to the fly.
- stream lost: a small "host?" tag top-right of the world, no overlay.

## Buttons

A: feed hint page (address QR + the fly page URL), B: Life ⇄ Neurons, C: hatch / hand-off as today.
Hold A + C: private key page (unchanged).

## Implementation contract

- `lib/screen/`: pure C++ (no Arduino headers) that draws every page onto an abstract `Painter` (fillRect, drawLine,
  fillCircle, drawCircle, fillEllipse (or polygon), drawText(x, y, str, size, colour, align)) from a `Model` struct
  (the parsed frame, replica raster columns, energy, state words, chain fields, moments queue, animation clock).
- `src/ui.cpp` implements `Painter` on the M5GFX sprite and feeds the `Model`; nothing in ui.cpp decides layout.
- `test/test_screen/`: a native `Painter` that rasterises into an RGB buffer and writes `screens/<page>.ppm` for
  several models (life: surge with food and predator; life: eating; life: starving; neurons; waiting; dead; hatching),
  plus `tools/ppm2png.py` to turn them into PNGs under `brand/pebble_screens/` for review. The test also asserts every
  page stays inside 320×240 and draws at least N pixels, and that a 400-column raster scroll is under 20 ms natively.
