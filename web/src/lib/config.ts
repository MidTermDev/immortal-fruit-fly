// A private RPC, when the host has one: a direct endpoint from the environment, or the server-side proxy
// (Vercel: set RPC_URL, never exposed to the browser). Empty on the GitHub Pages export.
const PRIVATE_RPC = [
  ...(process.env.NEXT_PUBLIC_RPC_URL ? [process.env.NEXT_PUBLIC_RPC_URL] : []),
  ...(process.env.NEXT_PUBLIC_RPC_PROXY === "1" && typeof window !== "undefined" ? [window.location.origin + (process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/rpc"] : []),
];
// Public endpoints for calls and the block number. They are NOT enough for a fly's record: eth_getLogs on publicnode
// answers only for the last ~10k blocks (403 "Archive requests require a personal token" before that) and the
// bnbchain dataseeds reject every getLogs with "limit exceeded" (measured 15 September 2026).
const PUBLIC_RPC = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"];

export const CFG = {
  chainId: 56,
  chainName: "BNB Smart Chain",
  // Order of preference for calls: the private RPC, then the public ones.
  rpc: [...PRIVATE_RPC, ...PUBLIC_RPC],
  privateRpc: PRIVATE_RPC,
  // Endpoints that serve historical eth_getLogs to a browser (CORS open), each with the widest block range it accepts
  // per request (measured 15 September 2026: NodeReal 50,000, 48club 5,000). The record scans try the private RPC
  // first, then these, then the public list above (recent blocks only), and report how far back they got.
  logsRpc: [
    { url: "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3", span: 50000 },   // NodeReal's public MegaNode endpoint (chainlist)
    { url: "https://rpc-bsc.48.club", span: 5000 },
  ],
  // Block range per eth_getLogs request on endpoints whose limit is unknown (the private RPC and the public list).
  logsSpan: 2000,
  explorer: "https://bscscan.com",
  publicRpc: "https://bsc-dataseed.bnbchain.org",
  token: "0x23791aa3b031659b593cf141a2bc76b0ad657777",
  brain: "0xee80f8cB5309C572343c38b5D717283BBBb517c5",
  brainV1: "0x32D28e97b50f5978eb51d7608492CC7221b01f63",
  world: "0xD730E65Bdc1cBd40f720a36EeD71e2028Bf20EB4",
  arcade: "0x3dE4fe3535dd9E1CC17b6718B985593e3E463279",
  registry: "0x0eeB0A675720306Ef6f426Bd8560c1288848f813",
  // Block the registry was created in (tx 0x11caa6cc…f1991). Event scans never look before it; fly #1 was minted in
  // 122000841 and the first bodies registered in 122000836, so a rounded-up value here would hide them for ever.
  registryDeployBlock: 122000724,
  // FlyCore: the per-fly 155-neuron compass core keyed by registry id (contracts/src/FlyCore.sol). Empty until it is
  // deployed; the fly pages show the "On-chain core" figure only when this is a non-empty address. Pebbles anchor here.
  core: "0x90835aceD9b2739658Ff94aBC7c0c45049ea49f3",
  // Block FlyCore was deployed in (0 = unknown: event scans fall back to the registry's deploy block).
  coreDeployBlock: 122089807,
  bodies: { arena: "0x47005543c06246124480D196a275327325695BEd", doom: "0x642ebC7fD62a24406d8A86885F0131472E641c86", host: "0x4fC3E7D1fAD1A8E7FAC849DAa5BfF0C8333fe2a6" },
  // Element is the NFT marketplace that indexes BNB Chain collections (OpenSea does not list BSC).
  market: { name: "Element", asset: "https://element.market/assets/bsc/0x0eeB0A675720306Ef6f426Bd8560c1288848f813", collection: "https://element.market/collections/immortal-fruit-flies-1" },
  ipfsGateway: "https://gateway.pinata.cloud/ipfs/",
  liveFallback: process.env.NEXT_PUBLIC_LIVE_URL || "",
  // The brain host (brain/HOST_PROTOCOL.md) announces its public origin in bodies(host).uri, like the arena. For local
  // development NEXT_PUBLIC_HOST_URL overrides it (http://localhost:9100 against a local server.py --remote-body); with
  // the override set, every living fly's page probes that host, whatever body the registry names.
  hostOverride: process.env.NEXT_PUBLIC_HOST_URL || "",
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
