import type { Metadata } from "next";
import { Suspense } from "react";
import Collection from "@/components/Collection";

export const metadata: Metadata = { title: "Immortal Fruit Flies · the collection", description: "Every immortal fruit fly on BNB Smart Chain: who is alive, where each one is running, the elders, the most lives, the bloodlines. Mint for 1 $FLY." };

export default function Page() { return <Suspense fallback={<main className="wrap" style={{ padding: "60px 0" }}>…</main>}><Collection /></Suspense>; }
