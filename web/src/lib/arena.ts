// The top-down drawing of a fly's world: food (amber) with its odor plume, the fly (red) and the trail it has left,
// the predator (blue) when one looms. One function for every body that streams the arena's frame shape: the home
// page's arena stream for fly #1 and the brain host's lite stream for a fly whose body is a pebble draw with it, so
// the two figures always look the same. The server sends only the current position; the trail is kept by the caller.

export type ArenaFood = { id?: number; x: number; y: number; energy: number; energy0: number; by?: string };
/** An odor puff without food (a pebble's landmark magnet, or a `cue` sense event). The host may send `[x, y]` or an
 *  object; either is drawn as a fainter glow than a plume. */
export type ArenaPuff = { x: number; y: number; strength?: number; radius?: number } | number[];
export type ArenaHdr = {
  arena: number; x: number; y: number; heading: number; alive: boolean; mode: string;
  food: ArenaFood[]; predator: { x: number; y: number; size: number } | null; puffs?: ArenaPuff[];
};
/** The brain host's lite frame (brain/HOST_PROTOCOL.md): the arena's whole hdr, no spikes. */
export type LifeFrame = ArenaHdr & {
  t_ms: number; step: number; energy: number; generation: number; life_ms: number; spikes_total: number; ate: number; jumps: number; hits: number;
  rates: Record<string, number>; steer: number; orn: number[]; events: [number, string][]; realtime?: number; wall?: number; nrender?: number;
  chain?: { last_hash: string; checkpoints: number };
};

export const ARENA_COLORS = { food: "#f0b429", fly: "#ff5a35", predator: "#58c4f5", dead: "#8a919c" };
const TRAIL_MAX = 1500;

/** Appends the fly's position to `trail` when it has moved at least 0.4 body lengths, keeping the last TRAIL_MAX points. */
export function extendTrail(trail: number[][], x: number, y: number) {
  const l = trail[trail.length - 1];
  if (!l || Math.hypot(l[0] - x, l[1] - y) > 0.4) { trail.push([x, y]); if (trail.length > TRAIL_MAX) trail.shift(); }
}

/** Draws the world into `c`, sized to its CSS box at device resolution. With no frame yet, draws the empty arena and
 *  the `waiting` text. `trail` is the list of past positions the caller keeps (see extendTrail); the current position
 *  is appended here so a caller only has to pass the same array each frame. */
export function drawArena(c: HTMLCanvasElement, f: ArenaHdr | null, trail: number[][], waiting = "connecting to the live fly…") {
  const g = c.getContext("2d"); if (!g) return;
  const r = c.getBoundingClientRect(), dpr = Math.min((typeof devicePixelRatio === "number" && devicePixelRatio) || 1, 2); const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  g.clearRect(0, 0, W, H);
  const A = f ? f.arena : 240, S = Math.min(W, H) * 0.96, sc = S / A, cx = W / 2, cy = H / 2;
  const P = (x: number, y: number) => [cx + x * sc, cy - y * sc];
  g.strokeStyle = "rgba(232,230,224,0.06)"; g.lineWidth = 1;
  for (let v = -A / 2; v <= A / 2; v += 20) { const [x0, y0] = P(v, -A / 2), [x1, y1] = P(v, A / 2); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); const [a0, b0] = P(-A / 2, v), [a1, b1] = P(A / 2, v); g.beginPath(); g.moveTo(a0, b0); g.lineTo(a1, b1); g.stroke(); }
  g.strokeStyle = "rgba(232,230,224,0.35)"; g.strokeRect(cx - S / 2, cy - S / 2, S, S);
  if (!f) { g.fillStyle = "rgba(232,230,224,0.4)"; g.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`; g.textAlign = "center"; g.fillText(waiting, cx, cy); return; }
  const hd = f;
  // odor plumes
  for (const fd of hd.food) { const [x, y] = P(fd.x, fd.y); const frac = fd.energy / Math.max(1, fd.energy0); const grd = g.createRadialGradient(x, y, 0, x, y, 30 * 2.2 * sc); grd.addColorStop(0, `rgba(240,180,41,${0.10 + 0.25 * frac})`); grd.addColorStop(1, "rgba(240,180,41,0)"); g.fillStyle = grd; g.beginPath(); g.arc(x, y, 30 * 2.2 * sc, 0, 7); g.fill(); }
  // odor puffs without food (a pebble's senses): fainter glows
  if (Array.isArray(hd.puffs)) for (const p of hd.puffs) {
    const px = Array.isArray(p) ? p[0] : p?.x, py = Array.isArray(p) ? p[1] : p?.y; if (typeof px !== "number" || typeof py !== "number") continue;
    const k = Array.isArray(p) ? 1 : Math.max(0, Math.min(1, p.strength ?? 1)), rad = (Array.isArray(p) || !p.radius ? 30 * 1.6 : p.radius) * sc;
    const [x, y] = P(px, py); const grd = g.createRadialGradient(x, y, 0, x, y, rad); grd.addColorStop(0, `rgba(240,180,41,${0.04 + 0.10 * k})`); grd.addColorStop(1, "rgba(240,180,41,0)"); g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
  }
  for (const fd of hd.food) { const [x, y] = P(fd.x, fd.y); g.fillStyle = ARENA_COLORS.food; g.beginPath(); g.arc(x, y, Math.max(3, 3 * sc), 0, 7); g.fill(); g.fillStyle = "rgba(232,230,224,0.55)"; g.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.fillText(`${Math.round(fd.energy)} s`, x + 6 * dpr, y - 5 * dpr); }
  // predator
  if (hd.predator) { const [x, y] = P(hd.predator.x, hd.predator.y); g.fillStyle = "rgba(88,196,245,0.8)"; g.beginPath(); g.arc(x, y, Math.max(4, hd.predator.size * sc), 0, 7); g.fill(); }
  // path (from server: only current position; draw a trail we keep locally)
  extendTrail(trail, hd.x, hd.y);
  g.strokeStyle = "rgba(240,180,41,0.55)"; g.lineWidth = Math.max(1, 1.2 * dpr); g.beginPath(); trail.forEach((p, i) => { const [x, y] = P(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
  // fly
  const [fx, fy] = P(hd.x, hd.y); g.save(); g.translate(fx, fy); g.rotate(-hd.heading); g.fillStyle = hd.alive ? ARENA_COLORS.fly : ARENA_COLORS.dead;
  const L = Math.max(7, 4 * sc); g.beginPath(); g.moveTo(L, 0); g.lineTo(-L * 0.6, L * 0.45); g.lineTo(-L * 0.6, -L * 0.45); g.closePath(); g.fill(); g.restore();
  g.fillStyle = "rgba(232,230,224,0.35)"; g.font = `${Math.round(9.5 * dpr)}px ui-monospace, monospace`; g.textAlign = "left"; g.textBaseline = "bottom";
  g.fillText(`${A} × ${A} body lengths · ${hd.mode}`, cx - S / 2 + 8 * dpr, cy + S / 2 - 6 * dpr);
}

/** The world's locomotion mode as a word a person would use. */
export const MODE_WORDS: Record<string, string> = { walk: "wandering", wander: "wandering", surge: "following a scent", cast: "casting for the plume", eat: "eating", flee: "fleeing", still: "still", jump: "jumping" };
export const modeWord = (mode: string | undefined) => (mode ? MODE_WORDS[mode] || mode : "—");
