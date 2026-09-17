import { chromium } from 'playwright';
const [,, url, out, secs, w, h] = process.argv;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: +w || 1280, height: +h || 720 }, recordVideo: { dir: out, size: { width: +w || 1280, height: +h || 720 } } });
const p = await ctx.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout((+secs || 20) * 1000);
await ctx.close(); await b.close();
console.log('recorded', url);
