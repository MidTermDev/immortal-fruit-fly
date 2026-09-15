"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther } from "ethers";
import Link from "next/link";
import { CFG } from "@/lib/config";
import { useWorld, worldFoodAmount } from "@/hooks/useWorld";
import SiteHeader from "./SiteHeader";
import WorldStage from "./WorldStage";

function tokenText(value: bigint) {
  const [whole, fraction] = formatEther(value).split(".");
  const decimals = fraction?.replace(/0+$/, "");
  return BigInt(whole).toLocaleString("en-US") + (decimals ? `.${decimals}` : "");
}

export default function WorldCareDashboard() {
  const { info, chainStatus, frame, spikes, live, wallet, transaction, busy, connect, disconnect, refresh, placeFood, resurrect, clearTransaction } = useWorld();
  const [amount, setAmount] = useState("1000");
  const [touched, setTouched] = useState(false);
  const walletMenu = useRef<HTMLDetailsElement>(null);
  const transactionNote = useRef<HTMLDivElement>(null);
  const dead = info !== null && !info.alive;
  const ready = chainStatus === "live" && info !== null;
  const locked = busy || wallet.connecting;
  const balanceUnavailable = !!wallet.address && !wallet.wrongNetwork && wallet.balance === null;
  const minimum = info ? dead ? info.tps : info.minFood : null;
  const presets = minimum !== null ? [minimum, minimum * BigInt(10), minimum * BigInt(60)] : [];

  const food = useMemo(() => {
    if (!info) return { amount: null, seconds: null, cost: null, error: null };
    try {
      const parsed = worldFoodAmount(amount, info, dead ? info.tps : info.minFood);
      if (parsed <= BigInt(0)) throw new Error("Enter a positive FLY amount.");
      const seconds = parsed / info.tps;
      if (seconds < BigInt(1)) throw new Error(`Enter at least ${tokenText(info.tps)} FLY.`);
      const cost = parsed + (dead ? info.resPrice : BigInt(0));
      return { amount: parsed, seconds, cost, error: wallet.balance !== null && cost > wallet.balance ? "Not enough FLY." : null };
    } catch (error) {
      return { amount: null, seconds: null, cost: null, error: error instanceof Error && error.message.length < 140 ? error.message : "Enter a valid FLY amount." };
    }
  }, [amount, dead, info, wallet.balance]);
  const showAmountError = !!food.error && (touched || !!wallet.address);
  const connectLabel = wallet.connecting ? "Connecting…" : wallet.wrongNetwork ? "Switch network" : "Connect wallet";
  const terminal = transaction.phase === "confirmed" || transaction.phase === "error";
  const status = chainStatus === "loading" ? "Connecting" : chainStatus === "offline" ? "Offline" : chainStatus === "stale" ? "Reconnecting" : dead ? "Needs revival" : "Alive";

  useEffect(() => {
    if (transaction.phase === "error") transactionNote.current?.focus();
  }, [transaction.phase, transaction.message]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || locked) return;
    if (!wallet.address || wallet.wrongNetwork) { await connect(); return; }
    setTouched(true);
    if (food.error || food.amount === null || balanceUnavailable) return;
    if (dead) await resurrect(amount.trim());
    else await placeFood(0, 0, amount.trim());
  };

  return <>
    <SiteHeader current="feed" wallet={wallet.address && !wallet.wrongNetwork ? (
      <details className="wallet-menu" ref={walletMenu} onKeyDown={(event) => { if (event.key === "Escape" && walletMenu.current) { walletMenu.current.open = false; walletMenu.current.querySelector("summary")?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
        <summary className="wallet-button"><span className="wallet-dot" />{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}<span aria-hidden="true">⌄</span></summary>
        <div className="wallet-popover"><span className="wallet-network">BNB Smart Chain</span><strong>{wallet.balance !== null ? tokenText(wallet.balance) : "—"} FLY</strong><button type="button" disabled={locked} onClick={disconnect}>Disconnect</button></div>
      </details>
    ) : <button type="button" className="wallet-button" disabled={locked} onClick={() => void connect()}>{connectLabel}</button>} />

    <main className="fly-dashboard" id="main">
      <div className="dashboard-heading">
        <div><h1>Feed the fly</h1><p className="feed-target">Whole brain · FlyWorld</p></div>
        <div className={`fly-status status-${chainStatus}${dead ? " is-dead" : ""}`}><span className="status-dot" />{status}{(chainStatus === "offline" || chainStatus === "stale") && <button type="button" onClick={() => void refresh()}>Retry</button>}</div>
      </div>
      <nav className="feed-source-nav" aria-label="Feeding source"><Link href="/feed/">On-chain circuit</Link><Link href="/feed/world/" aria-current="page">Whole brain</Link></nav>

      <div className="dashboard-workspace care-workspace">
        <section className="visual-column" aria-label="Whole-brain visualization">
          <div className="visual-stage"><WorldStage frame={frame} spikes={spikes} status={live} arena={info?.arena ?? 0} /></div>
          <dl className="fly-vitals">
            <div><dt>Food placements</dt><dd>{info ? info.foodCount.toLocaleString("en-US") : "—"}</dd></div>
            <div><dt>Generation</dt><dd>{info ? info.generation.toLocaleString("en-US") : "—"}</dd></div>
            <div><dt>Contract state</dt><dd>{info ? info.alive ? "Alive" : "Ended" : "—"}</dd></div>
          </dl>
        </section>

        <section className="care-panel" id="care" aria-label="Feed the whole brain">
          <form className="feed-form" onSubmit={submit} noValidate>
            <div className="care-heading"><h2>{dead ? "Revive the fly" : "Place food"}</h2><a href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener noreferrer">Get FLY ↗</a></div>
            <div className="amount-label"><label htmlFor="world-food">{dead ? "Starting food" : "Amount"}</label><span>{wallet.address && wallet.balance !== null ? `${tokenText(wallet.balance)} available` : "FLY"}</span></div>
            <div className={`feed-input${showAmountError ? " has-error" : ""}`}><input id="world-food" type="text" inputMode="decimal" autoComplete="off" spellCheck={false} maxLength={40} value={amount} disabled={locked} aria-invalid={showAmountError} aria-describedby={showAmountError ? "world-food-error" : "world-food-result"} onBlur={() => setTouched(true)} onChange={(event) => { setAmount(event.target.value); setTouched(true); }} /><span>FLY</span></div>
            <div className="feed-presets" aria-label="Food amount presets">{presets.map((value) => <button type="button" key={String(value)} disabled={locked} aria-pressed={food.amount === value} onClick={() => { setAmount(formatEther(value)); setTouched(true); }}>{tokenText(value)}</button>)}</div>
            <div className="feed-result" id="world-food-result"><span>{food.seconds !== null ? `${food.seconds.toLocaleString("en-US")} seconds of ${dead ? "energy" : "food"}` : "Choose an amount"}</span><span>{minimum !== null ? `Min ${tokenText(minimum)} FLY` : "—"}</span></div>
            {showAmountError && <p className="field-error" id="world-food-error" role="alert">{food.error}</p>}
            {balanceUnavailable && <p className="field-error" role="status">Balance unavailable. <button type="button" disabled={locked} onClick={() => void refresh()}>Retry</button></p>}
            <button className="feed-submit" type="submit" disabled={locked || !ready || (!!wallet.address && !wallet.wrongNetwork && (!!food.error || balanceUnavailable))}>
              {busy ? <><span className="button-spinner" />Confirming…</> : !ready ? chainStatus === "loading" ? "Connecting…" : "Waiting for connection" : !wallet.address || wallet.wrongNetwork ? connectLabel : dead ? "Revive the fly" : "Place food"}
              {!locked && ready && <span aria-hidden="true">↗</span>}
            </button>
            <p className="feed-cost">{food.cost !== null ? `${tokenText(food.cost)} FLY will be burned · + BNB gas` : "FLY + BNB gas"}</p>
            {dead && info && <p className="feed-cost">Includes {tokenText(info.resPrice)} FLY revival fee.</p>}
            {!dead && <p className="feed-cost">Food is placed at the arena center. Energy is added when eaten.</p>}
            {!dead && ready && (live === "offline" || live === "stale") && <p className="feed-cost" role="status">Live stream unavailable. Food can still be placed on-chain.</p>}
          </form>

          {transaction.phase !== "idle" && <div ref={transactionNote} tabIndex={-1} className={`transaction-note transaction-${transaction.phase}`} role={transaction.phase === "error" ? "alert" : "status"} aria-live="polite">
            <div className="transaction-title"><span>{transaction.phase === "confirmed" ? "✓" : transaction.phase === "error" ? "!" : <span className="button-spinner" />}</span><strong>{transaction.label || "Transaction"}</strong>{terminal && <button type="button" aria-label="Dismiss transaction message" onClick={clearTransaction}>Dismiss</button>}</div>
            <p>{transaction.message}</p>
            {transaction.hash && <a href={`${CFG.explorer}/tx/${transaction.hash}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}
          </div>}
        </section>
      </div>
      <div className="dashboard-details"><div><Link href="/world/">Watch whole brain</Link><a href={`${CFG.explorer}/address/${CFG.world}`} target="_blank" rel="noopener noreferrer">Contract ↗</a></div></div>
    </main>
  </>;
}
