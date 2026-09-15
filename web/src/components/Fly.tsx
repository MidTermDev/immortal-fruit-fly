"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther } from "ethers";
import Link from "next/link";
import { CFG } from "@/lib/config";
import { useFly } from "@/hooks/useFly";
import SiteHeader from "./SiteHeader";
import FlyStage from "./FlyStage";

const PRESETS = ["100", "1000", "10000"];
const ACTIONS = [
  { name: "Turn left", channel: 2, icon: "left" },
  { name: "Turn right", channel: 3, icon: "right" },
  { name: "Landmark", channel: 1, icon: "landmark" },
  { name: "Shock", channel: 4, icon: "shock" },
] as const;
type ActionKind = "feed" | "stimulate" | "tick" | "resurrect";

function tokenText(value: bigint, exact = false) {
  const [whole, fraction] = formatEther(value).split(".");
  const decimals = fraction?.slice(0, exact ? 18 : 4).replace(/0+$/, "");
  return BigInt(whole).toLocaleString("en-US") + (decimals ? `.${decimals}` : "");
}

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function ActionIcon({ type }: { type: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === "left" && <path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 6 6v3" />}
    {type === "right" && <path d="m16 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3" />}
    {type === "landmark" && <><path d="M7 21V4m0 1c4-5 6 5 12 0v10c-6 5-8-5-12 0" /><path d="M4 21h6" /></>}
    {type === "shock" && <path d="m13 2-9 12h7l-1 8 10-13h-8z" />}
  </svg>;
}

export default function Fly() {
  const { snapshot, connection, prices, wallet, transaction, busy, connect, disconnect, refresh, feed, tick, stimulate, resurrect, clearTransaction } = useFly();
  const [amount, setAmount] = useState("1000");
  const [amountTouched, setAmountTouched] = useState(false);
  const [action, setAction] = useState<(typeof ACTIONS)[number]>(ACTIONS[0]);
  const [strength, setStrength] = useState(4);
  const [wedge, setWedge] = useState(4);
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
  const stimCost = prices ? prices.stimPrice * BigInt(strength) : null;
  const canRun = ready && !dead && snapshot.energy > 0;
  const stimAffordable = stimCost === null || wallet.balance === null || wallet.balance >= stimCost;
  const feedback = useMemo(() => transaction.phase === "confirmed" && transaction.hash && lastAction ? { id: transaction.hash, kind: lastAction } : null, [transaction.phase, transaction.hash, lastAction]);

  const handleFeed = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || locked) return;
    if (!wallet.address || wallet.wrongNetwork) { await connect(); return; }
    setAmountTouched(true);
    if (amountError) return;
    setLastAction(dead ? "resurrect" : "feed");
    await (dead ? resurrect(amount.trim()) : feed(amount.trim()));
  };

  const handleInteraction = async (kind: "stimulate" | "tick") => {
    if (!canRun || locked) return;
    if (!wallet.address || wallet.wrongNetwork) { await connect(); return; }
    setLastAction(kind);
    if (kind === "tick") await tick();
    else await stimulate(action.channel, action.channel === 1 ? wedge : 0, strength);
  };

  const connectLabel = wallet.connecting ? "Connecting…" : wallet.wrongNetwork ? "Switch network" : "Connect wallet";
  const transactionVisible = transaction.phase !== "idle";
  const terminal = transaction.phase === "confirmed" || transaction.phase === "error";
  const statusText = connection === "loading" ? "Connecting" : connection === "offline" ? "Offline" : connection === "stale" ? "Reconnecting" : dead ? "Needs revival" : "Alive";

  return (
    <>
      <SiteHeader current="fly" wallet={wallet.address && !wallet.wrongNetwork ? (
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
          <h1>The fly</h1>
          <div className={`fly-status status-${connection}${dead ? " is-dead" : ""}`}>
            <span className="status-dot" />{statusText}
            {(connection === "offline" || connection === "stale") && <button type="button" onClick={() => void refresh()}>Retry</button>}
          </div>
        </div>

        <div className="dashboard-workspace">
          <section className="visual-column" aria-label="Fly visualization">
            <div className="visual-stage"><FlyStage snapshot={snapshot} connection={connection} feedback={feedback} /></div>
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
              <div className="transaction-title"><span>{transaction.phase === "confirmed" ? "✓" : transaction.phase === "error" ? "!" : <span className="button-spinner" />}</span><strong>{transaction.label || "Transaction"}</strong>{terminal && <button type="button" aria-label="Dismiss transaction message" onClick={clearTransaction}>×</button>}</div>
              <p>{transaction.message}</p>
              {transaction.hash && <a href={`${CFG.explorer}/tx/${transaction.hash}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}
            </div>}

            <div className="interact-panel">
              <div className="care-heading"><h2>Interact</h2><span className="interaction-cost">{stimCost === null ? "—" : tokenText(stimCost, true)} FLY + gas</span></div>
              <div className="interaction-options" aria-label="Choose an interaction">{ACTIONS.map((item) => <button key={item.channel} type="button" aria-pressed={action.channel === item.channel} disabled={locked || dead} onClick={() => setAction(item)}><ActionIcon type={item.icon} /><span>{item.name}</span></button>)}</div>
              <details className="interaction-settings">
                <summary>Adjust strength{action.channel === 1 ? " & direction" : ""}<span aria-hidden="true">+</span></summary>
                <div className="interaction-slider"><label htmlFor="stim-strength">Strength</label><input id="stim-strength" type="range" min="1" max="16" value={strength} disabled={locked || dead} onChange={(event) => setStrength(Number(event.target.value))} /><output htmlFor="stim-strength">{strength}</output></div>
                {action.channel === 1 && <div className="interaction-slider"><label htmlFor="stim-direction">Direction</label><input id="stim-direction" type="range" min="0" max="15" value={wedge} disabled={locked || dead} onChange={(event) => setWedge(Number(event.target.value))} /><output htmlFor="stim-direction">{Math.round(wedge * 22.5)}°</output></div>}
              </details>
              <button className="interaction-submit" type="button" disabled={locked || !canRun || (!!wallet.address && !stimAffordable)} onClick={() => void handleInteraction("stimulate")}>
                <span>{busy && lastAction === "stimulate" ? "Confirming…" : dead ? "Revive to interact" : !stimAffordable && wallet.address ? "Not enough FLY" : action.name}</span><span aria-hidden="true">↗</span>
              </button>
              <button className="advance-button" type="button" disabled={locked || !canRun} onClick={() => void handleInteraction("tick")}><span>{busy && lastAction === "tick" ? "Advancing…" : "Advance the fly"}</span><span>Gas only ↗</span></button>
            </div>
          </section>
        </div>

        <div className="dashboard-details">
          <div><Link href="/docs/">About the fly</Link><a href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener noreferrer">Contract ↗</a></div>
        </div>
      </main>
    </>
  );
}
