/* eslint-disable @typescript-eslint/no-explicit-any -- this file reads the supervisor's JSON as it comes */
// The Colony (COLONY.md): a shared Minecraft world on the VPS where several flies live at once, each a whole brain.
// This is the site's side of the supervisor's `/colony/state`: the shape the page expects, a tolerant reader (the
// supervisor may name a field either way; missing lists are empty lists), the fetch, and the top-down map drawn in the
// arena's palette so the Colony map, the arena and the brain host's world all read as the same organism.
//
// `/colony/state` as the page reads it (every field optional except `flies`):
// {"ok": true, "wall": 1789600000.1, "max": 6, "night": false, "time": 6000, "spawn": [0, 64, 0], "players": 3,
//  "flies": [{"id": 12, "name": "Specimen 012", "pos": [x, y, z], "yaw": 1.57, "mode": "surge", "energy": 812.4,
//             "alive": true, "realtime": 0.33, "health": 20, "last_event": [t_ms, "smelled food"], "say": "yum"}],
//  "queue": [{"id": 14, "name": "…"}],                       // assigned flies waiting for a spot (or a count)
//  "food": [{"pos": [x, y, z], "points": 5, "kind": "bread"}], "torches": [[x, y, z]], "mobs": [{"pos": [x, y, z], "kind": "zombie"}]}
//
// The site and the Colony are different origins (www.immortalfly.app, mc.immortalfly.app), so every JSON answer the
// supervisor serves must carry `Access-Control-Allow-Origin: *`, as server.py and flyhost.py do; nginx adds none. On
// hosts that run server code the page also has its own same-origin proxy (/api/colony/…) and falls back to it when the
// direct read is blocked, so a missing header degrades to one more hop rather than to a page that never fills.
import { ARENA_COLORS } from "./arena";
import { CFG } from "./config";
import { colonyOrigin } from "./registry";

export type ColonyFly = {
  id: number; name: string; x: number; y: number; z: number;
  /** direction the bot faces on the map, as a unit vector in (x, z); from `dir`, else from mineflayer's yaw (0 = north, -z; π/2 = west, -x) */
  dx: number; dz: number;
  mode: string; energy: number; alive: boolean; realtime: number | null; health: number | null;
  lastEvent: { t_ms: number; text: string } | null; say: string; since: number | null;
};
export type ColonyPoint = { x: number; y: number; z: number; kind: string; points?: number };
export type ColonyState = {
  ok: boolean; wall: number | null; max: number | null; night: boolean | null; time: number | null; players: number | null;
  spawn: [number, number, number] | null; flies: ColonyFly[]; queue: { id: number; name: string }[]; queued: number;
  food: ColonyPoint[]; torches: ColonyPoint[]; mobs: ColonyPoint[];
};

const num = (v: unknown, d: number | null = null): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
/** A position as `[x, y, z]`, `{x, y, z}`, or `{pos: …}`; null when there is none. */
export function readPos(p: any): [number, number, number] | null {
  if (!p) return null;
  if (Array.isArray(p)) {
    if (p.length >= 3) { const x = num(p[0]), y = num(p[1]), z = num(p[2]); return x === null || y === null || z === null ? null : [x, y, z]; }
    if (p.length === 2) { const x = num(p[0]), z = num(p[1]); return x === null || z === null ? null : [x, 0, z]; }
    return null;
  }
  if (typeof p === "object") { if (p.pos) return readPos(p.pos); const x = num(p.x), z = num(p.z); if (x === null || z === null) return null; return [x, num(p.y, 0) as number, z]; }
  return null;
}
const readEvent = (e: any): ColonyFly["lastEvent"] => {
  if (!e) return null;
  if (Array.isArray(e) && e.length >= 2) return { t_ms: num(e[0], 0) as number, text: String(e[1]) };
  if (typeof e === "string") return { t_ms: 0, text: e };
  if (typeof e === "object") return { t_ms: num(e.t_ms ?? e.t, 0) as number, text: String(e.text ?? e.data ?? e.event ?? "") };
  return null;
};
const readPoints = (l: any, kind: string): ColonyPoint[] => {
  const arr = Array.isArray(l) ? l : l && typeof l === "object" ? Object.values(l) : [];
  const out: ColonyPoint[] = [];
  for (const p of arr) { const pos = readPos(p); if (!pos) continue; const o = p && !Array.isArray(p) && typeof p === "object" ? p : {}; out.push({ x: pos[0], y: pos[1], z: pos[2], kind: String(o.kind || o.type || kind), points: num(o.points) ?? undefined }); }
  return out;
};

/** The supervisor's JSON, read defensively: whatever is missing is empty, whatever is misnamed is tried both ways. */
export function parseColonyState(j: any): ColonyState {
  const src = j && typeof j === "object" ? j : {};
  const fliesRaw = Array.isArray(src.flies) ? src.flies : src.flies && typeof src.flies === "object" ? Object.entries(src.flies).map(([k, v]: [string, any]) => ({ id: Number(k), ...(v || {}) })) : [];
  const flies: ColonyFly[] = [];
  for (const f of fliesRaw) {
    if (!f || typeof f !== "object") continue;
    const id = num(f.id ?? f.fly); if (id === null) continue;
    const pos = readPos(f.pos ?? f.position ?? f) || [0, 0, 0];
    let dx = 0, dz = 1; const dir = readPos(f.dir);
    if (dir && (dir[0] || dir[2])) { const n = Math.hypot(dir[0], dir[2]); dx = dir[0] / n; dz = dir[2] / n; }
    else { const yaw = num(f.yaw); if (yaw !== null) { dx = -Math.sin(yaw); dz = -Math.cos(yaw); } }
    const energy = num(f.energy, 0) as number;
    flies.push({
      id, name: String(f.name || `fly #${id}`), x: pos[0], y: pos[1], z: pos[2], dx, dz,
      mode: String(f.mode || (f.alive === false ? "dead" : "walk")), energy, alive: f.alive === undefined ? energy > 0 : !!f.alive,
      realtime: num(f.realtime), health: num(f.health), lastEvent: readEvent(f.last_event ?? f.lastEvent ?? f.event), say: String(f.say ?? f.speech ?? f.chat ?? ""), since: num(f.since),
    });
  }
  const qRaw = src.queue ?? src.waiting;
  const queue = Array.isArray(qRaw) ? qRaw.map((q: any) => (typeof q === "object" && q ? { id: Number(q.id), name: String(q.name || `fly #${q.id}`) } : { id: Number(q), name: `fly #${q}` })).filter((q) => Number.isFinite(q.id)) : [];
  const queued = Array.isArray(qRaw) ? queue.length : (num(qRaw, 0) as number);
  const spawn = readPos(src.spawn);
  return {
    ok: src.ok !== false, wall: num(src.wall ?? src.t), max: num(src.max ?? src.capacity ?? src.max_flies), night: typeof src.night === "boolean" ? src.night : null,
    time: num(src.time ?? src.time_of_day), players: num(src.players), spawn, flies, queue, queued,
    food: readPoints(src.food, "food"), torches: readPoints(src.torches, "torch"), mobs: readPoints(src.mobs ?? src.hostiles, "mob"),
  };
}

/** The site's same-origin proxy for `origin`'s JSON (src/app/api/colony/[...path]/route.ts), or "" when there is none:
 *  the host has no server (the GitHub Pages export), or `origin` is not the configured Colony (the proxy only ever
 *  reaches that one, so it is never a relay). */
export function colonyProxyBase(origin: string) {
  return CFG.colonyProxy && origin && origin === colonyOrigin() ? `${CFG.basePath}/api/colony` : "";
}
export type ColonyAnswer = { status: number; json: any; via: "direct" | "proxy" };
/** Whichever route answered last is tried first, so a Colony without CORS headers costs one failed request, not one per
 *  poll; after DIRECT_RETRY proxied answers the direct route is tried again, so a Colony that starts sending the header
 *  (or comes back up) is read directly again rather than through the site's server for the rest of the session. */
let preferProxy = false, proxied = 0;
const DIRECT_RETRY = 20;

/** GET `<origin><path>` as JSON within `timeoutMs` per route: directly, and through the same-origin proxy when the
 *  direct request cannot be made or read (the network, or an answer without CORS headers, which the browser reports as
 *  a failed fetch whatever its status). The status is the Colony's (a 502 from nginx while it is down is a 502 here);
 *  `json` is null when the body is not JSON. Null when no route answers at all. Never throws. */
export async function fetchColonyJson(origin: string, path: string, timeoutMs = 4000): Promise<ColonyAnswer | null> {
  if (!origin) return null;
  const proxy = colonyProxyBase(origin);
  // the site's routes end in a slash (next.config trailingSlash); without it every proxied read would be a 308 first
  const direct = { url: `${origin}${path}`, via: "direct" as const }, viaProxy = { url: `${proxy}${path}/`, via: "proxy" as const };
  const routes = proxy ? (preferProxy ? [viaProxy, direct] : [direct, viaProxy]) : [direct];
  for (const { url, via } of routes) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => ctl?.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl?.signal, cache: "no-store" });
      let json: any = null; try { json = await r.json(); } catch {}
      if (proxy) { preferProxy = via === "proxy"; proxied = via === "proxy" ? proxied + 1 : 0; if (proxied >= DIRECT_RETRY) { preferProxy = false; proxied = 0; } }
      return { status: r.status, json, via };
    } catch { /* this route is not available from here: try the other one */ }
    finally { clearTimeout(t); }
  }
  return null;
}

/** GET <origin>/colony/state; null when the Colony does not answer (or answers with an error). Never throws. */
export async function fetchColonyState(origin: string, timeoutMs = 4000): Promise<ColonyState | null> {
  const a = await fetchColonyJson(origin, "/colony/state", timeoutMs);
  if (!a || a.status < 200 || a.status >= 300 || !a.json || typeof a.json !== "object") return null;
  return parseColonyState(a.json);
}

/** True when the Colony at `origin` is running fly `id`: its /fly/<id>/health (brain/HOST_PROTOCOL.md) answers
 *  `{ok: true, …}` and does not say `hosting: false`. False when it is not, when the Colony is down, or when nothing at
 *  `origin` can be read from here. Never throws. */
export async function probeColonyFly(origin: string, id: number, timeoutMs = 4000): Promise<boolean> {
  const a = await fetchColonyJson(origin, `/fly/${id}/health`, timeoutMs);
  return !!(a && a.status >= 200 && a.status < 300 && a.json && a.json.ok && a.json.hosting !== false);
}

/** The world's locomotion mode as a word a person would use, with the Colony's own states. */
export const COLONY_MODE_WORDS: Record<string, string> = { walk: "wandering", wander: "wandering", surge: "following a scent", cast: "casting for the plume", eat: "eating", flee: "fleeing", still: "still", jump: "jumping", dead: "dead", joining: "joining the world", queued: "waiting for a spot" };
export const colonyModeWord = (mode: string | undefined) => (mode ? COLONY_MODE_WORDS[mode] || mode : "—");

const MAP_MIN_SPAN = 64;   // blocks across the map at least, so a colony of one fly is not a dot in an empty square

/** The Colony from above, in the arena's colours: flies as red triangles with their names (grey when dead), food
 *  amber with a faint scent, torches as small amber crosses (where a fly ate), hostile mobs blue. Minecraft's x runs
 *  right and z runs down; the map is centred on the flies and scaled so everything fits. With no state yet, an empty
 *  grid and the `waiting` text. */
export function drawColonyMap(c: HTMLCanvasElement, s: ColonyState | null, pickedId: number | null, waiting = "connecting to the Colony…") {
  const g = c.getContext("2d"); if (!g) return;
  const r = c.getBoundingClientRect(), dpr = Math.min((typeof devicePixelRatio === "number" && devicePixelRatio) || 1, 2); const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  g.clearRect(0, 0, W, H);
  const pad = 26 * dpr;
  const mono = (px: number) => `${Math.round(px * dpr)}px ui-monospace, monospace`;
  // extent: everything that is drawn, centred on the flies (or the spawn), never tighter than MAP_MIN_SPAN
  const pts: { x: number; z: number }[] = [];
  if (s) { for (const f of s.flies) pts.push(f); for (const l of [s.food, s.torches, s.mobs]) for (const p of l) pts.push(p); }
  let cx0 = 0, cz0 = 0;
  if (s && s.flies.length) { cx0 = s.flies.reduce((a, f) => a + f.x, 0) / s.flies.length; cz0 = s.flies.reduce((a, f) => a + f.z, 0) / s.flies.length; }
  else if (s && s.spawn) { cx0 = s.spawn[0]; cz0 = s.spawn[2]; }
  else if (pts.length) { cx0 = pts.reduce((a, p) => a + p.x, 0) / pts.length; cz0 = pts.reduce((a, p) => a + p.z, 0) / pts.length; }
  let half = MAP_MIN_SPAN / 2;
  for (const p of pts) half = Math.max(half, Math.abs(p.x - cx0) + 4, Math.abs(p.z - cz0) + 4);
  half = Math.min(half, 400);   // a mob a thousand blocks away does not shrink the flies to nothing
  const sc = Math.min(W - 2 * pad, H - 2 * pad) / (2 * half), cx = W / 2, cy = H / 2;
  const P = (x: number, z: number) => [cx + (x - cx0) * sc, cy + (z - cz0) * sc];
  // grid every 8 blocks (a chunk is 16), labelled at the edges in world coordinates
  const step = half > 160 ? 64 : half > 80 ? 32 : half > 40 ? 16 : 8;
  g.strokeStyle = "rgba(232,230,224,0.06)"; g.lineWidth = 1;
  const x0 = Math.floor((cx0 - half) / step) * step, z0 = Math.floor((cz0 - half) / step) * step;
  for (let v = x0; v <= cx0 + half; v += step) { const [x] = P(v, 0); if (x < 0 || x > W) continue; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let v = z0; v <= cz0 + half; v += step) { const [, y] = P(0, v); if (y < 0 || y > H) continue; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.strokeStyle = "rgba(232,230,224,0.35)"; g.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
  if (!s) { g.fillStyle = "rgba(232,230,224,0.4)"; g.font = mono(11); g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(waiting, cx, cy); return; }
  g.save(); g.beginPath(); g.rect(pad, pad, W - 2 * pad, H - 2 * pad); g.clip();
  // food: a scent (the odor plume the receptors smell, 32 blocks in the mapping) and the item
  for (const fd of s.food) { const [x, y] = P(fd.x, fd.z); const rad = Math.max(10 * dpr, 12 * sc); const grd = g.createRadialGradient(x, y, 0, x, y, rad); grd.addColorStop(0, "rgba(240,180,41,0.22)"); grd.addColorStop(1, "rgba(240,180,41,0)"); g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); }
  for (const fd of s.food) { const [x, y] = P(fd.x, fd.z); g.fillStyle = ARENA_COLORS.food; g.beginPath(); g.arc(x, y, Math.max(2.5 * dpr, 0.6 * sc), 0, 7); g.fill(); if (fd.points) { g.fillStyle = "rgba(232,230,224,0.55)"; g.font = mono(9); g.textAlign = "left"; g.textBaseline = "alphabetic"; g.fillText(`${fd.points} s`, x + 5 * dpr, y - 4 * dpr); } }
  // torches: where a fly ate; a landmark the others see as light
  for (const t of s.torches) { const [x, y] = P(t.x, t.z); const a = 3 * dpr; g.strokeStyle = "rgba(240,180,41,0.75)"; g.lineWidth = Math.max(1, 1.1 * dpr); g.beginPath(); g.moveTo(x - a, y); g.lineTo(x + a, y); g.moveTo(x, y - a); g.lineTo(x, y + a); g.stroke(); }
  // hostile mobs: what the looming detectors see
  for (const m of s.mobs) { const [x, y] = P(m.x, m.z); g.fillStyle = "rgba(88,196,245,0.85)"; g.beginPath(); g.arc(x, y, Math.max(3 * dpr, 0.5 * sc), 0, 7); g.fill(); g.fillStyle = "rgba(88,196,245,0.7)"; g.font = mono(8.5); g.textAlign = "left"; g.textBaseline = "alphabetic"; g.fillText(m.kind, x + 5 * dpr, y + 3 * dpr); }
  // flies: red triangles pointing where the bot faces, named; the picked one ringed
  for (const f of s.flies) {
    const [x, y] = P(f.x, f.z); const ang = Math.atan2(f.dz, f.dx);
    if (pickedId !== null && f.id === pickedId) { g.strokeStyle = "rgba(255,90,53,0.5)"; g.lineWidth = Math.max(1, 1.2 * dpr); g.beginPath(); g.arc(x, y, 11 * dpr, 0, 7); g.stroke(); }
    g.save(); g.translate(x, y); g.rotate(ang); g.fillStyle = f.alive ? ARENA_COLORS.fly : ARENA_COLORS.dead;
    const L = Math.max(7 * dpr, 1.2 * sc); g.beginPath(); g.moveTo(L, 0); g.lineTo(-L * 0.6, L * 0.45); g.lineTo(-L * 0.6, -L * 0.45); g.closePath(); g.fill(); g.restore();
    g.fillStyle = f.alive ? "rgba(232,230,224,0.85)" : "rgba(232,230,224,0.45)"; g.font = mono(10); g.textAlign = "left"; g.textBaseline = "alphabetic"; g.fillText(`#${f.id} ${f.name}`, x + 9 * dpr, y - 7 * dpr);
  }
  g.restore();
  g.fillStyle = "rgba(232,230,224,0.35)"; g.font = mono(9.5); g.textAlign = "left"; g.textBaseline = "bottom";
  const n = s.flies.length;
  g.fillText(`${Math.round(2 * half)} × ${Math.round(2 * half)} blocks · ${n} ${n === 1 ? "fly" : "flies"} · ${s.food.length} food · ${s.torches.length} torch${s.torches.length === 1 ? "" : "es"} · ${s.mobs.length} mob${s.mobs.length === 1 ? "" : "s"}${s.night ? " · night" : ""}`, pad + 8 * dpr, H - pad - 6 * dpr);
  g.textAlign = "right"; g.fillText(`x ${Math.round(cx0)} · z ${Math.round(cz0)} · N up`, W - pad - 8 * dpr, H - pad - 6 * dpr);
}
