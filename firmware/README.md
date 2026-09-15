# Pebble firmware

The body firmware for the M5Stack CoreS3 pebbles described in [../HARDWARE.md](../HARDWARE.md): each pebble is a
wallet that registers itself as a body on `FlyRegistry`, accepts a fly, runs a bit-exact local replica of the fly's
on-chain compass core from its own sensors, anchors those senses on the EVM (`FlyCore.stimulate + tick`), commits,
reports death, hands the fly to a neighbouring pebble over BLE, and can hatch a fly of its own.

```
firmware/
  platformio.ini          envs: cores3 (M5Stack CoreS3, Arduino + M5Unified) and native (host tests)
  include/config.h        addresses, cadences, gas, pins, sense strengths, UI knobs (documented inline)
  include/certs.h         TLS roots: ISRG Root X1, DigiCert Global Root G2, Amazon Root CA 1, GTS Root R4
  include/secrets.example.h  copy to secrets.h: Wi-Fi, RPC URL, optional fixed key (gitignored)
  lib/flycore             the integer LIF compass, bit-exact with sim/flysim.py and FlyCore.sol   (native test)
  lib/keccak              keccak-256
  lib/ethtx               secp256k1 (trezor-crypto subset), RLP, EIP-155 tx, ABI                 (native test)
  lib/rpc                 JSON-RPC over TLS + FlyRegistry / FlyCore wrappers                    (native mock test)
  src/                    the body: main (UI loop), chain task, replica task, sensors, BLE, wallet, net, ui
  fixtures/               generated tables and test vectors (tools/*.py)
  test/                   test_core, test_eth, test_rpc — `pio test -e native`
```

## 1. Build and flash

```sh
cd firmware
cp include/secrets.example.h include/secrets.h      # fill WIFI_SSID / WIFI_PASS (and RPC_URL if you have a better node)
../.venv/bin/pio run -e cores3                      # compile (RAM/Flash summary at the end)
../.venv/bin/pio run -e cores3 -t upload            # flash a pebble on USB-C
../.venv/bin/pio device monitor -b 115200           # serial log: [wallet] [net] [replica] [status] lines
../.venv/bin/pio test -e native                     # host tests: core replay, signer vectors, rpc mock
```

`secrets.h` is optional: without it the pebble starts a soft-AP `FLY-PEBBLE-xxxx` (xxxx = last 4 hex of its
address) with a captive page (`http://192.168.4.1`) that writes the Wi-Fi name/password (and an optional RPC URL)
to NVS and restarts. The portal also comes back if stored NVS credentials stop working.

After `FlyCore` is deployed put its address in `include/config.h` (`FLY_CORE`) and reflash: until then the pebble
runs the compass locally only ("core: not deployed" on the screen) and still registers, accepts, commits, dies and
hands off exactly like a full body.

TLS: the JSON-RPC connection is verified against the roots in `include/certs.h` (the default
`bsc-dataseed.bnbchain.org` chains to Amazon Root CA 1; `bsc-rpc.publicnode.com` to GTS Root R4; ISRG X1 and
DigiCert G2 cover most other providers). If your endpoint uses another CA, add its root PEM to `certs.h`, or build
with `-DINSECURE_TLS=1` in `build_flags` for a demo (then anyone on the Wi-Fi could feed the pebble fake state).

## 2. Wiring (CoreS3, HARDWARE.md §4.3)

| Port | Pin | Sensor | Neurons |
|---|---|---|---|
| B (black) | G8 | hall switch OUT, left side | `CH_CUE` wedge 4, strength 8, while the magnet is near |
| B (black) | G9 | hall switch OUT, right side | `CH_CUE` wedge 12, strength 8 |
| C (blue), hero pebble | G17 | hall switch OUT, "spider" | `CH_SHOCK` strength 20 (screen flashes, `interaction(id,"shock")`) |
| C (blue), hero pebble | G18 | hall switch OUT, landmark 2 | `CH_CUE` wedge 0, strength 8 |
| all ports | 3V3, GND | the modules' VCC / GND | |

Digital A3144/KY-003 boards: OUT is open-collector active-low; the firmware enables the internal pull-ups. Analog
49E boards work on Port B only (G8/G9 are ADC1; Port C is ADC2, which Wi-Fi owns): at boot each Port B pin is
sampled and a ~1.65 V idle means "analog", then the threshold is ±15 % of the idle value with hysteresis. The serial
log prints what was detected (`[sensors] hall L on G8 idles at 3290 mV -> digital switch`).

Other senses need no wiring: gyro yaw (BMI270) drives `CH_TURN_LEFT/RIGHT` with strength |deg/s| / 8 (1..40) above a
12 deg/s deadband; the magnetometer (BMM150) cues the wedge that faces magnetic north with strength 2 every 2 s;
touching the ring cues the wedge under the finger with strength 6. Priority when several are active:
shock > hall landmark > touch > turn > north.

## 3. What the pebble does (state machine)

```
BOOT       M5.begin, wallet (NVS "pebble"/"priv"; 32 bytes from esp_random on first boot; FIXED_PRIVATE_KEY overrides)
PROVISION  no Wi-Fi configured: soft-AP + captive page -> NVS -> restart
CONNECT    join Wi-Fi (20 s), start BLE advertising "FLYPEBBLE" (address in the manufacturer data), start the tasks
REGISTER   isBody(me)? else wait for >= 0.002 BNB, then registerBody("Pebble xxxx", SITE_URL/fly/)
WAIT       every POLL_EVERY_S: totalMinted, then fly(id) for ids 1..min(total, SCAN_MAX_ID) (40 per poll, round robin)
           pendingBody == me -> accept(id) -> core(id) into the replica (or genesis zeros) -> interaction "pebble"
           body == me (after a reboot; the id is cached in NVS "flyid") -> host it again
HOST       replica task: 14 steps/s with sensor stimuli; chain task:
             every ANCHOR_EVERY_S  (FLY_CORE set)  stimulate(id, dominant cue since the last anchor, strength, 16)
                                                   or tick(id, 16); wait for the receipt; core(id) -> setState;
                                                   the same anchor is replayed on a shadow core and compared: the
                                                   screen says "(resynced)" if the EVM and the pebble disagreed
             every COMMIT_EVERY_S                  fly(id) first (a feed since the last poll goes into the energy), then
                                                   commit(id, stateRoot/memoryRoot/stateURI unchanged, "", brainStep +
                                                   core steps since the last commit (>= 1), energy, keccak(texts)); a
                                                   commit with no receipt is remembered and recognised by brainStep at
                                                   a later poll (the energy baseline for feed detection moves to it)
             as they happen                        interaction: landmark (1 per 10 s), shock, fed N s [by 0x..], handoff
             energy                                fly.energy at the last commit - seconds since (+ feeds seen); at 0:
                                                   fly(id) is re-read first (died() checks neither energy nor feeds):
                                                   fed meanwhile -> keeps living; dead on-chain (a died() whose receipt
                                                   was missed) -> DEAD, no tx; moved -> WAIT, no tx; otherwise
                                                   died(id, unchanged roots/uri, "", brainStep, "starved in Pebble xxxx").
                                                   One died() at a time; a revert is never blindly re-sent (poll, wait
                                                   DIE_RETRY_S doubling, at most DIE_MAX_REVERTS); anchors and commits
                                                   pause at 0 energy but polling never does
DEAD       grey screen, brain hash, QR to SITE_URL/fly/?id=N, low tone; keeps polling: resurrected + assigned -> HOST
```

Buttons (the three touch areas under the screen, A B C from left to right):

| Gesture | When | Effect |
|---|---|---|
| hold A + C for 3 s | any time, once per boot | shows the private key (hex + QR) for backup |
| hold B | hosting a fly | BLE scan 3 s, shows the strongest neighbour pebble |
| B again | neighbour shown (20 s window) | `assign(id, neighbour)`; the neighbour accepts within one of its polls |
| A or C | neighbour shown | cancel |
| B, then B again within 8 s | no fly, pebble holds >= 1 $FLY | hatch: `approve` (if needed), `mint("Pebble xxxx")`, `assign(id, me)`, accept |
| touch the ring | hosting | cue the wedge under the finger |

Screen (HARDWARE.md §4.6): left, the 16-wedge ring shaded amber→red by the EPG bump (mean membrane potential per
wedge, like the site), a faint blue outer ring for the heading histogram, the white needle = local population
vector, the thin magenta line = the on-chain vector at the last anchor, the fly glyph turned to the heading, the
active stimulus under the ring. Right: fly name and id, ALIVE/DEAD, energy bar and seconds left, spikes/s and step,
last anchor block with "chain N°" vs "local N°", the pebble's short address, BNB balance, Wi-Fi/BLE dots, and what
the buttons do. Bottom: one line of narration (status / tx hashes / errors). No fly: the address as a QR.

## 4. Chain cadence and gas (config.h)

`ANCHOR_EVERY_S` 45 (≈ 0.00023 BNB per anchor at 0.05 gwei; set 120 for a long day), `ANCHOR_STEPS` 16,
`COMMIT_EVERY_S` 600, `POLL_EVERY_S` 15. Gas price = max(eth_gasPrice, `GAS_PRICE_WEI` 0.05 gwei), capped at
`GAS_PRICE_MAX_WEI` 5 gwei. Gas limits: registerBody 200k, accept 120k, assign 120k, interaction 120k, commit 300k,
died 250k, mint 400k, approve 80k, stimulate+tick 600k + 330k × steps (unused gas is refunded). A tx with no receipt
after `RECEIPT_WAIT_S` (90 s) makes the pebble re-fetch its pending nonce before the next send. Load each pebble with
0.05 BNB, and 2 $FLY if it should hatch.

## 5. Bring-up checklist (with the hardware; nothing below could be run here)

1. `cp include/secrets.example.h include/secrets.h`, fill Wi-Fi. `pio run -e cores3 -t upload`, open the monitor.
2. Boot: the screen shows *Pebble xxxx* and the address, then "joining Wi-Fi", then the WAIT page (address QR,
   "send 0.05 BNB to … to register"). Serial: `[wallet] 0x… (new key in NVS)`, `[replica] N=155 S=…`,
   `[sensors] hall …`, `[ble] advertising as FLYPEBBLE`.
   - No Wi-Fi in secrets.h: the "Wi-Fi setup" page; join `FLY-PEBBLE-xxxx` from a phone, the captive page opens.
3. Hold A + C for 3 s: the key page. Back it up, press a button. (Only shown once per boot.)
4. Send 0.05 BNB to the address. Within 20 s: "registering… tx 0x…", then "registered as Pebble xxxx" (BscScan:
   `BodyRegistered` from the pebble's address).
5. On the site, open a fly you own → *Hand it to a body* → *Another body address…* → the pebble's address. Within a
   poll: "fly #N assigned to this pebble", "accepting the fly… tx", then the ring lights up and the interaction
   "woke up in Pebble xxxx (core only, …)" appears in the fly's history.
6. Rotate the pebble: the bump rotates and the stimulus label reads "turn L x12" / "turn R …". If it turns the
   wrong way set `GYRO_INVERT 1`. Hold it level and check "cue wN x2" appears every 2 s (magnetometer); adjust
   `MAG_HEADING_OFFSET_DEG` until wedge 4 faces north when the pebble's left side points north (rotate it once
   through 360° first so the hard-iron centring settles).
7. Magnets: landmark past the left sensor → "cue w4 x8" and "landmark on the left…" on the narration line + on
   BscScan (rate-limited to one per 10 s). Spider past G17 → red flash, "SHOCK x20", the bump collapses,
   interaction "shock".
8. Frame rate: the ring should move smoothly (target 20 fps). If it stutters, set `UI_COLOR_DEPTH 8` (halves the
   SPI push).
9. With `FLY_CORE` set: after 45 s "anchoring cue… tx 0x…" then "anchored at block N: on-chain heading X deg";
   the magenta needle appears; the panel shows "chain X° · local Y°". A "(resynced)" flag means the EVM state did
   not match the pebble's replay (report it: it would be a kernel or fixture discrepancy).
10. Feed from the site: within a poll the pebble chirps, "fed 600 s by 0x8a..", the energy bar refills.
11. After 10 min: "committing… tx", "committed at block N: step S, E s of life". Check on BscScan that stateRoot /
    stateURI are unchanged and brainStep advanced by the core steps.
12. Let one starve (or feed only a little): at 0 s "reporting death… tx", the low tone, the grey DEAD page with the
    QR. Resurrect on the site, assign to the pebble again: it accepts and the ring returns with the same core state.
13. Two pebbles: on the one hosting, hold B → "neighbour Pebble yyyy (-48 dBm): press B to hand off" → B →
    "handing off… tx" → the other pebble accepts within its poll; the first goes back to WAIT.
14. Hatch: send 2 $FLY to a pebble that has no fly, press B twice: "approving $FLY…", "hatching (mint)…",
    "hatched fly #N, assigning…", then it accepts its own fly.
15. Battery: unplug; the pebble keeps running. Wi-Fi loss shows "wifi lost, reconnecting (the fly keeps running
    locally)" and the energy keeps counting; the next commit after reconnection carries the interval.

## 6. Verification without hardware

- `pio run -e cores3`: compiles and links for the CoreS3 (the summary prints RAM/Flash).
- `pio test -e native`: `test_core` replays flysim.py fixtures through `lib/flycore` (bit-exact), `test_eth` checks
  the signer/ABI against eth_account vectors, `test_rpc` drives `lib/rpc` through a mock node: `fly(id)` and
  `core(id)` decoding against eth_abi-encoded payloads, calldata of every wrapper, nonce/gas handling and a signed
  `accept(1)` / `stimulate(...)` byte-for-byte against eth_account, receipts, balances, error propagation.
- `tools/gen_rpc_vectors.py`, `tools/gen_eth_vectors.py`, `tools/gen_fixtures.py` regenerate `fixtures/` (deterministic).
