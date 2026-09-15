# Immortal Fruit Fly — the plan

*15 September 2026. This replaces the ad-hoc roadmap. It says what "immortal fruit flies on BNB Chain" means, what we have, what is wrong with it, and the order to build the real thing. Status notes in **[brackets]** were added the same day as steps shipped.*

## 1. What the words mean

Siyuan's tweet is a specification. Read it literally:

> BNB Chain is fast and low-cost enough to potentially host **parts of a fly's neural behavior on-chain**, while serving as a **permanent layer for identity, brain state, memory, lineage, and interaction history**. A fly could **die in a game** while its **brain state remains preserved** and can later be **instantiated again**, creating a form of digital immortality. … or multiple fly brains **sharing environments and memories**, gradually forming an **evolving on-chain digital species**.

Five things the chain holds, one thing it runs, and one loop that makes the fly immortal:

| Term | Precise meaning for us |
|---|---|
| **Identity** | A fly is a token. Its identity is the connectome it runs (dataset hash), the model version, its genesis, and its parents. Not a name, not a wallet. |
| **Brain state** | The complete neural state at an instant: every membrane potential, synaptic drive, delayed input and refractory clock (139,248 neurons, ~12 MB). The chain holds a commitment (hash); a permanent store holds the bytes. |
| **Memory** | What the fly has learned: plastic synaptic weights that change with experience and survive death. Distinct from brain state (which is what it is doing now). |
| **Lineage** | Births, deaths, resurrections and breeding, as a tree of token ids. |
| **Interaction history** | Everything that happened to it, in every body it ever had, as events: fed, jumped, ate, killed, met fly #7, died in DOOM. |
| **Neural behavior on-chain** | Some of the fly's neurons actually execute in the EVM. Not a hash of them: the neurons. Bodies must go through them. |
| **The immortality loop** | A *body* (a game, an arena, a robot) instantiates a fly from its last committed brain state, runs it, commits new state and history as it goes, commits its final state when it dies. Any body can instantiate it again. The brain outlives every body. |

The last row is the whole idea. "The fly escaped the computer" is only true if the fly is not tied to *a* computer: the same brain must be able to die in DOOM and wake up in the arena, or in someone else's robot, and be provably the same brain.

**Species** follows from the loop: many flies, minted by many people, hosted by many bodies, breeding by combining memories. CryptoKitties had genes that never changed after birth. A fly's "genome" is a brain that changes because it lived.

## 2. What we have, honestly

| Piece | Status | Verdict |
|---|---|---|
| `FlyBrain` (155-neuron compass, fully in the EVM, energy/engram/lineage) | live, verified, keeper ticking | **Keep.** This is "neural behavior on-chain". It becomes the on-chain reflex every fly carries. |
| Whole-brain simulator (`brain/sim.py`, Shiu 2024 model, real time on CPU, bit-exact replay, `verify.py`) | working | **Keep.** This is the engine every body uses. |
| `FlyWorld` (arena: food by burning $FLY, checkpoints, death, resurrect) | live | **Fold in.** It fuses one body (the arena) with the organism's record. The record must not belong to a body. |
| `FlyArcade` (DOOM decision log) | live, session 5 clean | **Fold in.** Same problem: a second, separate record for the same fly. |
| Snapshots served from a cloudflared tunnel that changes URL on restart | working today, dead tomorrow | **Replace.** Brain state is not "preserved" if the bytes live on one VPS behind a temporary URL. |
| Three contracts, three histories, no token, no way for anyone else to host or mint a fly | – | **This is the gap.** We built one fly with three bodies bolted onto it. We did not build the thing that makes flies persistent. |
| The RuneScape world | copied, not running | **Later.** It is a body. Bodies come after the organism exists. |

## 3. The design

### 3.1 `FlyRegistry` — the organism (ERC-721 on BNB Smart Chain)

One contract is the permanent layer. Everything about a fly lives here or is anchored here.

```solidity
struct Fly {
    bytes32 connectome;      // sha256 of the connectome file (FlyWire 783 build); identity
    uint32  model;           // simulator version; identity
    uint32  generation;      // lives lived
    uint256 parentA; uint256 parentB;   // 0 for genesis flies
    bytes32 stateRoot;       // sha256 of the full brain state at the last commit
    bytes32 memoryRoot;      // sha256 of the plastic weights (learned memory)
    string  stateURI;        // where the bytes are (ipfs://…; see 3.2)
    uint64  brainStep;       // model step at the last commit
    uint64  energy;          // seconds of life at the last commit
    address body;            // the operator currently running it, or 0 if dormant
    bool    alive;
    uint64  bornBlock; uint64 lastCommitBlock;
}
```

Functions, and who may call them:

| Function | Who | What it does |
|---|---|---|
| `mint(string name) → id` | anyone, burns **1 $FLY** | A new genesis fly: fresh brain (canonical resting state), empty memory, generation 0, 3,600 s of life banked. Supply capped at **10,000**. |
| `registerBody(string name, string uri)` | anyone | Declares an operator that can host flies (arena, DOOM, RuneScape, a robot). |
| `assign(id, body)` | the fly's owner, **or the body currently running it** | Hands a dormant or living fly to a body. The body must accept (`accept(id)`) before it may commit. |
| `commit(id, stateRoot, memoryRoot, uri, step, energy, historyRoot)` | the assigned body | A checkpoint. `historyRoot` commits the interaction log for the interval. |
| `interaction(id, kind, data)` | the assigned body | Notable events, as they happen (ate, jumped, killed, met #n). This is the interaction history. |
| `died(id, stateRoot, memoryRoot, uri, cause)` | the assigned body | Final state. Fly becomes dormant; `body = 0`. |
| `resurrect(id, seconds)` | anyone, burns **1,000 $FLY + seconds × 1 $FLY** (≥ 60 s) | Marks it alive with energy, generation + 1; the owner then assigns a body, which instantiates it from `stateURI`. |
| `feed(id, seconds)` | anyone, burns **1 $FLY per second** | Adds energy; the body applies it at its next poll (the arena drops it as food the fly must find). |
| `breed(a, b, childMemoryRoot, name) → id` | owner of both, both alive, burns **5,000 $FLY** | Child fly: genesis brain, both parents in its lineage; memory = published deterministic crossover of the parents' memories once plasticity exists (3.6). |
| `attest(id, step, stateRoot)` | registered attestors | An independent re-runner confirming a commit (see 3.4). |

Rules the contract enforces: a fly has at most one body; only that body commits; commits must advance `brainStep`; a dead fly cannot be committed; **a dead fly cannot be transferred or sold** until resurrected; `stateRoot` can only change through a commit or a death. ERC-2981 royalty 2.5%. A curator can set a dormant fly's portrait and the collection's `contractURI`, nothing else. Nothing in the contract can be upgraded and nothing moves anyone's tokens except the burns the caller asks for.

**[Shipped: `FlyRegistry` at `0x0eeB0A675720306Ef6f426Bd8560c1288848f813`, verified. Collection "Immortal Fruit Flies" (FLYS).]**

### 3.2 Brain state on a permanent layer

Snapshots (~12 MB) are pinned to **IPFS** (Pinata) by the body at every commit, and the registry's `stateURI` is the `ipfs://` CID while `stateRoot` is the sha256 of the bytes, so any body verifies what it downloads. Token metadata (portrait, status, energy, brain step, body, lineage) is re-pinned with every commit so marketplaces (Element on BNB Chain) show the fly as it is. **BNB Greenfield** is the planned mirror (the BNB-native story; needs a funded Greenfield account). The tunnel-hosted snapshots are only a cache.

**[Shipped: IPFS via the body keys; fly #1's commits and hand-offs fetched and hash-verified from IPFS on mainnet.]**

What a snapshot contains (already true of the current format): brain arrays, the full world/body state needed to continue, the plastic weights, and the brain step at which every on-chain event was applied. `verify.py` already replays one into the next bit for bit; that becomes the reference verifier.

### 3.3 Bodies — pluggable environments

A body is any program that speaks the registry protocol. We publish a small **Body SDK** (Python) around the simulator:

```
fly = registry.instantiate(id)      # download stateURI, verify sha256 == stateRoot, load brain + memory
loop: senses → fly.step(ms) → motor → every N s: registry.commit(...)  and  interaction(...) for notable events
on death: registry.died(...)
```

Our three bodies become plugins of the same SDK: **Arena** (odor plumes, food from burns, predator), **DOOM**, and later **RuneScape** (the world we copied) and anything the Strandbeest people want to plug in. The point of the SDK is that a fly moves between them with nothing lost, and that other people can build bodies without asking us.

### 3.4 Neural behavior on-chain

Every fly gets an on-chain reflex: `FlyBrain` (the 155-neuron compass) becomes per-fly storage in a `FlyCore` contract keyed by registry id (about 40 storage words per fly). A body must cue the core with what the fly senses (a landmark, a turn, a shock) at least once per commit, and the commit carries the core's own on-chain heading. That is the part of the fly's behavior that runs in the EVM and that a body cannot fake. Next reflex to add on-chain: the giant-fiber escape circuit (~200 neurons, one table), so "it jumped" is a chain fact.

### 3.5 Verification ladder

1. **Now:** deterministic model, open snapshots, `verify.py` (MATCH demonstrated).
2. **Attestors:** anyone runs a re-runner that pulls a fly's commits, replays the interval, and calls `attest`. The site shows a fly's commits as *attested by N*. Bodies that lie get caught by anyone with a CPU.
3. **Later:** proofs of a replay window once that is affordable.

### 3.6 Memory and species

The Shiu model has no plasticity, so today "memory" is the compass core's engram. The real memory is the mushroom body: Kenyon cell → MBON synapses depressed by dopamine (Aso 2014, Hige 2015). We add that to the simulator (a few thousand plastic weights, dopamine neurons driven by reward = eating, punishment = being caught), commit the weights as `memoryRoot`, and define `breed` as a published crossover of two memory vectors. Then a fly's lineage carries what its ancestors learned. That is the "evolving on-chain species" line, made concrete.

### 3.7 Economics ($FLY)

Everything that creates or sustains life burns $FLY: mint 1, feed, resurrect, breed. Bodies pay their own gas to commit (we run the first bodies; a body could charge its flies' owners later, out of scope). No faucets, no owner keys.

## 4. Build order

Each step is shippable and leaves the live fly running.

1. **`FlyRegistry` + migration.** Write, test (Foundry, including a replay of fly #1's real history), deploy. Mint fly #1 for Specimen 001 with its current whole-brain state as genesis; fold FlyWorld's checkpoints and FlyArcade's session 5 into its history as `interaction` events; retire FlyWorld/FlyArcade to read-only. **[Done.]**
2. **Permanent storage.** IPFS pin on every commit, `stateURI = ipfs://…`; Greenfield mirror later. **[Done, IPFS.]**
3. **The arena and DOOM as bodies.** `server.py` and `doom.py` speak the registry protocol: accept, instantiate (fetch + verify), commit, interactions, death. Demonstrate the loop: fly #1 arena → DOOM → arena with hashes matching across the move. **[Done on mainnet.]** The Body SDK (packaging the loop for others) is still to do.
4. **Per-fly on-chain core.** `FlyCore` keyed by registry id; the arena and DOOM bodies cue it; the commit carries its heading. **[In progress: built for the pebbles, see [HARDWARE.md](HARDWARE.md).]**
5. **Minting for everyone.** Site: mint (1 $FLY), your flies, assign to a body, feed, resurrect, breed; a fly page with its lineage, its history across bodies, its live stream when the arena is running it; marketplace branding (`contractURI`, per-token metadata; Element indexes BNB Chain, OpenSea does not). **[Done.]** Then the arena hosts many flies at once (same brain kernel, time-sliced; ~50 flies per machine). **[To do.]**
6. **Attestors.** Publish the re-runner; run two independent ones ourselves; show attestation counts.
7. **Memory.** Mushroom-body plasticity in the model, `memoryRoot`, `breed`.
8. **More bodies.** Pebbles: five M5Stack CoreS3 handhelds, each a wallet and a body that runs a fly's on-chain core from real sensors ([HARDWARE.md](HARDWARE.md)). RuneScape (the copied world), and an open call for robots. DOOM stays as the demo body.

## 5. What we stop doing

- No more one-off contracts per demo. Every new thing is a body on the registry.
- No more state on a temporary URL.
- No claims the code does not make true. The verification ladder is documented as the ladder it is.

## 6. Decisions (made 15 September 2026)

1. **Prices:** mint 1 $FLY, feed 1 $FLY/s, resurrect 1,000 $FLY + food, breed 5,000 $FLY. Max supply 10,000.
2. **Who may assign:** the owner **or** the body currently running the fly (so bodies can hand off).
3. **Storage:** IPFS (Pinata) now; Greenfield as a mirror later.
4. **Fly #1's records:** start with DOOM session 5 and the FlyWorld checkpoints, recorded as `interaction` events on the registry; sessions 0–4 are void.
