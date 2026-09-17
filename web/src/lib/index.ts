// The registry index (brain/index.py behind https://mc.immortalfly.app/registry/): every fly's record, owner and name,
// read from FlyRegistry v3 once a minute and served as JSON with CORS. The site reads it for what a browser cannot do
// against the chain in reasonable time (which flies a wallet owns, the whole collection with filters, the
// leaderboards). It is a read model: a fly's own page still reads the registry, and every number here says the block
// it was read at. When the index is down the pages fall back to the chain where they can, and say so where they cannot.
import { CFG } from "./config";
import { ZERO } from "./registry";

/** One fly as the index serves it (compact keys). `body`/`pending` are lower-case addresses or "" for none. */
export type IdxFly = {
  id: number; name: string; owner: string; gen: number; deaths: number; pa: number; pb: number; step: number; energy: number;
  born: number; commit: number; body: string; pending: string; alive: boolean; state: string;
};
export type Leader = { id: number; name: string; alive: boolean; value: number };
export type Keeper = { owner: string; flies: number; alive: number };
export type Leaders = {
  block: number; at: number;
  totals: { flies: number; alive: number; dead: number; running: number; dormant: number; owners: number; bred: number; deaths: number; steps: number; where: Record<string, number>; life_banked: number };
  oldest_alive: Leader[]; longest_lived: Leader[]; most_lives: Leader[]; highest_generation: Leader[]; biggest_brood: Leader[]; most_life: Leader[]; newest: Leader[]; top_keepers: Keeper[];
};
export type IdxAll = { block: number; at: number; total: number; bodies: Record<string, string>; flies: IdxFly[] };

export const INDEX = (process.env.NEXT_PUBLIC_INDEX_URL || CFG.colonyUrl + "/registry").replace(/\/+$/, "");
const TIMEOUT_MS = 12000;

async function get<T>(path: string): Promise<T | null> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${INDEX}/${path}`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; } finally { clearTimeout(t); }
}

export const fetchLeaders = () => get<Leaders>("leaders.json");
export const fetchAll = () => get<IdxAll>("flies.json");
export const fetchOwned = async (owner: string) => { const r = await get<{ block: number; flies: IdxFly[] }>(`owner/${owner.toLowerCase()}`); return r ? r.flies : null; };
/** The 320 px portrait the index serves from the curator's file; the fly pages keep using the IPFS original. */
export const portraitUrl = (id: number) => `${INDEX}/portrait/${id}.png`;

/** The index's compact record in the shape the cards read (lib/registry FlyRecord), for the fields the index has. */
export function toRecord(f: IdxFly) {
  return {
    id: f.id, name: f.name, owner: f.owner, uri: "", connectome: "", model: 0, generation: f.gen, deaths: f.deaths, parentA: f.pa, parentB: f.pb,
    stateRoot: f.state, memoryRoot: "", stateURI: "", brainStep: f.step, energy: f.energy, bornBlock: f.born, lastCommitBlock: f.commit,
    body: f.body || ZERO, pendingBody: f.pending || ZERO, alive: f.alive,
  };
}

export type Filter = "all" | "alive" | "running" | "dormant" | "dead" | "colony" | "bred";
export type Sort = "newest" | "oldest" | "lives" | "longest" | "generation" | "energy";
export const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" }, { key: "alive", label: "alive" }, { key: "running", label: "running in a body" }, { key: "dormant", label: "dormant" }, { key: "dead", label: "dead" }, { key: "colony", label: "in the Colony" }, { key: "bred", label: "bred" },
];
export const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "newest first" }, { key: "oldest", label: "oldest first" }, { key: "lives", label: "most lives" }, { key: "longest", label: "longest lived" }, { key: "generation", label: "highest generation" }, { key: "energy", label: "most life banked" },
];

/** Filter, search and sort the index's list in the browser: 3,268 records is nothing for a phone. */
export function select(all: IdxFly[], filter: Filter, sort: Sort, q: string, owner?: string, bodies: Record<string, string> = {}) {
  const colony = Object.entries(bodies).find(([, n]) => n === "colony")?.[0] || CFG.bodies.colony.toLowerCase();
  const needle = q.trim().toLowerCase();
  const idq = /^#?\d+$/.test(needle) ? parseInt(needle.replace("#", ""), 10) : 0;
  let rows = all;
  if (owner) rows = rows.filter((f) => f.owner === owner.toLowerCase());
  if (filter === "alive") rows = rows.filter((f) => f.alive);
  else if (filter === "running") rows = rows.filter((f) => f.alive && !!f.body);
  else if (filter === "dormant") rows = rows.filter((f) => f.alive && !f.body);
  else if (filter === "dead") rows = rows.filter((f) => !f.alive);
  else if (filter === "colony") rows = rows.filter((f) => f.alive && f.body === colony);
  else if (filter === "bred") rows = rows.filter((f) => f.pa > 0);
  if (needle) rows = rows.filter((f) => (idq && f.id === idq) || f.name.toLowerCase().includes(needle) || (needle.startsWith("0x") && f.owner.startsWith(needle)));
  const by: Record<Sort, (a: IdxFly, b: IdxFly) => number> = {
    newest: (a, b) => b.id - a.id, oldest: (a, b) => a.born - b.born || a.id - b.id, lives: (a, b) => b.deaths - a.deaths || a.id - b.id,
    longest: (a, b) => b.step - a.step || a.id - b.id, generation: (a, b) => b.gen - a.gen || a.id - b.id, energy: (a, b) => b.energy - a.energy || a.id - b.id,
  };
  return rows.slice().sort(by[sort]);
}
