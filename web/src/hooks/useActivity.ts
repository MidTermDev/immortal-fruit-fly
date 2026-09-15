"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chain } from "@/lib/chain";
import type { ChainEvent, EventSource } from "@/lib/chain";

export interface ActivityEvent extends Required<ChainEvent> {
  /** Unix seconds. Null means the event is known but its block time is not. */
  timestamp: number | null;
}

export type ActivityStatus = "loading" | "ready" | "partial" | "unavailable";
export interface ActivityState {
  /** Contract order: oldest first, then log index within each block. */
  events: ActivityEvent[];
  status: ActivityStatus;
  fromBlock: number | null;
  toBlock: number | null;
  latestCheckpointURI: string | null;
}

const EMPTY: ActivityState = { events: [], status: "loading", fromBlock: null, toBlock: null, latestCheckpointURI: null };
const SOURCES: EventSource[] = ["core", "world", "arcade"];
const WINDOW_BLOCKS = 2000;
const MAX_EVENTS = 2000;
const TIMESTAMPS_PER_READ = 24;
const REORG_OVERLAP = 12;

/** Bounded, incremental reader; kept independent of React for contract tests. */
export class ActivityReader {
  private records = new Map<string, Required<ChainEvent>>();
  private cursors: Record<EventSource, number | null> = { core: null, world: null, arcade: null };
  private times = new Map<number, number>();
  private pending: Promise<ActivityState> | null = null;
  private stopped = false;
  private state: ActivityState = EMPTY;
  private truncatedThroughBlock = -1;

  constructor(private readonly chain: Chain) {}

  read(): Promise<ActivityState> {
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }

  dispose() { this.stopped = true; this.chain.dispose(); }

  private async update(): Promise<ActivityState> {
    try {
      await this.chain.connectRead();
      const provider = this.chain.provider;
      if (!provider || this.stopped) return this.state;
      const latest = await provider.getBlockNumber();
      if (this.state.toBlock !== null && latest < this.state.toBlock) throw new Error("RPC is behind the last activity block.");
      const start = Math.max(0, latest - WINDOW_BLOCKS + 1);
      const ranges = SOURCES.map((source) => {
        const cursor = this.cursors[source];
        return { source, from: cursor === null ? start : Math.max(start, cursor - REORG_OVERLAP + 1) };
      });
      const reads = await Promise.allSettled(ranges.map(({ source, from }) => this.chain.readEvents(source, from, latest)));
      if (this.stopped) return this.state;

      let successes = 0;
      reads.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        successes++;
        const range = ranges[index];
        // Replace the overlap to remove orphaned logs after a short reorg.
        for (const [id, event] of this.records) if (event.source === range.source && event.block >= range.from) this.records.delete(id);
        for (const event of result.value) this.records.set(event.id, event);
        this.cursors[range.source] = latest;
      });
      if (successes === 0) throw new Error("Activity is unavailable from this RPC.");

      for (const [id, event] of this.records) if (event.block < start) this.records.delete(id);
      for (const block of this.times.keys()) if (block < start) this.times.delete(block);
      const ordered = [...this.records.values()].sort((a, b) => a.block - b.block || a.index - b.index);
      const truncated = ordered.length > MAX_EVENTS;
      const bounded = ordered.slice(-MAX_EVENTS);
      if (truncated) {
        this.truncatedThroughBlock = Math.max(this.truncatedThroughBlock, ordered[ordered.length - MAX_EVENTS - 1].block);
        this.records = new Map(bounded.map((event) => [event.id, event]));
      }

      const missingBlocks = [...new Set(bounded.slice().reverse().map((event) => event.block))].filter((block) => !this.times.has(block)).slice(0, TIMESTAMPS_PER_READ);
      const times = await Promise.allSettled(missingBlocks.map((block) => provider.getBlock(block)));
      if (this.stopped) return this.state;
      times.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value) this.times.set(missingBlocks[index], result.value.timestamp);
      });
      const events = bounded.map((event) => ({ ...event, timestamp: this.times.get(event.block) ?? null }));
      const checkpoint = events.slice().reverse().find((event) => event.source === "world" && (event.name === "Checkpoint" || event.name === "Died") && typeof event.args.snapshotURI === "string");
      let latestCheckpointURI = this.state.latestCheckpointURI;
      if (checkpoint) {
        try {
          const uri = new URL(checkpoint.args.snapshotURI);
          if (uri.protocol === "https:" || uri.protocol === "http:") latestCheckpointURI = uri.href;
        } catch { /* Invalid checkpoint metadata is not a usable stream origin. */ }
      }
      this.state = {
        events,
        status: successes !== SOURCES.length || start <= this.truncatedThroughBlock || events.some((event) => event.timestamp === null) ? "partial" : "ready",
        fromBlock: start,
        toBlock: latest,
        latestCheckpointURI,
      };
      if (successes !== SOURCES.length) this.chain.invalidateRead();
      return this.state;
    } catch {
      if (!this.stopped) {
        this.chain.invalidateRead();
        this.state = { ...this.state, status: this.state.events.length ? "partial" : "unavailable" };
      }
      return this.state;
    }
  }
}

export function useActivity(): ActivityState & { refresh: () => void } {
  const [state, setState] = useState<ActivityState>(EMPTY);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const reader = new ActivityReader(new Chain());
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const next = await reader.read();
      if (active) setState(next);
    };
    const poll = async () => {
      await read();
      if (active) timer = setTimeout(poll, 15_000);
    };
    refreshRef.current = read;
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = null;
      reader.dispose();
    };
  }, []);

  const refresh = useCallback(() => { void refreshRef.current?.(); }, []);
  return { ...state, refresh };
}
