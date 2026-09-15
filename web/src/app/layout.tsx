import type { Metadata } from "next";
import { Syne, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { CFG } from "@/lib/config";

const display = Syne({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-display", display: "swap" });
const body = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Immortal Fruit Fly", template: "%s · Immortal Fruit Fly" },
  description: "A real fruit-fly neural circuit from the FlyWire connectome, alive on BNB Smart Chain. Feed it, poke it, watch it think.",
  metadataBase: new URL("https://midtermdev.github.io/immortal-fruit-fly/"),
  openGraph: { title: "Immortal Fruit Fly", description: "The fly brain lives on-chain.", images: ["brand/og.png"] },
  icons: { icon: `${CFG.basePath}/brand/fly_400.png` },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="topbar">
          <div className="wrap">
            <Link className="brand" href="/"><span className="glyph">(@@)</span> IMMORTAL FRUIT FLY</Link>
            <nav className="nav"><Link href="/#play">Play</Link><Link href="/#brain">Brain</Link><Link href="/docs/">Docs</Link><Link href="/docs/vision/">Vision</Link><Link href="/docs/roadmap/">Roadmap</Link></nav>
            <span className="spacer" />
            <a className="btn small ghost" href={CFG.links.github} target="_blank" rel="noopener">GitHub</a>
            <a className="btn small gold" href={CFG.links.pancake + CFG.token} target="_blank" rel="noopener">Buy $FLY</a>
          </div>
        </header>
        {children}
        <footer>
          <div className="wrap">
            <div>Immortal Fruit Fly · not financial advice · it is a fly</div>
            <div className="links"><a href={CFG.links.x} target="_blank" rel="noopener">X</a><a href={CFG.links.telegram} target="_blank" rel="noopener">Telegram</a><a href={CFG.links.github} target="_blank" rel="noopener">GitHub</a><a href={`${CFG.explorer}/address/${CFG.brain}`} target="_blank" rel="noopener">FlyBrain on BscScan</a></div>
          </div>
        </footer>
      </body>
    </html>
  );
}
