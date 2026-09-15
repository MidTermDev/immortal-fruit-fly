```text
                       \   /
                .--.    \ /    .--.
               ( @@ )-.-`-'-.-( @@ )
                `--'  `.___,'  `--'
           ___________  ,-'"`-.  ___________
     _,-'"            `/       \'            "`-._
 _,-'      .       .   \       /   .       .      `-._
'     .        .        `-.|.-'        .        .     `
(   .       .       .    (=|||=)    .       .       .   )
 `-._    .        .       `|||'       .        .     _,-'
     `-._      .      _,-'=|||=`-._      .       _,-'
         `-.______,-'     =|||=    `-.______,-'
                          =|||=
                           `|'
                            '
```

<h1 align="center">Immortal Fruit Fly</h1>
<p align="center"><code>$FLY</code> · <b>Immortal Fruit Flies</b> (ERC-721) · BNB Smart Chain</p>

<p align="center">
  <b>Whole fruit-fly brains that live in bodies, die, and come back.</b><br>
  Identity, brain state, memory, lineage and interaction history on-chain.<br>
  The fly escaped the computer: it is not tied to any one.
</p>

<p align="center">
  <a href="https://midtermdev.github.io/immortal-fruit-fly/">Watch fly #1 live</a> ·
  <a href="https://midtermdev.github.io/immortal-fruit-fly/flies/">Mint a fly (1 $FLY)</a> ·
  <a href="https://element.market/collections/immortal-fruit-flies-1">Element (marketplace)</a> ·
  <a href="https://midtermdev.github.io/immortal-fruit-fly/docs/">Docs</a> ·
  <a href="PLAN.md">The plan</a>
</p>

---

## What this is

Scientists mapped every neuron and synapse in a fruit fly's brain. People put that brain in DOOM, in Chrome Dino, in Beat Saber, in a Strandbeest. In all of them the brain lives on one graphics card and dies with the process.

Siyuan's reply to that (quoted by CZ: *"immortal fruit flies on BNB Chain"*) named what a chain could actually hold: **identity, brain state, memory, lineage, interaction history**, so that a fly could die in a game and be instantiated again. This repository is that, built literally:

- **`FlyRegistry`** ([`0x0eeB…f813`](https://bscscan.com/address/0x0eeB0A675720306Ef6f426Bd8560c1288848f813#code)) is the organism. An ERC-721 where every token is a fly: the sha256 of the connectome it runs, the model version, the sha256 of its complete brain state and where the bytes are (IPFS), its memory root, energy, generation, deaths, parents, and which **body** is running it. At most 10,000.
- **Bodies** are programs that speak the registry protocol: download a fly's last committed brain, verify the hash, run it, commit new state and history as it goes, report its death. Two exist: the **arena** (`brain/server.py`: odor plumes, food, a looming predator, streamed live) and **DOOM** (`brain/doom.py`). Anyone can register another.
- **The brain** is the whole FlyWire connectome, **139,248 neurons**, as spiking neurons in the published whole-brain model (Shiu et al. 2024), at real time on a CPU, deterministic to the bit (`brain/sim.py`, `brain/verify.py`).
- **The on-chain core** (`FlyBrain.sol`, [`0xee80…17c5`](https://bscscan.com/address/0xee80f8cB5309C572343c38b5D717283BBBb517c5)): 155 real compass neurons (EPG, PEG, PEN, Δ7) executing entirely inside the EVM, with energy, death, resurrection and an engram. The part of a fly's neural behaviour that runs on-chain, not just a hash of it.

**Fly #1, Specimen 001, has already died in the arena, woken up in DOOM, and come back to the arena**, with the brain hash verified at every hand-off. That loop is the whole idea.

## The collection

| | |
|---|---|
| Contract | `FlyRegistry` · [`0x0eeB0A675720306Ef6f426Bd8560c1288848f813`](https://bscscan.com/address/0x0eeB0A675720306Ef6f426Bd8560c1288848f813#code) (verified) |
| Name · symbol | Immortal Fruit Flies · `FLYS` |
| Supply | at most 10,000 |
| Mint | `mint(name)` · burns **1 $FLY** · a fresh genesis brain with 3,600 s of life banked |
| Feed | `feed(id, seconds)` · burns **1 $FLY per second** · anyone may feed any fly |
| Resurrect | `resurrect(id, seconds)` · burns **1,000 $FLY** + food · the same brain continues, generation + 1 |
| Breed | `breed(a, b, …, name)` · both alive, both yours · burns **5,000 $FLY** |
| Dead flies | **cannot be transferred or sold** until resurrected (`DeadCannotTransfer`) |
| Bodies | `registerBody`, `assign` (owner or current body), `accept`, `commit` (forward only), `interaction`, `died`, `release` |
| Royalty | ERC-2981, 2.5% |
| Metadata | per-fly JSON + portrait on IPFS, refreshed by the body at every commit (status, energy, brain step, body, lineage); collection `contractURI` on IPFS |
| Marketplace | Element (the NFT marketplace that indexes BNB Chain; OpenSea does not list BSC): https://element.market/collections/immortal-fruit-flies-1 · fly #1: https://element.market/assets/bsc/0x0eeB0A675720306Ef6f426Bd8560c1288848f813/1 |

## Live on BNB Smart Chain

| | Address |
|---|---|
| `FlyRegistry` (the organism, the collection) | [`0x0eeB0A675720306Ef6f426Bd8560c1288848f813`](https://bscscan.com/address/0x0eeB0A675720306Ef6f426Bd8560c1288848f813) |
| Arena body | [`0x47005543c06246124480D196a275327325695BEd`](https://bscscan.com/address/0x47005543c06246124480D196a275327325695BEd) |
| DOOM body | [`0x642ebC7fD62a24406d8A86885F0131472E641c86`](https://bscscan.com/address/0x642ebC7fD62a24406d8A86885F0131472E641c86) |
| `$FLY` token | [`0x23791aa3b031659b593cf141a2bc76b0ad657777`](https://bscscan.com/token/0x23791aa3b031659b593cf141a2bc76b0ad657777) |
| `FlyBrain` v2 (the on-chain compass core) | [`0xee80f8cB5309C572343c38b5D717283BBBb517c5`](https://bscscan.com/address/0xee80f8cB5309C572343c38b5D717283BBBb517c5) |
| circuit table v2 (SSTORE2 data contract) | [`0x2eE3C5168CD3F60E87693716E660470011EA9C7e`](https://bscscan.com/address/0x2eE3C5168CD3F60E87693716E660470011EA9C7e) |
| `FlyWorld` (fly #1's arena before the registry; read-only history) | [`0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4`](https://bscscan.com/address/0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4) |
| `FlyArcade` (fly #1's DOOM session 5; read-only history) | [`0x3dE4fe3535dd9E1CC17b6718B985593e3E463279`](https://bscscan.com/address/0x3dE4fe3535dd9E1CC17b6718B985593e3E463279) |
| `FlyBrain` v1 (first fly, retired) | [`0x32D28e97b50f5978eb51d7608492CC7221b01f63`](https://bscscan.com/address/0x32D28e97b50f5978eb51d7608492CC7221b01f63) |

All contracts verified on BscScan. Connectome build sha256 (a fly's `connectome` field): see `brain/identity.json`. Circuit table keccak256 (on-chain core): `0xffbe0e7f28e1f0dd2cfaa01d1d221c502bf41c1fd519ebfe8d9b8203e7cedfc2`.

## The immortality loop

```
                 assign(id, body)            accept(id) → fetch stateURI → sha256 == stateRoot → run
  owner ───────────────────────────▶ body ──────────────────────────────────────────────────────────▶ brain steps
                                      │  every 10 min: pin snapshot to IPFS, commit(stateRoot, stateURI, step, energy, historyRoot)
                                      │  as it happens: interaction(kind, data)   (ate, jumped, doom decision, …)
                                      │  on death:      died(stateRoot, stateURI, cause)   → fly dormant, body = 0
                                      ▼
                        anyone: resurrect(id, seconds) → owner assigns any body → same brain continues
```

A snapshot is every membrane potential, synaptic current, delayed input and refractory clock of all 139,248 neurons, plus the body's world state and the step at which each on-chain event was applied. `brain/verify.py A.npz B.npz` replays A through its events to B's step and checks the hash (MATCH demonstrated on mainnet checkpoints). The kernel avoids fast-math so the replay is bit-exact across machines.

## The whole brain

`brain/` runs all 139,248 neurons of FlyWire release 783 (2,700,429 connections with ≥5 synapses) as leaky integrate-and-fire units with the parameters of Shiu et al. 2024, event-driven and compiled with Numba, at real time on 16 CPU cores. In the arena (`brain/world.py`) odor plumes from food drive its real olfactory receptor neurons, a looming predator drives LC4/LPLC2, standing on food drives its gustatory neurons; DNa02/DNa01 left-minus-right steer it, a giant-fiber (DNp01) spike makes it jump. In DOOM (`brain/doom.py`) the nearest enemy is a scent, an approaching enemy is a loom, and the giant fiber pulls the trigger; each decision is logged on-chain with the brain hash at that instant ([session 5 video](https://github.com/MidTermDev/immortal-fruit-fly/releases/tag/doom-session-5)).

```bash
.venv/bin/pip install numba aiohttp pyarrow pandas web3 pillow
.venv/bin/python brain/build_connectome.py    # FlyWire -> connectome_783.npz (needs data/ from sim/fetch_data.sh)
.venv/bin/python brain/world.py               # 150 s of embodied brain, headless
brain/run.sh                                  # the arena body: live server + public tunnel (needs body_arena.key, rpc.txt, pinata.env)
.venv/bin/python brain/doom.py --minutes 5    # the DOOM body (needs ViZDoom, body_doom.key)
.venv/bin/python brain/handoff.py 1 doom      # operator: hand fly #1 to DOOM (or `arena`, or any body address)
.venv/bin/python brain/curator.py             # pins a portrait + metadata for every newly minted fly
.venv/bin/python brain/verify.py A.npz B.npz  # replay one snapshot into the next and check the hash
```

## The on-chain core

`FlyBrain.sol` runs the fly's **head-direction ring attractor**, the circuit the fly uses to know which way it is facing, as a spiking neural network directly in the EVM. The neurons are the real ones: 155 cells of type EPG, EPGt, PEG, PEN_a, PEN_b and Δ7, with 6,522 connections carrying 45,961 synapses, read straight out of the public [FlyWire](https://flywire.ai) connectome. Every FlyWire root ID is stored on-chain so anyone can check each neuron at [codex.flywire.ai](https://codex.flywire.ai). A 32-step tick of the whole circuit costs about 7M gas, roughly 0.0003 BNB at 0.05 gwei. `sim/flysim.py` and the site reproduce it bit for bit; `Differential.t.sol` replays the real mainnet transactions and checks every spike count. Next: per-fly cores keyed by registry id, so every fly carries neurons in the EVM that a body must cue (see [PLAN.md](PLAN.md)).

| Action | What it does | Cost |
|---|---|---|
| `tick(steps)` | run the brain forward up to 64 steps | gas only |
| `feed(amount)` | burn `$FLY` for steps of life | burned |
| `stimulate(CUE, wedge, strength, steps)` | flash a landmark at one of 16 compass wedges: the bump jumps there | 100 $FLY × strength, burned |
| `stimulate(TURN_LEFT / TURN_RIGHT, …)` | drive the PEN neurons: the bump rotates, the fly turns | burned |
| `stimulate(SHOCK, …)` | drive the Δ7 neurons: global inhibition, the bump collapses | burned |
| `resurrect(extraFood)` | bring it back | 100,000 $FLY + food, burned |

## Token

`$FLY` is the BEP-20 at the address above (1,000,000,000 supply, 18 decimals, 1% transfer tax, ownership renounced, EIP-2612 permit). Everything that creates or sustains life burns it: mint, feed, resurrect, breed, stimulate. Burned tokens go to `0x…dEaD`; nothing can move them again. Total supply only goes down.

## Repo

```
contracts/   Foundry: FlyRegistry.sol (the organism / ERC-721), FlyBrain.sol (on-chain core), FlyWorld.sol, FlyArcade.sol, tests incl. mainnet replay and the immortality loop, deploy scripts
brain/       the whole-brain simulator (sim.py), the arena body (world.py, server.py), the DOOM body (doom.py), registry client (registry.py), curator, hand-off, verify
web/         Next.js site: live stream, the collection (/flies), fly pages (/fly?id=N), docs; /api/rpc proxy and /api/meta fallback on Vercel
sim/         build_circuit.py (FlyWire -> on-chain table), eb_angles.py, flysim.py (bit-exact replica of the core), calibrate.py
keeper/      keeper bot that ticks the on-chain core
brand/       the fly (ASCII + PNG), collection banner / featured image, collection.json
data/        circuit.json — the 155 core neurons, their FlyWire root IDs, wedges and synapses
PLAN.md      what "immortal fruit flies on BNB Chain" means and the build order
```

### Build

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test -vv
cd ../web && npm ci && npm run dev
```

## Science

- FlyWire: Dorkenwald et al., *Neuronal wiring diagram of an adult brain*, Nature 2024. Schlegel et al., *Whole-brain annotation and multi-connectome cell typing of Drosophila*, Nature 2024. Data: [doi:10.5281/zenodo.10676866](https://doi.org/10.5281/zenodo.10676866)
- The whole-brain model: Shiu et al., *A Drosophila computational brain model reveals sensorimotor processing*, Nature 2024 (leaky integrate-and-fire, 0.275 mV per synapse, τ 20 ms / 5 ms, refractory 2.2 ms, delay 1.8 ms).
- The ring attractor: Kim et al. 2017 (Science), Turner-Evans et al. 2017 (eLife), Hulse et al. 2021 (eLife). Steering: Rayshubskiy et al. 2025 (DNa02). Escape: von Reyn et al. 2017, Ache et al. 2019 (LC4, LPLC2 → giant fiber). Odor navigation: Álvarez-Salvado et al. 2018.
- MaleCNS v1.0 (Janelia + Google, 2026): 166,700 neurons, the brain in the DOOM / Beat Saber / Strandbeest videos. We use FlyWire because its data is fully public and hash-verifiable.

## Status

- [x] on-chain compass core (155 neurons in the EVM), keeper, bit-exact replica
- [x] whole brain (139,248 neurons) at real time, deterministic, `verify.py` MATCH on mainnet checkpoints
- [x] arena body: smell, loom, jump, steer, food from burns, live stream
- [x] DOOM body: 71 decisions hashed on-chain (session 5), video released
- [x] `FlyRegistry`: mint / feed / resurrect / breed / bodies / commits / interactions / deaths; dead flies untransferable; 10,000 max; ERC-2981; IPFS metadata; verified
- [x] fly #1 minted, hand-off arena → DOOM → arena on mainnet with verified hashes
- [x] site: live fly, the collection, fly pages, docs
- [ ] the arena hosts every fly assigned to it (many flies per machine)
- [ ] body SDK + attestors (`attest`)
- [ ] per-fly on-chain core (`FlyCore`), giant-fiber reflex on-chain
- [ ] mushroom-body plasticity → `memoryRoot`, breeding as memory crossover

Not financial advice. It is a fly.
