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
  description: "Immortal fruit flies on BNB Chain: whole FlyWire brains that live in bodies, die, and come back, with identity, brain state, memory, lineage and history on-chain. Mint one for 1 $FLY.",
  metadataBase: new URL("https://midtermdev.github.io/immortal-fruit-fly/"),
  openGraph: { title: "Immortal Fruit Fly", description: "Whole fruit-fly brains that die in one body and wake in another, anchored on BNB Chain.", images: ["brand/og.png"] },
  icons: { icon: `${CFG.basePath}/brand/fly_400.png` },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <div className="wrap">
            <Link className="brand" href="/"><span className="glyph">(@@)</span> Immortal Fruit Fly</Link>
            <nav className="nav">
              <Link href="/#organism">Specimen 001</Link><Link href="/flies/">Flies</Link><Link href="/#care">Care</Link><Link href="/#circuit">Circuit</Link>
              <Link href="/docs/vision/">Vision</Link><Link href="/docs/">Docs</Link>
            </nav>
            <span className="spacer" />
            <a className="btn sm" href={CFG.links.github} target="_blank" rel="noopener">Source</a>
            <Link className="btn sm fill" href="/flies/">Mint a fly</Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
