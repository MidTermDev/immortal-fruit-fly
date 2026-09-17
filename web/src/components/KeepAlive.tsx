"use client";
// Keep a fly alive for a little BNB, paid to the registry itself (FlyRegistryV3.feed is payable; nothing is burned as
// metabolism). One care column, used by a fly's page and by the home page for fly #1: an amount of BNB, the seconds of
// life it buys at the registry's price (lifeWeiPerSecond), one payable call, and the fly's energy as its record has it,
// which the feed raises at once.
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import { Chain, LifePrice } from "@/lib/chain";
import { fmt, short, dur, hms, fmtBnb, secondsFor, lifeCost, bnbPerDay } from "@/lib/registry";

const DEFAULT_BNB = "0.01";
const MIN_BNB = 0.001;
const PRICE_POLL_MS = 60000;   // the curator adjusts the price as BNB moves: re-read it every minute

/** Wei for the amount typed, or null when it is not a number of BNB. */
const parseBnb = (s: string): bigint | null => { try { const v = ethers.parseEther(String(s).trim() || "0"); return v > BigInt(0) ? v : null; } catch { return null; } };

export default function KeepAlive({ id, alive, energy, where, chain, wallet, connect, toast, onFed }: {
  id: number;
  /** A dead fly cannot be fed: resurrect it first. */
  alive: boolean;
  /** The fly's energy as the registry has it (seconds of life at the last checkpoint, plus feeds since), or null while unknown. */
  energy: number | null;
  /** Where the food lands once the body applies the feed: a phrase for this fly's body ("in the arena", "in the Colony"), or "" for a dormant fly. */
  where?: string;
  chain: Chain | null; wallet: string | null; connect: () => Promise<void>; toast: (m: string, ms?: number) => void;
  /** After a feed is mined: the caller re-reads the record (the energy and the Fed row are in it). */
  onFed?: () => Promise<void> | void;
}) {
  const [price, setPrice] = useState<LifePrice | null>(null);
  const [bnb, setBnb] = useState(DEFAULT_BNB);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const read = async (ch: Chain) => {
    try { setPrice(await ch.lifePrice()); setErr(null); }
    catch (e: any) { setErr("The registry did not answer: " + String(e?.shortMessage || e?.message || e).slice(0, 80)); }
  };
  // the price, on mount and every minute while the page is visible
  useEffect(() => {
    if (!chain) return;
    let stop = false;
    const tick = async () => { if (!stop) await read(chain); };
    tick();
    const t = setInterval(() => { if (document.visibilityState === "visible") tick(); }, PRICE_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [chain, id]);

  const wei = parseBnb(bnb);
  const tooLittle = wei !== null && Number(bnb) < MIN_BNB;
  const seconds = wei !== null && price ? secondsFor(wei, price.lifeWeiPerSecond) : null;
  const dayFor = price ? dur(secondsFor(ethers.parseEther(DEFAULT_BNB), price.lifeWeiPerSecond)) : "24 h";
  const ready = !!chain && !!price;

  const feed = async () => {
    if (!chain || !wallet) return toast("Connect a wallet first.");
    if (wei === null) return toast("How much BNB? 0.01 is about a day of life.");
    if (tooLittle) return toast(`At least ${MIN_BNB} BNB.`);
    setBusy(true);
    try {
      // the price as of now, not as of the page opening; the seconds are what the amount buys, the value exactly their cost
      const p = await chain.lifePrice().catch(() => price);   // the price shown, if the registry does not answer right now
      if (!p) throw new Error("the registry did not answer with a price");
      const n = secondsFor(wei, p.lifeWeiPerSecond); if (n < 1) throw new Error("that buys less than a second of life");
      const cost = lifeCost(n, p.lifeWeiPerSecond);
      toast("Keep alive: confirm in your wallet…", 120000);
      const rc = await chain.feedFly(id, n, cost);
      toast(`Gave it ${dur(n)} of life in block ${fmt(rc.blockNumber)} for ${fmtBnb(cost)} BNB. ${where ? `Its body drops it as food ${where} at its next poll; the fly has to smell its way there.` : "Banked on its record until a body runs it."}`, 10000);
      await read(chain); await onFed?.();
    } catch (e: any) { toast(`Failed: ${e.shortMessage || e.reason || e.message}`, 9000); } finally { setBusy(false); }
  };

  return (
    <div className="care-col" data-testid="keep-alive">
      <div className="care-t"><h3>Keep it alive</h3><span className="cost">{DEFAULT_BNB} BNB ≈ {dayFor}</span></div>
      <p>Pay a little BNB to the registry and the fly has that much more life on its record at once, at the registry&apos;s price; nothing is burned. {where ? `Its body drops it as food ${where} at its next poll, and the fly has to smell its way there.` : "A fly that is not running does not age: the life is banked until a body runs it."} Anyone may keep any fly alive.</p>
      <div className="field">
        <input type="number" min={MIN_BNB} step={0.001} value={bnb} onChange={(e) => setBnb(e.target.value)} aria-label="BNB to pay for life" data-testid="keep-bnb" />
        <button className="btn fill" disabled={busy || !alive || !ready} onClick={wallet ? feed : connect} title={alive ? "" : "Resurrect it first"}>{busy ? "…" : wallet ? "Keep alive with BNB" : "Connect"}</button>
      </div>
      <div className="lbl" data-testid="keep-estimate">{seconds !== null ? `≈ ${dur(seconds)} of life` : wei === null ? "enter an amount of BNB" : err ? "no price" : "reading the price…"}{tooLittle ? ` · at least ${MIN_BNB} BNB` : ""}{wallet ? ` · ${short(wallet)}` : ""}</div>
      <div>
        <div className="crow"><span>energy now</span><span data-testid="keep-energy" title="Seconds of life on the registry: the last checkpoint plus every feed since">{energy === null ? "—" : alive ? hms(energy) : "dead"}</span></div>
        <div className="crow"><span>price of life</span><span data-testid="keep-price">{price ? `${bnbPerDay(price.lifeWeiPerSecond)} BNB per day` : err ? "—" : "…"}</span></div>
      </div>
      <p style={{ fontSize: 13.5 }}>{err || "Paid straight to the registry, no $FLY needed; the operator's keeper feeds for free."} <a href={`${CFG.explorer}/address/${CFG.registry}#code`} target="_blank" rel="noopener">FlyRegistry v3, verified →</a></p>
    </div>
  );
}
