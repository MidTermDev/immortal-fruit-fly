export const CFG = {
  chainId: 56,
  chainName: "BNB Smart Chain",
  // Order of preference: a direct public RPC from the environment, the server-side proxy
  // (Vercel: set RPC_URL, never exposed to the browser), then public endpoints.
  rpc: [
    ...(process.env.NEXT_PUBLIC_RPC_URL ? [process.env.NEXT_PUBLIC_RPC_URL] : []),
    ...(process.env.NEXT_PUBLIC_RPC_PROXY === "1" ? [(process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/rpc"] : []),
    "https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org",
  ],
  explorer: "https://bscscan.com",
  token: "0x23791aa3b031659b593cf141a2bc76b0ad657777",
  brain: "0xee80f8cB5309C572343c38b5D717283BBBb517c5",
  brainV1: "0x32D28e97b50f5978eb51d7608492CC7221b01f63",
  world: "0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4",
  arcade: "0x3dE4fe3535dd9E1CC17b6718B985593e3E463279",
  liveFallback: process.env.NEXT_PUBLIC_LIVE_URL || "",
  circuitPtr: "0x2eE3C5168CD3F60E87693716E660470011EA9C7e",
  deployer: "0xA2eD0B7da1C7b5ee1af819CA281F4894B1700e27",
  links: {
    x: "https://x.com/",
    telegram: "https://t.me/",
    github: "https://github.com/MidTermDev/immortal-fruit-fly",
    codex: "https://codex.flywire.ai/app/cell_details?root_id=",
    pancake: "https://pancakeswap.finance/swap?chain=bsc&outputCurrency=",
    dexscreener: "https://dexscreener.com/bsc/",
    sourcify: "https://repo.sourcify.dev/56/",
  },
  previewStepsPerSecond: 14,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
};
