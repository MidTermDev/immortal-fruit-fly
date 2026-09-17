// The card a fly's link unfurls into on X and Telegram (1200×630): its portrait, name, status and record. Read from the
// registry index (one request, with the portrait it serves), else from the chain. Vercel only, like the other routes.
import { ImageResponse } from "next/og";
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import REGISTRY_ABI from "@/data/registry.abi.json";

export const dynamic = "force-dynamic";
const INDEX = (process.env.INDEX_URL || CFG.colonyUrl + "/registry").replace(/\/+$/, "");
const ZERO = "0x0000000000000000000000000000000000000000";
const fmt = (n: number) => n.toLocaleString("en-US");
const dur = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h >= 48 ? `${Math.floor(h / 24)} d` : h ? `${h} h ${m} min` : `${m} min`; };

type Rec = { id: number; name: string; alive: boolean; body: string; energy: number; gen: number; deaths: number; step: number; pa: number; owner: string };

async function fromIndex(id: number): Promise<Rec | null> {
  try {
    const r = await fetch(`${INDEX}/fly/${id}.json`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json(); const f = j.fly;
    return { id, name: f.name, alive: f.alive, body: f.body || "", energy: f.energy, gen: f.gen, deaths: f.deaths, step: f.step, pa: f.pa, owner: f.owner };
  } catch { return null; }
}
async function fromChain(id: number): Promise<Rec | null> {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || CFG.publicRpc, CFG.chainId, { staticNetwork: true });
    const reg = new ethers.Contract(CFG.registry, REGISTRY_ABI as any, provider);
    const [f, name, owner] = await Promise.all([reg.fly(id), reg.flyName(id), reg.ownerOf(id)]);
    if (!Number(f.bornBlock)) return null;
    return { id, name, alive: Boolean(f.alive), body: String(f.body) === ZERO ? "" : String(f.body).toLowerCase(), energy: Number(f.energy), gen: Number(f.generation), deaths: Number(f.deaths), step: Number(f.brainStep), pa: Number(f.parentA), owner: String(owner).toLowerCase() };
  } catch { return null; }
}
const where = (body: string) => { const b = body.toLowerCase(); if (!b) return "dormant"; if (b === CFG.bodies.arena.toLowerCase()) return "in the arena"; if (b === CFG.bodies.colony.toLowerCase()) return "in the Colony"; if (b === CFG.bodies.doom.toLowerCase()) return "in DOOM"; return "in a pebble"; };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = parseInt(String(raw).replace(/\.png$/, ""), 10);
  if (!id || id < 1) return new Response("bad id", { status: 400 });
  const f = (await fromIndex(id)) || (await fromChain(id));
  const status = !f ? "" : f.alive ? (f.body ? `alive · ${where(f.body)}` : "alive · dormant") : "dead · brain preserved";
  const color = !f ? "#8a919c" : f.alive ? (f.body ? "#58c4f5" : "#f0b429") : "#e2341a";
  // the portrait: the index serves a 320 px copy; a missing one leaves the frame dark
  let portrait = "";
  try { const r = await fetch(`${INDEX}/portrait/${id}.png`, { signal: AbortSignal.timeout(4000) }); if (r.ok) portrait = `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; } catch {}
  return new ImageResponse(
    (
      <div style={{ width: 1200, height: 630, display: "flex", background: "#0d0f12", color: "#e8e6e0", fontFamily: "sans-serif" }}>
        <div style={{ width: 470, height: 630, display: "flex", alignItems: "center", justifyContent: "center", background: "#161a1f", borderRight: "1px solid rgba(232,230,224,0.13)" }}>
          {portrait ? <img src={portrait} width={400} height={400} style={{ width: 400, height: 400 }} /> : <div style={{ fontSize: 120, color: "#3a4048" }}>{"(@@)"}</div>}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "56px 56px 48px", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 22, letterSpacing: 4, color: "#e2341a", textTransform: "uppercase" }}>
              <span>Specimen {String(id).padStart(3, "0")}</span>
              {f && <span style={{ color, border: `1px solid ${color}`, padding: "2px 12px", fontSize: 18, letterSpacing: 3 }}>{status}</span>}
            </div>
            <div style={{ fontSize: f && f.name.length > 18 ? 56 : 72, fontWeight: 700, letterSpacing: -2, marginTop: 18, lineHeight: 1.05 }}>{f ? f.name || `Fly #${id}` : `Fly #${id}`}</div>
            <div style={{ fontSize: 26, color: "#8a919c", marginTop: 22, lineHeight: 1.4 }}>{f ? `A whole fruit-fly brain, 139,248 neurons, ${f.pa ? `bred from #${f.pa}` : "a genesis fly"}, generation ${f.gen}${f.deaths ? `, died ${f.deaths}× and came back` : ""}.` : "A whole fruit-fly brain on BNB Smart Chain."}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div style={{ display: "flex", gap: 40 }}>
              {f && <div style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: 16, letterSpacing: 3, color: "#8a919c" }}>LIFE BANKED</span><span style={{ fontSize: 34, marginTop: 4 }}>{f.alive ? dur(f.energy) : "—"}</span></div>}
              {f && <div style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: 16, letterSpacing: 3, color: "#8a919c" }}>BRAIN TIME</span><span style={{ fontSize: 34, marginTop: 4 }}>{dur(Math.floor(f.step / 10000))}</span></div>}
              {f && <div style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: 16, letterSpacing: 3, color: "#8a919c" }}>LIVES</span><span style={{ fontSize: 34, marginTop: 4 }}>{f.deaths + 1}</span></div>}
            </div>
            <div style={{ fontSize: 22, letterSpacing: 3, color: "#e2341a" }}>immortalfly.app</div>
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, headers: { "cache-control": "public, max-age=120, s-maxage=120" } },
  );
}
