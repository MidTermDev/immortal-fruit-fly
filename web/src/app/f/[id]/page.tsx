// /f/<id>: the same specimen page as /fly/?id=<id>, at an address whose link unfurls into the fly's own card
// (title, description and /api/og/<id>) on X and Telegram. Vercel only, like the other dynamic routes.
import type { Metadata } from "next";
import { Suspense } from "react";
import Specimen from "@/components/Specimen";
import { CFG } from "@/lib/config";

export const dynamic = "force-dynamic";
const INDEX = (process.env.INDEX_URL || CFG.colonyUrl + "/registry").replace(/\/+$/, "");

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id: raw } = await params; const id = parseInt(raw, 10) || 0;
  let name = `Fly #${id}`, line = "A whole fruit-fly brain, 139,248 neurons, alive on BNB Smart Chain.";
  try {
    const r = await fetch(`${INDEX}/fly/${id}.json`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (r.ok) { const f = (await r.json()).fly; name = f.name || name; line = `${f.alive ? "Alive" : "Dead, brain preserved"} · generation ${f.gen} · ${f.deaths ? `died ${f.deaths}× and came back` : "never died"} · a whole fruit-fly brain on BNB Smart Chain.`; }
  } catch {}
  const spec = `Specimen ${String(id).padStart(3, "0")}`;
  const title = name.toLowerCase() === spec.toLowerCase() ? spec : `${name} · ${spec}`;
  const image = `${CFG.site}/api/og/${id}/`;   // with the slash: the site redirects without it, and not every crawler follows
  return { title, description: line, openGraph: { title, description: line, images: [{ url: image, width: 1200, height: 630 }], url: `${CFG.site}/f/${id}` }, twitter: { card: "summary_large_image", title, description: line, images: [image] } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params; const id = parseInt(raw, 10) || 0;
  return <Suspense fallback={<main className="wrap" style={{ padding: "60px 0" }}>…</main>}><Specimen idProp={id} /></Suspense>;
}
