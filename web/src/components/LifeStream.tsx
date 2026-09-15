"use client";
// A fly whose body is a pebble, living: the brain host (brain/HOST_PROTOCOL.md) runs its whole brain and world on the
// pebble's behalf and streams one lite frame (the arena's hdr, no spikes) every 200 ms at <origin>/fly/<id>/ws?lite=1.
// This draws that life with the same world drawing and colours as the home page: the arena, what the fly is doing as a
// word, its energy, the brain lighting up by region, and its diary. The caption says where the neurons are.
import { useEffect, useRef, useState } from "react";
import { drawArena, modeWord, LifeFrame } from "@/lib/arena";
import { fmt, hms, pad } from "@/lib/registry";

const HEALTH_TIMEOUT_MS = 4000;

/** True when the brain host at `origin` is running fly `id`: GET /fly/<id>/health answers `{ok: true, …}` within the
 *  timeout, and does not say `hosting: false` (a process that is up but no longer this fly's, while the pebble can
 *  still fetch /final). The host sets Access-Control-Allow-Origin: * on its JSON endpoints. Never throws. */
export type HostHealth = { ok: boolean; alive?: boolean; age_ms?: number; realtime?: number; body?: string; fly?: number; hosting?: boolean };
export async function probeHost(origin: string, id: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ ok: boolean; health: HostHealth | null }> {
  if (!origin) return { ok: false, health: null };
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const r = await fetch(`${origin}/fly/${id}/health`, { signal: ctl?.signal, cache: "no-store" });
    if (!r.ok) return { ok: false, health: null };
    const j = (await r.json()) as HostHealth;
    return { ok: !!(j && j.ok && j.hosting !== false), health: j };
  } catch { return { ok: false, health: null }; }
  finally { clearTimeout(t); }
}

/** A legend swatch: .cell-cap i takes its colour from the --c custom property. */
const sw = (c: string) => ({ "--c": c } as React.CSSProperties);
const bar = (label: string, v: number, max: number, color: string) => (
  <div className="dnbar" key={label}><span className="lbl">{label}</span><div className="track"><i style={{ width: `${Math.min(100, (100 * v) / max)}%`, background: color }} /></div><span className="mono">{v.toFixed(0)}</span></div>
);

export default function LifeStream({ id, origin, body }: { id: number; origin: string; body: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hdrRef = useRef<LifeFrame | null>(null);
  const trailRef = useRef<number[][]>([]);   // the fly's path, kept client-side: the frame carries only its position
  const [h, setH] = useState<LifeFrame | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    let ws: WebSocket | null = null, raf = 0, running = true, retry: ReturnType<typeof setTimeout> | undefined, backoff = 4000;
    hdrRef.current = null; trailRef.current = [];   // a new fly or host: the first frame replaces what was shown
    const url = origin.replace(/^http/, "ws") + `/fly/${id}/ws?lite=1`;
    const connect = () => {
      clearTimeout(retry);
      const prev = ws; ws = null; try { prev?.close(); } catch {}
      let sock: WebSocket;
      try { sock = new WebSocket(url); } catch { setLive("offline"); retry = setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 1.6); return; }
      ws = sock; setLive("connecting");
      sock.onopen = () => { if (sock === ws) { setLive("live"); backoff = 4000; } };
      sock.onmessage = (m) => {
        if (sock !== ws) return;
        try { const j = JSON.parse(m.data); const hd: LifeFrame = j && j.hdr ? j.hdr : j; if (hd && typeof hd.x === "number" && typeof hd.y === "number") { hdrRef.current = hd; setH(hd); } } catch {}
      };
      sock.onclose = () => { if (sock !== ws) return; setLive("offline"); if (running) { retry = setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 1.6); } };
      sock.onerror = () => { try { sock.close(); } catch {} };
    };
    const loop = () => { if (!running) return; const c = canvasRef.current; if (c) drawArena(c, hdrRef.current, trailRef.current, "connecting to the brain host…"); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    connect();
    return () => { running = false; clearTimeout(retry); cancelAnimationFrame(raf); const s = ws; ws = null; try { s?.close(); } catch {} };
  }, [id, origin]);

  const R: Record<string, number> = h?.rates || {}; const streaming = live === "live" && !!h;
  const smell = R.ALPN || 0, memory = (R.KC || 0) + (R.MBON || 0), sight = (R.LC4_left || 0) + (R.LC4_right || 0), steering = Math.abs((R.DNa02_left || 0) - (R.DNa02_right || 0)), taste = R.GRN_labellar || 0;
  const realtime = h && typeof h.realtime === "number" ? h.realtime : null;
  const caption = `whole brain on the brain host · ${realtime === null ? "—" : realtime.toFixed(1)}× real time · body: ${body}`;
  const state = live === "live" ? (h ? (h.alive ? "live" : "dead on the host") : "waiting for the first frame…") : live === "connecting" ? "connecting to the brain host…" : "stream offline · reconnecting";

  return (
    <div id="life" style={{ marginTop: 44 }}>
      <div className="fig-head core-head">
        <div><div className="num">Figure · life · #{pad(id)}</div><h2>Alive on the brain host, in a pebble&apos;s hands</h2></div>
        <p className="cap"><b>Fig. |</b> Its body is a pebble, which signs for it on the registry but cannot run 139,248 neurons; the <b>brain host</b> runs its whole brain and world on the pebble&apos;s behalf and streams this five times a second. <b>a,</b> The world: food (amber) with its odor plume, the fly (red) and its path, a puff of odor from the pebble&apos;s landmark magnet as a fainter glow, and the predator (blue) when one looms. <b>b,</b> What it is doing, its energy, and the brain lighting up by region. Every checkpoint of this brain is pinned to IPFS and committed to the chain by the pebble; the host never holds a key.</p>
      </div>
      <div className="grid2">
        <div className="cell">
          <div className="cell-t"><span className="a">a</span><span className="n">World</span><span className="r">{h ? `(${h.x.toFixed(1)}, ${h.y.toFixed(1)}) · ${Math.round((((h.heading * 180) / Math.PI) % 360 + 360) % 360)}°` : state}</span></div>
          <div className="cell-b b-arena"><canvas ref={canvasRef} className="walk-c" aria-label="Top-down view of the fly's world on the brain host: food, fly and predator" /></div>
          <div className="cell-cap"><span><i style={sw("#f0b429")} />food + plume</span><span><i style={sw("#ff5a35")} />fly</span><span><i style={sw("#58c4f5")} />predator</span><span className="life-cap" style={{ marginLeft: "auto" }} data-testid="life-caption">{caption}</span></div>
        </div>
        <div className="cell">
          <div className="cell-t"><span className="a">b</span><span className="n">Brain by region</span><span className="r">{streaming ? "live" : state}</span></div>
          <div className="cell-b life-b">
            <div className="life-mode"><span className="lbl">doing</span><b className="life-word" data-mode={h?.mode || ""}>{h ? (h.alive ? modeWord(h.mode) : "dead") : "…"}</b></div>
            <div className="life-energy"><span className="lbl">energy</span><span className="mono">{h ? `${hms(h.energy)} · ${fmt(Math.round(h.energy))} s` : "—"}</span></div>
            <div className="life-bars">
              {bar("smell · ALPN", smell, 120, "#42b89e")}
              {bar("memory · KC+MBON", memory, 160, "#d973bf")}
              {bar("sight · LC4 L+R", sight, 150, "#58c4f5")}
              {bar("steering · |DNa02 L−R|", steering, 120, "#ff5a35")}
              {bar("taste · GRN", taste, 80, "#f0b429")}
            </div>
            <div className="lbl" style={{ color: "var(--fig-dim)", marginTop: 4 }}>steer {h && typeof h.steer === "number" ? (h.steer >= 0 ? "+" : "") + h.steer.toFixed(1) : "—"} · ORN drive L {h?.orn ? Number(h.orn[0]).toFixed(0) : "—"} / R {h?.orn ? Number(h.orn[1]).toFixed(0) : "—"} Hz</div>
            <div className="lbl" style={{ color: "var(--fig-dim)" }}>{h ? `age ${hms(h.t_ms / 1000)} · ${fmt(h.spikes_total)} spikes · eaten ${Math.round(h.ate)} s · jumps ${h.jumps} · caught ${h.hits}` : "—"}</div>
          </div>
          <div className="cell-cap"><span>firing rates, Hz, 60 ms window</span><span style={{ marginLeft: "auto" }}>{realtime === null ? "" : `${realtime.toFixed(1)}× real time`}</span></div>
        </div>
      </div>
      <div className="log-head"><b style={{ fontSize: 13 }}>Diary</b><span className="lbl">what happened to it on the brain host · newest first</span></div>
      <div className="log-list" style={{ maxHeight: 200 }}>
        {h?.events?.length ? [...h.events].reverse().map((e, i) => <div className="lrow" key={i}><span className="blk">{hms(e[0] / 1000)}</span><span className="act" /><span className="ev">{e[1]}</span><span /></div>)
          : <div className="lrow"><span className="blk">—</span><span className="act" /><span className="ev">{h ? "nothing yet" : state}</span><span /></div>}
      </div>
    </div>
  );
}
