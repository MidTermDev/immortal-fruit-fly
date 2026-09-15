# Immortal Fruit Fly — Roadmap: a fly that actually lives on-chain

*Draft v0.1, 2026-09-15. Sections marked ⏳ are being filled from research in progress.*

## 0. Where we are (Genesis, live today)

- **Brain:** 155 real neurons of the FlyWire head-direction circuit (EPG, EPGt, PEG, PEN_a, PEN_b, Δ7), 6,522 connections / 45,961 synapses, simulated as integer leaky-integrate-and-fire neurons inside `FlyBrain` v2 at `0xee80f8cB5309C572343c38b5D717283BBBb517c5` on BNB Smart Chain.
- **Body:** a position and heading in a 2-D world, moved by the compass bump.
- **Metabolism:** one unit of energy per simulation step; `$FLY` is burned to feed.
- **Memory:** an engram (per-neuron potentiation) and a heading histogram.
- **Immortality:** death freezes and hashes the brain; anyone can resurrect it; lineage is on-chain.
- **Cost:** ~7M gas per 32-step tick with a live bump (≈0.00035 BNB at 0.05 gwei). A keeper ticks every 10 minutes.
- **Determinism:** `sim/flysim.py` and the website replay the chain bit for bit.

## 1. Principles

1. **Real wiring only.** Every neuron we run has a FlyWire / MaleCNS root ID. No made-up networks.
2. **The chain is the organism's only body.** State that matters (brain, memory, lineage) lives in storage; everything else is a view.
3. **Deterministic and replayable.** Anyone can recompute the fly's whole life from its events.
4. **Everything the fly eats is gone.** Token sinks, never token faucets, in the base protocol.
5. **Cheap enough to be alive.** Each phase must stay affordable on BNB Chain (or opBNB) at scale.

## 2. Phases

### Phase 1 — Alive (now → weeks)
Goal: the genesis fly is continuously alive, visibly, without a human in the loop.
- Keeper economics: whoever ticks earns a slice of what the fly eats (`tick` bounty from a keeper pool funded by feeds), so the brain never stops because a bot died.
- Sensory world v1: the fly gets *senses from the chain*. Block hashes become olfactory noise; large `$FLY` transfers become "food smell" that pulls the compass toward the feeder's wedge; big sells become a looming shadow (Δ7 shock). The fly reacts to the market.
- Live feed: the site streams every spike as it happens (replay from events), a public "EEG".
- Fly cam: a 24/7 rendered stream (brain + compass + walk) for X / Telegram.

### Phase 2 — Reflexes (1–2 months)
Goal: add the two circuits every fly-brain demo uses, so the fly can *react*.
- **Giant fiber escape circuit** (looming → jump). ⏳ neuron counts / synapses from research.
- **Descending steering** (PFL3 → DNa02 left/right) so the compass actually steers a body rather than a population vector.
- Multi-circuit brains: several SSTORE2 circuit tables chained in one contract; a tick runs all of them.
- Body v2: an on-chain arena with food, walls and predators; the fly's walk is a game everyone can watch and influence.

### Phase 3 — Learning (2–4 months)
Goal: the fly *learns* on-chain. Not a metaphor: dopamine-gated plasticity from the connectome.
- **Mushroom body compartment** (Kenyon cells → MBON, gated by PAM/PPL1 dopamine neurons). ⏳ minimal compartment from research.
- Reward = being fed; punishment = shock. The fly learns which on-chain "smells" (stimulus channels) predict food and steers toward them. Weights live in storage; anyone can audit what it learned.
- Memory export: a life's learned weights are the resurrectable soul; lineage entries carry them.

### Phase 4 — The colony (3–6 months)
Goal: from one organism to a species.
- `FlyFactory`: anyone mints a fly (an ERC-721 whose token is a live brain contract), same circuit, its own life.
- Shared world: flies see each other (mutual looming), compete for food, can be fed by fans.
- **Breeding:** two dead flies' engrams are crossed (per-neuron crossover + mutation) into a child's initial memory. Selection pressure = who gets fed. Evolution on-chain, with the connectome fixed and memory heritable.
- Leaderboards: oldest fly, most spikes, longest walk, most generations.

### Phase 5 — The whole brain (6–12 months)
Goal: the full 139k / 166k-neuron connectome, verifiably.
- Off-chain full-brain simulation (MaleCNS v1.0, 166,700 neurons) in the standard LIF recipe every demo uses; state checkpoints (Merkle roots of membrane potentials) posted on-chain every N steps.
- **Verification ladder:** optimistic (anyone can dispute a checkpoint by replaying a window on-chain with the same integer model) → ZK proofs of simulation windows once proving is cheap enough.
- Storage: brain snapshots on BNB Greenfield, hashes on BSC; execution of the small circuits on BSC, high-frequency ticks on opBNB with L1 checkpoints.
- Then: the whole fly plays the games (DOOM, Dino, Beat Saber) with every input and output anchored on-chain, and the *same* fly that played them is the one that lives in the contract.

## 3. Architecture notes

- **Tick cost model:** ~25k gas per step for 155 neurons + ~70 gas per synapse event. A 1,000-neuron circuit with 50k synapses at 30 spikes/step is ~1M gas per step: fine on opBNB, expensive on BSC. Rule: small reflexes on BSC, big circuits on opBNB, checkpoints on BSC.
- **Circuit tables:** SSTORE2 data contracts, ≤24 KB each, keccak-anchored; a brain can point to many.
- **Plasticity:** on-chain weights only where learning happens (a few thousand MB synapses), packed int8 deltas.
- **Determinism:** noise from `keccak256(step)`; no block data in the dynamics, so any client can replay.
- **Economics:** feeds and stimuli are burns; a keeper pool takes a small slice of feeds to pay tickers; resurrection price scales with generation.

## 4. What the trend has already shown ⏳
(Project table, common technical recipe, inputs/outputs — from research.)

## 5. Candidate circuits, with numbers ⏳
(Neuron/synapse counts, feasibility ranking — from research.)
