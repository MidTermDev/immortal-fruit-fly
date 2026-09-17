// @ts-nocheck
import { ethers } from "ethers";
import { CFG } from "./config";
import type { Ev } from "./registry";
import REGISTRY_ABI from "@/data/registry.abi.json";
import CORE_ABI from "@/data/core.abi.json";

/** What life costs on the registry (FlyRegistryV3): wei per second of life, and the flat fee to wake a dead fly. The
 *  curator adjusts both as BNB moves, so a page reads them when it opens and again before it pays. */
export type LifePrice = { lifeWeiPerSecond: bigint; resurrectWei: bigint };

/** How far back an event scan actually reached. `complete` is false when no endpoint would serve the older blocks;
 *  `from` is then the oldest block that was read, so the UI can say "since block N" instead of pretending. */
export type LogScan = { from: number; to: number; complete: boolean; floor: number };
export type EventScan = { events: Ev[]; scan: LogScan };
type LogEndpoint = { url: string; span: number; provider: any; head?: number };
type LogCache = { from: number; to: number; complete: boolean; logs: any[]; pending?: Promise<unknown> };

/** Blocks re-read at the top of an incremental scan, so a log in a block that was later reorged out is dropped. */
const REORG_DEPTH = 32;
const LOGS_TIMEOUT_MS = 15000;
const withTimeout = <T,>(p: Promise<T>, ms: number) => new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
const errText = (e: any) => String(e?.shortMessage || e?.info?.error?.message || e?.error?.message || e?.message || e).slice(0, 160);

export const BRAIN_ABI = [
  "function brainState() view returns (int16[] v,int8[] bias,uint16[16] headingHist,int32[] pendingInput,uint64 step,uint64 energy,bool alive,uint32 generation,int64 posX,int64 posY,int32 headX,int32 headY)",
  "function activeStimulus() view returns (uint8 channel,uint8 param,uint16 strength,uint64 untilStep,bool active)",
  "function totalSpikes() view returns (uint64)", "function totalBurned() view returns (uint256)", "function lineageLength() view returns (uint256)",
  "function lineage(uint256) view returns (uint64 bornBlock,uint64 diedBlock,uint64 steps,uint64 spikes,bytes32 brainStateHash)",
  "function bornBlock() view returns (uint64)", "function circuitHash() view returns (bytes32)", "function N() view returns (uint256)", "function S() view returns (uint256)",
  "function TOKENS_PER_STEP() view returns (uint256)", "function STIM_PRICE() view returns (uint256)", "function RESURRECT_PRICE() view returns (uint256)", "function STIM_TTL() view returns (uint16)", "function MAX_STEPS() view returns (uint8)",
  "function caretakers(address) view returns (uint128 fed,uint64 ticks,uint64 stimuli)",
  "function tick(uint16 steps)", "function feed(uint256 amount)", "function feedWithPermit(uint256 amount,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "function stimulate(uint8 channel,uint8 param,uint8 strength,uint16 steps)", "function stimulateWithPermit(uint8 channel,uint8 param,uint8 strength,uint16 steps,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "function resurrect(uint256 extraFood)", "function resurrectWithPermit(uint256 extraFood,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "event Ticked(address indexed by,uint64 fromStep,uint16 steps,uint32 spikes,int32 headX,int32 headY,int64 posX,int64 posY,uint64 energyLeft)",
  "event Fed(address indexed by,uint256 tokensBurned,uint64 energyAdded,uint64 energy)",
  "event Stimulated(address indexed by,uint8 channel,uint8 param,uint16 strength,uint64 untilStep,uint256 tokensBurned)",
  "event Died(uint32 indexed generation,uint64 bornBlock,uint64 diedBlock,uint64 lifeSteps,uint64 lifeSpikes,bytes32 brainStateHash)",
  "event Resurrected(uint32 indexed generation,address indexed by,uint256 tokensBurned,uint64 energy)",
];
export const WORLD_ABI = [
  "function placeFood(int32 x,int32 y,uint256 amount) returns (uint256)",
  "function resurrect(uint256 extraFood)",
  "function alive() view returns (bool)", "function generation() view returns (uint32)", "function lastHash() view returns (bytes32)", "function lastStep() view returns (uint64)",
  "function lastAgeMs() view returns (uint64)", "function lastEnergy() view returns (uint64)", "function totalBurned() view returns (uint256)", "function foodCount() view returns (uint256)",
  "function TOKENS_PER_SECOND() view returns (uint256)", "function MIN_FOOD() view returns (uint256)", "function RESURRECT_PRICE() view returns (uint256)", "function ARENA() view returns (int32)",
  "function fedBy(address) view returns (uint256)",
  "event FoodPlaced(uint256 indexed id,address indexed by,int32 x,int32 y,uint64 seconds_,uint256 tokensBurned)",
  "event Checkpoint(uint64 step,uint64 ageMs,bytes32 stateHash,int32 x,int32 y,uint64 energy,uint64 spikes,uint32 generation,string snapshotURI)",
  "event Died(uint32 indexed generation,uint64 ageMs,bytes32 stateHash,string snapshotURI)",
  "event Resurrected(uint32 indexed generation,address indexed by,uint256 tokensBurned,uint64 energy)",
];
export const TOKEN_ABI = [
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function nonces(address) view returns (uint256)",
];
// gas limits: public RPC estimation caps out at ~16.7M, so we set them ourselves
const GAS = { tick16: 4_500_000, tick32: 9_000_000, stim16: 9_000_000, stim32: 15_500_000 };
// FlyCore (per-fly cores), measured on a fresh chain with cold storage: tick(id,16) 4.25M with a cue active
// (FlyCore.t.sol test_gas) but 5.84M with a turn x2 active and 7.31M worst case (turn x255, ring saturated);
// tick(id,32) 8.75M / 10.8M / 13.8M in the same states. A tick that runs out of gas is charged the whole limit
// and does nothing, so the limits cover the worst case; unused gas is refunded. stimulate(…, 16 steps) = tick + ~65k.
const CORE_GAS = { tick16: 8_000_000, tick32: 15_000_000, stim0: 300_000, stim16: 9_000_000, stim32: 15_500_000 };

export class Chain {
  provider: any = null; rpcUrl = ""; brain: any = null; token: any = null; world: any = null; worldW: any; registry: any = null; registryW: any; signer: any = null; account: string | null = null; brainW: any; tokenW: any; prices: any;
  /** FlyCore, only when CFG.core is set (feature-gated until it is deployed). */
  core: any = null; coreW: any; corePrices: { stimPrice: bigint; stimTTL: number; maxSteps: number } | null = null;
  _logEndpoints: LogEndpoint[] | null = null;
  _logCache = new Map<string, LogCache>();
  async connectRead() {
    let lastErr;
    for (const url of CFG.rpc) {
      try {
        const p = new ethers.JsonRpcProvider(url, CFG.chainId, { staticNetwork: true });
        await Promise.race([p.getBlockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
        this.provider = p; this.rpcUrl = url; break;
      } catch (e) { lastErr = e; }
    }
    if (!this.provider) throw lastErr || new Error("no rpc");
    this.brain = new ethers.Contract(CFG.brain, BRAIN_ABI, this.provider);
    this.token = new ethers.Contract(CFG.token, TOKEN_ABI, this.provider);
    this.world = new ethers.Contract(CFG.world, WORLD_ABI, this.provider);
    this.registry = new ethers.Contract(CFG.registry, REGISTRY_ABI as any, this.provider);
    if (CFG.core) this.core = new ethers.Contract(CFG.core, CORE_ABI as any, this.provider);
    const [tps, sp, rp, ttl, maxSteps] = await Promise.all([this.brain.TOKENS_PER_STEP(), this.brain.STIM_PRICE(), this.brain.RESURRECT_PRICE(), this.brain.STIM_TTL(), this.brain.MAX_STEPS()]);
    this.prices = { tokensPerStep: tps, stimPrice: sp, resurrectPrice: rp, stimTTL: Number(ttl), maxSteps: Number(maxSteps) };
    return this;
  }
  async readState() {
    const [s, st, totalSpikes, totalBurned, lin, supply, block] = await Promise.all([this.brain.brainState(), this.brain.activeStimulus(), this.brain.totalSpikes(), this.brain.totalBurned(), this.brain.lineageLength(), this.token.totalSupply(), this.provider.getBlockNumber()]);
    return {
      v: Array.from(s.v, Number), bias: Array.from(s.bias, Number), hist: Array.from(s.headingHist, Number), pendingInput: Array.from(s.pendingInput, Number),
      step: Number(s.step), energy: Number(s.energy), alive: s.alive, generation: Number(s.generation), posX: Number(s.posX), posY: Number(s.posY), headX: Number(s.headX), headY: Number(s.headY),
      stim: { channel: Number(st.channel), param: Number(st.param), strength: Number(st.strength), untilStep: Number(st.untilStep), active: st.active },
      totalSpikes: Number(totalSpikes), totalBurned, lineageLength: Number(lin), totalSupply: supply, block,
    };
  }
  async readLineage(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) { const l = await this.brain.lineage(i); out.push({ generation: i, bornBlock: Number(l.bornBlock), diedBlock: Number(l.diedBlock), steps: Number(l.steps), spikes: Number(l.spikes), hash: l.brainStateHash }); }
    return out;
  }
  /** Seconds per simulated step, measured from the real interval between on-chain ticks. */
  async careRate(events: any[]) {
    const ticks = events.filter((e) => e.name === "Ticked").slice().reverse();
    if (ticks.length < 2) return null;
    const [a, b] = await Promise.all([this.provider.getBlock(ticks[0].block), this.provider.getBlock(ticks[ticks.length - 1].block)]);
    const dt = Number(b.timestamp) - Number(a.timestamp);
    if (dt <= 0) return null;
    const steps = ticks.reduce((n: number, t: any) => n + Number(t.args.steps), 0);
    return { stepsPerSecond: steps / dt, stepsPerDay: (steps / dt) * 86400, windowSeconds: dt, ticks: ticks.length };
  }

  // ---- Event scans. Public BSC RPCs are uneven about eth_getLogs (publicnode refuses blocks older than ~10k as
  // "archive", the dataseeds refuse it outright, others cap the range), so a record is read across several endpoints,
  // newest chunk first, moving to the next endpoint when one fails, and the result says how far back it reached.
  /** Endpoints for eth_getLogs, in order: the private RPC if there is one, the ones known to serve history, then the
   *  rest of the public list (good for the most recent blocks only). Built once per Chain. */
  logEndpoints(): LogEndpoint[] {
    if (this._logEndpoints) return this._logEndpoints;
    const out: LogEndpoint[] = [], seen = new Set<string>();
    const add = (url: string, span: number) => {
      if (!url || seen.has(url)) return; seen.add(url);
      const provider = url === this.rpcUrl ? this.provider : new ethers.JsonRpcProvider(url, CFG.chainId, { staticNetwork: true, batchMaxCount: 1 });
      out.push({ url, span, provider });
    };
    for (const url of CFG.privateRpc) add(url, CFG.logsSpan);
    for (const e of CFG.logsRpc) add(e.url, e.span);
    for (const url of CFG.rpc) add(url, CFG.logsSpan);
    return (this._logEndpoints = out);
  }
  /** Raw logs matching `filter` in the last `blocks` blocks, never older than `floor`, sorted oldest first. Never
   *  throws for a failed chunk: it returns what could be read and, in `scan`, the block it got back to. A repeat scan
   *  of the same filter reads only the blocks that are new since the last one (plus REORG_DEPTH for safety), so a
   *  page polling for changes costs one small request, not a full re-scan. */
  async scanLogs(filter: { address: string; topics?: any[] }, blocks: number, floor = 0): Promise<{ logs: any[]; scan: LogScan }> {
    const key = JSON.stringify([String(filter.address).toLowerCase(), filter.topics || null]);
    const prev = this._logCache.get(key);
    if (prev?.pending) await prev.pending.catch(() => {});   // one scan at a time per filter; the second continues from its cache
    const run = this._scanLogs(key, filter, blocks, floor);
    const cached = this._logCache.get(key);
    this._logCache.set(key, { ...(cached || { from: 0, to: 0, complete: false, logs: [] }), pending: run });
    try { return await run; } finally { const c = this._logCache.get(key); if (c && c.pending === run) delete c.pending; }
  }
  async _scanLogs(key: string, filter: { address: string; topics?: any[] }, blocks: number, floor: number): Promise<{ logs: any[]; scan: LogScan }> {
    const eps = this.logEndpoints();
    const to = Number(await this.provider.getBlockNumber()), from = Math.max(floor, to - blocks + 1);
    for (const ep of eps) ep.head = ep.provider === this.provider ? to : undefined;   // re-read once per scan, lazily, for the endpoints used
    const headOf = async (ep: LogEndpoint) => { if (ep.head === undefined) ep.head = Number(await withTimeout(ep.provider.getBlockNumber(), 6000)); return ep.head; };
    const host = (ep: LogEndpoint) => ep.url.replace(/^https?:\/\/([^/]+).*/, "$1");
    // incremental: a complete earlier scan of this filter is kept below `lo`; only the blocks above it are read again
    const cached = this._logCache.get(key);
    const incremental = !!(cached && cached.complete && cached.from <= from && cached.to >= from && cached.to <= to);
    const lo = incremental ? Math.max(from, cached.to - REORG_DEPTH + 1) : from;
    const logs: any[] = incremental ? cached.logs.filter((l) => l.blockNumber >= from && l.blockNumber < lo) : [];
    let cursor = to, top = to, readAny = false, ei = 0;
    while (cursor >= lo && ei < eps.length) {
      const ep = eps[ei];
      try {
        // an endpoint refuses a range past its own head, and the app's provider may be a block or two ahead of it
        const hi = Math.min(cursor, await headOf(ep));
        if (hi < lo) { ei++; continue; }
        if (!readAny) top = Math.min(top, hi);   // blocks above every endpoint's head are left for the next scan
        const chunkFrom = Math.max(lo, hi - ep.span + 1);
        const got = await withTimeout(ep.provider.getLogs({ ...filter, fromBlock: chunkFrom, toBlock: hi }), LOGS_TIMEOUT_MS);
        logs.push(...got); cursor = chunkFrom - 1; readAny = true;
      } catch (e) {
        console.warn(`eth_getLogs ${filter.address} up to block ${cursor} on ${host(ep)} failed (${errText(e)}); trying the next endpoint`);
        ei++;
      }
    }
    const complete = cursor < lo;
    if (!complete && incremental) {
      // the new blocks could not be read from anywhere: the last complete result, as of its own block, beats a gap
      console.warn(`event scan of ${filter.address}: no endpoint served blocks ${lo}…${to}; showing the record as of block ${cached.to}`);
      return { logs: cached.logs.filter((l) => l.blockNumber >= from), scan: { from, to: cached.to, complete: true, floor } };
    }
    const seen = new Set<string>(), out: any[] = [];
    for (const l of logs) { const k = `${l.transactionHash}:${l.index}`; if (l.blockNumber <= top && !seen.has(k)) { seen.add(k); out.push(l); } }
    out.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    const scan: LogScan = { from: complete ? from : cursor + 1, to: top, complete, floor };
    if (!complete) console.warn(`event scan of ${filter.address} is partial: blocks ${scan.from}…${scan.to} only (asked for ${from}…${to})`);
    this._logCache.set(key, { from: scan.from, to: scan.to, complete, logs: out });
    return { logs: out, scan };
  }
  /** Decoded events of one contract, newest first, with how far back the scan reached. */
  async _events(contract: any, filter: { address: string; topics?: any[] }, blocks: number, floor = 0, keep?: (p: any) => boolean): Promise<EventScan> {
    const { logs, scan } = await this.scanLogs(filter, blocks, floor);
    const events: Ev[] = [];
    for (const l of logs) { try { const p = contract.interface.parseLog({ topics: l.topics, data: l.data }); if (p && (!keep || keep(p))) events.push({ name: p.name, args: p.args, block: l.blockNumber, tx: l.transactionHash }); } catch {} }
    return { events: events.reverse(), scan };
  }

  async worldInfo() {
    const [alive, generation, lastAgeMs, lastEnergy, totalBurned, foodCount, tps, minFood, resPrice, arena] = await Promise.all([
      this.world.alive(), this.world.generation(), this.world.lastAgeMs(), this.world.lastEnergy(), this.world.totalBurned(), this.world.foodCount(),
      this.world.TOKENS_PER_SECOND(), this.world.MIN_FOOD(), this.world.RESURRECT_PRICE(), this.world.ARENA()]);
    return { alive, generation: Number(generation), lastAgeMs: Number(lastAgeMs), lastEnergy: Number(lastEnergy), totalBurned, foodCount: Number(foodCount), tps, minFood, resPrice, arena: Number(arena) };
  }
  /** FlyWorld's events, newest first, from the last `blocks` blocks. */
  worldEvents(blocks = 40000): Promise<EventScan> { return this._events(this.world, { address: CFG.world }, blocks); }
  /** The live server announces its public origin in the snapshotURI of each checkpoint. */
  liveOrigin(events: any[]) {
    for (const e of events) { if ((e.name === "Checkpoint" || e.name === "Died") && e.args.snapshotURI) { try { return new URL(e.args.snapshotURI).origin; } catch {} } }
    return null;
  }
  async placeFood(x: number, y: number, amount: bigint) { await this._ensureAllowanceFor(CFG.world, amount); return (await this.worldW.placeFood(x, y, amount)).wait(); }
  async resurrectWorld(extra: bigint, resPrice: bigint) { await this._ensureAllowanceFor(CFG.world, resPrice + extra); return (await this.worldW.resurrect(extra)).wait(); }
  async _ensureAllowanceFor(spender: string, value: bigint) { if ((await this.token.allowance(this.account, spender)) < value) await (await this.tokenW.approve(spender, ethers.MaxUint256)).wait(); }

  // ---- FlyRegistry (v3: mint and breed burn $FLY; life is paid in BNB, feed and resurrect are payable)
  async registryInfo() {
    const [total, max, mint, lifeWeiPerSecond, resurrectWei, breed, gen, burned] = await Promise.all([this.registry.totalMinted(), this.registry.MAX_SUPPLY(), this.registry.MINT_PRICE(), this.registry.lifeWeiPerSecond(), this.registry.resurrectWei(), this.registry.BREED_PRICE(), this.registry.GENESIS_ENERGY(), this.registry.totalBurned()]);
    return { total: Number(total), max: Number(max), mint, lifeWeiPerSecond, resurrectWei, breed, genesisEnergy: Number(gen), burned };
  }
  /** The live price of life, alone: one small read for a page that only keeps a fly alive. */
  async lifePrice(): Promise<LifePrice> {
    const [lifeWeiPerSecond, resurrectWei] = await Promise.all([this.registry.lifeWeiPerSecond(), this.registry.resurrectWei()]);
    return { lifeWeiPerSecond, resurrectWei };
  }
  async flyRecord(id: number) {
    const [f, name, owner, uri] = await Promise.all([this.registry.fly(id), this.registry.flyName(id), this.registry.ownerOf(id), this.registry.tokenURI(id)]);
    return { id, name, owner, uri, connectome: f.connectome, model: Number(f.model), generation: Number(f.generation), deaths: Number(f.deaths), parentA: Number(f.parentA), parentB: Number(f.parentB), stateRoot: f.stateRoot, memoryRoot: f.memoryRoot, stateURI: f.stateURI, brainStep: Number(f.brainStep), energy: Number(f.energy), bornBlock: Number(f.bornBlock), lastCommitBlock: Number(f.lastCommitBlock), body: f.body, pendingBody: f.pendingBody, alive: f.alive };
  }
  async bodyInfo(addr: string) { const b = await this.registry.bodies(addr); return { name: b.name, uri: b.uri, flies: Number(b.flies) }; }
  /** The registry's own test for a body: `assign(id, body)` reverts with NotRegistered() unless `isBody[body]`. */
  async isBody(addr: string) { return Boolean(await this.registry.isBody(addr)); }
  /** The registry's events (one fly's, when `flyId` is given), newest first, from the last `blocks` blocks but never
   *  before the registry existed. One scan serves every fly: the filter by id is applied to the decoded events. */
  registryEvents(blocks = 40000, flyId?: number): Promise<EventScan> {
    const mine = (p: any) => flyId === undefined || (p.args.id !== undefined && Number(p.args.id) === flyId) || (p.args._tokenId !== undefined && Number(p.args._tokenId) === flyId);
    return this._events(this.registry, { address: CFG.registry }, blocks, CFG.registryDeployBlock, mine);
  }
  async metadataOf(uri: string) { const u = uri.startsWith("ipfs://") ? CFG.ipfsGateway + uri.slice(7) : uri; try { return await (await fetch(u)).json(); } catch { return null; } }
  ipfsHttp(uri: string) { return uri && uri.startsWith("ipfs://") ? CFG.ipfsGateway + uri.slice(7) : uri; }
  async mintFly(name: string, price: bigint) { await this._ensureAllowanceFor(CFG.registry, price); return (await this.registryW.mint(name, { gasLimit: 400000 })).wait(); }
  /** Give fly `id` `seconds` of life for BNB: a plain payable call, no $FLY approval; `value` is what the registry asks
   *  (lifeCost(seconds) = seconds × lifeWeiPerSecond, computed by the caller from the price it showed). The energy lands
   *  on the record at once; the body applies it at its next poll. */
  async feedFly(id: number, seconds: number, value: bigint) {
    if (!this.registryW) throw new Error("Connect a wallet first.");
    return (await this.registryW.feed(id, seconds, { value, gasLimit: 150000 })).wait();
  }
  /** Wake dead fly `id` with `seconds` of life for BNB: `value` = resurrectWei + lifeCost(seconds). */
  async resurrectFly(id: number, seconds: number, value: bigint) {
    if (!this.registryW) throw new Error("Connect a wallet first.");
    return (await this.registryW.resurrect(id, seconds, { value, gasLimit: 200000 })).wait();
  }
  async assignFly(id: number, body: string) { return (await this.registryW.assign(id, body)).wait(); }
  async breedFlies(a: number, b: number, name: string, price: bigint) { await this._ensureAllowanceFor(CFG.registry, price); return (await this.registryW.breed(a, b, ethers.ZeroHash, name, { gasLimit: 500000 })).wait(); }
  async ownedFlies(owner: string, total: number) { const out: number[] = []; for (let i = 1; i <= total; i++) { try { if ((await this.registry.ownerOf(i)).toLowerCase() === owner.toLowerCase()) out.push(i); } catch {} } return out; }

  // ---- FlyCore: the per-fly compass core (155 neurons in the EVM, keyed by registry id)
  get hasCore() { return !!this.core; }
  async coreInfo() {
    if (!this.core) throw new Error("FlyCore is not configured");
    const [sp, ttl, maxSteps] = await Promise.all([this.core.STIM_PRICE(), this.core.STIM_TTL(), this.core.MAX_STEPS()]);
    this.corePrices = { stimPrice: sp, stimTTL: Number(ttl), maxSteps: Number(maxSteps) };
    return this.corePrices;
  }
  /** The whole on-chain state of one fly's core, plus its hash and the block it was read at. */
  async coreState(id: number) {
    const [c, hash, block] = await Promise.all([this.core.core(id), this.core.coreHash(id), this.provider.getBlockNumber()]);
    const step = Number(c.step), stimChannel = Number(c.stimChannel), stimUntilStep = Number(c.stimUntilStep);
    return {
      v: Array.from(c.v, Number), bias: Array.from(c.bias, Number), hist: Array.from(c.headingHist, Number), inp: Array.from(c.pendingInput, Number),
      step, headX: Number(c.headX), headY: Number(c.headY), posX: Number(c.posX), posY: Number(c.posY),
      stimChannel, stimParam: Number(c.stimParam), stimStrength: Number(c.stimStrength), stimUntilStep, stimActive: stimChannel !== 0 && step < stimUntilStep,
      totalSpikes: Number(c.totalSpikes), hash, block,
    };
  }
  /** Ticked / Stimulated / Seeded events of one fly's core, newest first, from the last `blocks` blocks but never
   *  before the core existed. Filtered on the node by the indexed id, so a fly's record is one small request. */
  coreEvents(id: number, blocks = 40000): Promise<EventScan> {
    const iface = this.core.interface;
    const topics = [["Ticked", "Stimulated", "Seeded"].map((n) => iface.getEvent(n).topicHash), ethers.zeroPadValue(ethers.toBeHex(id), 32)];
    return this._events(this.core, { address: CFG.core, topics }, blocks, CFG.coreDeployBlock || CFG.registryDeployBlock);
  }
  /** True when the connected wallet is the body currently running fly `id` (its senses are free; anyone else burns STIM_PRICE x strength). */
  async isCoreBody(id: number) { if (!this.account) return false; const f = await this.registry.fly(id); return String(f.body).toLowerCase() === this.account.toLowerCase(); }
  async coreStimulate(id: number, channel: number, param: number, strength: number, steps: number) {
    if (!this.coreW) throw new Error("Connect a wallet first.");
    if (!this.corePrices) await this.coreInfo();
    if (!(await this.isCoreBody(id))) await this._ensureAllowanceFor(CFG.core, this.corePrices!.stimPrice * BigInt(strength));
    const gasLimit = steps === 0 ? CORE_GAS.stim0 : steps > 16 ? CORE_GAS.stim32 : CORE_GAS.stim16;
    return (await this.coreW.stimulate(id, channel, param, strength, steps, { gasLimit })).wait();
  }
  async coreTick(id: number, steps: number) {
    if (!this.coreW) throw new Error("Connect a wallet first.");
    return (await this.coreW.tick(id, steps, { gasLimit: steps > 16 ? CORE_GAS.tick32 : CORE_GAS.tick16 })).wait();
  }

  /** FlyBrain v2's events, newest first, from the last `blocks` blocks. */
  recentEvents(blocks = 20000): Promise<EventScan> { return this._events(this.brain, { address: CFG.brain }, blocks); }
  async connectWallet() {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No wallet found. Install MetaMask, Rabby or Binance Wallet.");
    const bp = new ethers.BrowserProvider(eth);
    await bp.send("eth_requestAccounts", []);
    const hex = "0x" + CFG.chainId.toString(16);
    try { await bp.send("wallet_switchEthereumChain", [{ chainId: hex }]); }
    catch (e: any) {
      if (e && (e.code === 4902 || (e.error && e.error.code === 4902))) await bp.send("wallet_addEthereumChain", [{ chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: [CFG.publicRpc], blockExplorerUrls: [CFG.explorer] }]);
      else throw e;
    }
    this.signer = await bp.getSigner(); this.account = await this.signer.getAddress();
    this.brainW = this.brain.connect(this.signer); this.tokenW = this.token.connect(this.signer); this.worldW = this.world.connect(this.signer); this.registryW = this.registry.connect(this.signer);
    if (this.core) this.coreW = this.core.connect(this.signer);
    return this.account;
  }
  async balance() { return this.account ? this.token.balanceOf(this.account) : 0n; }
  async _permit(value: bigint) {
    const [name, nonce, net] = await Promise.all([this.token.name(), this.token.nonces(this.account), this.provider.getNetwork()]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const sig = await this.signer.signTypedData({ name, version: "1", chainId: net.chainId, verifyingContract: CFG.token },
      { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { owner: this.account, spender: CFG.brain, value, nonce, deadline });
    const s = ethers.Signature.from(sig);
    return { deadline, v: s.v, r: s.r, s: s.s };
  }
  async _hasAllowance(value: bigint) { return (await this.token.allowance(this.account, CFG.brain)) >= value; }
  async _ensureAllowance(value: bigint) { if (!(await this._hasAllowance(value))) await (await this.tokenW.approve(CFG.brain, ethers.MaxUint256)).wait(); }
  async feed(amount: bigint) { await this._ensureAllowance(amount); return (await this.brainW.feed(amount)).wait(); }
  async stimulate(channel: number, param: number, strength: number, steps: number) {
    await this._ensureAllowance(this.prices.stimPrice * BigInt(strength));
    return (await this.brainW.stimulate(channel, param, strength, steps, { gasLimit: steps > 16 ? GAS.stim32 : GAS.stim16 })).wait();
  }
  async tick(steps: number) { return (await this.brainW.tick(steps, { gasLimit: steps > 16 ? GAS.tick32 : GAS.tick16 })).wait(); }
  async resurrect(extraFood: bigint) { await this._ensureAllowance(this.prices.resurrectPrice + extraFood); return (await this.brainW.resurrect(extraFood)).wait(); }
}
