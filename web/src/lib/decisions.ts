import type { ActivityEvent } from "@/hooks/useActivity";

export function heading(x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x === 0 && y === 0 ? null : (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Round the contract's signed 1/256-cell coordinate without losing int64 bits. */
export function position(raw: bigint): string {
  const magnitude = raw < BigInt(0) ? -raw : raw;
  const hundredths = (magnitude * BigInt(100) + BigInt(128)) / BigInt(256);
  const sign = raw < BigInt(0) && hundredths !== BigInt(0) ? "-" : "";
  return `${sign}${hundredths / BigInt(100)}.${String(hundredths % BigInt(100)).padStart(2, "0")}`;
}

export interface Execution {
  event: ActivityEvent;
  /** New core input events since this transaction's preceding Ticked event. */
  inputs: ActivityEvent[];
  from: bigint;
  to: bigint;
  steps: number;
  spikes: number;
  x: string;
  y: string;
  direction: number | null;
  energy: bigint;
}

export function executions(events: ActivityEvent[]) {
  const ordered = events.filter((event) => event.source === "core").slice().sort((a, b) => a.block - b.block || a.index - b.index);
  const pending = new Map<string, ActivityEvent[]>();
  const seen = new Set<string>();
  const result: Execution[] = [];
  for (const event of ordered) {
    const transaction = `${event.block}:${event.tx.toLowerCase()}`;
    const identity = `${transaction}:${event.index}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (["Stimulated", "Fed", "Resurrected"].includes(event.name)) {
      pending.set(transaction, [...(pending.get(transaction) ?? []), event]);
      continue;
    }
    if (event.name !== "Ticked") continue;
    const from = BigInt(event.args.fromStep);
    result.push({
      event,
      inputs: pending.get(transaction) ?? [],
      from,
      to: from + BigInt(event.args.steps),
      // steps and spikes are uint16/uint32; Number preserves their full range.
      steps: Number(event.args.steps),
      spikes: Number(event.args.spikes),
      x: position(BigInt(event.args.posX)),
      y: position(BigInt(event.args.posY)),
      direction: heading(Number(event.args.headX), Number(event.args.headY)),
      energy: BigInt(event.args.energyLeft),
    });
    pending.delete(transaction);
  }
  return result.reverse();
}

export const count = (value: number | bigint) => value.toLocaleString("en-US");
export const txLabel = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;
export const timeLabel = (timestamp: number | null) => timestamp === null ? "Time unavailable" : new Date(timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function inputLabel(event: ActivityEvent) {
  if (event.name === "Stimulated") return ["Input", "Landmark", "Left input", "Right input", "Shock"][Number(event.args.channel)] ?? "Stimulus";
  if (event.name === "Fed") return "Energy added";
  if (event.name === "Resurrected") return "Revival";
  return event.name;
}
