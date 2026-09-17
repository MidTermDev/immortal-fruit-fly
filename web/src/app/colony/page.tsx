import type { Metadata } from "next";
import { Suspense } from "react";
import Colony from "@/components/Colony";
import { CFG } from "@/lib/config";

export const metadata: Metadata = {
  title: "The Colony",
  description: "Immortal Fruit Flies living together in a shared Minecraft world on the VPS, each running its whole brain: the live world, a colony map, and the picked fly's 139,248 neurons firing as it walks.",
  alternates: { canonical: `${CFG.site}/colony/` },
};

export default function Page() { return <Suspense fallback={<main className="wrap" style={{ padding: "60px 0" }}>…</main>}><Colony /></Suspense>; }
