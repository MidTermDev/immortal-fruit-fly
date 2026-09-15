"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther } from "ethers";
import Link from "next/link";
import { CFG } from "@/lib/config";
import { useFly } from "@/hooks/useFly";
import SiteHeader from "./SiteHeader";
import FlyStage from "./FlyStage";

const PRESETS = ["100", "1000", "10000"];
type ActionKind = "feed" | "resurrect";

function tokenText(value: bigint, exact = false) {
  const [whole, fraction] = formatEther(value).split(".");
  const decimals = fraction?.slice(0, exact ? 18 : 4).replace(/0+$/, "");
  return BigInt(whole).toLocaleString("en-US") + (decimals ? `.${decimals}` : "");
}

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export default function CareDashboard() {
  const { snapshot, connection, prices, wallet, transaction, busy, connect, disconnect, refresh, feed, resurrect, clearTransaction } = useFly();
  const [amount, setAmount] = useState("1000");
  const [amountTouched, setAmountTouched] = useState(false);
  const [lastAction, setLastAction] = useState<ActionKind | null>(null);
  const walletMenu = useRef<HTMLDetailsElement>(null);
  const transactionNote = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transaction.phase === "error") transactionNote.current?.focus();
  }, [transaction.phase, transaction.message]);

  const dead = snapshot !== null && !snapshot.alive;
  const ready = connection === "live" && snapshot !== null && prices !== null;
  const locked = busy || wallet.connecting;
  const tokenAmount = useMemo(() => {
    try { return /^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(amount.trim()) ? parseEther(amount.trim()) : null; }
    catch { return null; }
  }, [amount]);
  const energyAdded = tokenAmount !== null && tokenAmount > BigInt(0) && prices ? tokenAmount / prices.tokensPerStep : BigInt(0);
  const totalCost = tokenAmount !== null && prices ? tokenAmount + (dead ? prices.resurrectPrice : BigInt(0)) : null;
  const energyLimit = BigInt("18446744073709551615") - (dead ? BigInt(0) : snapshot?.energyRaw ?? BigInt(snapshot?.energy ?? 0));
  const amountError = !amount.trim() ? "Enter an amount." : tokenAmount === null || tokenAmount <= BigInt(0) ? "Enter a valid FLY amount." : prices && energyAdded < BigInt(1) ? `Minimum ${tokenText(prices.tokensPerStep, true)} FLY.` : energyAdded > energyLimit ? "Amount exceeds the energy limit." : wallet.balance !== null && totalCost !== null && totalCost > wallet.balance ? "Not enough FLY." : null;
  const showAmountError = amountTouched && amountError;

  const handleFeed = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || locked) return;
    if (!wallet.address || wallet.wrongNetwork) { await connect(); return; }
    setAmountTouched(true);
    if (amountError) return;
    setLastAction(dead ? "resurrect" : "feed");
    await (dead ? resurrect(amount.trim()) : feed(amount.trim()));
  };

  const connectLabel = wallet.connecting ? "Connecting…" : wallet.wrongNetwork ? "Switch network" : "Connect wallet";
  const transactionVisible = transaction.phase !== "idle";
  const terminal = transaction.phase === "confirmed" || transaction.phase === "error";
  const statusText = connection === "loading" ? "Connecting" : connection === "offline" ? "Offline" : connection === "stale" ? "Reconnecting" : dead ? "Needs revival" : "Alive";

  return (
    <>
      <SiteHeader current="feed" wallet={wallet.address && !wallet.wrongNetwork ? (
        <details className="wallet-menu" ref={walletMenu} onKeyDown={(event) => { if (event.key === "Escape" && walletMenu.current) { walletMenu.current.open = false; walletMenu.current.querySelector("summary")?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
          <summary className="wallet-button"><span className="wallet-dot" />{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}<span aria-hidden="true">⌄</span></summary>
          <div className="wallet-popover">
            <span className="wallet-network">BNB Smart Chain</span>
            <strong>{wallet.balance !== null ? tokenText(wallet.balance) : "—"} FLY</strong>
            <button type="button" disabled={locked} onClick={disconnect}>Disconnect</button>
          </div>
        </details>
      ) : <button type="button" className="wallet-button" disabled={locked} onClick={() => void connect()}><span className="wallet-icon" aria-hidden="true">◫</span>{connectLabel}</button>} />

      <main className="fly-dashboard" id="main">
        <div className="dashboard-heading">
          <div><h1>Feed the fly</h1><p className="feed-target">On-chain circuit · FlyBrain</p></div>
          <div className={`fly-status status-${connection}${dead ? " is-dead" : ""}`}>
            <span className="status-dot" />{statusText}
            {(connection === "offline" || connection === "stale") && <button type="button" onClick={() => void refresh()}>Retry</button>}
          </div>
        </div>

        <nav className="feed-source-nav" aria-label="Feeding destination"><Link href="/feed/" aria-current="page">On-chain circuit</Link><Link href="/feed/world/">Whole brain</Link></nav>

        <div className="dashboard-workspace care-workspace">
          <section className="visual-column" aria-label="Brain visualization">
            <div className="visual-stage"><FlyStage snapshot={snapshot} connection={connection} /></div>
            <dl className="fly-vitals">
              <div><dt>Energy</dt><dd title={snapshot ? `${snapshot.energy.toLocaleString("en-US")} steps` : undefined}>{snapshot ? compact(snapshot.energy) : "—"}<small>steps</small></dd></div>
              <div><dt>Steps lived</dt><dd>{snapshot ? compact(snapshot.step) : "—"}</dd></div>
              <div><dt>Generation</dt><dd>{snapshot ? snapshot.generation : "—"}</dd></div>
            </dl>
          </section>

          <section className="care-panel" id="care" aria-label="Care for the fly">
            <form className="feed-form" onSubmit={handleFeed} noValidate>
              <div className="care-heading"><h2>{dead ? "Revive the fly" : "Feed the fly"}</h2><a href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener noreferrer">Get FLY ↗</a></div>
              <div className="amount-label"><label htmlFor="feed-amount">{dead ? "Food to add" : "Amount"}</label><span>{wallet.address && wallet.balance !== null ? `${tokenText(wallet.balance)} available` : "FLY"}</span></div>
              <div className={`feed-input${showAmountError ? " has-error" : ""}`}>
                <input id="feed-amount" type="text" inputMode="decimal" maxLength={40} autoComplete="off" spellCheck={false} value={amount} disabled={locked} aria-invalid={!!showAmountError} aria-describedby={showAmountError ? "amount-error" : "feed-result"} onBlur={() => setAmountTouched(true)} onChange={(event) => { setAmount(event.target.value); setAmountTouched(true); }} />
                <span>FLY</span>
              </div>
              <div className="feed-presets" aria-label="Feed amount presets">{PRESETS.map((preset) => <button key={preset} type="button" aria-pressed={amount === preset} disabled={locked} onClick={() => { setAmount(preset); setAmountTouched(true); }}>{Number(preset).toLocaleString("en-US")}</button>)}</div>
              <div className="feed-result" id="feed-result">
                <span>{energyAdded > BigInt(0) ? `+${energyAdded.toLocaleString("en-US")} energy` : prices ? "Choose an amount" : "— energy"}</span>
                <span>{dead && prices ? `${tokenText(prices.resurrectPrice, true)} FLY revival fee` : "+ BNB gas"}</span>
              </div>
              {showAmountError && <p className="field-error" id="amount-error" role="alert">{amountError}</p>}
              <button className="feed-submit" type="submit" disabled={locked || !ready || (!!wallet.address && !!amountError)}>
                {busy && (lastAction === "feed" || lastAction === "resurrect") ? <><span className="button-spinner" />Confirming…</> : !ready ? connection === "loading" ? "Connecting…" : "Waiting for connection" : !wallet.address || wallet.wrongNetwork ? connectLabel : dead ? "Revive the fly" : "Feed the fly"}
                {!locked && ready && <span aria-hidden="true">↗</span>}
              </button>
              <p className="feed-cost">{totalCost !== null && totalCost > BigInt(0) ? `${tokenText(totalCost, true)} FLY will be burned${dead ? " · + BNB gas" : ""}` : "Feeding uses FLY"}</p>
            </form>

            {transactionVisible && <div ref={transactionNote} tabIndex={-1} className={`transaction-note transaction-${transaction.phase}`} role={transaction.phase === "error" ? "alert" : "status"} aria-live="polite">
              <div className="transaction-title"><span>{transaction.phase === "confirmed" ? "✓" : transaction.phase === "error" ? "!" : <span className="button-spinner" />}</span><strong>{transaction.label || "Transaction"}</strong>{terminal && <button type="button" aria-label="Dismiss transaction message" onClick={clearTransaction}>Dismiss</button>}</div>
              <p>{transaction.message}</p>
              {transaction.hash && <a href={`${CFG.explorer}/tx/${transaction.hash}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}
            </div>}

          </section>
        </div>

        <div className="dashboard-details">
          <div><Link href="/">Back to watching</Link><a href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener noreferrer">Contract ↗</a></div>
        </div>
      </main>
    </>
  );
}
