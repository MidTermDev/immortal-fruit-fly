import Link from "next/link";
import type { ReactNode } from "react";
import { CFG } from "@/lib/config";

export default function SiteHeader({ current, wallet }: { current: "fly" | "docs"; wallet?: ReactNode }) {
  return (
    <header className="site-header">
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="site-header-inner">
        <Link className="site-brand" href="/" aria-label="Immortal Fruit Fly home">
          <svg className="brand-mark" viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true">
            <path d="M14 11C8-2 0 8 10 17M14 11C20-2 28 8 18 17" stroke="currentColor" strokeWidth="1.5" />
            <ellipse cx="14" cy="17" rx="3" ry="7" fill="currentColor" />
            <path d="m11 15-5 3m11-3 5 3M11 19l-4 5m10-5 4 5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span>Immortal <span className="brand-fruit">Fruit </span>Fly</span>
        </Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link className="dashboard-link" href="/" aria-current={current === "fly" ? "page" : undefined}>The fly</Link>
          <Link href="/docs/" aria-current={current === "docs" ? "page" : undefined}>Docs</Link>
        </nav>
        <div className="header-action">{wallet ?? <a className="header-source" href={CFG.links.github} target="_blank" rel="noopener noreferrer">GitHub ↗</a>}</div>
      </div>
    </header>
  );
}
