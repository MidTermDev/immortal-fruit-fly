# Immortal Fruit Fly contracts (Foundry)

| Contract | What |
|---|---|
| `src/FlyRegistry.sol` | the organism: ERC-721 flies, bodies, commits, interactions, death, resurrection, breeding |
| `src/FlyCore.sol` | the per-fly on-chain compass: 155 FlyWire neurons ticked in the EVM, keyed by registry id |
| `src/FlyBrain.sol` | FlyBrain v2, the singleton predecessor of FlyCore (live, fly #1's compass until it is seeded into FlyCore) |
| `src/FlyWorld.sol`, `src/FlyArcade.sol` | read-only history (arena, DOOM) |
| `src/ImmortalFly.sol` | the $FLY BEP-20 (the live token at `0x2379…7777` is the user's own deployment; the tests use this one) |

```shell
forge build
forge test -vv          # differential tests against FlyBrain v2 and sim/flysim.py, permissions, gas on fly #1's real state
```

## FlyCore gas

`forge test --match-test test_gas_onFly1RealState -vv` measures every call the pebbles and the site make on
fly #1's real compass state (`data/fly1_v2_state.json`, FlyBrain v2's `brainState()` from mainnet: a mature
engram) as a receipt's `gasUsed` (`isolate = true` in foundry.toml runs every call as its own transaction;
the figures were checked against receipts on a local fork of BSC, within 2k gas). The cost is dominated by
synaptic propagation and scales with spikes, so a fresh core understates it by ~30%. Numbers for the kernel
in this tree:

| Call | Gas |
|---|---|
| `stimulate` + `tick(16)` by the body: turn (strength 40) / cue (8) / shock (20) | 4.14–4.37M / 3.46M / 3.00M |
| `tick(16)` with a turn (40) / cue (8) / shock (20) / nothing active | 4.23M / 3.46M / 2.85M / 3.05M |
| `tick(16)` under a strength-255 stimulus (the strongest poke) | 4.09M |
| `tick(32)` quiet / cue / turn (40) | 5.5M / 6.1M / 8.1M |
| `tick(64)` quiet | 10.9M |
| poke: `stimulate(cue x5)` + `tick(32)` with the $FLY burn | 6.7M |
| FlyBrain v2 (the previous kernel), `tick(16)` on the same state with a turn (40) active | 6.8M |

The test asserts a 16-step anchor stays under 4.6M under any stimulus (HARDWARE.md §4.4: 0.00023 BNB at
0.05 gwei; 0.017 BNB/h at 45 s), `tick(32)` under 7M quiet or with a cue (HARDWARE.md §3) and under 8.5M
with a strength-40 turn, and that the core is cheaper than FlyBrain v2 on the same state. Raise the
budgets only together with HARDWARE.md and the firmware's `ANCHOR_GAS_*`.

## Data

- `data/circuit.hex`, `data/circuit_meta.json`: the circuit table (FlyWire 783, 155 neurons, 6,522 synapses)
- `data/params.json`: the calibrated v2 dynamics (`persistInput`)
- `data/fly1_v2_state.json`: fly #1's compass state read from FlyBrain v2 on mainnet (block 122080452, step 20896)
- `data/fly1_replay.json`: 21 actions on that state replayed through `sim/flysim.py`, with the expected core hash
  after each (`data/make_fly1_replay.py` rebuilds it); `test_replayFly1StateAgainstFlysim` checks FlyCore against it

## Deploy

```shell
forge script script/DeployCore.s.sol --rpc-url bsc --broadcast --verify -vvvv   # ~13M gas
```

See `.env.example` for the environment. The deployer becomes FlyCore's curator (may `seed` a fresh core once
per fly, nothing else).
