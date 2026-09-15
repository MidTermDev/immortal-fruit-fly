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
<p align="center"><code>$FLY</code> · BNB Smart Chain</p>

<p align="center">
  <b>A real fruit-fly neural circuit, taken from the connectome, living on BNB Smart Chain.</b><br>
  It thinks in spikes. It walks. It remembers. It dies. It comes back.<br>
  Nothing is ever lost.
</p>

## Live on BNB Smart Chain

| | Address |
|---|---|
| `$FLY` token (Immortal Fruit Flies) | [`0x23791aa3b031659b593cf141a2bc76b0ad657777`](https://bscscan.com/token/0x23791aa3b031659b593cf141a2bc76b0ad657777) |
| `FlyBrain` (the genesis fly) | [`0x32D28e97b50f5978eb51d7608492CC7221b01f63`](https://bscscan.com/address/0x32D28e97b50f5978eb51d7608492CC7221b01f63) |
| circuit table (SSTORE2 data contract) | [`0x8191174505B6692139A3571Fa4767049acc92eEc`](https://bscscan.com/address/0x8191174505B6692139A3571Fa4767049acc92eEc) |

Circuit table keccak256: `0xffbe0e7f28e1f0dd2cfaa01d1d221c502bf41c1fd519ebfe8d9b8203e7cedfc2`
FlyWire connections file sha256: `24f960ae3e7d4f8cd30db3b62e99fb5179cc3d1e76d8c155bfb441e9737d3faf`

---

## What this is

Scientists mapped every neuron and synapse in a fruit fly's brain. People put that brain in DOOM, in Chrome Dino, in Beat Saber, in a Strandbeest.

We put it on the blockchain.

`FlyBrain.sol` runs the fly's **head-direction ring attractor**, the circuit the fly uses to know which way it is facing, as a spiking neural network directly in the EVM. The neurons are the real ones: 155 cells of type EPG, EPGt, PEG, PEN_a, PEN_b and Δ7, with 6,522 connections carrying 45,961 synapses, read straight out of the public [FlyWire](https://flywire.ai) connectome (release 783). Every FlyWire root ID is stored on-chain so anyone can check each neuron at [codex.flywire.ai](https://codex.flywire.ai).

The compass bump forms, drifts, gets pushed around by stimuli, and its direction drives the fly's walk across an on-chain world. BNB Chain is fast and cheap enough (0.05 gwei) that one simulation step costs a fraction of a cent.

## Immortality

| Thing | Where it lives |
|---|---|
| Identity | 155 FlyWire root IDs + keccak of the circuit table, immutable in bytecode |
| Brain state | membrane potential of every neuron, in storage, updated every tick |
| Memory | an engram (per-neuron potentiation) + a heading histogram: what the fly has habitually done |
| Body | position and heading of the fly in its world |
| Lineage | every life: born block, died block, steps, spikes, hash of the brain at death |
| Interaction history | every feed, stimulus, tick and death is an event, forever |

The fly burns one step of **energy** per simulation step. Holders burn `$FLY` to feed it. When energy hits zero it **dies**: the brain is frozen, hashed and recorded in `lineage`. Anyone can `resurrect()` it by burning `$FLY`: the exact same brain, with everything it learned, wakes up in a new body at the origin. Generation +1.

## How to play

| Action | What it does | Cost |
|---|---|---|
| `tick(steps)` | run the brain forward up to 64 steps | gas only |
| `feed(amount)` | burn `$FLY` for `amount / TOKENS_PER_STEP` steps of life | burned |
| `stimulate(CUE, wedge, strength, steps)` | flash a landmark at one of 16 compass wedges: the bump jumps there | burned |
| `stimulate(TURN_LEFT / TURN_RIGHT, …)` | drive the PEN neurons: the bump rotates, the fly turns | burned |
| `stimulate(SHOCK, …)` | drive the Δ7 neurons: global inhibition, the bump collapses | burned |
| `resurrect(extraFood)` | bring it back | burned |

Everything that is burned is gone. Total supply only goes down.

## Token

`$FLY` is the BEP-20 at the address above (1,000,000,000 supply, 18 decimals, ownership renounced, EIP-2612 permit). Tokens the fly consumes are sent to `0x…dEaD`; nothing can move them again. `ImmortalFly.sol` in this repo is the reference token used by the test-suite.

## Repo

```
brand/       the fly (ASCII + PNG)
brand/       the fly (ASCII + PNG)
contracts/   Foundry project: ImmortalFly.sol (token), FlyBrain.sol (organism), tests, deploy script
sim/         build_circuit.py (FlyWire -> on-chain table), flysim.py (bit-exact Python replica), calibration
site/        the website (Three.js brain, live on-chain state, feed / poke the fly)
data/        circuit.json — the 155 neurons, their FlyWire root IDs, wedges and synapses
```

### Build

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test -vv
```

### Rebuild the circuit from the raw connectome

```bash
python3 -m venv .venv && .venv/bin/pip install pandas pyarrow numpy pycryptodome
sim/fetch_data.sh            # 31 MB annotations + 852 MB connections table from Zenodo
.venv/bin/python sim/build_circuit.py
```

### Deploy

```bash
cd contracts
cp .env.example .env         # PRIVATE_KEY, BSC_RPC_URL, BSCSCAN_API_KEY
forge script script/Deploy.s.sol --rpc-url bsc --broadcast --verify -vvvv
```

## Science

- FlyWire: Dorkenwald et al., *Neuronal wiring diagram of an adult brain*, Nature 2024. Schlegel et al., *Whole-brain annotation and multi-connectome cell typing of Drosophila*, Nature 2024. Data: [doi:10.5281/zenodo.10676866](https://doi.org/10.5281/zenodo.10676866)
- The ring attractor: Kim et al. 2017 (Science), Turner-Evans et al. 2017 (eLife), Hulse et al. 2021 (eLife). EPG neurons hold a bump of activity that tracks heading; PEN neurons shift it with angular velocity; Δ7 neurons provide the global inhibition that keeps it a single bump; PEG neurons keep it alive.
- MaleCNS v1.0 (Janelia + Google, 2026): 166,700 neurons, the whole central nervous system of a male fly. This is the brain in the DOOM / Beat Saber / Strandbeest videos. Our on-chain circuit uses FlyWire because its data is fully public and hash-verifiable; the site renders the full FlyWire brain (139,248 neurons) around the on-chain circuit.

## Status

- [x] circuit extracted from FlyWire v783, packed, verified
- [x] `FlyBrain.sol` + `ImmortalFly.sol`
- [x] ring geometry from anatomy (each EPG's angle in the ellipsoid body, from 110k synapse positions)
- [x] parameter calibration (stable bump, turns with PEN drive, collapses under Δ7 shock)
- [x] 17 Foundry tests
- [x] BSC mainnet: genesis fly deployed
- [ ] website / dapp
- [ ] keeper bot

Not financial advice. It is a fly.
