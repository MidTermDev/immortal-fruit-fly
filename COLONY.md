# The Colony: flies living together in Minecraft

*17 September 2026. The next body: a Minecraft world on the VPS where many flies live at once, viewable in the browser, each running its whole brain, each spending its on-chain life to be there. Companion to [PLAN.md](PLAN.md), [HARDWARE.md](HARDWARE.md) and [brain/HOST_PROTOCOL.md](brain/HOST_PROTOCOL.md).*

## 1. What it is

The Colony is a registered body on `FlyRegistry` (name `Colony`, key `brain/body_colony.key`). An owner assigns a fly to it from the fly's page; the Colony accepts, downloads the fly's brain from IPFS, verifies the hash, and the fly **joins a shared Minecraft server as a player** named after it. Its 139,248 neurons run on the VPS; what those neurons sense is the Minecraft world around the bot, and what they drive is the bot's body. Several flies live in the same world at the same time: they smell the same food, flee the same zombies, and meet each other. Every notable thing is written to the chain as an `interaction`; the brain is checkpointed to IPFS every ten minutes; when the fly starves it dies on-chain and its brain is preserved, exactly as in the arena.

Nobody needs Minecraft installed to watch: the site's `/colony` page shows the world through a browser viewer, with each fly's brain lighting up beside it.

## 2. Senses and motor (honest mapping)

The mapping reuses the arena's, so behaviour is the same organism in a new world.

| Minecraft | Fly neurons | How |
|---|---|---|
| food items on the ground (bread, apples, cookies) and food blocks (sweet berry bushes, cake) within 32 blocks | olfactory receptor neurons, left/right by bearing (an odor plume with the arena's distance decay) | the strongest scent wins, bilateral contrast as in `world.py` |
| a hostile mob approaching (zombie, skeleton, spider) in the front 120° | LC4 / LPLC2 looming detectors, by side | angular size growth, as in DOOM |
| standing on / holding food | gustatory neurons (GRN) | eating restores energy: 1 s of life per food point, bread = 5 |
| another fly within 6 blocks | `interaction(id, "met", "fly #n")`, once per minute per pair | social history; no neural input yet (the model has no social circuit) |
| light level (night) | none in v1 | night is when the zombies come |
| DNa02 L−R, DNa01 | turn rate (yaw) | the arena's steering readout |
| DN population | forward speed (walk / sprint) | surge-and-cast locomotion program from the arena |
| giant fiber (DNp01) spike | jump | the escape reflex, as in the arena and DOOM |
| MDN | walk backward | as in the arena |

What flies do together, without pretending they cooperate: they converge on the same food, they scatter from the same zombie, they mark where they ate (the bot places a torch: a landmark the others can see as light, and the colony's map fills with torches where the food was), and their meetings go on-chain. That is a colony as flies actually have them: shared environment, shared memory of where the food is, no foreman.

## 3. Life, energy, death

- Being in the Colony costs 1 s of life per second, from the fly's on-chain energy (the body commits `energy` every checkpoint).
- `feed(id, seconds)` on the registry drops that many food points near the fly in the world (bread, 5 s each), as the arena drops food. The fly has to smell its way there and eat.
- A zombie hit costs 60 s (the arena's rule) and knocks the bot; the bot never fights back (flies don't).
- Energy 0 → `died(id, …, "starved in the Colony")`, the bot leaves the world; resurrect on the site and assign again.
- Capacity: `COLONY_MAX_FLIES` at once (default 6; each whole brain gets `28 // n` threads; the frame carries `realtime` so the speed is always shown honestly). Beyond that, assigned flies wait in a queue and the site says so.

## 4. Architecture

```
 owner: assign(id, Colony) ─▶ FlyRegistry ◀── Colony body: accept / commit / interaction / died (key body_colony.key)
                                   │
   brain/colony/colony.py (supervisor, aiohttp :8125, cloudflared tunnel, announces its url as the Colony body)
     ├─ scans the registry: alive flies whose body == Colony → one brain process each (cap COLONY_MAX_FLIES)
     ├─ brain/server.py --colony FLY_ID=… : the whole brain + MinecraftWorld adapter (world.py senses/motor reused)
     │      ◀── local WebSocket (10 Hz) ──▶ brain/colony/agent.mjs (mineflayer bot "fly<id>"): senses in, motor out
     ├─ PaperMC server (brain/colony/server/, offline mode, whitelist = the flies, viewer bots, and names from ALLOW_PLAYERS)
     ├─ prismarine-viewer per active fly (its own port, proxied under /fly/<id>/view/) and one colony camera bot (/view/)
     └─ /colony/state (all flies: position, mode, energy, last event), /fly/<id>/ws?lite=1 (the lite frame), /fly/<id>/ws (hdr + spikes)
```

`server.py --colony` is the same process as the arena and the brain host, with `World` swapped for `MinecraftWorld`: the same odor/looming/taste code, the same DN readouts, the same snapshot format (so `verify.py` replays it), the same checkpoint/death/interaction paths, using the Colony key. The Node agent is a thin body: it does no thinking.

### Agent protocol (local WebSocket `ws://127.0.0.1:<port>/agent`)

Node → Python, 10 Hz:
```json
{"t": 1789600000.1, "pos": [x, y, z], "yaw": 1.57, "health": 20, "onGround": true, "light": 15, "night": false,
 "food": [{"dx": 3.2, "dz": -1.0, "dist": 3.4, "points": 5, "kind": "bread"}],
 "mobs": [{"dx": -8.0, "dz": 2.0, "dist": 8.2, "kind": "zombie", "closing": 1.9}],
 "flies": [{"id": 12, "dist": 4.1}], "eating": false, "holdingFood": 3, "hit": false}
```
Python → Node, 10 Hz:
```json
{"turn": -0.6, "forward": 1.0, "sprint": false, "back": false, "jump": false, "eat": true, "torch": false, "say": "yum"}
```
`turn` is rad/s (clamped ±3), `forward` 0..1, `eat` makes the bot pick up / eat the nearest food, `torch` places a torch where it stands (once per meal), `say` is a chat line (the speech strip: "I smell something…", "a shadow!", "yum").

## 5. The web view

- `/colony` on the site: the world through a browser viewer (prismarine-viewer, embedded), a colony map (top-down: flies, food, torches, mobs; from `/colony/state`), and a fly picker. For the picked fly: the 3D brain point cloud lighting up (the home page's `BrainLive`, fed by `/fly/<id>/ws`), the region bars, the diary and its speech, the on-chain block of its last checkpoint. That is the "neurology" panel: the real neurons of the fly you are watching, firing as it walks.
- Each fly's page gets a **Colony** figure when its body is the Colony: the viewer and the same panel.
- Nothing on the page is a video: it is the live world and the live brain.

## 6. Build order

1. Paper server (1.21.x, offline mode, flat-ish world with a spawn glade, difficulty easy, mobs on, keep-inventory) installed under `brain/colony/server/`, started by the supervisor; a `colony` body key and address.
2. `agent.mjs` (mineflayer): join, senses, motor, eat, torch, chat; tested against the server with a scripted brain (a Python stub that surges toward food) before the real one.
3. `MinecraftWorld` in `brain/world.py` (subclass: same senses/motor code, positions from the agent, food/mob lists from the agent, eating and hits from the agent) and `server.py --colony`.
4. `colony.py` supervisor: registry scan, accept, brain processes, viewers, proxy, tunnel, announce; commits/deaths through the Colony key; the food-drop on `Fed`.
5. Site: `/colony` and the fly-page figure; docs page.
6. Later: real players on a whitelist, night raids, breeding in the world.

## 7. Honest limits

- Speed: six whole brains on one machine run at roughly a third of real time each; the page says so. The number of flies in the world is the cap, not a hidden slowdown.
- The brains do not know what Minecraft is. They smell, see looming, taste, and steer, because that is what the connectome does; everything else (which item is food, what a zombie is) is the body's translation, exactly as a real fly's body translates the world into receptor currents.
- Colony checkpoints are trusted-body commits, like DOOM's: what the bot sensed is not a world event a verifier can regenerate from the chain, so the senses stay out of the snapshot's applied-event log and are written per checkpoint interval to `brain/state_colony_<id>/senses_<n>.jsonl` (each adopted frame with the brain step it was applied at); given that stream the brain is deterministic, and a replay tool can come later. On-chain `interaction` events from the Colony are rate-limited to one per kind per 30 s per fly (zombies at night would otherwise cost a transaction a jump); every event still enters the checkpoint's `historyRoot`.
