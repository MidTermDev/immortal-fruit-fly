# Pebbles: immortal fruit flies in physical hardware

*15 September 2026. The plan for putting the fly contracts into five handheld devices, what the demo shows, and the build order. Companion to [PLAN.md](PLAN.md).*

## 0. Hardware on the table

| Have | Assumed part | Used as |
|---|---|---|
| 5 × "S3 Core dev kit" pebbles | **M5Stack CoreS3** (ESP32-S3, 16 MB flash, 8 MB PSRAM, 2.0" 320×240 touch screen, BMI270 gyro/accel + BMM150 magnetometer, mic, speaker, Wi-Fi, BLE, 500 mAh battery, Grove ports A/B/C) | one **body** each, with its own **wallet** |
| 10 × hall sensors | digital hall switch modules (A3144/KY-003 style, 3 pins VCC·GND·OUT, active-low; analog 49E boards also work via ADC) | **landmarks and predators**: a magnet near a sensor is something the fly sees |
| magnets | any small neodymium (glue one under a “landmark” token and one under a “spider” token) | the things you move around the pebble |

If the pebbles turn out to be a different M5Stack S3 board (CoreS3 SE, AtomS3, StampS3), only the pin table in §4.3 and the screen size change; the firmware is written on M5Unified, which abstracts the board.

## 1. What the demo shows (90 seconds)

Five pebbles on a table. Each one is **a wallet that owns a fly and the body that runs its neurons**.

1. **Turn a pebble in your hand.** The compass neurons on its screen (the same 155 EPG/PEN/Δ7 cells that run on BNB Chain) rotate their bump of activity with the gyroscope. The fly knows which way it is facing because real fly neurons say so.
2. **Slide the landmark magnet past its left side.** The hall sensor fires, the EPG neurons of that wedge get a cue, the bump snaps to the landmark. Slide the spider magnet past: Δ7 shock, the bump collapses, the screen flashes, the fly freezes.
3. **Look at BscScan.** Every 45 s the pebble signs `FlyCore.stimulate(...)` + `tick(16)` with its own key: the cues it sensed, applied to *the same neurons in the EVM*. The transaction is from the pebble’s address. The site shows the on-chain heading next to the pebble’s.
4. **Feed it from your phone.** `feed(id, 600)` on the site. The pebble chirps: “fed 600 s by 0x8a…”. Energy bar refills.
5. **Let one starve.** Screen goes grey: DEAD, brain preserved at block N, a QR code to resurrect it. Resurrect on the site; the pebble wakes with the identical compass state.
6. **Touch two pebbles together.** BLE finds the neighbour; the current body signs `assign(id, neighbour)`, the neighbour signs `accept(id)`, reads the core state from the chain, and continues it. The fly hopped bodies. On the site: *Body: Pebble 3*, with the whole hand-off in its interaction history.
7. **Mint from the pebble.** A fresh pebble with 1 $FLY and some BNB presses *Hatch*: it mints its own fly and becomes its body. Hardware that owns an organism.

What makes it more than a gadget: nothing on the pebble is authoritative. The fly’s identity, its neurons’ state, its energy, its history are on the chain. Unplug the pebble and the fly is still there; hand it to a different pebble, or to the arena, and it is the same fly.

## 2. Architecture

```
  ┌────────────── pebble (ESP32-S3) ──────────────┐        ┌──────────── BNB Smart Chain ───────────┐
  │ gyro → TURN_LEFT/RIGHT      hall L/R → CUE 4/12│        │ FlyRegistry  (the organism, ERC-721)    │
  │ magnetometer → weak CUE at magnetic north       │ signed │   registerBody / accept / interaction /  │
  │ hall "spider" → SHOCK                           │  tx    │   commit / died / assign                 │
  │ local bit-exact replica of the core (preview)   │ ─────▶ │ FlyCore      (per-fly 155 neurons in EVM)│
  │ screen: ring, bump, fly, energy, chain status   │ ◀───── │   stimulate(id,…) / tick(id, n)          │
  │ NVS: private key (the pebble’s wallet)          │ reads  │   state: v[155], bias, hist, head, step  │
  │ BLE: find neighbour pebbles → hand-off          │        │ $FLY: mint / feed / resurrect burn it    │
  └────────────────────────────────────────────────┘        └─────────────────────────────────────────┘
```

**The pebble is a body.** It speaks the registry protocol exactly like the arena and DOOM do: `registerBody("Pebble 3", uri)`, waits to be assigned, `accept(id)`, then `interaction`s as things happen, `commit`s on a schedule, `died` when energy hits zero.

**What it runs is the fly’s on-chain core.** A pebble cannot run the 139,248-neuron whole brain (12 MB of state, 16 CPU cores at real time). It runs the fly’s *other* brain: the compass circuit that already executes inside the EVM. `FlyCore` makes that per-fly: every fly in the registry gets its own 155-neuron state in the contract, keyed by token id. The pebble keeps a bit-exact local replica of it for the display (the same integer model, the same `keccak256(step)` noise), and anchors it on-chain every `ANCHOR_EVERY` seconds by sending the cues it sensed and ticking the EVM neurons, then re-reading the state so the replica stays exact. This is the same replica-plus-anchor scheme the website and the DOOM harness already use.

**The whole brain sleeps while a fly is in a pebble.** A pebble commits with the fly’s existing `stateRoot`/`stateURI` unchanged (the whole-brain snapshot is preserved exactly), `brainStep` advanced by the core steps it ticked, and `energy` decremented by real seconds. When a whole-brain body (the arena) takes the fly back, it continues from that snapshot. Documented as such on the fly page: *body: Pebble 3 (core only)*.

## 3. `FlyCore.sol`: neural behavior on-chain, per fly

The existing `FlyBrain` v2 kernel (Yul inner loop, SSTORE2 circuit table, calibrated v2 parameters) refactored from one singleton organism to `mapping(uint256 id => Core)`:

```solidity
struct Core { uint256[16] v; uint256[32] inp; uint256[8] bias; uint256 headingHist;
              uint64 step; uint64 totalSpikes; int64 posX; int64 posY; int32 headX; int32 headY;
              uint8 stimChannel; uint8 stimParam; uint16 stimStrength; uint64 stimUntilStep; }

function tick(uint256 id, uint16 steps) external;                 // anyone, gas only; fly must be alive in the registry
function stimulate(uint256 id, uint8 ch, uint8 param, uint8 strength, uint16 steps) external;
    // the fly's current body (registry.fly(id).body == msg.sender): gas only — its senses
    // anyone else: burns strength × STIM_PRICE $FLY — a poke
function seed(uint256 id, int16[] v, int8[] bias, uint16[16] hist, int32[] inp, uint64 step) external;
    // curator, once per fly, only while step == 0: continuity for fly #1 from FlyBrain v2
function core(uint256 id) view returns (…);  function coreHash(uint256 id) view returns (bytes32);
event Ticked(uint256 indexed id, address indexed by, uint64 fromStep, uint16 steps, uint32 spikes, int32 headX, int32 headY, int64 posX, int64 posY);
event Stimulated(uint256 indexed id, address indexed by, uint8 channel, uint8 param, uint16 strength, uint64 untilStep, uint256 tokensBurned);
```

No energy, no death, no lineage in the core: those are the registry’s. Immutable parameters, no owner (the curator can only `seed` a fresh core, once). The kernel was reworked for gas (the synapse table is stored with the gains pre-folded): measured on fly #1’s real state, `stimulate + tick(id, 16)` by the body costs 3.0–4.4M gas (≈ 0.0002 BNB at 0.05 gwei), `tick(id, 32)` 5.5–8.1M depending on activity, deployment 13.4M.

**[Deployed: `FlyCore` at `0x90835aceD9b2739658Ff94aBC7c0c45049ea49f3`, verified, block 122089807; fly #1’s core seeded from FlyBrain v2 at step 22,048.]**

## 4. Firmware (`firmware/`, PlatformIO, Arduino + M5Unified)

### 4.1 Modules

| Module | What | Verified how |
|---|---|---|
| `lib/flycore` | the integer LIF compass, bit-exact with `sim/flysim.py` and the EVM (int32 arithmetic, truncating division, keccak noise, persistent input, plasticity, walk) | native build, replays fixtures generated by `flysim.py` (stimuli + ticks) and compares every `v`, `bias`, `headX/Y`, spike counts |
| `lib/keccak` | keccak-256 (noise seed, tx hashing, ABI selectors) | test vectors |
| `lib/ethtx` | secp256k1 signing with recovery id (trezor-crypto subset), RLP, EIP-155 legacy tx for chain 56, address from key, ABI encode/decode helpers | native build signs fixed transactions and compares to `eth_account` output |
| `lib/rpc` | JSON-RPC over TLS to a public BSC endpoint: `eth_call`, nonce, gas price, `eth_sendRawTransaction`, receipts, minimal `eth_getLogs`; typed wrappers for `FlyRegistry` and `FlyCore` | compile + host mock |
| `src/main.cpp` | the body: state machine (PROVISION → REGISTER → WAIT → HOST → DEAD), sensors, anchoring schedule, UI, BLE hand-off | compile for `m5stack-cores3`; on-device checklist §6 |

### 4.2 Senses → neurons

| Physical input | Neurons | How |
|---|---|---|
| gyro yaw rate (BMI270) | PEN_a/PEN_b, left or right hemisphere (`CH_TURN_*`) | local: strength ∝ rate, applied continuously; on-chain: net rotation since the last anchor, as one turn stimulus of matching strength |
| magnetometer heading (BMM150) | EPG of the wedge facing magnetic north (`CH_CUE`, weak) | the on-chain compass stays anchored to the real world: the pebble’s neurons know which way north is |
| hall sensor, left side | EPG wedge 4 (`CH_CUE`, strong) | a landmark on the left |
| hall sensor, right side | EPG wedge 12 (`CH_CUE`, strong) | a landmark on the right |
| hall sensor tagged “spider” (hero pebble, Port C) | all Δ7 (`CH_SHOCK`) | the bump collapses, the fly freezes; `interaction(id, "shock")` |
| touch: hold the ring | `CH_CUE` at the touched wedge | a poke, like the website |
| light (camera mean, CoreS3 only) | none in v1 | later: looming |

### 4.3 Wiring (CoreS3)

| Port | Pins | Sensor |
|---|---|---|
| Port B (black) | G8 = hall left OUT, G9 = hall right OUT, 3V3, GND | two hall switches, internal pull-ups, active low |
| Port C (blue), hero pebble only | G17, G18 as GPIO | third and fourth hall sensors (spider, landmark 2) |
| Port A (red) | I2C, free | future: more sensors via a Grove hub |

Analog (49E) boards: same pins, read with `analogRead`, threshold at ±15% of the idle value; the firmware auto-detects at boot (a digital switch idles at 3.3 V; a 49E idles at ~1.65 V).

### 4.4 Chain cadence and gas

| Action | Who signs | Gas | When |
|---|---|---|---|
| `registerBody` | pebble | ~90k | first boot (name “Pebble N”, uri = the site’s fly page) |
| `accept` | pebble | ~60k | when assigned |
| `FlyCore.stimulate + tick(16)` | pebble | 3.0–4.4M ≈ 0.0002 BNB (limit 5.9M) | every `ANCHOR_EVERY` s (default 45 s → ~0.016 BNB/h ≈ $10/h per pebble; set 120 s for a long day) |
| `interaction` | pebble | ~35k | landmark seen, shock, hand-off, fed |
| `commit` | pebble | ~120k | every 10 min |
| `died` | pebble | ~90k | energy 0 |
| `assign` (hand-off) | the current pebble | ~50k | touch |
| `mint` (hatch) | pebble | ~250k + 1 $FLY | button |

Load each pebble with **0.05 BNB** (about 2 hours of anchoring at 45 s plus everything else) and, for hatching, **2 $FLY**. The pebble shows its address and a QR at boot.

### 4.5 Keys and provisioning

- First boot: 32 random bytes from the ESP32 hardware RNG → private key in NVS (never leaves the device; the screen shows only the address). *Hold the left and right touch buttons under the screen together for three seconds* shows the key once, for backup.
- Wi-Fi: `firmware/include/secrets.h` (gitignored) with SSID/password and the RPC URL; alternatively a soft-AP captive portal (`FLY-PEBBLE-xxxx`) if no secrets are compiled in.
- Chain: public `https://bsc-dataseed.bnbchain.org` (accepts `eth_sendRawTransaction`), TLS with the ISRG/DigiCert root pinned in `certs.h`.

### 4.6 Screen

320×240. Left: the ring, 16 wedges shaded by EPG spikes in the last 100 ms, the population-vector needle, the fly glyph rotated to the heading; a faint outer ring for the heading histogram (the memory). Right: fly name and id, ALIVE/DEAD, energy bar with seconds left, spikes/s, the last anchor (block, “on-chain heading” vs local), the pebble’s short address, Wi-Fi/BLE dots. Bottom: one line of narration (“landmark on the left”, “anchoring… tx 0x…”, “fed 600 s by 0x8a…”). Dead: grey, brain hash, QR to `…/fly/?id=N`.

## 5. Build order (each step leaves everything before it working)

1. **`FlyCore.sol`** + tests (differential against FlyBrain v2 and `flysim.py`, body-vs-poker permissions, seed-once, registry alive gating) + deploy script. Deploy, verify, `seed` fly #1 from FlyBrain v2’s current state, register the core address in the site config. **[Done.]**
2. **Firmware core + crypto, host-verified.** `lib/flycore` bit-exact vs `flysim.py`; `lib/ethtx` signature-exact vs `eth_account`. **[Done: 45 host tests.]**
3. **Firmware body**, compiled for CoreS3: provisioning, register, wait/accept, anchoring loop, commits, death, screen, sensors, BLE hand-off, hatch. **[Done: builds, RAM 22%, flash 27%; not yet run on a device.]**
4. **Site**: fly pages show pebble bodies (“core only”), the on-chain core dial and record per fly, pokes and ticks, and a *Pebbles* docs page with the wiring table and the demo script. **[Done.]**
5. **Bring-up on your desk** (§6), then film the 90 seconds.
6. Later: a soft-AP provisioning page; light/looming from the camera; a pebble as a whole-brain *remote* body (the VPS runs the brain, the pebble is its senses and its face).

## 6. Bring-up checklist (you, with the hardware)

1. `pip install platformio` (or use the repo’s venv), `cd firmware`, copy `include/secrets.example.h` → `include/secrets.h`, fill Wi-Fi.
2. `pio run -e cores3 -t upload` with a pebble on USB-C. It boots, shows *Pebble 1 · 0xABCD…* and a QR.
3. Send it 0.05 BNB. It registers itself (watch the tx on the screen and on BscScan).
4. On the site, open a fly you own → *Hand it to a body* → “Another body address…” → paste the pebble’s address. The pebble accepts within a poll and the ring lights up.
5. Rotate it. Bring the magnets. Feed it from the site. Repeat for the other four.
6. Two pebbles: hold *Hand off* on the one hosting a fly, tap the neighbour when it appears, watch the fly move.

## 7. Risks and the honest caveats

- **Gas is the cost of the story.** Anchoring the EVM neurons is what makes the demo real; the cadence knob is there so a day of demos does not cost a day of BNB.
- **Between anchors the screen is a preview.** Exactly as on the site: the label says which heading is on-chain and which is local. The two agree at every anchor or the pebble resyncs and says so.
- **Clock and Wi-Fi.** A pebble that loses Wi-Fi keeps running locally and queues its interactions; the commit after reconnection carries them. Energy is counted by the pebble’s clock and reconciled with the chain at each commit.
- **TLS on a microcontroller** is the fiddliest part. The fallback is a plain-HTTP relay on the VPS that only forwards already-signed transactions (it never sees a key).
