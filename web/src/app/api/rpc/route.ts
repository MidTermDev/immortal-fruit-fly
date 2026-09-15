// Server-side JSON-RPC proxy. Set RPC_URL in the host's environment (Vercel: Project → Settings →
// Environment Variables). The browser only ever sees /api/rpc, so the endpoint key stays private.
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["eth_blockNumber", "eth_call", "eth_getLogs", "eth_getBlockByNumber", "eth_chainId", "eth_estimateGas", "eth_gasPrice",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBalance", "eth_getCode", "net_version", "eth_feeHistory", "eth_maxPriorityFeePerGas"]);

export async function POST(req: Request) {
  const url = process.env.RPC_URL;
  if (!url) return new Response(JSON.stringify({ error: "RPC_URL not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls) if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method)) return new Response(JSON.stringify({ error: "method not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
