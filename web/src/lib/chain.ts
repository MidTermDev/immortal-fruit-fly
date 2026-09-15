// @ts-nocheck
import { ethers } from "ethers";
import { CFG } from "./config";

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
export const TOKEN_ABI = [
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function nonces(address) view returns (uint256)",
];
// gas limits: public RPC estimation caps out at ~16.7M, so we set them ourselves
const GAS = { tick16: 4_500_000, tick32: 9_000_000, stim16: 9_000_000, stim32: 15_500_000 };

export class Chain {
  provider: any = null; brain: any = null; token: any = null; signer: any = null; account: string | null = null; brainW: any; tokenW: any; prices: any;
  async connectRead() {
    let lastErr;
    for (const url of CFG.rpc) {
      try {
        const p = new ethers.JsonRpcProvider(url, CFG.chainId, { staticNetwork: true });
        await Promise.race([p.getBlockNumber(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
        this.provider = p; break;
      } catch (e) { lastErr = e; }
    }
    if (!this.provider) throw lastErr || new Error("no rpc");
    this.brain = new ethers.Contract(CFG.brain, BRAIN_ABI, this.provider);
    this.token = new ethers.Contract(CFG.token, TOKEN_ABI, this.provider);
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
  async recentEvents(blocks = 20000) {
    const to = await this.provider.getBlockNumber(); const from = Math.max(0, to - blocks);
    const raw: any[] = [];
    for (let b = to; b > from; b -= 2000) { try { raw.push(...(await this.provider.getLogs({ address: CFG.brain, fromBlock: Math.max(from, b - 1999), toBlock: b }))); } catch (e) { console.warn("getLogs chunk failed", e); } }
    raw.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
    const out = [];
    for (const l of raw) { try { const p = this.brain.interface.parseLog({ topics: l.topics, data: l.data }); if (p) out.push({ name: p.name, args: p.args, block: l.blockNumber, tx: l.transactionHash }); } catch {} }
    return out.reverse();
  }
  async connectWallet() {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No wallet found. Install MetaMask, Rabby or Binance Wallet.");
    const bp = new ethers.BrowserProvider(eth);
    await bp.send("eth_requestAccounts", []);
    const hex = "0x" + CFG.chainId.toString(16);
    try { await bp.send("wallet_switchEthereumChain", [{ chainId: hex }]); }
    catch (e: any) {
      if (e && (e.code === 4902 || (e.error && e.error.code === 4902))) await bp.send("wallet_addEthereumChain", [{ chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: [CFG.rpc[1]], blockExplorerUrls: [CFG.explorer] }]);
      else throw e;
    }
    this.signer = await bp.getSigner(); this.account = await this.signer.getAddress();
    this.brainW = this.brain.connect(this.signer); this.tokenW = this.token.connect(this.signer);
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
