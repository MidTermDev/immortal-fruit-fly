// Fallback token metadata, generated from the chain. FlyRegistry.tokenURI(id) returns the per-fly IPFS
// metadata once a body or the curator has set one; before that it falls back to baseURI + id, which can
// point here (Vercel only; needs RPC_URL). Never the source of truth: the registry is.
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import REGISTRY_ABI from "@/data/registry.abi.json";

export const dynamic = "force-dynamic";
const COLLECTION_IMAGE = "ipfs://QmW6hnaa3vvRPnvyGJTWwBSygn3dWMTosLgC8TXWR9gAGy";
const ZERO = "0x0000000000000000000000000000000000000000";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = parseInt(String(raw).replace(/\.json$/, ""), 10);
  const url = process.env.RPC_URL || CFG.publicRpc;
  if (!id || id < 1) return new Response(JSON.stringify({ error: "bad id" }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const provider = new ethers.JsonRpcProvider(url, CFG.chainId, { staticNetwork: true });
    const reg = new ethers.Contract(CFG.registry, REGISTRY_ABI as any, provider);
    const f = await reg.fly(id);
    if (!Number(f.bornBlock)) return new Response(JSON.stringify({ error: "no such fly" }), { status: 404, headers: { "content-type": "application/json" } });
    const [name, uri] = await Promise.all([reg.flyName(id), reg.tokenURI(id)]);
    // If the registry already points at real metadata on IPFS, serve that rather than a synthetic copy.
    if (typeof uri === "string" && uri.startsWith("ipfs://")) {
      try { const r = await fetch(CFG.ipfsGateway + uri.slice(7), { headers: { "user-agent": "immortal-fruit-fly/1" } }); if (r.ok) return new Response(await r.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } }); } catch {}
    }
    const alive = Boolean(f.alive), body = String(f.body);
    const bodyName = body === ZERO ? "none" : body.toLowerCase() === CFG.bodies.arena.toLowerCase() ? "Arena" : body.toLowerCase() === CFG.bodies.doom.toLowerCase() ? "DOOM" : body;
    const meta = {
      name: `${name || `Fly #${id}`} · Fly #${id}`,
      description: `A living fruit-fly brain on BNB Smart Chain: 139,248 neurons of the FlyWire connectome running the published whole-brain model. Brain state ${String(f.stateRoot).slice(0, 14)}… is committed on-chain${f.stateURI ? `; the bytes are at ${f.stateURI}` : " (genesis state)"}. ${alive ? "It dies when it starves and can be woken by anyone." : "It is dead: its brain is frozen at exactly this state and it cannot be sold until someone resurrects it."} Everything it has lived through, in every body, is in its interaction history.`,
      image: COLLECTION_IMAGE,
      external_url: `https://midtermdev.github.io/immortal-fruit-fly/fly/?id=${id}`,
      attributes: [
        { trait_type: "Generation", value: Number(f.generation) }, { trait_type: "Deaths", value: Number(f.deaths) },
        { trait_type: "Status", value: alive ? "alive" : "dead (brain preserved)" }, { trait_type: "Energy (s)", value: Number(f.energy) },
        { trait_type: "Brain step", value: Number(f.brainStep) }, { trait_type: "Body", value: bodyName },
        { trait_type: "Neurons", value: 139248 }, { trait_type: "Connectome", value: "FlyWire 783" },
        { trait_type: "Lineage", value: Number(f.parentA) ? `child of #${f.parentA} and #${f.parentB}` : "genesis" },
      ],
    };
    return new Response(JSON.stringify(meta), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
  } catch (e: any) {
    // ERC721NonexistentToken(uint256) is selector 0x7e273289; ethers reports it as an unknown custom error.
    const nonexistent = /nonexistent|ERC721/i.test(String(e?.message || e?.reason || "")) || String(e?.data || "").startsWith("0x7e273289") || /unknown custom error/.test(String(e?.message || ""));
    return new Response(JSON.stringify({ error: nonexistent ? "no such fly" : "chain unavailable" }), { status: nonexistent ? 404 : 503, headers: { "content-type": "application/json" } });
  }
}
