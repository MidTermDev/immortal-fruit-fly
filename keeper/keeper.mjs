// Keeper: keeps the fly's brain running by calling tick() on a schedule.
//   PRIVATE_KEY=0x... BRAIN=0x... node keeper/keeper.mjs
// Env: RPC (default BSC), STEPS (default 32), INTERVAL_SEC (default 900), MAX_GAS_GWEI (default 1)
import { ethers } from 'ethers';
const RPC = process.env.RPC || 'https://bsc-dataseed.bnbchain.org';
const BRAIN = process.env.BRAIN || '0x32D28e97b50f5978eb51d7608492CC7221b01f63';
const STEPS = Number(process.env.STEPS || 32);
const INTERVAL = Number(process.env.INTERVAL_SEC || 900) * 1000;
const MAX_GAS_GWEI = Number(process.env.MAX_GAS_GWEI || 1);
const ABI = ['function tick(uint16)', 'function alive() view returns (bool)', 'function energy() view returns (uint64)', 'function step() view returns (uint64)',
  'function posX() view returns (int64)', 'function posY() view returns (int64)', 'function totalSpikes() view returns (uint64)'];
const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const brain = new ethers.Contract(BRAIN, ABI, wallet);
const log = (...a) => console.log(new Date().toISOString(), ...a);
async function once() {
  try {
    const [alive, energy, step] = await Promise.all([brain.alive(), brain.energy(), brain.step()]);
    if (!alive) { log('fly is dead; nothing to tick. someone must resurrect() it.'); return; }
    const fee = await provider.getFeeData();
    const gwei = Number(ethers.formatUnits(fee.gasPrice ?? 0n, 'gwei'));
    if (gwei > MAX_GAS_GWEI) { log(`gas ${gwei} gwei > ${MAX_GAS_GWEI}, skipping`); return; }
    const steps = Math.min(STEPS, Number(energy));
    const tx = await brain.tick(steps);
    const rc = await tx.wait();
    const [px, py, spikes] = await Promise.all([brain.posX(), brain.posY(), brain.totalSpikes()]);
    log(`tick(${steps}) ok: step ${step}->${Number(step) + steps} gas ${rc.gasUsed} pos (${Number(px) / 256},${Number(py) / 256}) spikes ${spikes} tx ${rc.hash}`);
  } catch (e) { log('error', e.shortMessage || e.message); }
}
log(`keeper for ${BRAIN} as ${wallet.address}: ${STEPS} steps every ${INTERVAL / 1000}s`);
await once();
setInterval(once, INTERVAL);
