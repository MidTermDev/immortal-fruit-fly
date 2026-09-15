import { ethers } from "ethers";
import { CFG } from "./config";
import type { FlyPrices, FlySnapshot, TransactionProgress } from "./fly-types";

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
  "error Dead()", "error NotDead()", "error BadSteps()", "error BadChannel()", "error BadStrength()", "error ZeroAmount()",
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
  "error OutOfArena()", "error TooSmall()", "error Dead()", "error NotDead()",
];
export const TOKEN_ABI = [
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function nonces(address) view returns (uint256)",
];
// gas limits: public RPC estimation caps out at ~16.7M, so we set them ourselves
const GAS = { tick16: 4_500_000, tick32: 9_000_000, stim16: 9_000_000, stim32: 15_500_000 };

export interface WalletProvider extends ethers.Eip1193Provider {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export function injectedWallet(): WalletProvider | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { ethereum?: WalletProvider }).ethereum;
}

export function actionError(error: unknown): string {
  const e = error as { code?: string | number; shortMessage?: string; message?: string; reason?: string; revert?: { name?: string }; info?: { error?: { code?: number } } } | null;
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001) return "Cancelled in your wallet.";
  if (e?.code === -32002) return "A wallet request is already open. Check your wallet.";
  if (e?.code === "INSUFFICIENT_FUNDS") return "You need more BNB for the network fee.";
  const contractError = e?.revert?.name || e?.reason;
  if (contractError === "Dead") return "The fly has died. Revive it before interacting.";
  if (contractError === "NotDead") return "The fly is already alive. Feed it instead.";
  if (contractError === "ZeroAmount") return "Enter enough FLY for at least one step.";
  if (contractError === "OutOfArena") return "Choose a point inside the arena.";
  if (contractError === "TooSmall") return "Enter at least the minimum food amount.";
  if (e?.code === "CALL_EXCEPTION") return "The transaction could not run. Refresh the fly and try again.";
  if (e?.code === "NETWORK_ERROR" || e?.code === "TIMEOUT" || e?.code === "SERVER_ERROR") return "Connection unavailable. Please try again.";
  return e?.message && !e.code && e.message.length < 180 ? e.message : "Something went wrong. Please try again.";
}

export type EventSource = "core" | "world";
export type ChainEvent = { name: string; args: ethers.Result; block: number; tx: string; index?: number; id?: string; source?: EventSource };
export interface WorldInfo {
  alive: boolean; generation: number; lastAgeMs: number; lastEnergy: number; lastEnergyRaw: bigint;
  totalBurned: bigint; foodCount: number; tps: bigint; minFood: bigint; resPrice: bigint; arena: number;
  lastStep: number; lastHash: string; block: number;
}

export class Chain {
  provider: ethers.JsonRpcProvider | null = null;
  brain!: ethers.Contract;
  token!: ethers.Contract;
  world!: ethers.Contract;
  worldW!: ethers.Contract;
  signer: ethers.JsonRpcSigner | null = null;
  account: string | null = null;
  brainW!: ethers.Contract;
  tokenW!: ethers.Contract;
  prices!: FlyPrices;
  private rpcCursor = 0;
  private disposed = false;

  async connectRead() {
    if (this.provider) return this;
    let lastErr: unknown;
    for (let offset = 0; offset < CFG.rpc.length; offset++) {
      if (this.disposed) throw new Error("Connection closed.");
      const index = (this.rpcCursor + offset) % CFG.rpc.length;
      const request = new ethers.FetchRequest(CFG.rpc[index]);
      request.timeout = 8000;
      const provider = new ethers.JsonRpcProvider(request, CFG.chainId, { staticNetwork: true });
      try {
        const brain = new ethers.Contract(CFG.brain, BRAIN_ABI, provider);
        const [tps, sp, rp, ttl, maxSteps] = await Promise.all([brain.TOKENS_PER_STEP(), brain.STIM_PRICE(), brain.RESURRECT_PRICE(), brain.STIM_TTL(), brain.MAX_STEPS()]);
        if (this.disposed) throw new Error("Connection closed.");
        this.provider = provider;
        this.brain = brain;
        this.token = new ethers.Contract(CFG.token, TOKEN_ABI, provider);
        this.world = new ethers.Contract(CFG.world, WORLD_ABI, provider);
        this.prices = { tokensPerStep: tps, stimPrice: sp, resurrectPrice: rp, stimTTL: Number(ttl), maxSteps: Number(maxSteps) };
        this.rpcCursor = (index + 1) % CFG.rpc.length;
        return this;
      } catch (error) {
        provider.destroy();
        lastErr = error;
      }
    }
    throw lastErr || new Error("Connection unavailable. Please try again.");
  }

  invalidateRead() {
    this.provider?.destroy();
    this.provider = null;
  }

  dispose() {
    this.disposed = true;
    this.invalidateRead();
    this.disconnectWallet();
  }

  async readState(): Promise<FlySnapshot> {
    if (!this.provider) throw new Error("Connection unavailable. Please try again.");
    // Use one block for the whole snapshot, so a tick cannot split its fields.
    const block = await this.provider.getBlockNumber();
    const overrides = { blockTag: block };
    const [s, st, totalSpikes, totalBurned, lin, supply] = await Promise.all([this.brain.brainState(overrides), this.brain.activeStimulus(overrides), this.brain.totalSpikes(overrides), this.brain.totalBurned(overrides), this.brain.lineageLength(overrides), this.token.totalSupply(overrides)]);
    return {
      v: Array.from(s.v, Number), bias: Array.from(s.bias, Number), hist: Array.from(s.headingHist, Number), pendingInput: Array.from(s.pendingInput, Number),
      step: Number(s.step), energy: Number(s.energy), energyRaw: BigInt(s.energy), alive: s.alive, generation: Number(s.generation), posX: Number(s.posX), posY: Number(s.posY), headX: Number(s.headX), headY: Number(s.headY),
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
  async careRate(events: ChainEvent[]) {
    if (!this.provider) return null;
    const ticks = events.filter((e) => e.name === "Ticked").slice().reverse();
    if (ticks.length < 2) return null;
    const [a, b] = await Promise.all([this.provider.getBlock(ticks[0].block), this.provider.getBlock(ticks[ticks.length - 1].block)]);
    if (!a || !b) return null;
    const dt = Number(b.timestamp) - Number(a.timestamp);
    if (dt <= 0) return null;
    const steps = ticks.reduce((n, t) => n + Number(t.args.steps), 0);
    return { stepsPerSecond: steps / dt, stepsPerDay: (steps / dt) * 86400, windowSeconds: dt, ticks: ticks.length };
  }

  async worldInfo(): Promise<WorldInfo> {
    if (!this.provider) throw new Error("Connection unavailable. Please try again.");
    const block = await this.provider.getBlockNumber();
    const at = { blockTag: block };
    const [alive, generation, lastAgeMs, lastEnergy, totalBurned, foodCount, tps, minFood, resPrice, arena, lastStep, lastHash] = await Promise.all([
      this.world.alive(at), this.world.generation(at), this.world.lastAgeMs(at), this.world.lastEnergy(at), this.world.totalBurned(at), this.world.foodCount(at),
      this.world.TOKENS_PER_SECOND(at), this.world.MIN_FOOD(at), this.world.RESURRECT_PRICE(at), this.world.ARENA(at), this.world.lastStep(at), this.world.lastHash(at)]);
    return { alive, generation: Number(generation), lastAgeMs: Number(lastAgeMs), lastEnergy: Number(lastEnergy), lastEnergyRaw: BigInt(lastEnergy), totalBurned, foodCount: Number(foodCount), tps, minFood, resPrice, arena: Number(arena), lastStep: Number(lastStep), lastHash, block };
  }
  async readEvents(source: EventSource, fromBlock: number, toBlock: number): Promise<Required<ChainEvent>[]> {
    if (!this.provider) throw new Error("Connection unavailable. Please try again.");
    if (toBlock < fromBlock) return [];
    if (toBlock - fromBlock >= 2000) throw new Error("Read at most 2,000 blocks at a time.");
    const contract = source === "world" ? this.world : this.brain;
    const address = source === "world" ? CFG.world : CFG.brain;
    // Errors propagate: a denied log request must never look like empty history.
    const logs = await this.provider.getLogs({ address, fromBlock, toBlock });
    const events: Required<ChainEvent>[] = [];
    for (const log of logs) {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed) events.push({ source, name: parsed.name, args: parsed.args, block: log.blockNumber, tx: log.transactionHash, index: log.index, id: `${source}:${log.transactionHash}:${log.index}` });
    }
    return events.sort((a, b) => a.block - b.block || a.index - b.index);
  }
  async worldEvents(blocks = 2000) {
    if (!this.provider) throw new Error("Connection unavailable. Please try again.");
    const to = await this.provider.getBlockNumber();
    return (await this.readEvents("world", Math.max(0, to - Math.min(Math.max(blocks, 1), 2000) + 1), to)).reverse();
  }
  /** The live server announces its public origin in the snapshotURI of each checkpoint. */
  liveOrigin(events: ChainEvent[]) {
    for (const e of events) { if ((e.name === "Checkpoint" || e.name === "Died") && e.args.snapshotURI) { try { const url = new URL(e.args.snapshotURI); if (url.protocol === "https:" || url.protocol === "http:") return url.origin; } catch {} } }
    return null;
  }
  async placeFood(x: number, y: number, amount: bigint, progress?: TransactionProgress, validate?: () => Promise<void>) {
    await this._ensureAllowanceFor(CFG.world, amount, progress);
    await validate?.();
    return this.send(() => this.worldW.placeFood(x, y, amount), progress);
  }
  async resurrectWorld(extra: bigint, resPrice: bigint, progress?: TransactionProgress, validate?: () => Promise<void>) {
    await this._ensureAllowanceFor(CFG.world, resPrice + extra, progress);
    await validate?.();
    return this.send(() => this.worldW.resurrect(extra), progress);
  }
  async _ensureAllowanceFor(spender: string, value: bigint, progress?: TransactionProgress) {
    if ((await this.token.allowance(this.account, spender)) >= value) return;
    progress?.("approval");
    const tx = await this.tokenW.approve(spender, value);
    progress?.("approving", tx.hash);
    await this.confirmed(tx);
  }

  async recentEvents(blocks = 20000) {
    if (!this.provider) return [];
    const to = await this.provider.getBlockNumber(); const from = Math.max(0, to - blocks);
    const raw: ethers.Log[] = [];
    for (let b = to; b > from; b -= 2000) { try { raw.push(...(await this.provider.getLogs({ address: CFG.brain, fromBlock: Math.max(from, b - 1999), toBlock: b }))); } catch (e) { console.warn("getLogs chunk failed", e); } }
    raw.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    const out = [];
    for (const l of raw) { try { const p = this.brain.interface.parseLog({ topics: l.topics, data: l.data }); if (p) out.push({ name: p.name, args: p.args, block: l.blockNumber, tx: l.transactionHash }); } catch {} }
    return out.reverse();
  }
  async connectWallet() {
    const eth = injectedWallet();
    if (!eth) throw new Error("Open this page in your wallet browser, or install a browser wallet.");
    const bp = new ethers.BrowserProvider(eth);
    await bp.send("eth_requestAccounts", []);
    const hex = "0x" + CFG.chainId.toString(16);
    try { await bp.send("wallet_switchEthereumChain", [{ chainId: hex }]); }
    catch (error) {
      const e = error as { code?: number; info?: { error?: { code?: number } }; error?: { code?: number } };
      if (e.code === 4902 || e.info?.error?.code === 4902 || e.error?.code === 4902) await bp.send("wallet_addEthereumChain", [{ chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: [CFG.rpc[1]], blockExplorerUrls: [CFG.explorer] }]);
      else throw e;
    }
    const wallet = await this.syncWallet();
    if (wallet.wrongNetwork) throw new Error("Switch your wallet to BNB Smart Chain.");
    if (!wallet.address) throw new Error("Connect your wallet to continue.");
    return this.account;
  }

  async syncWallet(): Promise<{ address: string | null; wrongNetwork: boolean }> {
    const eth = injectedWallet();
    if (!eth) return { address: null, wrongNetwork: false };
    const [accounts, chainId] = await Promise.all([eth.request({ method: "eth_accounts" }), eth.request({ method: "eth_chainId" })]);
    const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? ethers.getAddress(accounts[0]) : null;
    const wrongNetwork = Number(chainId) !== CFG.chainId;
    this.disconnectWallet();
    this.account = address;
    if (address && !wrongNetwork) {
      const bp = new ethers.BrowserProvider(eth);
      // Account checks above are read-only; event handling must never prompt.
      this.signer = new ethers.JsonRpcSigner(bp, address);
      this.brainW = new ethers.Contract(CFG.brain, BRAIN_ABI, this.signer);
      this.tokenW = new ethers.Contract(CFG.token, TOKEN_ABI, this.signer);
      this.worldW = new ethers.Contract(CFG.world, WORLD_ABI, this.signer);
    }
    return { address, wrongNetwork: !!address && wrongNetwork };
  }

  disconnectWallet() { this.signer = null; this.account = null; }

  async validateWallet(expectedAccount: string) {
    const wallet = await this.syncWallet();
    if (!wallet.address || wallet.address.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error("Your wallet account changed. Please try again.");
    if (wallet.wrongNetwork) throw new Error("Switch your wallet to BNB Smart Chain.");
  }

  async balance() { return this.account ? this.token.balanceOf(this.account) : BigInt(0); }
  async _permit(value: bigint) {
    if (!this.signer || !this.account || !this.provider) throw new Error("Connect your wallet to continue.");
    const [name, nonce, net] = await Promise.all([this.token.name(), this.token.nonces(this.account), this.provider.getNetwork()]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const sig = await this.signer.signTypedData({ name, version: "1", chainId: net.chainId, verifyingContract: CFG.token },
      { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { owner: this.account, spender: CFG.brain, value, nonce, deadline });
    const s = ethers.Signature.from(sig);
    return { deadline, v: s.v, r: s.r, s: s.s };
  }
  async _hasAllowance(value: bigint) { return (await this.token.allowance(this.account, CFG.brain)) >= value; }

  private async confirmed(tx: ethers.ContractTransactionResponse) {
    try {
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The transaction failed. Please try again.");
      return receipt;
    } catch (error) {
      const replacement = error as { code?: string; cancelled?: boolean; receipt?: ethers.TransactionReceipt };
      if (replacement.code === "TRANSACTION_REPLACED") {
        if (replacement.cancelled) throw new Error("Transaction cancelled in your wallet.");
        if (replacement.receipt?.status === 1) return replacement.receipt;
      }
      throw error;
    }
  }

  async _ensureAllowance(value: bigint, progress?: TransactionProgress) {
    return this._ensureAllowanceFor(CFG.brain, value, progress);
  }

  private async send(send: () => Promise<ethers.ContractTransactionResponse>, progress?: TransactionProgress) {
    progress?.("wallet");
    const tx = await send();
    progress?.("pending", tx.hash);
    const receipt = await this.confirmed(tx);
    progress?.("confirmed", receipt.hash);
    return receipt;
  }

  async feed(amount: bigint, progress?: TransactionProgress, validate?: () => Promise<void>) {
    await this._ensureAllowance(amount, progress);
    await validate?.();
    return this.send(() => this.brainW.feed(amount), progress);
  }

  async stimulate(channel: number, param: number, strength: number, steps: number, progress?: TransactionProgress, validate?: () => Promise<void | number>) {
    await this._ensureAllowance(this.prices.stimPrice * BigInt(strength), progress);
    const refreshedSteps = await validate?.();
    if (typeof refreshedSteps === "number") steps = refreshedSteps;
    return this.send(() => this.brainW.stimulate(channel, param, strength, steps, { gasLimit: steps > 16 ? GAS.stim32 : GAS.stim16 }), progress);
  }

  async tick(steps: number, progress?: TransactionProgress) {
    return this.send(() => this.brainW.tick(steps, { gasLimit: steps > 16 ? GAS.tick32 : GAS.tick16 }), progress);
  }

  async resurrect(extraFood: bigint, progress?: TransactionProgress, validate?: () => Promise<void>) {
    await this._ensureAllowance(this.prices.resurrectPrice + extraFood, progress);
    await validate?.();
    return this.send(() => this.brainW.resurrect(extraFood), progress);
  }
}
