import { ethers } from "ethers";
import { CFG } from "./config";

export type FlyRecord = {
  id: number; name: string; owner: string; uri: string; connectome: string; model: number; generation: number; deaths: number;
  parentA: number; parentB: number; stateRoot: string; memoryRoot: string; stateURI: string; brainStep: number; energy: number;
  bornBlock: number; lastCommitBlock: number; body: string; pendingBody: string; alive: boolean;
};
export type RegistryInfo = { total: number; max: number; mint: bigint; res: bigint; feed: bigint; breed: bigint; genesisEnergy: number; burned: bigint };
export type Ev = { name: string; args: any; block: number; tx: string };

export const ZERO = "0x0000000000000000000000000000000000000000";
export const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
export const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
export const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };
export const hms = (s: number) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; };
export const ipfs = (uri: string) => (uri && uri.startsWith("ipfs://") ? CFG.ipfsGateway + uri.slice(7) : uri);
export const pad = (id: number) => String(id).padStart(3, "0");

export function bodyName(addr: string, names: Record<string, string> = {}) {
  if (!addr || addr === ZERO) return "";
  const a = addr.toLowerCase();
  if (a === CFG.bodies.arena.toLowerCase()) return "Arena";
  if (a === CFG.bodies.doom.toLowerCase()) return "DOOM";
  return names[a] || short(addr);
}

/** One word for where the organism is right now. */
export function status(f: FlyRecord) {
  if (!f.alive) return { key: "dead", label: "dead", note: "brain frozen at its last state; resurrect to continue it" };
  if (f.body !== ZERO) return { key: "alive", label: "alive", note: `running in ${bodyName(f.body)}` };
  if (f.pendingBody !== ZERO) return { key: "waiting", label: "assigned", note: `waiting for ${bodyName(f.pendingBody)} to accept it` };
  return { key: "dormant", label: "dormant", note: "alive but not running anywhere; its energy is frozen" };
}

export const decodeKind = (k: string) => { try { return ethers.toUtf8String(k).replace(/\0+$/, ""); } catch { return String(k).slice(0, 10); } };
