import type { NextConfig } from "next";

const isPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: isPages ? "/immortal-fruit-fly" : "",
  assetPrefix: isPages ? "/immortal-fruit-fly/" : undefined,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE_PATH: isPages ? "/immortal-fruit-fly" : "" },
};

export default nextConfig;
