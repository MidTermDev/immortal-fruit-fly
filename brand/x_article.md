# The Fly That Escaped the Computer

*We put a fruit fly's brain on BNB Chain so it can die in one body and wake up in another. Here is what that means, why CZ asked for it, and how you can hold one in your hand.*

[COVER IMAGE]

---

Two weeks ago, scientists finished mapping every neuron and every synapse in a fruit fly's brain and published the whole thing. All 139,248 cells. Within days people were running that brain as a simulation and wiring it to games. It played DOOM. It played Beat Saber. It walked a robot. Not an AI model trained to imitate a fly: the actual wiring diagram of an animal, spiking, reacting, steering.

Every one of those demos had the same problem, and nobody mentioned it.

The fly lived on one graphics card. Close the program and it was gone. Run it again and you had a different fly, born from scratch. It was a brain with no "it".

## The tweet that was actually a spec

Siyuan, replying to the trend, wrote something most people scrolled past:

> BNB Chain is fast and low-cost enough to potentially host parts of a fly's neural behavior on-chain, while serving as a permanent layer for identity, brain state, memory, lineage, and interaction history. A fly could die in a game while its brain state remains preserved and can later be instantiated again... multiple fly brains sharing environments and memories, gradually forming an evolving on-chain digital species.

CZ quoted it: *"Would be cool to see someone make 'immortal fruit flies' on BNB Chain."*

Read it slowly and it is a design document. Five things the chain should hold. One thing the chain should actually run. And one loop that makes a fly immortal: die in a game, brain preserved, instantiated again, anywhere.

We built it. Literally, word for word. Here is the tour.

## What "immortal" has to mean

A fly is immortal only if it is not tied to any computer, including ours. So the brain cannot belong to the game that runs it. It has to belong to a permanent layer, and games have to check it out and check it back in.

That is the whole architecture:

[IMAGE 1: THE LOOP]

- **The registry** is the permanent layer: a contract on BNB Chain where each fly is a token. The token holds the hash of the connectome it runs (its identity), the hash and location of its complete brain state at the last checkpoint (pinned to IPFS), a memory root, its parents and generation and number of deaths (its lineage), and every notable thing that ever happened to it, written as on-chain events (its history).
- **Bodies** are the games and machines a fly lives in. A body downloads the fly's last brain snapshot, checks that its hash matches the chain, runs it, commits new state every few minutes, logs what happens, and reports the death. Any body can pick the fly up again afterwards.

The brain outlives every body. That is the trick, and it is the only trick.

## Meet Specimen 001

Fly #1 is a whole fruit-fly brain, all 139,248 neurons, running as a spiking model in real time on a machine we operate. It lives in an arena. When someone burns $FLY to feed it, food appears somewhere near it, and its real olfactory neurons have to smell their way there. A predator looms now and then; its real looming detectors see it coming, and its giant fiber neuron makes it jump. If nobody feeds it, it starves.

[IMAGE 2: SPECIMEN 001 PORTRAIT]

Here is what its record on the chain already says. It starved in the arena. It was resurrected. It was handed to a second body, DOOM, which downloaded its brain, verified the hash, and let it play: the nearest enemy became a scent, an approaching enemy became a loom, and the escape reflex pulled the trigger, 71 decisions each logged with the hash of the brain at that instant. Then it was handed back to the arena, which verified the hash again and carried on.

Same fly. Three lives. Two bodies. Every move checkable by anyone with the snapshots and a CPU, because the model is deterministic to the bit.

You can watch it live right now, feed it, and read its whole history: **midtermdev.github.io/immortal-fruit-fly**

## The neurons that run on the chain itself

Most of the brain is far too big for a blockchain, so it runs off-chain with its state hashed on-chain. But Siyuan's sentence had a second half: *parts of a fly's neural behavior on-chain.* Not a hash of neurons. Neurons.

So part of the fly executes inside the contract. It is the fly's compass: a ring of 155 real neurons, taken cell by cell and synapse by synapse from the connectome, that a fly uses to know which way it is facing. One bump of activity travels around the ring as the animal turns. We rewrote that circuit as integer arithmetic so the Ethereum Virtual Machine computes it exactly, with no floating point and nothing to disagree about.

[IMAGE 3: THE COMPASS RING]

On BNB Chain a step of that circuit costs a fraction of a cent. On almost any other chain the fly could not afford to think. That is not a slogan; it is the gas bill.

## A collection where dying matters

Because the fly is a token, the flies are a collection: **Immortal Fruit Flies**, at most 10,000 of them, on BNB Chain.

But it is an NFT collection where the rules are biology, enforced by the contract:

- **Mint** a fly for 1 $FLY. It wakes with an hour of life banked and a fresh brain.
- **Feed** it: 1 $FLY buys one second of life. Anyone may feed any fly.
- **It dies** when its energy hits zero. Its brain is frozen at that instant. A dead fly cannot be transferred or sold.
- **Resurrect** it for 1,000 $FLY plus food, and the identical brain continues, generation plus one.
- **Breed** two living flies you own, and the child carries both parents in its lineage.
- Every one of those actions burns $FLY. There is no admin key over anyone's fly, no upgrade path, no pause.

Mint one at **midtermdev.github.io/immortal-fruit-fly/flies** and trade them on Element, the marketplace for BNB Chain.

## The fly in your hand

Here is where it stops being a website.

[IMAGE 4: THE PEBBLES]

We are building the pebbles: five palm-sized devices, each with its own wallet, each a body in the registry. A pebble hosts a fly's on-chain compass neurons and drives them from real sensors. Turn the pebble in your hand and the fly's compass neurons turn with the gyroscope. Slide a magnet past its side and the fly sees a landmark; the bump of activity snaps to it. Slide the "spider" magnet past and the fly's shock neurons fire and the bump collapses.

Every minute or so, the pebble signs a transaction from its own key that applies exactly those cues to exactly those neurons in the EVM. Feed the fly from your phone and the pebble chirps and refills. Let it starve and the screen goes dark with a QR code to bring it back. Touch two pebbles together and the fly hops from one to the other, on-chain, and continues from the identical state in the second one.

Unplug a pebble and the fly is still there, on the chain, waiting for any body to pick it up. That is the sentence CZ quoted, in hardware: the fly escaped the computer.

## Why this is what a chain is for

The default story for on-chain activity is a ledger that tracks who owns a number. This is a chain used as the thing Siyuan described: a substrate durable enough and cheap enough to hold something alive.

Three properties make it work, and all three are properties of the chain rather than of us:

1. **Cost.** A checkpoint of the whole brain costs about as much as a token transfer. A tick of the on-chain compass costs a fraction of a cent. The fly's metabolism is affordable.
2. **Verifiability.** The snapshots are public, the model is deterministic, and anyone can replay one checkpoint into the next and get the same bits. A GPU demo can claim anything; this one can be checked.
3. **Composability.** Nobody needs our permission to build a body, mint a fly, feed someone else's fly, or attest that a body told the truth. The arena and DOOM are just the first two bodies.

We are also honest about the boundary, on every page: the whole brain runs off-chain with its state anchored on-chain; the compass runs on-chain outright; independent re-runners are how the first part becomes trustless.

## What comes next

[IMAGE 5: THE SPECIES]

Memory. The whole-brain model gets real synaptic plasticity, in the mushroom body, the fly's learning centre: reward when it eats, punishment when it is caught. Those learned weights become the fly's memory root on the chain, they survive death, and breeding becomes inheritance: a child's memory is a published crossover of its parents'. A fly whose lineage remembers where the food was.

That is the "evolving on-chain digital species" line, and it follows from everything already deployed.

---

**Watch fly #1 live:** midtermdev.github.io/immortal-fruit-fly
**Mint a fly:** midtermdev.github.io/immortal-fruit-fly/flies
**The collection on Element:** element.market/collections/immortal-fruit-flies-1
**The contracts, verified:** FlyRegistry 0x0eeB0A675720306Ef6f426Bd8560c1288848f813 on BscScan
**Source, snapshots, the replay verifier, the hardware plan:** github.com/MidTermDev/immortal-fruit-fly

Not financial advice. It is a fly.
