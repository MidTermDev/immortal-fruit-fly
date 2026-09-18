// The site tour for the showcase video: real pages, recorded headlessly at 1920×1080 with a drawn cursor, smooth
// scrolls and scripted clicks. node tour.mjs [home|flies|fly|colony|docs|dead|all]  ->  rec/tour_<name>/*.webm
import { chromium } from 'playwright';
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--font-render-hinting=none'];
const SITE = process.env.SITE || 'https://www.immortalfly.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// a cursor drawn on the page (the recorder does not draw the real one)
const CURSOR = `(() => { const c = document.createElement('div'); c.id = '__cur'; c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-4px,-3px);transition:none;opacity:0';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.6L9.5 19z" fill="#14161a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const r = document.createElement('div'); r.id = '__rip'; r.style.cssText = 'position:fixed;width:34px;height:34px;border-radius:50%;border:2px solid #e2341a;z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-17px,-17px) scale(0.4)';
  const add = () => { document.body.appendChild(c); document.body.appendChild(r); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  window.__cur = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; c.style.opacity = '1'; };
  window.__click = (x, y) => { r.style.left = x + 'px'; r.style.top = y + 'px'; r.style.transition = 'none'; r.style.opacity = '0.9'; r.style.transform = 'translate(-17px,-17px) scale(0.4)'; requestAnimationFrame(() => { r.style.transition = 'opacity 0.5s, transform 0.5s'; r.style.opacity = '0'; r.style.transform = 'translate(-17px,-17px) scale(1.4)'; }); };
})();`;

class Tour {
  constructor(page) { this.page = page; this.x = 960; this.y = 540; }
  async moveTo(x, y, ms = 700) {
    const x0 = this.x, y0 = this.y, n = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= n; i++) { const t = ease(i / n); const cx = x0 + (x - x0) * t, cy = y0 + (y - y0) * t; await this.page.mouse.move(cx, cy); await this.page.evaluate(([a, b]) => window.__cur && window.__cur(a, b), [cx, cy]); await sleep(16); }
    this.x = x; this.y = y;
  }
  async clickAt(x, y, ms = 700) { await this.moveTo(x, y, ms); await this.page.evaluate(([a, b]) => window.__click && window.__click(a, b), [x, y]); await sleep(120); await this.page.mouse.click(x, y); }
  async clickSel(sel, ms = 700) { const el = this.page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); const b = await el.boundingBox(); if (!b) throw new Error('no box ' + sel); await this.clickAt(b.x + b.width / 2, b.y + b.height / 2, ms); }
  async scrollTo(y, ms = 1600) { await this.page.evaluate(async ([to, dur]) => { const from = window.scrollY; const t0 = performance.now(); const e = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); await new Promise((res) => { const step = (now) => { const t = Math.min(1, (now - t0) / dur); window.scrollTo(0, from + (to - from) * e(t)); if (t < 1) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }); }, [y, ms]); }
  async scrollToSel(sel, offset = -80, ms = 1600) { const y = await this.page.evaluate(([s, o]) => { const el = document.querySelector(s); return el ? Math.max(0, el.getBoundingClientRect().top + window.scrollY + o) : 0; }, [sel, offset]); await this.scrollTo(y, ms); }
  async type(sel, text, per = 90) { await this.clickSel(sel); for (const ch of text) { await this.page.keyboard.type(ch); await sleep(per); } }
}

async function shoot(name, secs, w, h, run) {
  const b = await chromium.launch({ args });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, recordVideo: { dir: 'rec/tour_' + name, size: { width: w, height: h } } });
  await ctx.addInitScript(CURSOR);
  const p = await ctx.newPage(); const t = new Tour(p); const t0 = Date.now();
  try { await run(p, t); } catch (e) { console.log(name, 'error:', String(e).slice(0, 200)); }
  const left = t0 + secs * 1000 - Date.now(); if (left > 0) await sleep(left);
  await ctx.close(); await b.close(); console.log('done', name, ((Date.now() - t0) / 1000).toFixed(0), 's');
}

const which = process.argv[2] || 'all';
const all = which === 'all';

if (all || which === 'home') await shoot('home', 44, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(6000);
  await t.moveTo(1200, 600, 900); await sleep(3000);
  await t.scrollToSel('#organism', -60, 2200); await sleep(9000);
  await t.moveTo(700, 560, 1200); await sleep(2000);
  await t.scrollTo((await p.evaluate(() => window.scrollY)) + 900, 2200); await sleep(8000);
  await t.scrollTo((await p.evaluate(() => window.scrollY)) + 900, 2200); await sleep(6000);
});

if (all || which === 'flies') await shoot('flies', 62, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/flies/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(7000);
  await t.moveTo(1300, 500, 900); await sleep(2500);
  await t.scrollToSel('.avail', -40, 1800); await sleep(3500);
  await t.scrollToSel('.boards', -110, 2000); await sleep(7000);
  await t.scrollToSel('#browse', -70, 2000); await sleep(2500);
  await t.clickSel('.browse-bar .chips button:nth-child(2)'); await sleep(2000);   // alive
  await t.clickSel('.browse-bar .chips button:nth-child(5)'); await sleep(2500);   // dead
  await t.clickSel('.browse-bar .chips button:nth-child(1)'); await sleep(1200);   // all
  await t.type('.browse-bar input[type=search]', '龙', 150); await sleep(3000);
  await p.locator('.browse-bar input[type=search]').fill(''); await sleep(600);
  await t.type('.browse-bar input[type=search]', 'CZ', 140); await sleep(3000);
  await p.locator('.browse-bar input[type=search]').fill(''); await sleep(400);
  await p.locator('.browse-bar select').selectOption('lives'); await t.moveTo(1100, 700, 800); await sleep(3500);
  await t.scrollTo((await p.evaluate(() => window.scrollY)) + 700, 2200); await sleep(4000);
});

if (all || which === 'fly') await shoot('fly', 52, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/fly/?id=2', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(9000);
  await t.moveTo(1150, 520, 900); await sleep(3000);
  let y = 0;
  for (const [dy, hold] of [[820, 6500], [900, 6500], [900, 6500], [900, 6000], [900, 5000]]) { y += dy; await t.scrollTo(y, 2000); await sleep(hold); }
});

if (all || which === 'colony') await shoot('colony', 46, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/colony/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(12000);
  await t.moveTo(1000, 640, 900); await sleep(6000);
  await t.scrollTo(700, 2000); await sleep(7000);
  await t.scrollToSel('#neurology', -60, 2200); await sleep(12000);
});

if (all || which === 'docs') await shoot('docs', 16, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/docs/', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(4000);
  await t.moveTo(900, 500, 800); await sleep(1500);
  await t.scrollTo(700, 2400); await sleep(3000); await t.scrollTo(1500, 2400); await sleep(3000);
});

if (all || which === 'dead') await shoot('dead', 16, 1920, 1080, async (p, t) => {
  await p.goto(SITE + '/fly/?id=65', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(8000);
  await t.moveTo(1150, 500, 900); await sleep(2000);
  await t.scrollTo(800, 2000); await sleep(4000);
});
