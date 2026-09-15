import { Contract, Interface, toBeHex } from "ethers";
import type { JsonRpcProvider, Log, Result } from "ethers";
import type { Chain } from "./chain";
import { ARCADE_ABI, ARCADE_ADDRESS } from "./arcade-abi";

export { ARCADE_ABI, ARCADE_ADDRESS } from "./arcade-abi";
export type ArcadeStatus = "loading" | "ready" | "partial" | "unavailable";
export interface ArcadeCursor { block: number; beforeIndex?: number }

export interface ArcadeSession {
  id: bigint; game: string; startBlock: bigint; endBlock: bigint;
  decisions: number; kills: number; finalHash: string;
  /** Unix seconds, or null if the block timestamp could not be read. */
  startedAt: number | null; endedAt: number | null;
}

export interface ArcadeDecision {
  id: string; session: bigint; n: number; brainHash: string; brainStep: bigint;
  /** Recorded accumulated turn; positive is left in brain/doom.py. */
  turn: number;
  /** At least one fire signal occurred in the operator's sampled interval. */
  fire: boolean;
  /** Cumulative whole-brain spike counter modulo 2^32, not a per-decision total. */
  spikes: number;
  /** Current episode kills; a new episode may reset this within one session. */
  kills: number; health: number; gameTic: number;
  block: number; index: number; tx: string; blockHash: string | null; timestamp: number | null;
}

export interface ArcadeState {
  sessions: ArcadeSession[]; totalSessions: bigint | null;
  selectedSessionId: bigint | null; selectedSession: ArcadeSession | null;
  /** Ordered by block, then log index. */
  decisions: ArcadeDecision[];
  status: ArcadeStatus; sessionStatus: ArcadeStatus; decisionStatus: ArcadeStatus;
  block: number | null; fromBlock: number | null; toBlock: number | null;
  hasOlderDecisions: boolean; truncated: boolean; error: string | null;
  olderCursor: ArcadeCursor | null; isLatest: boolean;
}

export const EMPTY_ARCADE: ArcadeState = {
  sessions: [], totalSessions: null, selectedSessionId: null, selectedSession: null, decisions: [],
  status: "loading", sessionStatus: "loading", decisionStatus: "loading",
  block: null, fromBlock: null, toBlock: null, hasOlderDecisions: false, truncated: false, error: null, olderCursor: null, isLatest: true,
};

const SESSION_LIMIT = 12;
const MAX_BLOCKS = 8000;
const CHUNK_BLOCKS = 2000;
const DECISION_LIMIT = 250;
const REORG_OVERLAP = 12;
const TIMESTAMP_LIMIT = 32;
const iface = new Interface(ARCADE_ABI);
const DECISION_TOPIC = iface.getEvent("Decision")!.topicHash;

function rpcBlock(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Session block exceeds the supported RPC range.");
  return Number(value);
}

export function decodeArcadeDecision(log: Pick<Log, "topics" | "data" | "blockNumber" | "index" | "transactionHash" | "blockHash">): ArcadeDecision | null {
  const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (!decoded || decoded.name !== "Decision") return null;
  const a = decoded.args;
  return {
    id: `${log.transactionHash}:${log.index}`, session: BigInt(a.session), n: Number(a.n), brainHash: a.brainHash,
    brainStep: BigInt(a.brainStep), turn: Number(a.turn), fire: a.fire, spikes: Number(a.spikes), kills: Number(a.kills),
    health: Number(a.health), gameTic: Number(a.gameTic), block: log.blockNumber, index: log.index,
    tx: log.transactionHash, blockHash: log.blockHash || null, timestamp: null,
  };
}

function decodeSession(id: bigint, value: Result): ArcadeSession {
  return { id, game: String(value.game), startBlock: BigInt(value.startBlock), endBlock: BigInt(value.endBlock), decisions: Number(value.decisions), kills: Number(value.kills), finalHash: value.finalHash, startedAt: null, endedAt: null };
}

interface DecisionWindow {
  records: Map<string, ArcadeDecision>; from: number; to: number; complete: boolean;
  droppedThrough: number; signature: string;
}

/** One read connection, a bounded session list, and cached selected-session log windows. */
export class ArcadeReader {
  private stopped = false;
  private pending: Promise<ArcadeState> | null = null;
  private pendingSelection: bigint | null = null;
  private pendingPage = "latest";
  private state: ArcadeState = EMPTY_ARCADE;
  private sessions = new Map<bigint, ArcadeSession>();
  private windows = new Map<string, DecisionWindow>();
  private pastEnd = new Set<bigint>();
  private times = new Map<number, { timestamp: number; hash: string | null }>();
  private contract: Contract | null = null;
  private contractProvider: JsonRpcProvider | null = null;

  constructor(private readonly chain: Chain) {}

  read(selected: bigint | null = null, page: ArcadeCursor | null = null): Promise<ArcadeState> {
    if (this.stopped) return Promise.resolve(this.state);
    const pageKey = page ? `${page.block}:${page.beforeIndex ?? "all"}` : "latest";
    if (this.pending) {
      if (this.pendingSelection === selected && this.pendingPage === pageKey) return this.pending;
      return this.pending.then(() => this.read(selected, page));
    }
    this.pendingSelection = selected; this.pendingPage = pageKey;
    this.pending = this.update(selected, page).finally(() => { this.pending = null; });
    return this.pending;
  }

  dispose() { this.stopped = true; this.chain.dispose(); }

  private async readDecisions(provider: JsonRpcProvider, session: ArcadeSession, head: number, page: ArcadeCursor | null = null) {
    const sessionStart = rpcBlock(session.startBlock);
    const sessionEnd = page ? page.block : session.endBlock > BigInt(0) && !this.pastEnd.has(session.id) ? rpcBlock(session.endBlock) : head;
    const to = Math.min(head, sessionEnd), from = Math.max(sessionStart, to - MAX_BLOCKS + 1);
    if (from > to) throw new Error("Waiting for the session's start block.");
    const key = `${session.id}:${page ? `${page.block}:${page.beforeIndex ?? "all"}` : "latest"}`;
    const previous = this.windows.get(key);
    const signature = `${session.startBlock}:${session.endBlock}:${session.decisions}:${session.finalHash}`;
    const cachedEnd = previous?.complete && previous.signature === signature && (page !== null || previous.records.size === session.decisions && session.endBlock > BigInt(0)) && to <= head - REORG_OVERLAP;
    const readFrom = previous?.complete && previous.from <= from && previous.to <= to ? Math.max(from, previous.to - REORG_OVERLAP + 1) : from;
    const ranges: { from: number; to: number }[] = [];
    if (!cachedEnd) for (let start = readFrom; start <= to; start += CHUNK_BLOCKS) ranges.push({ from: start, to: Math.min(start + CHUNK_BLOCKS - 1, to) });
    const records = new Map(previous?.records ?? []);
    const responses = await Promise.allSettled(ranges.map(async (range) => {
      const raw = await provider.getLogs({ address: ARCADE_ADDRESS, topics: [DECISION_TOPIC, toBeHex(session.id, 32)], fromBlock: range.from, toBlock: range.to });
      return raw.map(decodeArcadeDecision).filter((decision): decision is ArcadeDecision => !!decision && decision.session === session.id && !(page?.beforeIndex !== undefined && decision.block === page.block && decision.index >= page.beforeIndex));
    }));
    let successes = 0;
    responses.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      successes++;
      const range = ranges[index];
      // Replace overlapping ranges so orphaned decisions disappear after a short reorg.
      for (const [id, decision] of records) if (decision.block >= range.from && decision.block <= range.to) records.delete(id);
      for (const decision of result.value) {
        const timestamp = this.times.get(decision.block);
        if (timestamp?.hash && decision.blockHash && timestamp.hash !== decision.blockHash) this.times.delete(decision.block);
        records.set(decision.id, decision);
      }
    });
    for (const [id, decision] of records) if (decision.block < from || decision.block > to) records.delete(id);
    const ordered = [...records.values()].sort((a, b) => a.block - b.block || a.index - b.index);
    const droppedThrough = Math.max(previous?.droppedThrough ?? -1, ordered.length > DECISION_LIMIT ? ordered[ordered.length - DECISION_LIMIT - 1].block : -1);
    const bounded = ordered.slice(-DECISION_LIMIT);
    const complete = successes === ranges.length;
    this.windows.delete(key);
    this.windows.set(key, { records: new Map(bounded.map((decision) => [decision.id, decision])), from, to, complete, signature, droppedThrough });
    while (this.windows.size > 4) this.windows.delete(this.windows.keys().next().value!);
    const olderCursor: ArcadeCursor | null = droppedThrough >= from && bounded.length ? { block: bounded[0].block, beforeIndex: bounded[0].index } : from > sessionStart ? { block: from - 1 } : null;
    const truncated = olderCursor !== null || page !== null;
    return { decisions: bounded, from, to, complete, unavailable: ranges.length > 0 && successes === 0 && bounded.length === 0, truncated, olderCursor };
  }

  private async update(selected: bigint | null, page: ArcadeCursor | null): Promise<ArcadeState> {
    const prior = this.state;
    try {
      await this.chain.connectRead();
      const provider = this.chain.provider;
      if (!provider || this.stopped) return prior;
      const block = await provider.getBlockNumber();
      if (prior.block !== null && block < prior.block) throw new Error("RPC is behind the last observed block.");
      if (this.contractProvider !== provider) { this.contract = new Contract(ARCADE_ADDRESS, ARCADE_ABI, provider); this.contractProvider = provider; }
      const contract = this.contract!;
      const count = BigInt(await contract.sessionCount({ blockTag: block }));
      const id = selected ?? (count > BigInt(0) ? count - BigInt(1) : null);
      const ids: bigint[] = [];
      for (let index = count - BigInt(1); index >= BigInt(0) && ids.length < SESSION_LIMIT; index--) ids.push(index);
      if (id !== null && id >= BigInt(0) && id < count && !ids.includes(id)) ids.push(id);
      const reads = await Promise.allSettled(ids.map(async (sessionId) => decodeSession(sessionId, await contract.sessions(sessionId, { blockTag: block }))));
      if (this.stopped) return prior;
      const failedSessions = reads.some((result) => result.status === "rejected");
      reads.forEach((result) => { if (result.status === "fulfilled") this.sessions.set(result.value.id, result.value); });
      for (const sessionId of this.sessions.keys()) if (!ids.includes(sessionId)) this.sessions.delete(sessionId);
      const sessions = ids.filter((sessionId) => sessionId !== id || ids.indexOf(sessionId) < SESSION_LIMIT).map((sessionId) => this.sessions.get(sessionId)).filter((session): session is ArcadeSession => !!session);
      const current = id === null ? null : this.sessions.get(id) ?? null;
      const selectedReadFailed = id !== null && (id < BigInt(0) || id >= count || reads[ids.indexOf(id)]?.status === "rejected");
      let decisions: ArcadeDecision[] = [], from: number | null = null, to: number | null = null, truncated = false, logsFailed = false, olderCursor: ArcadeCursor | null = null;
      let decisionStatus: ArcadeStatus = count === BigInt(0) ? "ready" : "unavailable";
      let error: string | null = selectedReadFailed ? "This session could not be read." : failedSessions ? "Some session details are unavailable." : null;
      if (current && !selectedReadFailed) {
        try {
          let result = await this.readDecisions(provider, current, block, page);
          // endSession does not prohibit later decide calls. A higher recorded count
          // requires a head-ended window; earlier pages remain available explicitly.
          if (!page && current.endBlock > BigInt(0) && !this.pastEnd.has(current.id) && result.complete && !result.truncated && Math.max(0, ...result.decisions.map((decision) => decision.n)) < current.decisions) {
            this.pastEnd.add(current.id);
            result = await this.readDecisions(provider, current, block);
          }
          if (this.stopped) return prior;
          ({ decisions, from, to, truncated, olderCursor } = result);
          logsFailed = !result.complete;
          decisionStatus = result.unavailable ? "unavailable" : result.complete && !truncated && decisions.length === current.decisions ? "ready" : "partial";
          if (!result.complete) error = decisions.length ? "Some decision log ranges are unavailable." : "Decision logs are unavailable from this RPC.";
          else if (truncated) error = "Showing a bounded range of this session's decisions.";
          else if (decisions.length !== current.decisions) error = "The available logs do not cover every recorded decision.";
        } catch {
          logsFailed = true; error = "Decision logs could not be read.";
          if (prior.selectedSessionId === id) {
            decisions = prior.decisions; from = prior.fromBlock; to = prior.toBlock; truncated = prior.truncated; olderCursor = prior.olderCursor;
            decisionStatus = decisions.length ? "partial" : "unavailable";
          }
        }
      } else if (current && prior.selectedSessionId === id) decisions = prior.decisions;

      // Share a bounded block-time cache across session metadata and decision rows.
      const wantedTimes = [...new Set([
        ...(current ? [current.startBlock, current.endBlock].filter((value) => value > BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)).map(Number) : []),
        ...decisions.slice().reverse().map((decision) => decision.block),
        ...sessions.flatMap((session) => [session.startBlock, session.endBlock].filter((value) => value > BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)).map(Number)),
      ])].filter((value) => !this.times.has(value)).slice(0, TIMESTAMP_LIMIT);
      const timestamps = await Promise.allSettled(wantedTimes.map((value) => provider.getBlock(value)));
      if (this.stopped) return prior;
      timestamps.forEach((result, index) => { if (result.status === "fulfilled" && result.value) this.times.set(wantedTimes[index], { timestamp: result.value.timestamp, hash: result.value.hash }); });
      while (this.times.size > 512) this.times.delete(this.times.keys().next().value!);
      const withTimes = (session: ArcadeSession): ArcadeSession => ({ ...session, startedAt: session.startBlock <= BigInt(Number.MAX_SAFE_INTEGER) ? this.times.get(Number(session.startBlock))?.timestamp ?? null : null, endedAt: session.endBlock > BigInt(0) && session.endBlock <= BigInt(Number.MAX_SAFE_INTEGER) ? this.times.get(Number(session.endBlock))?.timestamp ?? null : null });
      decisions = decisions.map((decision) => ({ ...decision, timestamp: this.times.get(decision.block)?.timestamp ?? null }));
      const sessionList = sessions.map(withTimes), selectedSession = current ? withTimes(current) : null;
      const sessionStatus: ArcadeStatus = failedSessions || selectedReadFailed || sessionList.some((session) => session.startedAt === null || session.endBlock > BigInt(0) && session.endedAt === null) ? sessionList.length ? "partial" : "unavailable" : "ready";
      if (decisionStatus === "ready" && decisions.some((decision) => decision.timestamp === null)) { decisionStatus = "partial"; error ||= "Some decision block times are unavailable."; }
      const status: ArcadeStatus = sessionStatus === "ready" && decisionStatus === "ready" ? "ready" : sessionStatus === "unavailable" && decisionStatus === "unavailable" ? "unavailable" : "partial";
      this.state = { sessions: sessionList, totalSessions: count, selectedSessionId: id, selectedSession, decisions, status, sessionStatus, decisionStatus, block, fromBlock: from, toBlock: to, truncated, hasOlderDecisions: olderCursor !== null, error, olderCursor, isLatest: page === null };
      if (logsFailed || decisionStatus === "unavailable" || failedSessions) this.chain.invalidateRead();
      return this.state;
    } catch {
      if (this.stopped) return prior;
      this.chain.invalidateRead();
      const sameSelection = selected === null || selected === prior.selectedSessionId;
      this.state = { ...prior, selectedSessionId: selected ?? prior.selectedSessionId, selectedSession: sameSelection ? prior.selectedSession : null, decisions: sameSelection ? prior.decisions : [],
        status: prior.sessions.length ? "partial" : "unavailable", sessionStatus: prior.sessions.length ? "partial" : "unavailable", decisionStatus: sameSelection && prior.decisions.length ? "partial" : "unavailable", error: "The arcade connection is unavailable. Retrying will preserve the last records." };
      return this.state;
    }
  }
}
