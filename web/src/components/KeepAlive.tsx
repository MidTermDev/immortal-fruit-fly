"use client";
// Keep a fly alive for a little BNB (contracts/src/LifeFund.sol). One care column, used by a fly's page and by the home
// page for fly #1: an amount of BNB, the seconds of life it buys at the fund's rate (the contract's own quote), one
// payable call, and the fly's standing with the fund (sponsored life not yet fed, the free allowance left today). The
// $FLY feed stays as it was: the caller passes its own seconds input as children, shown behind "or feed it $FLY directly".
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import { Chain, LifeInfo } from "@/lib/chain";
import { fmt, short, dur } from "@/lib/registry";

const DEFAULT_BNB = "0.01";
const MIN_BNB = 0.001;
const POLL_MS = 60000;   // the keeper feeds from the credit while the fly lives somewhere: re-read the standing every minute
const QUOTE_DEBOUNCE_MS = 250;

/** Wei for the amount typed, or null when it is not a number of BNB. */
const parseBnb = (s: string): bigint | null => { try { const v = ethers.parseEther(String(s).trim() || "0"); return v > BigInt(0) ? v : null; } catch { return null; } };
/** The contract's quote, computed here from the rate it published: seconds = wei × secondsPerWeiE18 / 1e18. */
const localQuote = (wei: bigint, rate: bigint) => Number((wei * rate) / ethers.WeiPerEther);

export default function KeepAlive({ id, alive, where, chain, wallet, connect, toast, onSponsored, onInfo, children }: {
  id: number;
  /** A dead fly cannot be fed (resurrect it first); the credit would only wait. */
  alive: boolean;
  /** Where the food lands once the keeper feeds it: a phrase for this fly's body ("in the arena", "in the Colony"), or "" for a dormant fly. */
  where?: string;
  chain: Chain | null; wallet: string | null; connect: () => Promise<void>; toast: (m: string, ms?: number) => void;
  /** After a sponsorship is mined: the caller re-reads the record (the Sponsored event is in it). */
  onSponsored?: () => Promise<void> | void;
  /** The fly's standing with the fund, each time it is read (the page's Record aside shows it too). */
  onInfo?: (life: LifeInfo | null) => void;
  /** The $FLY feed (the existing seconds input), shown behind "or feed it $FLY directly". */
  children?: ReactNode;
}) {
  const [life, setLife] = useState<LifeInfo | null>(null);
  const [bnb, setBnb] = useState(DEFAULT_BNB);
  const [quote, setQuote] = useState<{ wei: bigint; seconds: number } | null>(null);   // the contract's answer for the amount typed
  const [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onInfoRef = useRef(onInfo); onInfoRef.current = onInfo;

  const read = async (ch: Chain) => {
    try { const li = await ch.lifeInfo(id); setLife(li); setErr(null); onInfoRef.current?.(li); }
    catch (e: any) { setErr("The fund did not answer: " + String(e?.shortMessage || e?.message || e).slice(0, 80)); onInfoRef.current?.(null); }
  };
  // the standing, on mount and every minute while the page is visible
  useEffect(() => {
    if (!chain || !chain.hasLifeFund) return;
    let stop = false;
    const tick = async () => { if (!stop) await read(chain); };
    tick();
    const t = setInterval(() => { if (document.visibilityState === "visible") tick(); }, POLL_MS);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, id]);
  // the contract's own quote for the amount typed, debounced; the local formula answers at once meanwhile
  useEffect(() => {
    clearTimeout(quoteTimer.current);
    const wei = parseBnb(bnb); if (!chain || !chain.hasLifeFund || wei === null) return;
    quoteTimer.current = setTimeout(async () => { try { const seconds = await chain.quoteLife(wei); setQuote({ wei, seconds }); } catch {} }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(quoteTimer.current);
  }, [bnb, chain]);

  const wei = parseBnb(bnb);
  const tooLittle = wei !== null && Number(bnb) < MIN_BNB;
  const seconds = wei === null ? null : quote && quote.wei === wei ? quote.seconds : life ? localQuote(wei, life.secondsPerWei) : null;
  const dayFor = life ? dur(localQuote(ethers.parseEther(DEFAULT_BNB), life.secondsPerWei)) : "24 h";
  const ready = !!chain && chain.hasLifeFund;

  const sponsor = async () => {
    if (!chain || !wallet) return toast("Connect a wallet first.");
    if (wei === null) return toast("How much BNB? 0.01 is a day of life.");
    if (tooLittle) return toast(`At least ${MIN_BNB} BNB.`);
    setBusy(true);
    try {
      toast("Sponsor: confirm in your wallet…", 120000);
      const rc = await chain.sponsorFly(id, wei);
      const got = seconds !== null ? dur(seconds) : "the seconds";
      toast(`Sponsored ${got} of life in block ${fmt(rc.blockNumber)}. The keeper feeds it from that whenever it is hungry${where ? ` ${where}` : ""}.`, 10000);
      await read(chain); await onSponsored?.();
    } catch (e: any) { toast(`Failed: ${e.shortMessage || e.reason || e.message}`, 9000); } finally { setBusy(false); }
  };

  return (
    <div className="care-col" data-testid="keep-alive">
      <div className="care-t"><h3>Keep it alive</h3><span className="cost">{DEFAULT_BNB} BNB ≈ {dayFor}</span></div>
      <p>Pay a little BNB and the fly is credited with life at the fund&apos;s rate. The operator&apos;s keeper feeds it from that credit whenever it is running in a body and getting hungry{where ? `, ${where}` : ""}; a fly that is not running does not age, and the credit waits. Anyone may keep any fly alive.</p>
      <div className="field">
        <input type="number" min={MIN_BNB} step={0.001} value={bnb} onChange={(e) => setBnb(e.target.value)} aria-label="BNB to sponsor" data-testid="keep-bnb" />
        <button className="btn fill" disabled={busy || !alive || !ready} onClick={wallet ? sponsor : connect} title={alive ? "" : "Resurrect it first"}>{busy ? "…" : wallet ? "Sponsor with BNB" : "Connect"}</button>
      </div>
      <div className="lbl" data-testid="keep-estimate">{seconds !== null ? `≈ ${dur(seconds)} of life` : wei === null ? "enter an amount of BNB" : ready ? "quoting…" : "reading the fund…"}{tooLittle ? ` · at least ${MIN_BNB} BNB` : ""}{wallet ? ` · ${short(wallet)}` : ""}</div>
      <div>
        <div className="crow"><span>sponsored life</span><span data-testid="keep-credit">{life ? (life.credit ? `${dur(life.credit)} left` : "none left") : err ? "—" : "…"}</span></div>
        <div className="crow"><span>free today</span><span>{life ? `${dur(life.freeLeftToday)} of ${dur(life.freeSecondsPerDay)} left` : err ? "—" : "…"}</span></div>
      </div>
      <div className="lbl">{life ? (life.credit ? "fed automatically while it lives somewhere" : "nothing sponsored yet · the free allowance still applies") : err || "reading the fund…"}{life ? ` · fund stock ${dur(life.stockSeconds)}` : ""}</div>
      <p style={{ fontSize: 13.5 }}>The keeper feeds it from the operator&apos;s $FLY whenever it is hungry; you pay a little BNB, the metabolism still burns $FLY on-chain. <a href={`${CFG.explorer}/address/${CFG.lifeFund}#code`} target="_blank" rel="noopener">LifeFund, verified →</a></p>
      {children && (
        <div style={{ borderTop: "1px solid var(--rule-2)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 13 }}>
          <button className="btn sm plain" style={{ alignSelf: "flex-start" }} aria-expanded={direct} onClick={() => setDirect(!direct)} data-testid="keep-direct">{direct ? "hide the $FLY feed" : "or feed it $FLY directly →"}</button>
          {direct && children}
        </div>)}
    </div>
  );
}
