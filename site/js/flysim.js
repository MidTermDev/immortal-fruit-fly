// Bit-exact JavaScript port of FlyBrain.sol's simulation (see also sim/flysim.py).
// Requires ethers (for keccak256).
(function (global) {
  const COS16 = [125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25, 25, 71, 106, 125];
  const SIN16 = [25, 71, 106, 125, 125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25];
  const WEDGES = 16, BIAS_MAX = 24, STRIDE = 16;
  const CH = { NONE: 0, CUE: 1, TURN_LEFT: 2, TURN_RIGHT: 3, SHOCK: 4 };
  const T = { EPG: 0, EPGT: 1, PEG: 2, PEN_A: 3, PEN_B: 4, DELTA7: 5 };
  const TYPE_NAMES = ['EPG', 'EPGt', 'PEG', 'PEN_a', 'PEN_b', 'Δ7'];

  const tdiv = (a, b) => Math.trunc(a / b);
  function isqrt(x) { if (x === 0) return 0; let z = Math.trunc((x + 1) / 2), y = x; while (z < y) { y = z; z = Math.trunc((Math.trunc(x / z) + z) / 2); } return y; }
  function keccakU64(n) { return BigInt(ethers.keccak256(ethers.zeroPadValue(ethers.toBeHex(n), 8))); }
  function keccakU256(b) { return BigInt(ethers.keccak256(ethers.zeroPadValue(ethers.toBeHex(b), 32))); }

  class Circuit {
    constructor(hex) {
      const d = ethers.getBytes(hex);
      if (d[0] !== 1) throw new Error('circuit table version');
      const N = d[1], S = (d[2] << 8) | d[3];
      let o = 4;
      this.N = N; this.S = S;
      this.type = Array.from(d.slice(o, o + N)); o += N;
      this.wedge = Array.from(d.slice(o, o + N)); o += N;
      this.side = Array.from(d.slice(o, o + N)); o += N;
      const off = []; for (let i = 0; i <= N; i++) off.push((d[o + 2 * i] << 8) | d[o + 2 * i + 1]); o += 2 * (N + 1);
      this.out = [];
      for (let i = 0; i < N; i++) { const lst = []; for (let j = off[i]; j < off[i + 1]; j++) lst.push([d[o + 2 * j], d[o + 2 * j + 1]]); this.out.push(lst); }
      o += 2 * S;
      this.root = []; for (let i = 0; i < N; i++) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(d[o + 8 * i + k]); this.root.push(v.toString()); }
    }
  }

  class FlySim {
    constructor(circuit, params) {
      this.c = circuit; this.p = params;
      const N = circuit.N;
      this.v = new Array(N).fill(0); this.bias = new Array(N).fill(0); this.inp = new Array(N).fill(0);
      this.hist = new Array(WEDGES).fill(0);
      this.step = 0; this.energy = 0; this.alive = true; this.generation = 0;
      this.posX = 0; this.posY = 0; this.headX = 0; this.headY = 0;
      this.stimChannel = 0; this.stimParam = 0; this.stimStrength = 0; this.stimUntil = 0;
      this.totalSpikes = 0;
      this.onStep = null; // (spikeList, stepNumber) => void
    }
    loadState(s) {
      // s: { v:int16[], bias:int8[], hist:uint16[16], step, energy, alive, generation, posX, posY, headX, headY, stim:{channel,param,strength,untilStep} }
      this.v = s.v.map(Number); this.bias = s.bias.map(Number); this.hist = s.hist.map(Number);
      this.inp.fill(0);
      this.step = Number(s.step); this.energy = Number(s.energy); this.alive = !!s.alive; this.generation = Number(s.generation);
      this.posX = Number(s.posX); this.posY = Number(s.posY); this.headX = Number(s.headX); this.headY = Number(s.headY);
      if (s.stim) { this.stimChannel = Number(s.stim.channel); this.stimParam = Number(s.stim.param); this.stimStrength = Number(s.stim.strength); this.stimUntil = Number(s.stim.untilStep); }
    }
    stimulate(channel, param, strength) {
      this.stimChannel = channel; this.stimParam = param; this.stimStrength = strength;
      this.stimUntil = this.step + this.p.stimTTL;
    }
    buildStim() {
      const c = this.c, p = this.p, amp = this.stimStrength * p.stimGain, stim = new Array(c.N).fill(0);
      const ch = this.stimChannel, param = this.stimParam;
      for (let i = 0; i < c.N; i++) {
        const t = c.type[i];
        if (ch === CH.CUE) {
          if (t <= T.EPGT && c.wedge[i] !== 255) {
            const dist = (c.wedge[i] + WEDGES - param) % WEDGES;
            if (dist === 0) stim[i] = amp; else if (dist === 1 || dist === WEDGES - 1) stim[i] = tdiv(amp, 2);
          }
        } else if (ch === CH.TURN_LEFT || ch === CH.TURN_RIGHT) {
          if ((t === T.PEN_A || t === T.PEN_B) && ((ch === CH.TURN_LEFT && c.side[i] === 0) || (ch === CH.TURN_RIGHT && c.side[i] === 1))) stim[i] = amp;
        } else if (ch === CH.SHOCK) { if (t === T.DELTA7) stim[i] = amp; }
      }
      return stim;
    }
    tick(steps) {
      const c = this.c, p = this.p, N = c.N;
      if (!this.alive) return null;
      const stimActive = this.stimChannel !== 0 && this.step < this.stimUntil;
      const stimI = stimActive ? this.buildStim() : null;
      const spk = new Array(N).fill(0), bins = new Array(WEDGES).fill(0);
      let hx = 0, hy = 0, tickSpikes = 0, ran = 0;
      const s0 = this.step;
      while (ran < steps && this.energy > 0) {
        const sn = s0 + ran, stimNow = stimActive && sn < this.stimUntil;
        let rnd = keccakU64(sn);
        const spikeList = [];
        for (let i = 0; i < N; i++) {
          if ((i & 31) === 0 && i !== 0) rnd = keccakU256(rnd);
          const nz = Number((rnd >> BigInt((i & 31) * 8)) & 0xFFn) - 128;
          let x = this.v[i];
          x -= tdiv(x * p.leak, 1024);
          x += this.inp[i] + tdiv(nz * p.noise, 128) + this.bias[i] * p.gBias;
          if (stimNow) x += stimI[i];
          this.inp[i] = 0;
          if (x < p.vMin) x = p.vMin;
          if (x >= p.thresh) {
            x = p.reset; spikeList.push(i); spk[i]++;
            if (c.type[i] <= T.EPGT && c.wedge[i] !== 255) { hx += COS16[c.wedge[i]]; hy += SIN16[c.wedge[i]]; bins[c.wedge[i]]++; }
          }
          this.v[i] = x;
        }
        tickSpikes += spikeList.length;
        for (const i of spikeList) { const g = p.gains[c.type[i]]; for (const [post, w] of c.out[i]) this.inp[post] += tdiv(w * g, 16); }
        if (this.onStep) this.onStep(spikeList, sn);
        ran++; this.energy--;
      }
      for (let i = 0; i < N; i++) { let b = this.bias[i]; if (spk[i] * 8 >= ran) { if (b < BIAS_MAX) b++; } else if (spk[i] === 0) { if (b > -BIAS_MAX) b--; } this.bias[i] = b; }
      let best = 0, bestCount = 0; for (let w = 0; w < WEDGES; w++) if (bins[w] > bestCount) { bestCount = bins[w]; best = w; }
      if (bestCount > 0 && this.hist[best] < 0xFFFF) this.hist[best]++;
      const mag = isqrt(hx * hx + hy * hy);
      if (mag > 0 && mag >= p.walkThreshold * ran) { this.posX += tdiv(hx * STRIDE * ran, mag); this.posY += tdiv(hy * STRIDE * ran, mag); }
      this.headX = hx; this.headY = hy;
      this.step = s0 + ran; this.totalSpikes += tickSpikes;
      if (stimActive && this.step >= this.stimUntil) this.stimChannel = 0;
      if (this.energy === 0) this.alive = false;
      return { steps: ran, spikes: tickSpikes, spk, bins, hx, hy };
    }
  }

  global.FlySim = { Circuit, FlySim, CH, T, TYPE_NAMES, COS16, SIN16, WEDGES };
})(window);
