import type { Metadata } from "next";
import { Suspense } from "react";
import ArcadeDashboard from "@/components/ArcadeDashboard";

export const metadata: Metadata = { title: "Arcade · Recorded decisions" };

export default function ArcadePage() {
  return <Suspense fallback={<main className="fly-dashboard">Loading arcade records…</main>}><ArcadeDashboard /></Suspense>;
}
