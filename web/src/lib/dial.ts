// The sixteen-wedge compass dial of the ellipsoid body, shared by the FlyBrain v2 figure (Fly.tsx) and the
// per-fly FlyCore figure (Core.tsx). Inner ring: wedge activity (the bump), amber turning red where it is strong.
// Outer ring: the heading histogram (the memory). Needle: the population vector, full length when the bump is strong.
import { WEDGES } from "./flysim";

/** `fill` sizes the dial from its parent box (minus the parent's padding) instead of the canvas's own box. */
export function drawDial(c: HTMLCanvasElement, act: number[], hist: number[], headA: number, headM: number, maxCss = 300, fill = false) {
  const g = c.getContext("2d"); if (!g) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let r = c.getBoundingClientRect();
  if (fill && c.parentElement) { const p = c.parentElement, pr = p.getBoundingClientRect(), cs = getComputedStyle(p); r = new DOMRect(0, 0, pr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), pr.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)); }
  const css = Math.max(1, Math.floor(Math.min(r.width, r.height, maxCss)));
  if (c.style.width !== css + "px") { c.style.width = css + "px"; c.style.height = css + "px"; }
  const S = Math.max(1, Math.round(css * dpr)); if (c.width !== S) { c.width = S; c.height = S; }
  const cx = S / 2, R = S * 0.39, r0 = S * 0.24; g.clearRect(0, 0, S, S);
  const hm = Math.max(1, ...hist);
  for (let w = 0; w < WEDGES; w++) {
    const a0 = (w * 2 * Math.PI) / WEDGES, a1 = a0 + (2 * Math.PI) / WEDGES - 0.03, a = Math.max(0, Math.min(1, act[w] || 0));
    g.beginPath(); g.arc(cx, cx, R, -a1, -a0, false); g.arc(cx, cx, r0, -a0, -a1, true); g.closePath();
    g.fillStyle = `rgba(240,180,41,${0.055 + a * 0.85})`; g.fill();
    if (a > 0.55) { g.fillStyle = `rgba(255,90,53,${(a - 0.55) * 1.5})`; g.fill(); }
    g.beginPath(); g.arc(cx, cx, R + S * 0.035, -a1, -a0, false); g.arc(cx, cx, R + S * 0.013, -a0, -a1, true); g.closePath();
    g.fillStyle = `rgba(88,196,245,${0.07 + 0.6 * ((hist[w] || 0) / hm)})`; g.fill();
  }
  g.save(); g.translate(cx, cx); g.rotate(-headA);
  g.beginPath(); g.moveTo(0, -S * 0.01); g.lineTo(r0 * (0.35 + 0.65 * Math.max(0, Math.min(1, headM))), 0); g.lineTo(0, S * 0.01); g.closePath();
  g.fillStyle = "#e8e6e0"; g.fill(); g.restore();
  g.beginPath(); g.arc(cx, cx, S * 0.015, 0, 7); g.fillStyle = "#ff5a35"; g.fill();
  g.fillStyle = "rgba(232,230,224,0.4)"; g.font = `${Math.round(S * 0.036)}px ui-monospace, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
  for (let w = 0; w < WEDGES; w += 4) { const a = ((w + 0.5) * 2 * Math.PI) / WEDGES; g.fillText(String(w), cx + Math.cos(a) * S * 0.458, cx - Math.sin(a) * S * 0.458); }
}

/** Wedge that a click on the dial canvas falls in (0-15, counter-clockwise from the right, as the ring is drawn). */
export function wedgeAt(e: { clientX: number; clientY: number; target: EventTarget | null }) {
  const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
  const x = e.clientX - r.left - r.width / 2, y = -(e.clientY - r.top - r.height / 2);
  return ((Math.floor(Math.atan2(y, x) / ((2 * Math.PI) / WEDGES)) % WEDGES) + WEDGES) % WEDGES;
}
