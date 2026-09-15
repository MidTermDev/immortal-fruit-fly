// Immortal Fruit Fly — site configuration.
// Leave `brain` empty before deployment: the site then runs the same circuit locally and says so.
window.FLY_CONFIG = {
  chainId: 56,
  chainName: 'BNB Smart Chain',
  rpc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.binance.org'],
  explorer: 'https://bscscan.com',
  token: "0x23791aa3b031659b593cf141a2bc76b0ad657777",   // Immortal Fruit Flies ($FLY)
  brain: "0xee80f8cB5309C572343c38b5D717283BBBb517c5",   // FlyBrain v2 (genesis fly, persistent input)
  links: {
    x: 'https://x.com/',
    telegram: 'https://t.me/',
    github: 'https://github.com/MidTermDev/immortal-fruit-fly',
    codex: 'https://codex.flywire.ai/app/cell_details?root_id=',
    pancake: 'https://pancakeswap.finance/swap?chain=bsc&outputCurrency=',
    dexscreener: 'https://dexscreener.com/bsc/',
  },
  // client-side preview speed (steps per second) between on-chain ticks
  previewStepsPerSecond: 10,
};
