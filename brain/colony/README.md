# brain/colony: the Minecraft side of the Colony

The Colony ([../../COLONY.md](../../COLONY.md)) is a Minecraft world on the VPS where several flies live at once.
This directory holds the *body*: a private Paper server, one mineflayer bot per fly (`agent.mjs`), the browser
viewers, and the tools to test them. The brains (`server.py --colony`) and the supervisor (`colony.py`,
`run_colony.sh`) are separate and are not described here beyond what they must call.

```
brain/colony/
  server/                 the Paper 1.21.4 installation (gitignored except eula.txt, server.properties.in,
                          config/paper-world-defaults.yml); paper.jar, the world, logs, rcon.txt live here
  tools/fetch_paper.sh    downloads the pinned Paper build into server/paper.jar (fill v3 API, sha256 checked)
  tools/run_server.sh     start | run | setup | stop | status
  tools/rcon.py           RCON client (no dependencies), CLI and library
  agent.mjs               the bot of one fly: senses out, motor in, over a local WebSocket at 10 Hz
  tools/viewer.mjs        a prismarine-viewer for a bot (module used by agent.mjs, and a follower camera CLI)
  tools/camera.mjs        the colony camera bot `flycam`: top-down overview for the site's /view/
  tools/scripted_brain.py a stand-in brain with a hard-coded policy, for testing the agent end to end
```

Versions: **Minecraft 1.21.4**, Paper build 232 (the newest 1.21.x that both mineflayer 4.39 (tested versions) and
prismarine-viewer 1.33 (shipped textures and block states) support). Node dependencies: `mineflayer 4.39.0`,
`prismarine-viewer 1.33.0`, `canvas` (prismarine-viewer requires it server-side but does not declare it), `vec3`.
Java 21 (`~/.sdkman/candidates/java/current/bin/java`), Python `../../.venv/bin/python` (aiohttp for the scripted brain).

## The server

```
cd brain/colony
npm install                      # once
tools/fetch_paper.sh             # once: server/paper.jar (Paper 1.21.4-232, sha256 verified)
tools/run_server.sh start        # starts detached, waits for "Done", applies the world setup, returns
tools/run_server.sh status
tools/run_server.sh stop         # `stop` over RCON, SIGTERM after 30 s
```

`start` runs `java -Xms1G -Xmx3G -XX:+UseG1GC -jar paper.jar nogui` with cwd `server/`, pidfile `server/server.pid`,
Paper's own log in `server/logs/latest.log` and the JVM's stdout in `server/logs/console.log`. The first start
generates the world (about 10 s). `run` starts it in the foreground instead (for a supervisor that wants to own the
process; it must then call `tools/run_server.sh setup` after "Done" itself). `setup` is idempotent and is what
`start` applies: the gamerules (`keepInventory`, `doDaylightCycle`, `doMobSpawning`, `doImmediateRespawn` on,
`doWeatherCycle`, `mobGriefing`, `announceAdvancements` off, `spawnRadius 2`), `weather clear`, the spawn at
`0 64 0`, a 256-block world border centred on it, the spawn chunks force-loaded, and a ring of eight torches around
spawn (the lit glade the flies arrive in).

**Ports.** Minecraft on `127.0.0.1:25565`, RCON on `127.0.0.1:25575`; both loopback only (`server-ip=127.0.0.1`).
Nothing of the Colony is public except through the supervisor on :8125 behind nginx.

**RCON.** The password is generated once into `server/rcon.txt` (mode 600, gitignored) and copied into
`server.properties` at every start. `server.properties` itself is generated from `server.properties.in` on first
start (edit the template; Paper re-saves the live file). Use it as:

```
tools/rcon.py list
tools/rcon.py 'whitelist add fly12' 'give fly12 minecraft:torch 64'
echo 'say hello' | tools/rcon.py -
tools/rcon.py --wait 90 list           # block until RCON accepts a login (server starting)
from rcon import Rcon; with Rcon() as r: print(r.command('list'))   # (sys.path += ['brain/colony/tools'])
```

The client sends one request at a time (vanilla closes the socket if two packets arrive in one read) and reads
multi-packet replies by size.

**The world.** `level-type=minecraft:flat` with a custom preset: bedrock, 121 stone, 5 dirt, grass, biome plains, no
structures, seed 139248, name `colony`. The surface is y=63 so a standing fly is at **y=64**: above 0 (prismarine-viewer's
third-person camera only initialises for y>0) and above the slime spawn height (a superflat at y=-60 is a slime
chunk swamp, as the first test showed). Flat, open and unlit, so dropped food is visible from the camera and the
zombies, skeletons, spiders and creepers come at night everywhere except where the flies have placed torches.
`max-world-size=128` (the border is 256 wide), `view-distance=6`, `simulation-distance=4`, `difficulty=easy`,
`spawn-monsters=true`, `pvp=false`, `spawn-protection=0`, `max-players=20`, motd "Immortal Fruit Fly colony".
`config/paper-world-defaults.yml` makes bread, apples, cookies and sweet berries on the ground live 1 hour instead
of 5 minutes (`alt-item-despawn-rate`), so food dropped by `feed()` waits for a fly.

**Whitelist rule.** `online-mode=false`, `white-list=true`, `enforce-whitelist=true`: anyone can claim any name, so
only whitelisted names can join, and only the supervisor edits the whitelist, over RCON, never by hand:

- when the Colony accepts fly `<id>`: `whitelist add fly<id>` (then start `agent.mjs`);
- when the fly leaves, dies or is unassigned: `whitelist remove fly<id>` (with `enforce-whitelist` that also kicks it);
- the camera bots: `whitelist add flycam` and `whitelist add cam<id>` for follower cameras, plus `gamemode spectator <name>`;
- real players only from `ALLOW_PLAYERS` (COLONY.md section 4), added the same way.

Bot names are `fly<id>` (at most 16 characters, so ids up to 13 digits). On its first join a fly has an empty
inventory: the supervisor gives it torches (`give fly<id> minecraft:torch 64`) so the `torch` action can work;
`keepInventory` keeps them across deaths.

## The agent (`agent.mjs`)

```
FLY_ID=12 NAME=fly12 BRAIN_WS=ws://127.0.0.1:9012/agent SERVER_HOST=127.0.0.1 SERVER_PORT=25565 node agent.mjs
node agent.mjs --id 12 --name fly12 --brain ws://127.0.0.1:9012/agent --host 127.0.0.1 --port 25565
```

Defaults: `NAME=fly<id>`, `BRAIN_WS=ws://127.0.0.1:<9000+id>/agent`, server `127.0.0.1:25565`, `MC_VERSION=1.21.4`.
Optional: `VIEWER_PORT=<port>` serves a prismarine-viewer of this fly's world on `127.0.0.1:<port>`
(`VIEWER_PREFIX=/fly/<id>/view` when the supervisor proxies it under that path, `VIEWER_FIRST_PERSON=0` for the
orbit camera), `AGENT_VERBOSE=1` logs the food/mob lists every 5 s.

The bot joins, connects to the brain, and every 100 ms sends the senses and applies the last motor command. It
reconnects to the server (2 s, doubling to 60 s) and to the brain (1 s, doubling to 15 s), stands still when the
brain has been silent for 1 s, and leaves cleanly on SIGTERM. When the brain closes its WebSocket the bot stops
moving but stays in the world; the supervisor stops the agent process when the fly is gone. **Every message the
agent sends on the brain socket is a senses frame** (`server.py` adopts any object it receives as senses, with
`holdingFood` defaulting to 0, so a greeting would be a phantom meal): there is no hello, no status message.

**Senses (Node to Python, 10 Hz)**, COLONY.md's fields plus a few extras:

```json
{"t": 1789600000.1, "pos": [x, y, z], "yaw": 1.57, "health": 20, "onGround": true, "light": 15, "night": false,
 "food": [{"dx": 3.2, "dz": -1.0, "dist": 3.4, "points": 5, "kind": "bread", "bearing": 0.4, "count": 1}],
 "mobs": [{"dx": -8.0, "dz": 2.0, "dist": 8.2, "kind": "zombie", "closing": 1.9, "bearing": -0.3}],
 "flies": [{"id": 12, "dist": 4.1, "name": "fly12"}],
 "eating": false, "holdingFood": 3, "hit": false, "damage": 0, "died": false, "respawned": false,
 "hunger": 18, "picked": 0, "ate": 0, "torches": 15, "time": 6000}
```

- `food`: items on the ground within 32 blocks whose kind is bread (5), apple (4), cookie (2) or sweet berries (2);
  `points` is per item times the stack `count`; sorted by distance. (Food blocks such as berry bushes are not scanned in v1.)
- `mobs`: hostile mobs within 24 blocks in the front 120 degrees, sorted by distance; `closing` is the speed toward the
  bot in blocks/s (from the change of distance, smoothed over two ticks; negative when it moves away).
- `flies`: other players named `fly<n>` within 6 blocks.
- `dx`/`dz` are world-frame offsets (target minus bot). `yaw` is mineflayer's: 0 faces north (-z), +pi/2 west, and it
  **increases when turning left**; the heading vector is `(-sin yaw, -cos yaw)`. `bearing` is the angle from the heading to
  the target in radians, **positive = to the left**, the same sign as `turn`: `turn = k * bearing` steers toward it.
- `light`: the larger of the block light at the feet and the sky light dimmed by the time of day (vanilla's skyDarken
  formula), 0..15; `night` is time-of-day 13000..23000; `time` is the raw time of day in ticks.
- `hit`: the health dropped since the last tick, or the server reported damage to the bot; `damage` is the health
  lost since the last tick, summed over every health packet the server sent in between (so the killing blow keeps its
  damage even though the immediate respawn puts the health back to 20 within the same tick). The server's damage
  event and its health packet can straddle a tick, so a damage event whose health packet has not arrived is held for
  one tick: the frame that says `hit` carries the `damage`. Nothing is compared until the server's first health
  packet has arrived after a (re)join, so a fly that comes back with a persisted health below 20 does not report a
  phantom hit. Starvation damage (hunger bar at 0) counts as a hit too: there is no way to tell the source from the
  health packets alone.
- `died` / `respawned`: true on the one tick after the bot died / after it is back at world spawn (`doImmediateRespawn`,
  `keepInventory`: the death is a teleport to spawn with the inventory intact). They usually come in the same frame
  as the killing blow's `hit`; `pos` in that frame is already the spawn.
- `hunger` is the Minecraft food bar; `picked` and `ate` are the food points picked up / swallowed since the last tick;
  `holdingFood` the points in the inventory; `torches` the torches it carries.

**Motor (Python to Node)**: `{"turn": -0.6, "forward": 1.0, "sprint": false, "back": false, "jump": false, "eat": true, "torch": false, "say": "yum"}`

- `turn` rad/s, clamped to +-3, integrated into the yaw at 10 Hz (`bot.look`).
- `forward` 0..1: 1 (or >= 0.9) walks continuously, sprinting when `sprint` is true or `forward` is 1; between 0.05 and
  0.9 the bot walks on a duty cycle of that fraction of ticks (Minecraft walking is on/off); `back` walks backward
  when `forward` is 0.
- `jump`: one tick of the jump control (the escape reflex).
- `eat`: pickup is automatic when the bot walks over an item; with `eat` true and no food in hand, a morsel within 4
  blocks makes the body face it and step onto it (the tongue reflex; the brain does the long-range steering). With food in
  hand and `eat` true the bot equips and swallows it (`bot.equip` + `bot.consume`, about 1.6 s, `eating` true meanwhile).
  Minecraft refuses to eat when the hunger bar is full, so **the pickup is the meal**: `picked` is what the brain should
  count as eaten (1 s of life per point); `ate` follows whenever hunger allows. Hunger drops with sprinting and jumping.
- `torch`: places a torch on the block under its feet, at most once per 30 s, at the first moment within 3 s of the
  request that the bot stands still on the ground (a request while walking is latched, not lost). Needs a torch in the
  inventory.
- `say`: a chat line, 100 characters. The brain hands each line out once and its lines come in bursts ("there!" then
  "yum" 100 ms apart), so they are queued (at message arrival, once per motor message) and said one per 5 s, in
  order; a line already waiting is not queued twice, the queue keeps the newest 4, and a line that has waited more
  than 20 s is dropped unsaid. Queued lines are still said while the brain is silent.

## The viewers

- Per fly: `VIEWER_PORT=<port> VIEWER_PREFIX=/fly/<id>/view node agent.mjs …` serves the fly's own world view
  (first-person by default; the page follows the fly) at `http://127.0.0.1:<port>/fly/<id>/view/`. The prefix must be the
  path the supervisor proxies, because the page connects to `<pathname>socket.io`; proxy WebSocket upgrades too.
- The colony overview: `node tools/camera.mjs --port 3100 [--prefix /view] [--height 40]` joins as `flycam` (whitelist
  it; `gamemode spectator flycam`), hovers 40 blocks above the centroid of the visible flies (over spawn when none are in
  sight) looking straight down, and serves that view. Its page is the site's `/view/`.
- A follower camera: `node tools/viewer.mjs --follow fly12 --port 3012 [--name cam12] [--prefix /fly/12/view]` joins
  as `cam12` and hovers 5 blocks behind and 3 above fly12, looking at it (an alternative to the in-process viewer when a
  third-person following view is wanted).

All viewer servers bind `127.0.0.1` only.

## The scripted brain and the end-to-end test

`tools/scripted_brain.py` serves the agent protocol with a fixed policy: a mob closing faster than 1 block/s within 12
blocks makes it jump, turn away and sprint; otherwise it turns toward the strongest scent (points with a distance decay),
walks, and eats when within 4 blocks; otherwise it wanders. After a meal it stands still for a second and asks for a torch;
it says "I smell something…", "a shadow!" and "yum" like the arena's speech strip. It logs every notable sense.

```
tools/run_server.sh start
tools/rcon.py 'whitelist add fly1' 'whitelist add flycam'
../../.venv/bin/python tools/scripted_brain.py --port 9901 &
FLY_ID=1 BRAIN_WS=ws://127.0.0.1:9901/agent VIEWER_PORT=3901 AGENT_VERBOSE=1 node agent.mjs &
node tools/camera.mjs --port 3902 &
tools/rcon.py 'gamemode spectator flycam' 'give fly1 minecraft:torch 16' 'effect give fly1 minecraft:hunger 12 30'
tools/rcon.py 'execute at fly1 run summon minecraft:item ~-8 ~1 ~3 {Item:{id:"minecraft:bread",count:1}}'
      # -> agent: "says I smell something…", "picked up 1 x bread", "ate bread (+5 points)", "says yum" 5 s after the
      #    first line (queued, not dropped), "placed a torch at x y z"
tools/rcon.py 'time set 18000'          # -> senses: light drops, night=true; the plain fills with mobs
tools/rcon.py 'execute at fly1 run summon minecraft:zombie ^ ^ ^10'
      # -> brain: "MOB zombie dist=9.9 closing=0.7", "FLEE zombie closing=3.7 -> jump"; agent: "jumped (zombie at 7.26, closing 1.61)", "hit by zombie"
tools/rcon.py 'time set day' 'kill @e[type=!player]'
tools/rcon.py 'damage fly1 8' 'kick fly1'
      # -> the bot rejoins at hp 12 (or whatever the fight left): the brain sees NO "HIT" on the rejoin
tools/rcon.py 'kill fly1'               # -> agent: "died (damage this tick 12 …)", "respawned at (…)"; brain: "DIED (the
      #    killing blow's damage 12 …)", "RESPAWNED at [x, 64, z]" (the senses carry died/respawned, and the damage)
kill %1 %2 %3; tools/run_server.sh stop
```

Chat shows up in `server/logs/latest.log` as `[Not Secure] <fly1> yum`; the torch as a block (`execute if block x y z minecraft:torch run say ok`).
The scripted brain prints `WARNING: not a senses frame` if the agent ever sends anything but senses on the socket
(`server.py` would have adopted it as a frame); a clean run has none.

## What the supervisor must call

1. `tools/fetch_paper.sh` if `server/paper.jar` is missing; `npm install` if `node_modules/` is.
2. `tools/run_server.sh start` (blocks until "Done" and the setup; exit code 0), or `run` in the foreground plus `setup`.
3. Per accepted fly `<id>` with brain port `<p>`: `tools/rcon.py 'whitelist add fly<id>'`, then
   `FLY_ID=<id> BRAIN_WS=ws://127.0.0.1:<p>/agent VIEWER_PORT=<v> VIEWER_PREFIX=/fly/<id>/view node agent.mjs`;
   once it has joined (`list` shows it, or the agent's "spawned" line): `give fly<id> minecraft:torch 64`.
   Food from `feed(id, seconds)`: `execute at fly<id> run summon minecraft:item ~<dx> ~1 ~<dz> {Item:{id:"minecraft:bread",count:<n>}}`
   (bread is 5 s each), a few blocks away in a random direction so the fly has to smell it.
4. When the fly leaves: SIGTERM the agent, `whitelist remove fly<id>`.
5. The overview: `whitelist add flycam`, `node tools/camera.mjs --port <port> --prefix /view`, then `gamemode spectator flycam`.
   `run_server.sh start` returns long before RCON answers when it is launched detached, so every `whitelist add` (the camera,
   `ALLOW_PLAYERS`, each fly) is retried on every scan until its own RCON write succeeds, and the camera bot is not started
   before its name is in (`colony.py`: `whitelist_allowed`, `camera_due`; `/colony/state` reports `world.camera_whitelisted`).
6. `tools/run_server.sh stop` at shutdown.

**What the supervisor exposes of a brain.** `/fly/<id>/{frame,ws,state,health}` by exact name and `/fly/<id>/snapshots/<one plain
file name>` (or the index), nothing else: `colony.public_path` refuses every other path with 404 before the child lookup, including
any path with a `.` or `..` segment, a `%` or a `\` (the client URL library would collapse `snapshots/../admin/commit` into the
brain's local-only `/admin/commit`, which trusts 127.0.0.1, i.e. the proxy). Everything forwarded carries `X-Forwarded-For`, and
`server.py`'s local-only routes (`/agent`, `/pending_drops`, `/dropped`, `/admin/*`, `/final`) refuse any request with a forwarding
header even from 127.0.0.1: the second line, should the first ever slip.
