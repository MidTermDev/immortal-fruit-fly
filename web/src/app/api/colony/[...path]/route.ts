// Same-origin proxy for the Colony's read-only JSON (COLONY.md; brain/colony/colony.py behind mc.immortalfly.app).
// The site (www.immortalfly.app) and the Colony are different origins, and a browser may only read a cross-origin
// answer that carries Access-Control-Allow-Origin; nginx in front of the Colony adds none, so without the header from
// the supervisor itself the /colony page would sit at "not answering" for ever while the world was in fact running.
// Through here the browser asks its own origin (lib/colony.ts tries the Colony directly first, then this).
// Vercel (or any Node host) only: the GitHub Pages export has no server and reads the Colony directly.
// Only GET, only the endpoints the site reads, only the configured Colony: never a relay. No secrets are involved.
import { CFG } from "@/lib/config";

export const dynamic = "force-dynamic";

/** The Colony's origin as the server sees it: COLONY_URL (server-side), else the development override, else the fixed public origin. */
const UPSTREAM = (process.env.COLONY_URL || process.env.NEXT_PUBLIC_COLONY_URL || CFG.colonyUrl).replace(/\/+$/, "");
/** What the site reads: the colony state, and one fly's health, lite frame and state (brain/HOST_PROTOCOL.md). */
const ALLOWED = /^(colony\/state|fly\/\d{1,9}\/(health|frame|state))$/;
const TIMEOUT_MS = 6000;

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const p = (path || []).join("/");
  if (!ALLOWED.test(p)) return json({ ok: false, error: "not proxied" }, 404);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${UPSTREAM}/${p}`, { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
    const text = await r.text();
    const type = r.headers.get("content-type") || "";
    // a 502 page from nginx while the Colony is down is not JSON: say so in the shape the page reads
    if (!/json/i.test(type)) return json({ ok: false, error: `the Colony answered ${r.status} without JSON`, status: r.status }, r.status >= 400 ? r.status : 502);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return json({ ok: false, error: "the Colony did not answer" }, 502);
  } finally { clearTimeout(t); }
}
