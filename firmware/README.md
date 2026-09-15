# Pebble firmware

The body firmware for the M5Stack CoreS3 pebbles described in [../HARDWARE.md](../HARDWARE.md): each pebble is a
wallet that registers itself as a body on `FlyRegistry`, accepts a fly, runs a bit-exact local replica of the fly's
on-chain compass core from its own sensors, anchors those senses on the EVM (`FlyCore.stimulate + tick`), commits,
reports death, hands the fly to a neighbouring pebble over BLE, and can hatch a fly of its own.

The fly's *whole* brain (139,248 neurons) runs on the **brain host** on the VPS on the pebble's behalf
([../brain/HOST_PROTOCOL.md](../brain/HOST_PROTOCOL.md)): the pebble finds the host through the registry
(`bodies(FLY_HOST_ADDR).uri`), streams the fly's life over a WebSocket into its **Life view**, sends its senses to
the fly's world, and signs every commit and death itself with the checkpoint payloads the host prepares. The host
never holds a key. Without a host the pebble is what it was: the compass core, its ring, core-only commits.

```
firmware/
  platformio.ini          envs: cores3 (M5Stack CoreS3, Arduino + M5Unified) and native (host tests)
  include/config.h        addresses, cadences, gas, pins, sense strengths, UI knobs (documented inline)
  include/certs.h         TLS roots: ISRG Root X1, DigiCert Global Root G2, Amazon Root CA 1, GTS Root R4
  include/secrets.example.h  copy to secrets.h: Wi-Fi, RPC URL, optional fixed key (gitignored)
  lib/flycore             the integer LIF compass, bit-exact with sim/flysim.py and FlyCore.sol   (native test)
  lib/keccak              keccak-256
  lib/ethtx               secp256k1 (trezor-crypto subset), RLP, EIP-155 tx, ABI                 (native test)
  lib/rpc                 JSON-RPC over TLS + FlyRegistry / FlyCore wrappers (incl. bodies(addr))  (native mock test)
  lib/hostframe           the brain host protocol: lite frame + checkpoint payload parsers (ArduinoJson),
                          auth digest/signature, HTTP Date parser                                (native test)
  src/                    the body: main (UI loop), chain task, host task, replica task, sensors, BLE, wallet, net, ui
  fixtures/               generated tables and test vectors (tools/*.py)
  test/                   test_core, test_eth, test_rpc, test_host — `pio test -e native`
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

TLS: the JSON-RPC connection and the brain host connections (WebSocket and HTTPS) are verified against the roots in
`include/certs.h` (the default `bsc-dataseed.bnbchain.org` chains to Amazon Root CA 1; `bsc-rpc.publicnode.com` to
GTS Root R4; the host's cloudflared tunnel to Google Trust Services or Let's Encrypt, both present; ISRG X1 and
DigiCert G2 cover most other providers). If your endpoint uses another CA, add its root PEM to `certs.h`, or build
with `-DINSECURE_TLS=1` in `build_flags` for a demo (then anyone on the Wi-Fi could feed the pebble fake state).

`platformio.ini` gives the arduinoWebSockets library the framework's `WiFi` / `WiFiClientSecure` include paths
explicitly (`-I${platformio.packages_dir}/framework-arduinoespressif32/libraries/...`): the library includes them
behind a `#elif` on `WEBSOCKETS_NETWORK_TYPE` that the dependency finder does not evaluate.

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
                                                   with the brain host reachable: GET /fly/<id>/checkpoint (signed) and
                                                   commit(id, <exactly the payload's stateRoot, memoryRoot, stateURI,
                                                   metadataURI, brainStep, energy, historyRoot>), then interaction(id,
                                                   kind, data) for up to INTERACTIONS_PER_COMMIT of the payload's
                                                   notable events (ate / jumped / caught), newest first;
                                                   host unreachable (or its brainStep not past the chain's): the
                                                   core-only commit as before: commit(id, stateRoot/memoryRoot/stateURI
                                                   unchanged, "", brainStep + core steps since the last commit (>= 1),
                                                   energy, keccak(texts)). A commit with no receipt is remembered and
                                                   recognised by brainStep at a later poll (the energy baseline for
                                                   feed detection moves to it). /checkpoint is destructive on the
                                                   host (it pins the snapshot and hands over the interactions since
                                                   the previous checkpoint, then forgets them), so the pebble waits
                                                   for it up to HOST_CHECKPOINT_TIMEOUT_MS (5 min: two Pinata pins
                                                   and a registry read; the proxy allows 15) and keeps the payload
                                                   until the chain has it: a send that failed (RPC down, no BNB) is
                                                   re-sent as it is after COMMIT_RETRY_S with the energy drained by
                                                   the seconds since the fetch; a receipt that was missed is checked
                                                   against the record at the regular cadence and the payload re-sent
                                                   only if it did not land; its interactions go out once the commit
                                                   is known to be on the chain (receipt or record). No new checkpoint
                                                   is asked for while one is held (dropped after
                                                   COMMIT_HOLD_MAX_REVERTS reverted sends, on a hand-off, on death)
             as they happen                        interaction: landmark (1 per 10 s), shock, fed N s [by 0x..], handoff
             energy                                the newest of: the host's frame energy - seconds since (the whole
                                                   brain knows what the fly ate) and fly.energy at the last commit -
                                                   seconds since (+ feeds seen; a feed seen while no frame arrives is
                                                   added on top of the frame's value until the next frame)
             death                                 a fresh frame (< 3 s, same generation as the record) says alive ==
                                                   false, or the local counter reaches 0: fly(id) is re-read first
                                                   (died() checks neither energy nor feeds): fed meanwhile -> keeps
                                                   living; dead on-chain (a died() whose receipt was missed) -> DEAD, no
                                                   tx; moved -> WAIT, no tx; otherwise GET /fly/<id>/final (signed):
                                                   200 -> died(id, <the payload's roots, uris, brainStep>, cause);
                                                   409 (alive in its world) -> wait for the host's verdict; unreachable
                                                   -> died(id, unchanged roots/uri, "", brainStep, "starved in Pebble
                                                   xxxx") as before (only when the local counter is at 0). One died()
                                                   at a time; a revert is never blindly re-sent (poll, wait DIE_RETRY_S
                                                   doubling, at most DIE_MAX_REVERTS); anchors and commits pause while
                                                   dying but polling never does
           host task (core 0):
             origin                                bodies(FLY_HOST_ADDR).uri read by the chain task when hosting
                                                   starts, every HOST_ORIGIN_REFRESH_S (5 min) and whenever the stream
                                                   fails (never more often than HOST_ORIGIN_RETRY_S)
             frames                                wss <origin>/fly/<id>/ws?lite=1 (links2004/WebSockets over
                                                   WiFiClientSecure, roots from certs.h; heartbeat 15 s); one lite frame
                                                   every 200 ms parsed by lib/hostframe into g_host (position, heading,
                                                   energy, alive, mode, food[<=8], predator, puffs[<=4], rates subset,
                                                   events[<=6], realtime, generation); a 400-point trail; frames over
                                                   HOST_FRAME_MAX (6 KB) are dropped. Whenever the socket is quiet for
                                                   1.5 s the task polls GET /frame every HOST_POLL_MS (300) with
                                                   keep-alive; a socket silent for HOST_WS_GIVEUP_MS is switched off
                                                   for HOST_WS_RETRY_MS (polling carries on). -DHOST_USE_WS=0 polls only
             senses                                landmark left/right -> {"kind":"landmark","side":...}, spider ->
                                                   {"kind":"shock","side":HOST_SHOCK_SIDE}, landmark 2 / a touched wedge
                                                   -> {"kind":"cue","wedge":w}: POST /fly/<id>/sense (signed), at most
                                                   one a second (extras wait, > 5 s old ones are dropped); the local
                                                   core stimuli and the anchors are unchanged. /frame and /sense share
                                                   one TLS connection with the chain task's /checkpoint and /final,
                                                   which hold it for minutes: they wait HOST_HTTP_BUSY_WAIT_MS for it
                                                   and otherwise skip the poll / keep the sense for the next round, so
                                                   the WebSocket loop never stalls behind a checkpoint
             auth                                  X-Fly-Ts = unix seconds from the host's own clock (the frame's
                                                   `wall`, else the Date header of any host response, else SNTP),
                                                   X-Fly-Sig = 0x r||s||v over keccak256("flyhost|<id>|<ts>"), v = 27 +
                                                   recid, signed with the pebble's key (lib/hostframe, test_host)
             sounds                                a new diary line with "finished a food" -> chirp, "jumped" -> blip,
                                                   "caught" -> low tone (the backlog on connect stays silent)
DEAD       grey screen, brain hash, QR to SITE_URL/fly/?id=N, low tone; keeps polling: resurrected + assigned -> HOST
           (the host task keeps streaming a dead fly's diary for the 10 minutes its process lives on)
```

A frame or a `/final` payload whose `generation` differs from the registry record's is ignored (after a
resurrection the host may still stream the previous life's death for a while); the Compass view then says
"brain host offline" until the new life's frames arrive.

Buttons (the three touch areas under the screen, A B C from left to right):

| Gesture | When | Effect |
|---|---|---|
| hold A + C for 3 s | any time, once per boot | shows the private key (hex + QR) for backup |
| B | hosting a fly | toggles Life / Compass (Life needs fresh frames; stale > 3 s falls back to the Compass by itself) |
| hold B | hosting a fly | BLE scan 3 s, shows the strongest neighbour pebble |
| B again | neighbour shown (20 s window) | `assign(id, neighbour)`; the neighbour accepts within one of its polls |
| A or C | neighbour shown | cancel |
| B, then B again within 8 s | no fly, pebble holds >= 1 $FLY | hatch: `approve` (if needed), `mint("Pebble xxxx")`, `assign(id, me)`, accept |
| touch the ring | hosting, Compass view | cue the wedge under the finger (also sent to the host as a cue) |

Screens. **Life** (default while the host's frames are fresh): left, the fly's world top-down in a dark panel:
the arena border, the trail (oldest dimmest), food dots with a soft green plume glow sized by what is left of them,
odor puffs as fainter violet glows, the predator as a blue dot, the fly as a red triangle pointing along its
heading, and the line "brain on host · 0.8x real time" so nobody mistakes where the neurons are; under the panel
the newest diary line. Right: fly name and id, ALIVE with the generation, energy bar with h/m/s from the frame, a
big word for what it is doing (wandering / following a scent / casting / eating / fleeing / still), five short bars
for the brain lighting up by region: smell (ALPN), memory (KC + MBON), sight (LC4 L + R), steering (|DNa02 L − R|),
taste (GRN), each `1 − exp(−rate / LIFE_SCALE_*)`, then jumps/hits, Wi-Fi/BLE dots, "ws"/"poll" (green while
connected) and the button hints. **Compass** (B, or automatically when frames go stale): the 16-wedge ring shaded
amber→red by the EPG bump (mean membrane potential per wedge, like the site), a faint blue outer ring for the
heading histogram, the white needle = local population vector, the thin magenta line = the on-chain vector at the
last anchor, the fly glyph turned to the heading, the active stimulus under the ring, labelled "on-chain" (and
"brain host offline" / "no brain host" when there are no fresh frames). Right: fly name and id, ALIVE/DEAD, energy
bar and seconds left, spikes/s and step, last anchor block with "chain N°" vs "local N°", the pebble's short
address, BNB balance, Wi-Fi/BLE dots, and what the buttons do. Bottom of both: one line of narration (status / tx
hashes / errors). No fly: the address as a QR.

## 4. Chain cadence and gas (config.h)

`ANCHOR_EVERY_S` 45 (≈ 0.00023 BNB per anchor at 0.05 gwei; set 120 for a long day), `ANCHOR_STEPS` 16,
`COMMIT_EVERY_S` 600, `POLL_EVERY_S` 15, `INTERACTIONS_PER_COMMIT` 3 (host events sent after a whole-brain commit). Gas price = max(eth_gasPrice, `GAS_PRICE_WEI` 0.05 gwei), capped at
`GAS_PRICE_MAX_WEI` 5 gwei. Host knobs: `HOST_STALE_MS` 3000, `HOST_POLL_MS` 300, `HOST_FRAME_MAX` 6144,
`HOST_HTTP_MAX` 8192, `HOST_HTTP_TIMEOUT_MS` 12000 (connect, /frame, /sense), `HOST_CHECKPOINT_TIMEOUT_MS` 300000
(/checkpoint and /final: the host pins twice and reads the registry before answering; giving up early loses the
interactions it handed over), `HOST_HTTP_BUSY_WAIT_MS` 100, `COMMIT_RETRY_S` 60 and `COMMIT_HOLD_MAX_REVERTS` 3 (a
held checkpoint payload whose send failed is re-sent that often, and dropped after that many reverts),
`HOST_ORIGIN_REFRESH_S` 300, `HOST_ORIGIN_RETRY_S` 30,
`HOST_WS_GIVEUP_MS` 20000, `HOST_WS_RETRY_MS` 60000, `HOST_SENSE_MIN_MS` 1000, `HOST_SHOCK_SIDE` "right",
`HOST_TRAIL_LEN` 400, `LIFE_SCALE_*` (the Hz at which each Life bar is 63% full; calibrate on a live fly). Gas limits: registerBody 200k, accept 120k, assign 120k, interaction 120k, commit 300k,
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
16. Brain host (with `brain/flyhost.py` running and registered): within a poll of accepting, serial shows
    `[host] origin https://…` then `[host] ws wss://…/fly/N/ws?lite=1` and `[host] ws connected`; the Life view
    appears (the fly moves, the diary updates, "brain on host · N.Nx real time"). Press B: the Compass ("on-chain");
    B again: Life. Kill the host process: within 3 s the Compass comes back with "brain host offline"; the energy
    keeps counting from the last frame; restart the host: Life returns. Check the memory line in the serial log
    (`[heap] internal free …`) while the WebSocket, the host HTTPS and the RPC TLS connections are all up.
17. Senses to the host: landmark magnet left → serial `[host] sense {"kind":"landmark","side":"left"} -> {"ok":true,…}`
    and a violet puff appears on the left of the fly, which turns toward it; spider → a blue dot approaches, the
    fly jumps (blip). Feed from the site: food appears in the world; when the fly finishes it, a chirp and the
    diary line. Touch a wedge in the Compass view: a puff in that direction.
18. Whole-brain commit: after 10 min "asking the brain host for a checkpoint…", "committing the host's
    checkpoint… tx", "committed at block N: step S, E s of life (whole brain)", then up to 3 "ate/jumped/caught: …
    tx" lines. On BscScan the commit carries the host's stateRoot / stateURI (ipfs://…) and the interactions
    follow. Stop the host before a commit: "brain host checkpoint failed (…): core-only commit". Cut the RPC
    (wrong RPC_URL) right after "asking the brain host for a checkpoint…": "commit failed: … (the checkpoint is
    kept; retrying)", then a minute later "re-sending the held checkpoint (step S, attempt 2)"; no second
    checkpoint is asked of the host until that one is on the chain, and its interactions follow it.
19. Death through the host: let the fly starve in its world (or feed nothing): the frame says dead → "died in
    its world: checking the registry", "reporting death (host payload)… tx", the DEAD page. The cause on the site
    reads "starved in Pebble xxxx". Resurrect + assign again: the old process's dead frames are ignored
    ("brain host offline" until the new life streams).

## 6. Verification without hardware

- `pio run -e cores3`: compiles and links for the CoreS3 (the summary prints RAM/Flash).
- `pio test -e native`: `test_core` replays flysim.py fixtures through `lib/flycore` (bit-exact), `test_eth` checks
  the signer/ABI against eth_account vectors, `test_rpc` drives `lib/rpc` through a mock node: `fly(id)` and
  `core(id)` decoding against eth_abi-encoded payloads, calldata of every wrapper, nonce/gas handling and a signed
  `accept(1)` / `stimulate(...)` byte-for-byte against eth_account, receipts, balances, error propagation;
  `test_host` parses the HOST_PROTOCOL.md lite frame and checkpoint/final payloads with the pebble's own parser
  (`lib/hostframe`, same ArduinoJson), checks the caps (8 food, 4 puffs, 6 events, 8 interactions newest first) and
  rejects, and checks the auth digest and the r||s||v signature byte-for-byte against eth_account, including the
  address `Account._recover_hash` recovers (the host's check); plus the HTTP Date parser, `bodies(address)`, and
  the held checkpoint (`hostframe::Held`: pending until the chain's brainStep reaches the payload's, energy drained
  by the seconds since the fetch, `commitDue` retry cadence, millis() rollover).
- `tools/gen_rpc_vectors.py`, `tools/gen_eth_vectors.py`, `tools/gen_fixtures.py`, `tools/gen_host_vectors.py`
  regenerate `fixtures/` (deterministic).
