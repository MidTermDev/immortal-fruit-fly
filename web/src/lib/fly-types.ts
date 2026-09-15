export type FlyConnection = "loading" | "live" | "stale" | "offline";

export interface FlyPrices {
  tokensPerStep: bigint;
  stimPrice: bigint;
  resurrectPrice: bigint;
  stimTTL: number;
  maxSteps: number;
}

export interface FlySnapshot {
  v: number[];
  bias: number[];
  hist: number[];
  pendingInput: number[];
  step: number;
  energy: number;
  /** Exact uint64 value for token/energy limit validation. */
  energyRaw?: bigint;
  alive: boolean;
  generation: number;
  /** Contract coordinates in 1/256 units; the visual owns their presentation. */
  posX: number;
  posY: number;
  headX: number;
  headY: number;
  stim: { channel: number; param: number; strength: number; untilStep: number; active: boolean };
  totalSpikes: number;
  totalBurned: bigint;
  lineageLength: number;
  totalSupply: bigint;
  block: number;
}

export interface FlyWallet {
  address: string | null;
  balance: bigint | null;
  connecting: boolean;
  wrongNetwork: boolean;
}

export type TransactionPhase = "idle" | "approval" | "approving" | "wallet" | "pending" | "confirmed" | "error";

export interface FlyTransaction {
  phase: TransactionPhase;
  label: string;
  message: string;
  hash?: string;
}

export type TransactionProgress = (phase: TransactionPhase, hash?: string) => void;

export interface FlyControls {
  snapshot: FlySnapshot | null;
  connection: FlyConnection;
  prices: FlyPrices | null;
  wallet: FlyWallet;
  transaction: FlyTransaction;
  busy: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
  feed: (rawAmount: string) => Promise<void>;
  tick: () => Promise<void>;
  stimulate: (channel: number, param: number, strength: number) => Promise<void>;
  resurrect: (rawFood: string) => Promise<void>;
  clearTransaction: () => void;
}
