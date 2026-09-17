import type { NextConfig } from "next";

const isPages = process.env.GITHUB_PAGES === "true";
// Static export for GitHub Pages; on Vercel (or any Node host) the /api/rpc proxy is available.
const proxy = !isPages && !!process.env.RPC_URL;

const nextConfig: NextConfig = {
  output: isPages ? "export" : undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: isPages ? "/immortal-fruit-fly" : "",
  assetPrefix: isPages ? "/immortal-fruit-fly/" : undefined,
  reactStrictMode: true,
  // NEXT_PUBLIC_COLONY_PROXY: the same-origin proxy for the Colony's JSON (/api/colony/…) exists wherever server code runs.
  env: { NEXT_PUBLIC_BASE_PATH: isPages ? "/immortal-fruit-fly" : "", NEXT_PUBLIC_RPC_PROXY: proxy ? "1" : "0", NEXT_PUBLIC_COLONY_PROXY: isPages ? "0" : "1" },
};

export default nextConfig;
