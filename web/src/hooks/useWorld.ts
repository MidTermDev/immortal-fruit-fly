"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { actionError, Chain, injectedWallet } from "@/lib/chain";
import { CFG } from "@/lib/config";
import type { FlyConnection, FlyTransaction, FlyWallet, TransactionProgress } from "@/lib/fly-types";
import { normalizeWorldMessage, worldOrigin } from "@/lib/world-types";
import type { WorldChainEvent, WorldControls, WorldFrame, WorldInfo, WorldLiveStatus, WorldObservation } from "@/lib/world-types";

const EMPTY_WALLET: FlyWallet = { address: null, balance: null, connecting: false, wrongNetwork: false };
const IDLE: FlyTransaction = { phase: "idle", label: "", message: "" };
const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
// Client-only observations survive navigation, but are never represented as complete history.
let sessionObservations: WorldObservation[] = [];

export function worldFoodAmount(raw: string, info: WorldInfo, minimum = info.minFood): bigint {
  if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(raw.trim())) throw new Error("Enter a valid FLY amount.");
  const amount = parseEther(raw.trim());
  if (info.tps <= BigInt(0)) throw new Error("Food pricing is unavailable. Try again.");
  if (amount < minimum) throw new Error(`Enter at least ${formatEther(minimum)} FLY.`);
  if (amount / info.tps > UINT64_MAX) throw new Error("This amount is too large.");
  return amount;
}

export function useWorld(): WorldControls {
  const [frame, setFrame] = useState<WorldFrame | null>(null);
  const [spikes, setSpikes] = useState<Uint16Array | null>(null);
  const [live, setLive] = useState<WorldLiveStatus>("connecting");
  const [origin, setOrigin] = useState<string | null>(() => worldOrigin(CFG.liveFallback));
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [chainStatus, setChainStatus] = useState<FlyConnection>("loading");
  const [events, setEvents] = useState<WorldChainEvent[]>([]);
  const [historyStatus, setHistoryStatus] = useState<WorldControls["historyStatus"]>("loading");
  const [history, setHistory] = useState<WorldObservation[]>([]);
  const [wallet, setWallet] = useState<FlyWallet>(EMPTY_WALLET);
  const [transaction, setTransaction] = useState<FlyTransaction>(IDLE);
  const [busy, setBusy] = useState(false);
  const chainRef = useRef<Chain | null>(null);
  const infoRef = useRef<WorldInfo | null>(null);
  const walletRef = useRef(EMPTY_WALLET);
  const frameRef = useRef<WorldFrame | null>(null);
  const reading = useRef<{ chain: Chain; promise: Promise<WorldInfo> } | null>(null);
  const refreshLock = useRef<Chain | null>(null);
  const actionLock = useRef(false);
  const connectLock = useRef(false);
  const disconnected = useRef(false);
  const walletEpoch = useRef(0);

  const updateWallet = useCallback((next: FlyWallet) => { walletRef.current = next; setWallet(next); }, []);

  const updateBalance = useCallback(async (chain: Chain) => {
    const address = walletRef.current.address, epoch = walletEpoch.current;
    if (!address || !chain.provider) return;
    try {
      const balance: bigint = await chain.token.balanceOf(address);
      if (chainRef.current === chain && epoch === walletEpoch.current) updateWallet({ ...walletRef.current, balance });
    } catch {
      if (chainRef.current === chain && epoch === walletEpoch.current) updateWallet({ ...walletRef.current, balance: null });
    }
  }, [updateWallet]);

  const readFresh = useCallback((chain: Chain): Promise<WorldInfo> => {
    if (reading.current?.chain === chain) return reading.current.promise;
    const promise = (async () => {
      try {
        await chain.connectRead();
        const next: WorldInfo = await chain.worldInfo();
        if (chainRef.current === chain) {
          if (infoRef.current?.block && next.block && next.block < infoRef.current.block) throw new Error("Waiting for the connection to catch up.");
          infoRef.current = next; setInfo(next); setChainStatus("live");
        }
        return next;
      } catch (error) {
        if (chainRef.current === chain) { setChainStatus(infoRef.current ? "stale" : "offline"); chain.invalidateRead(); }
        throw error;
      } finally { if (reading.current?.chain === chain) reading.current = null; }
    })();
    reading.current = { chain, promise };
    return promise;
  }, []);

  const refresh = useCallback(async () => {
    const chain = chainRef.current;
    if (!chain || refreshLock.current === chain) return;
    refreshLock.current = chain;
    try {
      await readFresh(chain);
      if (chainRef.current !== chain) return;
      await updateBalance(chain);
      try {
        const next = await chain.worldEvents(2000);
        if (chainRef.current !== chain) return;
        setEvents(next.slice(0, 60)); setHistoryStatus("ready");
        if (!worldOrigin(CFG.liveFallback)) {
          const announcement = next.find((event) => (event.name === "Checkpoint" || event.name === "Died") && worldOrigin(event.args.snapshotURI));
          const discovered = announcement ? worldOrigin(announcement.args.snapshotURI) : null;
          if (discovered) setOrigin(discovered);
        }
      } catch { if (chainRef.current === chain) setHistoryStatus("unavailable"); }
    } catch { if (chainRef.current === chain) setHistoryStatus("unavailable"); }
    finally { if (refreshLock.current === chain) refreshLock.current = null; }
  }, [readFresh, updateBalance]);

  const syncWallet = useCallback(async (chain: Chain) => {
    const epoch = ++walletEpoch.current;
    try {
      const next = await chain.syncWallet();
      if (chainRef.current !== chain || epoch !== walletEpoch.current || disconnected.current) return;
      updateWallet({ ...next, balance: null, connecting: connectLock.current });
      await updateBalance(chain);
    } catch { if (chainRef.current === chain && epoch === walletEpoch.current) updateWallet(EMPTY_WALLET); }
  }, [updateBalance, updateWallet]);

  useEffect(() => {
    const chain = new Chain(); chainRef.current = chain;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (active) timer = setTimeout(poll, 15_000); };
    void poll();
    if (!disconnected.current) void syncWallet(chain);
    const provider = injectedWallet();
    const changed = () => { if (!disconnected.current) void syncWallet(chain); };
    const lost = () => { walletEpoch.current++; chain.disconnectWallet(); updateWallet(EMPTY_WALLET); };
    provider?.on?.("accountsChanged", changed); provider?.on?.("chainChanged", changed); provider?.on?.("disconnect", lost);
    return () => {
      active = false; clearTimeout(timer);
      provider?.removeListener?.("accountsChanged", changed); provider?.removeListener?.("chainChanged", changed); provider?.removeListener?.("disconnect", lost);
      if (chainRef.current === chain) chainRef.current = null;
      chain.dispose();
    };
  }, [refresh, syncWallet, updateWallet]);

  useEffect(() => {
    let active = true, socket: WebSocket | null = null, retryCount = 0;
    let retry: ReturnType<typeof setTimeout>, flushTimer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout>;
    let pending: ReturnType<typeof normalizeWorldMessage> = null, receivedAt = 0;
    frameRef.current = null;
    const initialize = setTimeout(() => {
      setFrame(null); setSpikes(null); setHistory(sessionObservations);
      if (!origin) {
        setLive("offline"); setStreamError("No live stream has been announced in the available checkpoints.");
        return;
      }
      if (window.location.protocol === "https:" && new URL(origin).protocol === "http:") {
        setLive("offline"); setStreamError("The announced stream needs a secure connection.");
        return;
      }
      connectStream();
    }, 0);

    const publish = () => {
      flushTimer = undefined;
      if (!active || !pending) return;
      const next = pending.frame;
      frameRef.current = next; setFrame(next); setSpikes(next.alive ? pending.spikes : new Uint16Array()); setLastFrameAt(receivedAt);
      const previous = sessionObservations[sessionObservations.length - 1];
      const latestEvent = next.events[next.events.length - 1], priorEvent = previous?.events[previous.events.length - 1];
      if (previous?.id !== `${next.generation}:${next.step}:${next.wall}` && (!previous || previous.generation !== next.generation || previous.mode !== next.mode || previous.alive !== next.alive || receivedAt - previous.receivedAt >= 1000 || JSON.stringify(latestEvent) !== JSON.stringify(priorEvent))) {
        const observation: WorldObservation = { id: `${next.generation}:${next.step}:${next.wall}`, receivedAt, t_ms: next.t_ms, step: next.step, generation: next.generation, mode: next.mode, alive: next.alive, steer: next.steer, orn: next.orn, rates: next.rates, events: next.events };
        sessionObservations = [...sessionObservations, observation].slice(-100);
        setHistory(sessionObservations);
      }
      pending = null;
    };

    function connectStream() {
      if (!active || !origin) return;
      setLive(frameRef.current ? "stale" : "connecting");
      const url = new URL("/ws", origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      try { socket = new WebSocket(url.href); } catch {
        setLive(frameRef.current ? "stale" : "offline");
        retry = setTimeout(connectStream, 5000); return;
      }
      const current = socket;
      watchdog = setTimeout(() => current.close(), 10_000);
      current.onmessage = (message) => {
        if (!active || socket !== current) return;
        const decoded = normalizeWorldMessage(message.data);
        if (!decoded) { setStreamError("The stream sent an unreadable frame. Reconnecting…"); current.close(); return; }
        const previous = frameRef.current;
        if (previous && (decoded.frame.generation < previous.generation || decoded.frame.generation === previous.generation && decoded.frame.step < previous.step)) return;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { if (active) { setLive("stale"); setStreamError("Waiting for a fresh frame."); current.close(); } }, 10_000);
        retryCount = 0; receivedAt = Date.now(); pending = decoded;
        setLive("live"); setStreamError(null);
        if (flushTimer === undefined) flushTimer = setTimeout(publish, 200);
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        clearTimeout(watchdog);
        if (!active || socket !== current) return;
        setLive(frameRef.current ? "stale" : "offline");
        setStreamError((message) => message || "The live stream is unavailable. Retrying automatically.");
        retry = setTimeout(connectStream, Math.min(30_000, 3000 * 2 ** Math.min(retryCount++, 4)));
      };
    }
    return () => {
      active = false; clearTimeout(initialize); clearTimeout(retry); clearTimeout(flushTimer); clearTimeout(watchdog);
      if (socket) { socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.close(); }
    };
  }, [origin]);

  const connect = useCallback(async () => {
    const chain = chainRef.current;
    if (!chain || actionLock.current || connectLock.current) return;
    connectLock.current = true; disconnected.current = false; updateWallet({ ...walletRef.current, connecting: true });
    try {
      await chain.connectWallet();
      if (chainRef.current !== chain) return;
      await syncWallet(chain); await refresh(); setTransaction(IDLE);
    } catch (error) {
      if (chainRef.current === chain) { await syncWallet(chain); setTransaction({ phase: "error", label: "Wallet", message: actionError(error) }); }
    } finally { connectLock.current = false; if (chainRef.current === chain) updateWallet({ ...walletRef.current, connecting: false }); }
  }, [refresh, syncWallet, updateWallet]);

  const disconnect = useCallback(() => {
    disconnected.current = true; walletEpoch.current++; chainRef.current?.disconnectWallet(); updateWallet(EMPTY_WALLET);
  }, [updateWallet]);

  const run = useCallback(async (label: string, action: (chain: Chain, current: WorldInfo, validate: () => Promise<WorldInfo>, progress: TransactionProgress) => Promise<unknown>) => {
    const chain = chainRef.current;
    if (!chain || actionLock.current || connectLock.current) return;
    actionLock.current = true; setBusy(true); setTransaction({ phase: "wallet", label, message: "Checking your wallet…" });
    const progress: TransactionProgress = (phase, hash) => {
      if (chainRef.current !== chain) return;
      const messages: Record<string, string> = { approval: "Approve this FLY amount in your wallet.", approving: "Waiting for the FLY approval…", wallet: "Confirm the action in your wallet.", pending: "Waiting for confirmation…", confirmed: "Confirmed on-chain. The live server will read the event." };
      setTransaction({ phase, label, message: messages[phase] || "", hash });
    };
    try {
      const address = walletRef.current.address;
      if (!address || disconnected.current) throw new Error("Connect your wallet to continue.");
      const validate = async () => {
        if (chainRef.current !== chain || disconnected.current) throw new Error("Wallet disconnected. Connect again.");
        await chain.validateWallet(address);
        if (reading.current?.chain === chain) await reading.current.promise.catch(() => undefined);
        const current = await readFresh(chain), balance: bigint = await chain.token.balanceOf(address);
        if (chainRef.current !== chain || disconnected.current || walletRef.current.address?.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet account changed. Try again.");
        updateWallet({ address, balance, wrongNetwork: false, connecting: false });
        return current;
      };
      await action(chain, await validate(), validate, progress);
      void refresh();
    } catch (error) { if (chainRef.current === chain) setTransaction({ phase: "error", label, message: actionError(error) }); }
    finally { actionLock.current = false; if (chainRef.current === chain) setBusy(false); }
  }, [readFresh, refresh, updateWallet]);

  const afford = useCallback((amount: bigint) => {
    if (walletRef.current.balance === null) throw new Error("Your FLY balance is unavailable. Try again.");
    if (walletRef.current.balance < amount) throw new Error("You do not have enough FLY for this amount.");
  }, []);

  const placeFood = useCallback((x: number, y: number, rawAmount: string) => run("Place food", async (chain, current, validate, progress) => {
    const amount = worldFoodAmount(rawAmount, current);
    const check = (state: WorldInfo) => {
      if (!state.alive) throw new Error("The fly has died. Revive it before placing food.");
      if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > state.arena || Math.abs(y) > state.arena) throw new Error("Choose a position inside the arena.");
      worldFoodAmount(rawAmount, state); afford(amount);
    };
    check(current);
    return chain.placeFood(x, y, amount, progress, async () => check(await validate()));
  }), [afford, run]);

  const resurrect = useCallback((rawExtra: string) => run("Revive", async (chain, current, validate, progress) => {
    const extra = worldFoodAmount(rawExtra, current, current.tps);
    const check = (state: WorldInfo) => {
      if (state.alive) throw new Error("The fly is already alive.");
      afford(state.resPrice + extra);
    };
    check(current);
    return chain.resurrectWorld(extra, current.resPrice, progress, async () => check(await validate()));
  }), [afford, run]);

  const clearTransaction = useCallback(() => { if (!actionLock.current) setTransaction(IDLE); }, []);
  return { frame, spikes, live, origin, lastFrameAt, streamError, info, chainStatus, events, historyStatus, history, wallet, transaction, busy, connect, disconnect, refresh, placeFood, resurrect, clearTransaction };
}
