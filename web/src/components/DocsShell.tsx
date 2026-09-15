import Link from "next/link";

const NAV = [
  { h: "Start", items: [["/docs/", "Overview"], ["/docs/vision/", "The vision"], ["/docs/play/", "How to play"]] },
  { h: "Under the hood", items: [["/docs/how-it-works/", "How the brain runs on-chain"], ["/docs/contracts/", "Contracts & addresses"], ["/docs/circuit/", "The circuit, neuron by neuron"]] },
  { h: "Where it goes", items: [["/docs/roadmap/", "Roadmap"], ["/docs/pebbles/", "Pebbles: the fly in hardware"], ["/docs/trend/", "The fly-brain trend"], ["/docs/science/", "Science & sources"]] },
];

export default function DocsShell({ current, children }: { current: string; children: React.ReactNode }) {
  return (
    <main className="wrap docs">
      <nav className="docs-nav" aria-label="Documentation">
        {NAV.map((g) => (<div key={g.h}><p className="eyebrow">{g.h}</p>{g.items.map(([href, label]) => <Link key={href} href={href} className={href === current ? "on" : ""}>{label}</Link>)}</div>))}
      </nav>
      <article className="prose">{children}</article>
    </main>
  );
}
