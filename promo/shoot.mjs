import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
const rcon = (...cmds) => { try { return execFileSync('/home/ubuntu/flybrain/.venv/bin/python', ['/home/ubuntu/flybrain/brain/colony/tools/rcon.py', ...cmds], { encoding: 'utf8' }); } catch (e) { return 'rcon failed ' + e.message.slice(0, 80); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
async function record(name, url, secs, w, h, during, scroll) {
  const b = await chromium.launch({ args });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: 'rec/' + name, size: { width: w, height: h } } });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (scroll) { await p.waitForTimeout(6000); await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), scroll); }
  const t0 = Date.now();
  for (const [at, fn] of during) { const wait = t0 + at * 1000 - Date.now(); if (wait > 0) await sleep(wait); console.log(name, at + 's:', String(fn()).trim().slice(0, 80)); }
  const left = t0 + secs * 1000 - Date.now(); if (left > 0) await sleep(left);
  await ctx.close(); await b.close(); console.log('done', name);
}
const which = process.argv[2] || 'all';
if (which === 'all' || which === 'day') {
  rcon('time set 2000', 'weather clear', 'kill @e[type=item]');
  await record('day', 'https://mc.immortalfly.app/view/', 34, 1280, 720, [
    [5, () => rcon('execute at fly2 run summon minecraft:item ~7 ~1 ~-4 {Item:{id:"minecraft:bread",count:12}}', 'execute at fly2 run summon minecraft:item ~9 ~1 ~-2 {Item:{id:"minecraft:bread",count:12}}')],
    [20, () => rcon('execute at fly2 run summon minecraft:item ~-8 ~1 ~5 {Item:{id:"minecraft:bread",count:12}}')],
  ]);
}
if (which === 'all' || which === 'night') {
  rcon('time set 18500');
  await record('night', 'https://mc.immortalfly.app/fly/2/view/', 34, 1280, 720, [
    [3, () => rcon('execute at fly2 run summon minecraft:item ~5 ~1 ~3 {Item:{id:"minecraft:bread",count:8}}')],
    [12, () => rcon('execute at fly2 run summon minecraft:zombie ^ ^ ^9', 'execute at fly2 run summon minecraft:zombie ^-3 ^ ^11')],
    [22, () => rcon('execute at fly2 run summon minecraft:zombie ^4 ^ ^8')],
  ]);
  rcon('time set 2000', 'kill @e[type=zombie]');
}
if (which === 'all' || which === 'nightcam') {
  rcon('time set 18500');
  await record('nightcam', 'https://mc.immortalfly.app/view/', 26, 1280, 720, [
    [4, () => rcon('execute at fly2 run summon minecraft:zombie ^ ^ ^10', 'execute at fly2 run summon minecraft:zombie ^5 ^ ^9', 'execute at fly2 run summon minecraft:zombie ^-5 ^ ^9')],
  ]);
  rcon('time set 2000', 'kill @e[type=zombie]');
}
if (which === 'all' || which === 'brain') {
  await record('brain', 'https://www.immortalfly.app/', 26, 1920, 1080, [], '#organism');
  await record('colony', 'https://www.immortalfly.app/colony/', 26, 1920, 1080, [], '#neurology');
}
