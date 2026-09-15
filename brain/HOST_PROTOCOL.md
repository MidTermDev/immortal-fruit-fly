# The brain host: a whole brain for a fly whose body is a pebble

A pebble is a fly's *body* on the registry (its address accepts, commits, logs, reports death) but it cannot run the
139,248-neuron whole brain. The **brain host** runs that brain on the VPS on the pebble's behalf, streams the fly's
life to the pebble (and to the site), takes the pebble's senses as events in the fly's world, and hands the pebble
signed-nothing: the pebble signs every registry transaction itself with the checkpoint payloads the host prepares.
The host never holds a body key. Fly #1 in the arena (`server.py` as the arena body) is unchanged.

```
 pebble (body key)                                brain host (VPS)                                BNB Chain
 ─────────────────                                ────────────────                                ─────────
 accept(id) ──────────────────────────────────────────────────────────────────────────────────▶ registry
 GET bodies(HOST).uri  ◀──────────────────────────────────────────────────────────────────────── registry
 wss <host>/fly/<id>/ws?lite=1  ◀──────── frames (5 Hz) ── sim of fly <id>: world + whole brain
 POST <host>/fly/<id>/sense  ─────────────▶ puff of odor / predator from that side
 GET  <host>/fly/<id>/checkpoint (signed) ─▶ snapshot → IPFS, metadata → IPFS, payload ◀─┐
 commit(id, payload…) ────────────────────────────────────────────────────────────────────┴───▶ registry
 interaction(id, …) for the payload's notable events ────────────────────────────────────────▶ registry
 GET  <host>/fly/<id>/final (signed) when the frame says dead ─▶ final payload → died(id, …) ─▶ registry
```

## Discovery

The host is itself a registered body on `FlyRegistry` (name `Brain host`, key `brain/body_host.key`, address in
`firmware/include/config.h` as `FLY_HOST_ADDR` and in `web/src/lib/config.ts` as `bodies.host`). Its `uri` is the
current public origin (a cloudflared tunnel; re-registered on every restart, exactly like the arena). A fly `<id>`
hosted for a pebble lives at `<uri>/fly/<id>/…`.

## Which flies the host runs

Every 15 s the supervisor (`brain/flyhost.py`) scans the registry: for each alive fly whose `body` is a registered body
whose name starts with `Pebble`, it runs one `server.py --remote-body` process (env `FLY_ID`, `BODY_ADDR`, `PORT`,
`NUMBA_NUM_THREADS`), and proxies `/fly/<id>/*` (HTTP and WebSocket) to it. A process is stopped when the fly is no
longer that pebble's, or 10 minutes after it died (so the pebble can still fetch `/final`). Threads per process:
`max(4, 16 // nflies)`; the frame carries `realtime` so every client can show the speed honestly.

## Instantiation

As the arena does: fetch `stateURI` from IPFS, load it, and verify that the brain's state hash (`WholeBrain.state_hash()`, sha256 over the membrane, synaptic, ring and refractory arrays and the step) equals `stateRoot`; load the world. A genesis fly
(`stateURI` empty, `stateRoot == GENESIS_STATE`) starts from the canonical resting state (`WholeBrain()` fresh), whose
hash must equal `stateRoot`. Energy, alive and generation come from the fly record. Feeds and resurrections are
applied from chain events exactly as in the arena (`Fed` → food placed near the fly; `Resurrected` → world.resurrect).

## Endpoints (all under `/fly/<id>`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/frame` | no | the lite frame (below) |
| GET | `/ws?lite=1` | no | WebSocket, one lite frame every 200 ms as JSON text (no spikes); `/ws` without `lite` behaves like the arena's (hdr + spikes) |
| GET | `/state` | no | `{hdr, log, frame_age_s}` like the arena |
| GET | `/health` | no | `{ok, alive, age_ms, realtime, body, fly}` |
| POST | `/sense` | yes | applies a sense event to the world; `{ok:true, effect:"…"}` |
| GET | `/checkpoint` | yes | saves + pins a snapshot and fresh token metadata; returns the commit payload |
| GET | `/final` | yes | the death payload (only once the fly is dead in the world); `409` while alive |

### Auth (the pebble proves it is the body)

Headers `X-Fly-Ts: <unix seconds>` and `X-Fly-Sig: 0x<r(32)||s(32)||v(1)>` with `v ∈ {27, 28}` over
`digest = keccak256(ascii("flyhost|" + id + "|" + ts))` (the raw digest is signed; no EIP-191 prefix).
The host recovers the signer with `eth_account.Account._recover_hash(digest, signature=sig)` and requires
`signer == registry.fly(id).body` (record cached 15 s) and `|now - ts| ≤ 120 s`. Failure → `403 {"error":"not the body"}`.

### Lite frame

Exactly the arena's `hdr` (see `World.snapshot()` plus `wall`, `realtime`, `chain`, `nrender`), no `spikes`:

```json
{"t_ms": 1234500.0, "step": 12345000, "x": 12.3, "y": -4.5, "heading": 1.57, "energy": 812.4, "alive": true,
 "generation": 0, "life_ms": 1234500.0, "spikes_total": 812345678, "ate": 120.0, "jumps": 7, "hits": 0,
 "food": [{"id": 1, "x": 40.0, "y": 10.0, "energy": 550.0, "energy0": 600.0, "by": "0x…"}],
 "predator": {"x": 80.1, "y": -30.2, "size": 6.0} , "lamp": [96.0, 96.0], "arena": 240.0,
 "rates": {"DNa02_left": 11.0, "DNa02_right": 40.2, "DNa01_left": …, "DNa_left": …, "DN_all": …, "ALPN": …, "KC": …, "MBON": …, "LC4_left": …, "LC4_right": …, "GRN_labellar": …, "DNp01_left": …, "DNp01_right": …, "MDN_left": …, "MDN_right": …},
 "steer": 0.4, "mode": "surge", "orn": [12.0, 30.5], "events": [[1230000.0, "smelled food"], [1231000.0, "giant fiber spike: jumped"]],
 "wall": 1789500000.0, "realtime": 0.82, "chain": {"last_hash": "…", "checkpoints": 3}, "nrender": 41873}
```

`mode` is the world's locomotion mode: `walk` (wandering), `surge` (following a scent) or `cast` (searching); eating,
jumping and being caught show up in `events` and `rates`. `puffs` (odor puffs from the pebble's senses, `{x, y, strength,
expires_ms}`) is present when any are active. `events` are the last 12 diary lines `(t_ms, text)`; `realtime` is
simulated seconds per wall second.

### `/sense` body

```json
{"kind": "landmark", "side": "left"}      → an odor puff (no food) 40 body lengths to that side of the fly, 8 s: it turns and surges toward it
{"kind": "shock", "side": "right"}        → a predator appears 0.7·ARENA away on that side, approaching now (looming → giant fiber → jump)
{"kind": "cue", "wedge": 4}               → an odor puff in that compass direction (wedge w = angle (w + 0.5)·2π/16)
{"kind": "turn", "deg": -35.0}            → the world's wind (plume drift) rotates by that much (v2; the host may ignore it)
```

Sides are relative to the fly's heading. Rate limit: one event per second per fly; extra events are dropped (`{ok:false}`).

### `/checkpoint` response (the commit payload)

```json
{"stateRoot": "0x…", "memoryRoot": "0x…", "stateURI": "ipfs://…", "metadataURI": "ipfs://…",
 "brainStep": 142378000, "energy": 812, "historyRoot": "0x…",
 "interactions": [{"t_ms": 1231000.0, "kind": "jumped", "data": "giant fiber spike: jumped"}, {"t_ms": …, "kind": "ate", "data": "finished a food item worth 600s"}],
 "age_s": 1234, "spikes": 812345678, "generation": 0}
```

`historyRoot = sha256(json.dumps(interactions, sort_keys=True))` over every interaction since the previous checkpoint
(the same rule as the arena). The pebble sends `commit(id, stateRoot, memoryRoot, stateURI, metadataURI, brainStep,
energy, historyRoot)` and then `interaction(id, kind, data)` for up to `INTERACTIONS_PER_COMMIT` (default 3) of the
listed notable events, newest first, with kinds `ate`, `jumped`, `caught`. The token metadata the host pins carries
`Body: <pebble name>` and the state being committed (never a stale record).

### `/final` response

The same shape plus `"cause": "starved in <pebble name>"`; the pebble sends `died(id, stateRoot, memoryRoot, stateURI,
metadataURI, brainStep, cause)`. Available for as long as the chain still says the fly is alive (the death is unreported),
and for 10 minutes after the on-chain death; it survives a host restart.

## What the pebble shows

**Life** (default when the host stream is up): the fly's world top-down (fly, trail, food and plume, predator), what it
is doing (`mode` as a word: wandering, following a scent, casting, eating, fleeing), energy, the brain lighting up by
region from `rates` (smell: ALPN; memory: KC/MBON; sight: LC4; steering: DNa; taste: GRN), and the diary; chirps on
`ate`, `jumped`, `caught`. **Compass** (a button away): the on-chain core ring, as today. The Life view says
`brain on host · 0.8× real time` so nobody mistakes where the neurons are; the compass says `on-chain`.

## Failure modes

- Host unreachable: the pebble keeps the local core running, shows the Compass view with `brain host offline`, and
  commits the core-only payload (previous roots unchanged, brainStep advanced) as before.
- Pebble unreachable: the host keeps simulating (the fly keeps living); energy is drained by the host's clock, and the
  next checkpoint the pebble fetches carries the truth. If the pebble never returns, the fly starves on the host and
  `/final` waits for it.
- Both agree on energy by the checkpoint payload; the pebble's own energy counter is only for the display between them.
