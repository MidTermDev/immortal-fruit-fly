import type { Result } from "ethers";
import type { FlyConnection, FlyTransaction, FlyWallet } from "./fly-types";

export type WorldLiveStatus = "connecting" | "live" | "stale" | "offline";
export interface WorldPoint { x: number; y: number }
export interface WorldFood extends WorldPoint { id: number | string; energy: number; energy0: number; by: string | null }

/** Values received from brain/server.py. These are server observations, not chain receipts. */
export interface WorldFrame extends WorldPoint {
  t_ms: number; step: number; heading: number; energy: number; alive: boolean; generation: number;
  life_ms: number; spikes_total: number; ate: number; jumps: number; hits: number;
  food: WorldFood[]; predator: (WorldPoint & { size: number }) | null;
  lamp: [number, number]; arena: number; path: [number, number][];
  rates: Record<string, number>; base: Record<string, number>; steer: number; mode: string;
  orn: [number, number]; events: [number, string][]; wall: number; realtime: number; nrender?: number;
}

export interface WorldInfo {
  alive: boolean; generation: number; lastAgeMs: number; lastEnergy: number;
  totalBurned: bigint; foodCount: number; tps: bigint; minFood: bigint; resPrice: bigint;
  /** Contract ARENA is the half-width. The live frame arena is the full width. */
  arena: number;
  block?: number; lastHash?: string; lastStep?: number;
}

export interface WorldChainEvent { name: string; args: Result; block: number; tx: string }
export interface WorldObservation {
  id: string; receivedAt: number; t_ms: number; step: number; generation: number;
  mode: string; alive: boolean; steer: number; orn: [number, number];
  rates: Record<string, number>; events: [number, string][];
}

export interface WorldControls {
  frame: WorldFrame | null; spikes: Uint16Array | null; live: WorldLiveStatus;
  origin: string | null; lastFrameAt: number | null; streamError: string | null;
  info: WorldInfo | null; chainStatus: FlyConnection; events: WorldChainEvent[];
  historyStatus: "loading" | "ready" | "unavailable"; history: WorldObservation[];
  wallet: FlyWallet; transaction: FlyTransaction; busy: boolean;
  connect: () => Promise<void>; disconnect: () => void; refresh: () => Promise<void>;
  placeFood: (x: number, y: number, rawAmount: string) => Promise<void>;
  resurrect: (rawExtra: string) => Promise<void>; clearTransaction: () => void;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every((n) => finite(n, -1e6, 1e6));

/** Only the endpoint origin is used. Credentials and non-web protocols are rejected. */
export function worldOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function rates(value: unknown): Record<string, number> | null {
  if (!object(value) || Object.keys(value).length > 128) return null;
  const entries = Object.entries(value);
  if (entries.some(([key, n]) => key.length > 64 || !finite(n, 0, 1e9))) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Reject malformed frames before they reach the canvas, metrics or observation log. */
export function normalizeWorldMessage(value: unknown): { frame: WorldFrame; spikes: Uint16Array } | null {
  try {
    if (typeof value === "string") {
      if (value.length > 2_000_000) return null;
      value = JSON.parse(value);
    }
    if (!object(value) || !object(value.hdr)) return null;
    const h = value.hdr;
    const counters = ["t_ms", "step", "energy", "generation", "life_ms", "spikes_total", "ate", "jumps", "hits", "wall", "realtime"];
    if (counters.some((key) => !finite(h[key], 0)) || !finite(h.x, -1e6, 1e6) || !finite(h.y, -1e6, 1e6) || !finite(h.heading, -1e9, 1e9) || !finite(h.steer, -1e9, 1e9)) return null;
    if (typeof h.alive !== "boolean" || typeof h.mode !== "string" || h.mode.length > 40 || !finite(h.arena, 1, 1e6) || !pair(h.orn) || h.orn.some((n) => n < 0) || !pair(h.lamp)) return null;
    const observedRates = rates(h.rates), baseline = rates(h.base);
    if (!observedRates || !baseline || !Array.isArray(h.food) || h.food.length > 2000 || !Array.isArray(h.events) || h.events.length > 100) return null;
    const food: WorldFood[] = [];
    for (const item of h.food) {
      if (!object(item) || !(typeof item.id === "string" && item.id.length <= 80 || finite(item.id, 0)) || !finite(item.x, -1e6, 1e6) || !finite(item.y, -1e6, 1e6) || !finite(item.energy, 0) || !finite(item.energy0, 0) || !(item.by === null || typeof item.by === "string" && item.by.length <= 80)) return null;
      food.push({ id: item.id, x: item.x, y: item.y, energy: item.energy, energy0: item.energy0, by: item.by });
    }
    let predator: WorldFrame["predator"] = null;
    if (h.predator !== null && h.predator !== undefined) {
      if (!object(h.predator) || !finite(h.predator.x, -1e6, 1e6) || !finite(h.predator.y, -1e6, 1e6) || !finite(h.predator.size, 0, 1e6)) return null;
      predator = { x: h.predator.x, y: h.predator.y, size: h.predator.size };
    }
    const events: [number, string][] = [];
    for (const event of h.events) {
      if (!Array.isArray(event) || event.length !== 2 || !finite(event[0], 0) || typeof event[1] !== "string" || event[1].length > 500) return null;
      events.push([event[0], event[1]]);
    }
    const path: [number, number][] = [];
    if (h.path !== undefined) {
      if (!Array.isArray(h.path) || h.path.length > 3000 || !h.path.every(pair)) return null;
      path.push(...h.path);
    }
    if (h.nrender !== undefined && (!finite(h.nrender, 0, 65536) || !Number.isInteger(h.nrender))) return null;
    if (typeof value.spikes !== "string" || value.spikes.length > 180000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.spikes)) return null;
    const binary = atob(value.spikes);
    if (binary.length % 2) return null;
    const spikes = new Uint16Array(binary.length / 2);
    for (let i = 0; i < spikes.length; i++) {
      spikes[i] = binary.charCodeAt(i * 2) | binary.charCodeAt(i * 2 + 1) << 8;
      if (typeof h.nrender === "number" && spikes[i] >= h.nrender) return null;
    }
    return { frame: { ...h, food, predator, path, rates: observedRates, base: baseline, events } as unknown as WorldFrame, spikes };
  } catch { return null; }
}
