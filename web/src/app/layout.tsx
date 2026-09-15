import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Newsreader } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { CFG } from "@/lib/config";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans", display: "swap" });
const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Immortal Fruit Fly", template: "%s · Immortal Fruit Fly" },
  description: "Specimen 001: a real fruit-fly compass circuit from the FlyWire connectome, kept alive on BNB Smart Chain by whoever feeds it.",
  metadataBase: new URL("https://midtermdev.github.io/immortal-fruit-fly/"),
  openGraph: { title: "Immortal Fruit Fly", description: "A living fruit-fly circuit, kept alive on a blockchain.", images: ["brand/og.png"] },
  icons: { icon: `${CFG.basePath}/brand/fly_400.png` },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <div className="runhead">
          <div className="wrap">
            <span>Specimen 001</span>
            <span className="hide-s">Drosophila melanogaster · head-direction ring</span>
            <span className="sep" />
            <span className="hide-s">FlyWire 783</span>
            <span>BNB Smart Chain</span>
          </div>
        </div>
        <header className="topbar">
          <div className="wrap">
            <Link className="brand" href="/"><span className="glyph">(@@)</span> Immortal Fruit Fly</Link>
            <nav className="nav">
              <Link href="/#signs">Vital signs</Link><Link href="/#care">Care</Link><Link href="/#circuit">Circuit</Link>
              <Link href="/docs/vision/">Vision</Link><Link href="/docs/">Docs</Link>
            </nav>
            <span className="spacer" />
            <a className="btn sm" href={CFG.links.github} target="_blank" rel="noopener">Source</a>
            <a className="btn sm fill" href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener">Get $FLY</a>
          </div>
        </header>
        {children}
        <footer>
          <div className="wrap">
            <div>
              <p style={{ color: "var(--ink-2)", maxWidth: "46ch" }}>An organism made of public connectome data, kept alive by whoever feeds it. Not financial advice. It is a fly.</p>
              <div className="links">
                <a href={CFG.links.x} target="_blank" rel="noopener">X</a>
                <a href={CFG.links.telegram} target="_blank" rel="noopener">Telegram</a>
                <a href={CFG.links.github} target="_blank" rel="noopener">GitHub</a>
                <a href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener">BscScan</a>
                <a href={CFG.links.sourcify + CFG.brain} target="_blank" rel="noopener">Verified source</a>
              </div>
            </div>
            <div className="cite">
              Circuit: Dorkenwald et al. &amp; Schlegel et al., <i>Nature</i> 632 (2024), FlyWire release 783.<br />
              Connectivity: doi:10.5281/zenodo.10676866<br />
              Organism: FlyBrain, BNB Smart Chain 56, {CFG.brain}
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
