import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Newsreader } from "next/font/google";
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
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
