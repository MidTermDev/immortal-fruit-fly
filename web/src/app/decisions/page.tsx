import { Suspense } from "react";
import DecisionsDashboard from "@/components/DecisionsDashboard";
export default function DecisionsPage() { return <Suspense fallback={<main className="fly-dashboard">Loading decisions…</main>}><DecisionsDashboard /></Suspense>; }
