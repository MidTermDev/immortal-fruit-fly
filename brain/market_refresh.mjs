// Ask Element (the BNB Chain NFT marketplace) to re-read a fly's token metadata after we change it.
// Element's refresh is a UI action behind an anti-abuse token, so we drive it headlessly. Best effort.
// usage: node brain/market_refresh.mjs <tokenId> [<tokenId> ...]   (needs web/node_modules/playwright)
import { createRequire } from 'module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { chromium } = require('playwright');
const REGISTRY = '0x69DA3239B69c0B7C9C063F105c4DDf008FFb8F53';
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: market_refresh.mjs <id>...'); process.exit(2); }
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
for (const id of ids) {
  try {
    await p.goto(`https://element.market/assets/bsc/${REGISTRY}/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(8000);
    const c = await p.evaluate(() => { const e = [...document.querySelectorAll('svg.element-icon')].find(s => /ItemRefresh/i.test(s.innerHTML) || /ItemRefresh/i.test(s.getAttribute('aria-label') || '') ); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (!c) { console.log(`#${id}: refresh control not found`); continue; }
    await p.mouse.click(c.x, c.y); await p.waitForTimeout(2500);
    const ok = /Refresh request submitted/i.test(await p.innerText('body'));
    console.log(`#${id}: ${ok ? 'refresh submitted' : 'no confirmation'}`);
  } catch (e) { console.log(`#${id}: failed ${String(e).slice(0, 120)}`); }
}
await b.close();
