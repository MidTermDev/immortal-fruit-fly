import type { Metadata } from "next";
import { Suspense } from "react";
import Specimen from "@/components/Specimen";

export const metadata: Metadata = { title: "Specimen", description: "One immortal fruit fly: its brain state, lineage, and everything that has happened to it, on BNB Smart Chain." };

export default function Page() { return <Suspense fallback={<main className="wrap" style={{ padding: "60px 0" }}>…</main>}><Specimen /></Suspense>; }
