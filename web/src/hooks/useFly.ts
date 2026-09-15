"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { actionError, Chain, injectedWallet } from "@/lib/chain";
import type { FlyConnection, FlyControls, FlyPrices, FlySnapshot, FlyTransaction, FlyWallet, TransactionProgress } from "@/lib/fly-types";

const EMPTY_WALLET: FlyWallet = { address: null, balance: null, connecting: false, wrongNetwork: false };
const IDLE: FlyTransaction = { phase: "idle", label: "", message: "" };
const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

function foodAmount(raw: string, prices: FlyPrices): bigint {
  if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(raw.trim())) throw new Error("Enter a valid FLY amount.");
  const amount = parseEther(raw.trim());
  if (amount < prices.tokensPerStep) throw new Error(`Enter at least ${formatEther(prices.tokensPerStep)} FLY.`);
  if (amount / prices.tokensPerStep > UINT64_MAX) throw new Error("This amount is too large.");
  return amount;
}

export function useFly(): FlyControls {
  const [snapshot, setSnapshot] = useState<FlySnapshot | null>(null);
  const [connection, setConnection] = useState<FlyConnection>("loading");
  const [prices, setPrices] = useState<FlyPrices | null>(null);
  const [wallet, setWallet] = useState<FlyWallet>(EMPTY_WALLET);
  const [transaction, setTransaction] = useState<FlyTransaction>(IDLE);
  const [busy, setBusy] = useState(false);
  const chainRef = useRef<Chain | null>(null);
  const snapshotRef = useRef<FlySnapshot | null>(null);
  const walletRef = useRef<FlyWallet>(EMPTY_WALLET);
  const walletEpoch = useRef(0);
  const disconnected = useRef(false);
  const actionLock = useRef(false);
  const connectLock = useRef(false);
  const reading = useRef<{ chain: Chain; promise: Promise<FlySnapshot> } | null>(null);

  const updateWallet = useCallback((next: FlyWallet) => {
    walletRef.current = next;
    setWallet(next);
  }, []);

  const updateBalance = useCallback(async (chain: Chain) => {
    const address = walletRef.current.address;
    const epoch = walletEpoch.current;
    if (!address || !chain.provider) return;
    try {
      const balance: bigint = await chain.token.balanceOf(address);
      if (chainRef.current === chain && epoch === walletEpoch.current && walletRef.current.address === address) {
        updateWallet({ ...walletRef.current, balance });
      }
    } catch {
      if (chainRef.current === chain && epoch === walletEpoch.current) updateWallet({ ...walletRef.current, balance: null });
    }
  }, [updateWallet]);

  const readFresh = useCallback((chain: Chain): Promise<FlySnapshot> => {
    if (reading.current?.chain === chain) return reading.current.promise;
    const promise = (async () => {
      try {
        await chain.connectRead();
        const next = await chain.readState();
        if (chainRef.current === chain) {
          if (snapshotRef.current && next.block < snapshotRef.current.block) throw new Error("Waiting for the connection to catch up.");
          snapshotRef.current = next;
          setSnapshot(next);
          setPrices(chain.prices);
          setConnection("live");
        }
        return next;
      } catch (error) {
        if (chainRef.current === chain) {
          setConnection(snapshotRef.current ? "stale" : "offline");
          chain.invalidateRead();
        }
        throw error;
      } finally {
        if (reading.current?.chain === chain) reading.current = null;
      }
    })();
    reading.current = { chain, promise };
    return promise;
  }, []);

  const refresh = useCallback(async () => {
    const chain = chainRef.current;
    if (!chain) return;
    try {
      await readFresh(chain);
      await updateBalance(chain);
    } catch {
      // The last confirmed snapshot stays visible; the next poll retries.
    }
  }, [readFresh, updateBalance]);

  const syncWallet = useCallback(async (chain: Chain) => {
    const epoch = ++walletEpoch.current;
    try {
      const current = await chain.syncWallet();
      if (chainRef.current !== chain || epoch !== walletEpoch.current || disconnected.current) return;
      updateWallet({ ...current, balance: null, connecting: connectLock.current });
      await updateBalance(chain);
    } catch {
      if (chainRef.current === chain && epoch === walletEpoch.current) updateWallet(EMPTY_WALLET);
    }
  }, [updateBalance, updateWallet]);

  useEffect(() => {
    const chain = new Chain();
    chainRef.current = chain;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, 10_000);
    };
    void poll();
    if (!disconnected.current) void syncWallet(chain);

    const provider = injectedWallet();
    const changed = () => { if (!disconnected.current) void syncWallet(chain); };
    const lost = () => {
      walletEpoch.current++;
      chain.disconnectWallet();
      updateWallet(EMPTY_WALLET);
    };
    provider?.on?.("accountsChanged", changed);
    provider?.on?.("chainChanged", changed);
    provider?.on?.("disconnect", lost);
    return () => {
      active = false;
      clearTimeout(timer);
      provider?.removeListener?.("accountsChanged", changed);
      provider?.removeListener?.("chainChanged", changed);
      provider?.removeListener?.("disconnect", lost);
      if (chainRef.current === chain) chainRef.current = null;
      chain.dispose();
    };
  }, [refresh, syncWallet, updateWallet]);

  const connect = useCallback(async () => {
    const chain = chainRef.current;
    if (!chain || actionLock.current || connectLock.current) return;
    connectLock.current = true;
    disconnected.current = false;
    updateWallet({ ...walletRef.current, connecting: true });
    try {
      await chain.connectWallet();
      if (chainRef.current !== chain) return;
      await syncWallet(chain);
      await refresh();
      setTransaction(IDLE);
    } catch (error) {
      if (chainRef.current !== chain) return;
      await syncWallet(chain);
      setTransaction({ phase: "error", label: "Wallet", message: actionError(error) });
    } finally {
      connectLock.current = false;
      if (chainRef.current === chain) updateWallet({ ...walletRef.current, connecting: false });
    }
  }, [refresh, syncWallet, updateWallet]);

  const disconnect = useCallback(() => {
    disconnected.current = true;
    walletEpoch.current++;
    chainRef.current?.disconnectWallet();
    updateWallet(EMPTY_WALLET);
  }, [updateWallet]);

  const run = useCallback(async (
    label: string,
    action: (chain: Chain, current: FlySnapshot, validate: () => Promise<FlySnapshot>, progress: TransactionProgress) => Promise<unknown>,
  ) => {
    const chain = chainRef.current;
    if (!chain || actionLock.current || connectLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setTransaction({ phase: "wallet", label, message: "Checking your wallet…" });
    const progress: TransactionProgress = (phase, hash) => {
      if (chainRef.current !== chain) return;
      const messages: Record<string, string> = {
        approval: "Approve FLY in your wallet. Then confirm the action.",
        approving: "Approving FLY…",
        wallet: "Confirm in your wallet.",
        pending: "Waiting for confirmation…",
        confirmed: "Confirmed.",
      };
      setTransaction({ phase, label, message: messages[phase] || "", hash });
    };
    try {
      const address = walletRef.current.address;
      if (!address || disconnected.current) throw new Error("Connect your wallet to continue.");
      const validate = async () => {
        if (chainRef.current !== chain || disconnected.current) throw new Error("Wallet disconnected. Please connect again.");
        await chain.validateWallet(address);
        // A poll started before approval is not a fresh preflight for the write.
        if (reading.current?.chain === chain) await reading.current.promise.catch(() => undefined);
        const current = await readFresh(chain);
        const balance: bigint = await chain.token.balanceOf(address);
        if (chainRef.current !== chain || disconnected.current || walletRef.current.address?.toLowerCase() !== address.toLowerCase()) throw new Error("Your wallet account changed. Please try again.");
        updateWallet({ address, balance, wrongNetwork: false, connecting: false });
        return current;
      };
      const current = await validate();
      await action(chain, current, validate, progress);
      // Release the action at its receipt. A slow state read must not keep a
      // confirmed action looking pending or overwrite a newer transaction.
      void (async () => {
        if (reading.current?.chain === chain) await reading.current.promise.catch(() => undefined);
        if (chainRef.current === chain) await refresh();
      })();
    } catch (error) {
      if (chainRef.current === chain) setTransaction({ phase: "error", label, message: actionError(error) });
    } finally {
      actionLock.current = false;
      if (chainRef.current === chain) setBusy(false);
    }
  }, [readFresh, refresh, updateWallet]);

  const afford = useCallback((amount: bigint) => {
    if (walletRef.current.balance === null) throw new Error("Could not check your FLY balance. Please try again.");
    if (walletRef.current.balance < amount) throw new Error("Not enough FLY in your wallet.");
  }, []);

  const feed = useCallback((rawAmount: string) => run("Feed", async (chain, current, validate, progress) => {
    const amount = foodAmount(rawAmount, chain.prices);
    const check = (state: FlySnapshot) => {
      if (!state.alive) throw new Error("The fly has died. Revive it before feeding.");
      const energy = state.energyRaw ?? BigInt(state.energy);
      if (energy + amount / chain.prices.tokensPerStep > UINT64_MAX) throw new Error("This amount is too large.");
      afford(amount);
    };
    check(current);
    return chain.feed(amount, progress, async () => check(await validate()));
  }), [afford, run]);

  const tick = useCallback(() => run("Run", async (chain, current, _validate, progress) => {
    if (!current.alive) throw new Error("Revive the fly before interacting.");
    const steps = Math.min(32, chain.prices.maxSteps, current.energy);
    if (steps < 1) throw new Error("Feed the fly before interacting.");
    return chain.tick(steps, progress);
  }), [run]);

  const stimulate = useCallback((channel: number, param: number, strength: number) => run("Interact", async (chain, current, validate, progress) => {
    if (!Number.isInteger(channel) || channel < 1 || channel > 4 || !Number.isInteger(param) || param < 0 || param > 255 || (channel === 1 && param > 15)) throw new Error("Choose a valid interaction.");
    if (!Number.isInteger(strength) || strength < 1 || strength > 255) throw new Error("Choose a strength between 1 and 255.");
    const cost = chain.prices.stimPrice * BigInt(strength);
    const check = (state: FlySnapshot) => {
      if (!state.alive) throw new Error("Revive the fly before interacting.");
      if (state.energy < 1) throw new Error("Feed the fly before interacting.");
      afford(cost);
    };
    check(current);
    return chain.stimulate(channel, param, strength, Math.min(16, chain.prices.maxSteps, current.energy), progress, async () => {
      // Another visitor may have used the remaining energy during approval.
      const latest = await validate();
      check(latest);
      return Math.min(16, chain.prices.maxSteps, latest.energy);
    });
  }), [afford, run]);

  const resurrect = useCallback((rawFood: string) => run("Revive", async (chain, current, validate, progress) => {
    const food = foodAmount(rawFood, chain.prices);
    const check = (state: FlySnapshot) => {
      if (state.alive) throw new Error("The fly is already alive. Feed it instead.");
      afford(chain.prices.resurrectPrice + food);
    };
    check(current);
    return chain.resurrect(food, progress, async () => check(await validate()));
  }), [afford, run]);

  const clearTransaction = useCallback(() => {
    if (!actionLock.current) setTransaction(IDLE);
  }, []);

  return { snapshot, connection, prices, wallet, transaction, busy, connect, disconnect, refresh, feed, tick, stimulate, resurrect, clearTransaction };
}
