import { ethers } from "ethers";
import { CFG } from "./config";

export type FlyRecord = {
  id: number; name: string; owner: string; uri: string; connectome: string; model: number; generation: number; deaths: number;
  parentA: number; parentB: number; stateRoot: string; memoryRoot: string; stateURI: string; brainStep: number; energy: number;
  bornBlock: number; lastCommitBlock: number; body: string; pendingBody: string; alive: boolean;
};
/** The registry's numbers (v3): mint and breed in $FLY (burned), life in BNB (`lifeWeiPerSecond` per second of life,
 *  `resurrectWei` flat to wake a dead fly, nothing burned), and `burned` the $FLY mints and breeding have sent to the dead address. */
export type RegistryInfo = { total: number; max: number; mint: bigint; lifeWeiPerSecond: bigint; resurrectWei: bigint; breed: bigint; genesisEnergy: number; burned: bigint };
export type Ev = { name: string; args: any; block: number; tx: string };

export const ZERO = "0x0000000000000000000000000000000000000000";
export const fmt = (n: number | bigint) => Number(n).toLocaleString("en-US");
export const short = (a?: string | null) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
export const fmtTok = (wei: bigint, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: d }); } catch { return "0"; } };
export const hms = (s: number) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; };
/** A duration without the zero parts: "24 h", "21 h 40 min", "2 h", "45 min", "30 s". For sums of life (sponsored, fed) rather than a clock. */
export const dur = (s: number | bigint) => { let n = Math.max(0, Math.floor(Number(s))); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60); n %= 60; if (h >= 48) { const d = Math.floor(h / 24); return h % 24 ? `${fmt(d)} d ${h % 24} h` : `${fmt(d)} d`; } return h ? (m ? `${h} h ${m} min` : `${h} h`) : m ? (n ? `${m} min ${n} s` : `${m} min`) : `${n} s`; };
/** "in the arena", "in the Colony", "in DOOM", "in Pebble 3": where a fly's food lands, as a phrase. */
export const inBody = (addr: string, names: Record<string, string> = {}) => { if (!addr || addr === ZERO) return ""; const a = addr.toLowerCase(); return a === CFG.bodies.arena.toLowerCase() ? "in the arena" : a === CFG.bodies.colony.toLowerCase() ? "in the Colony" : `in ${bodyName(addr, names)}`; };
/** BNB from wei, trimmed: "0.01", "0.0015", "1.2". */
export const fmtBnb = (wei: bigint) => { try { return Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 6 }); } catch { return "0"; } };
/** Two newest-first records as one, newest first; the first list's rows come first within a block. */
export const mergeEvents = (...lists: Ev[][]) => ([] as Ev[]).concat(...lists).sort((x, y) => y.block - x.block);
/** Seconds of life `wei` buys at `rate` wei per second (the registry's lifeWeiPerSecond): floor(wei / rate), 0 when there is no price yet. */
export const secondsFor = (wei: bigint, rate: bigint) => (rate > BigInt(0) ? Number(wei / rate) : 0);
/** What `seconds` of life costs in wei at `rate`: the registry's own lifeCost(seconds) = seconds × lifeWeiPerSecond. */
export const lifeCost = (seconds: number, rate: bigint) => BigInt(Math.max(0, Math.floor(seconds))) * rate;
/** "0.01 BNB per day" at `rate`, for the price lines. */
export const bnbPerDay = (rate: bigint) => fmtBnb(lifeCost(86400, rate));
export const ipfs = (uri: string) => (uri && uri.startsWith("ipfs://") ? CFG.ipfsGateway + uri.slice(7) : uri);
export const pad = (id: number) => String(id).padStart(3, "0");

export function bodyName(addr: string, names: Record<string, string> = {}) {
  if (!addr || addr === ZERO) return "";
  const a = addr.toLowerCase();
  if (a === CFG.bodies.arena.toLowerCase()) return "Arena";
  if (a === CFG.bodies.doom.toLowerCase()) return "DOOM";
  if (a === CFG.bodies.colony.toLowerCase()) return "Colony";
  return names[a] || short(addr);
}

/** The Colony (COLONY.md): the shared Minecraft world on the VPS, a whole-brain body like the arena. */
export function isColonyBody(addr: string) {
  return !!addr && addr !== ZERO && addr.toLowerCase() === CFG.bodies.colony.toLowerCase();
}

/** A body that is neither the arena, DOOM nor the Colony: a pebble (or any other registered body) that runs the fly's on-chain core itself and cannot run the whole brain; the brain host runs that for it, or it sleeps (see bodyNote). */
export function isCoreOnlyBody(addr: string) {
  if (!addr || addr === ZERO) return false;
  const a = addr.toLowerCase();
  return a !== CFG.bodies.arena.toLowerCase() && a !== CFG.bodies.doom.toLowerCase() && a !== CFG.bodies.colony.toLowerCase();
}

/** Where a fly's whole brain is, in one place, so every page says the same thing. A pebble body signs for the fly on
 *  the registry; the 139,248 neurons run on the brain host when the host answers `/fly/<id>/health` for that fly
 *  (`hostServes` true), and sleep in the last committed snapshot when it does not (false, or null while unknown). */
export function bodyNote(f: FlyRecord, hostServes: boolean | null, names: Record<string, string> = {}) {
  const name = bodyName(f.body, names);
  const out = (kind: "none" | "whole" | "host" | "core" | "colony", tag: string, note: string, title = "") => ({ kind, name, tag, label: tag ? `${name} ${tag}` : name, note, title });
  if (!f.alive || f.body === ZERO) return out("none", "", "");
  if (isColonyBody(f.body)) return out("colony", "(Minecraft)", "in the Colony (Minecraft): whole brain on the VPS, streamed live", "The Colony is a shared Minecraft world on the VPS: the fly's 139,248 neurons run there, sensing the world around its bot and driving it, and its life is streamed to the site");
  if (!isCoreOnlyBody(f.body)) return out("whole", "", `running in ${name}`);
  if (hostServes) return out("host", "· whole brain on the brain host", `running in ${name}, a pebble that signs for it while the brain host runs its whole brain`, "The pebble is the body on the registry and signs every commit; the brain host runs the 139,248 neurons for it and streams its life here");
  return out("core", "(core only: the whole brain sleeps)", `running in ${name}, core only: the whole brain sleeps`, "A pebble runs only the fly's on-chain compass core; the whole-brain snapshot is preserved until a whole-brain body, or the brain host, takes it up");
}

/** The brain host's origin for a page to probe: the development override, else the https origin the host registered as its body uri. */
export function hostOrigin(uri: string) {
  if (CFG.hostOverride) { try { return new URL(CFG.hostOverride).origin; } catch { return ""; } }
  return /^https:\/\//.test(uri || "") ? new URL(uri).origin : "";
}

/** The Colony's origin: the development override, else the fixed public origin (CFG.colonyUrl), else the https origin
 *  the Colony registered as its body uri. Empty only when none of the three is a URL. */
export function colonyOrigin(uri = "") {
  for (const u of [CFG.colonyOverride, CFG.colonyUrl]) { if (u) { try { return new URL(u).origin; } catch {} } }
  return /^https:\/\//.test(uri || "") ? new URL(uri).origin : "";
}

/** One word for where the organism is right now. */
export function status(f: FlyRecord, names: Record<string, string> = {}, hostServes: boolean | null = null) {
  if (!f.alive) return { key: "dead", label: "dead", note: "brain frozen at its last state; resurrect to continue it" };
  if (f.body !== ZERO) return { key: "alive", label: "alive", note: bodyNote(f, hostServes, names).note };
  if (f.pendingBody !== ZERO) return { key: "waiting", label: "assigned", note: `waiting for ${bodyName(f.pendingBody, names)} to accept it` };
  return { key: "dormant", label: "dormant", note: "alive but not running anywhere; its energy is frozen" };
}

/** What a record covers, for the head of a log: "in the last 60,000 blocks", or the truth when the public RPCs
 *  would not serve the older blocks, so a short list is never mistaken for a short history. */
export function scanLabel(scan: { from: number; to: number; complete: boolean; floor: number } | null, blocks: number) {
  if (!scan) return `in the last ${fmt(blocks)} blocks`;
  if (!scan.complete) return `since block ${fmt(scan.from)} · the public RPCs would not serve older blocks`;
  if (scan.floor && scan.from <= scan.floor) return "over its whole history";
  return `in the last ${fmt(blocks)} blocks`;
}

export const decodeKind = (k: string) => { try { return ethers.toUtf8String(k).replace(/\0+$/, ""); } catch { return String(k).slice(0, 10); } };
