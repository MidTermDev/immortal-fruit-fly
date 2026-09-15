"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chain } from "@/lib/chain";
import { ArcadeReader, EMPTY_ARCADE } from "@/lib/arcade";
import type { ArcadeCursor, ArcadeState } from "@/lib/arcade";

export interface ArcadeControls extends ArcadeState {
  refresh: () => void;
  selectSession: (id: bigint | null) => void;
  loadOlder: () => void; showLatest: () => void; canLoadOlder: boolean; loadingOlder: boolean;
}

/** Read-only observer. No wallet connection, approvals or transactions are requested. */
export function useArcade(): ArcadeControls {
  const [state, setState] = useState<ArcadeState>(EMPTY_ARCADE);
  const selected = useRef<bigint | null>(null);
  const page = useRef<ArcadeCursor | null>(null);
  const stateRef = useRef<ArcadeState>(EMPTY_ARCADE);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const reader = new ArcadeReader(new Chain());
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const requested = selected.current, revision = epoch.current, cursor = page.current;
      const next = await reader.read(requested, cursor);
      if (active && selected.current === requested && epoch.current === revision) { stateRef.current = next; setState(next); setLoadingOlder(false); }
    };
    const poll = async () => { await read(); if (active) timer = setTimeout(poll, 15_000); };
    refreshRef.current = read;
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = null; reader.dispose(); };
  }, []);

  const refresh = useCallback(() => { void refreshRef.current?.(); }, []);
  const selectSession = useCallback((id: bigint | null) => {
    if (id !== null && (id < BigInt(0) || id === selected.current)) return;
    selected.current = id; page.current = null; epoch.current++; setLoadingOlder(false);
    const previous = stateRef.current;
    const next: ArcadeState = { ...previous, selectedSessionId: id, selectedSession: previous.sessions.find((session) => session.id === id) ?? null, decisions: [], status: "loading", decisionStatus: "loading", error: null, fromBlock: null, toBlock: null, hasOlderDecisions: false, truncated: false, olderCursor: null, isLatest: true };
    stateRef.current = next; setState(next);
    void refreshRef.current?.();
  }, []);
  const loadOlder = useCallback(() => {
    const current = stateRef.current;
    if (!current.olderCursor || current.decisionStatus === "loading") return;
    selected.current = current.selectedSessionId;
    page.current = current.olderCursor; epoch.current++; setLoadingOlder(true);
    const next: ArcadeState = { ...current, status: "loading", decisionStatus: "loading", error: null };
    stateRef.current = next; setState(next); void refreshRef.current?.();
  }, []);
  const showLatest = useCallback(() => {
    page.current = null; epoch.current++; setLoadingOlder(false);
    const next: ArcadeState = { ...stateRef.current, status: "loading", decisionStatus: "loading", error: null };
    stateRef.current = next; setState(next); void refreshRef.current?.();
  }, []);
  return { ...state, refresh, selectSession, loadOlder, showLatest, canLoadOlder: state.olderCursor !== null, loadingOlder };
}
