// The fly's on-chain compass core, bit-exact with contracts/src/FlyBrain.sol (_tick/_step/_plasticity/_walk/_buildStim)
// and sim/flysim.py. Every arithmetic step below is annotated with the line of the reference it mirrors.
// Portable C++17: no exceptions, no iostream, no dynamic allocation (tick() touches only members and small stack arrays),
// fixed-width integers everywhere; intermediate math in int64 where the contract uses int256 (all results fit int32,
// exactly as flysim.py's unbounded Python ints do).
#include "flycore.h"
#include "keccak.h"
#include <string.h>

namespace flycore {

// cos/sin of the wedge centres (w + 0.5) * 2π/16, scaled to 127: FlyBrain.sol COS_T/SIN_T, flysim.py COS16/SIN16.
static const int32_t COS16[WEDGES] = {125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25, 25, 71, 106, 125};
static const int32_t SIN16[WEDGES] = {25, 71, 106, 125, 125, 106, 71, 25, -25, -71, -106, -125, -125, -106, -71, -25};

// FlyBrain.sol _sqrt: Babylonian floor square root. (x + 1) / 2 is written overflow-free; identical for every x < 2^64 - 1.
uint64_t isqrt(uint64_t x) {
  if (x == 0) return 0;
  uint64_t z = x / 2 + (x & 1);
  uint64_t y = x;
  while (z < y) {
    y = z;
    z = (x / z + z) / 2;
  }
  return y;
}

static inline uint16_t rd16(const uint8_t* p) { return (uint16_t)(((uint16_t)p[0] << 8) | p[1]); }

// ---------------------------------------------------------------- Circuit

// Same checks, in the same order, as the FlyBrain constructor ("short", "version", "N", "length", "offset0", "offsetN",
// "type", "wedge", "monotonic", "post").
bool Circuit::load(const uint8_t* t, size_t n_len) {
  table = nullptr; len = 0; N = 0; S = 0; type = wedge = side = offsets = syn = nullptr;
  if (t == nullptr || n_len < 4) return false;
  if (t[0] != 1) return false;
  const size_t n = t[1];
  const size_t s = rd16(t + 2);
  if (n == 0) return false;  // n <= 255 by construction (one byte)
  const size_t offType = 4;
  const size_t offWedge = offType + n;
  const size_t offSide = offWedge + n;
  const size_t offOffsets = offSide + n;
  const size_t offSyn = offOffsets + 2 * (n + 1);
  const size_t offRoot = offSyn + 2 * s;
  if (n_len != offRoot + 8 * n) return false;
  if (rd16(t + offOffsets) != 0) return false;
  if (rd16(t + offOffsets + 2 * n) != s) return false;
  for (size_t i = 0; i < n; ++i) {
    if (t[offType + i] > T_DELTA7) return false;
    const uint8_t w = t[offWedge + i];
    if (w != NO_WEDGE && w >= WEDGES) return false;
    if (rd16(t + offOffsets + 2 * i) > rd16(t + offOffsets + 2 * i + 2)) return false;
  }
  for (size_t j = 0; j < s; ++j) {
    if (t[offSyn + 2 * j] >= n) return false;
  }
  table = t; len = n_len; N = (int)n; S = (int)s;
  type = t + offType; wedge = t + offWedge; side = t + offSide; offsets = t + offOffsets; syn = t + offSyn;
  return true;
}

// ------------------------------------------------------------------- Core

Core::Core(const Circuit& c, const Params& p) : c_(c), p_(p) { reset(); }

void Core::reset() {
  memset(v, 0, sizeof v);
  memset(bias, 0, sizeof bias);
  memset(inp, 0, sizeof inp);
  memset(hist, 0, sizeof hist);
  memset(lastSpk, 0, sizeof lastSpk);
  memset(lastBins, 0, sizeof lastBins);
  memset(stimI_, 0, sizeof stimI_);
  step = 0; totalSpikes = 0; posX = 0; posY = 0; headX = 0; headY = 0;
  stimChannel = CH_NONE; stimParam = 0; stimStrength = 0; stimUntil = 0;
}

// FlyBrain.sol _stimulate (minus the token burn): BadChannel / BadStrength / BadChannel(param) -> false.
bool Core::stimulate(uint8_t channel, uint8_t param, uint8_t strength) {
  if (channel == CH_NONE || channel > CH_SHOCK) return false;
  if (strength == 0) return false;
  if (channel == CH_CUE && param >= WEDGES) return false;
  stimChannel = channel;
  stimParam = param;
  stimStrength = strength;
  stimUntil = step + p_.stimTTL;
  return true;
}

// FlyBrain.sol _buildStim / flysim.py _build_stim.
void Core::buildStim() {
  const int N = c_.N;
  const int32_t amp = (int32_t)stimStrength * p_.stimGain;
  const uint8_t ch = stimChannel;
  const uint8_t param = stimParam;
  for (int i = 0; i < N; ++i) {
    int32_t s = 0;
    const uint8_t t = c_.type[i];
    if (ch == CH_CUE) {
      if (t <= T_EPGT) {
        const uint8_t w = c_.wedge[i];
        if (w != NO_WEDGE) {
          const unsigned dist = ((unsigned)w + WEDGES - param) % WEDGES;
          if (dist == 0) s = amp;
          else if (dist == 1 || dist == WEDGES - 1) s = tdiv(amp, 2);
        }
      }
    } else if (ch == CH_TURN_LEFT || ch == CH_TURN_RIGHT) {
      if (t == T_PEN_A || t == T_PEN_B) {
        const uint8_t sd = c_.side[i];  // 0 = left, 1 = right
        if ((ch == CH_TURN_LEFT && sd == 0) || (ch == CH_TURN_RIGHT && sd == 1)) s = amp;
      }
    } else if (ch == CH_SHOCK) {
      if (t == T_DELTA7) s = amp;
    }
    stimI_[i] = s;
  }
}

// FlyBrain.sol _tick + _step + _plasticity + _walk, without energy (the registry owns life).
// Bad `steps` (0 or > maxSteps) is a revert on-chain: here a no-op that returns steps = 0.
TickResult Core::tick(uint16_t steps) {
  TickResult r;
  r.steps = 0; r.spikes = 0; r.headX = headX; r.headY = headY; r.posX = posX; r.posY = posY;
  if (steps == 0 || steps > p_.maxSteps) return r;

  const int N = c_.N;
  const int64_t leak = p_.leak, thresh = p_.thresh, reset_ = p_.reset, vMin = p_.vMin;
  const int64_t gBias = p_.gBias, noise = p_.noise;

  const bool stimActive = stimChannel != CH_NONE && step < stimUntil;
  if (stimActive) buildStim();
  const uint64_t stimUntilStep = stimUntil;
  if (!p_.persistInput) memset(inp, 0, sizeof(int32_t) * (size_t)N);  // v1 semantics; v2 keeps the pending input

  uint32_t* const spk = lastSpk;    // per-neuron spikes this tick (display + plasticity)
  uint32_t* const bins = lastBins;  // EPG spikes per wedge this tick (display + heading memory)
  memset(spk, 0, sizeof(uint32_t) * (size_t)N);
  memset(bins, 0, sizeof lastBins);
  int64_t hx = 0, hy = 0;
  uint32_t tickSpikes = 0;
  const uint64_t s0 = step;
  uint16_t ran = 0;

  uint8_t rnd[32];
  uint8_t spikeList[MAX_N];

  while (ran < steps) {
    const uint64_t sn = s0 + ran;
    const bool stimNow = stimActive && sn < stimUntilStep;

    // noise seed = keccak256(abi.encodePacked(uint64 sn)); re-hashed every 32 neurons
    uint8_t seed[8];
    for (int b = 0; b < 8; ++b) seed[b] = (uint8_t)(sn >> (8 * (7 - b)));
    keccak256(seed, 8, rnd);

    // pass 1: leak, integrate, threshold
    unsigned nSpk = 0;
    for (int i = 0; i < N; ++i) {
      const int lane = i & 31;
      if (lane == 0 && i != 0) keccak256(rnd, 32, rnd);
      // (rnd >> (lane*8)) & 0xFF on the big-endian uint256 is digest byte 31 - lane
      const int64_t nz = (int64_t)rnd[31 - lane] - 128;
      int64_t x = v[i];
      x -= (x * leak) / 1024;                                   // truncating, as sdiv
      x += (int64_t)inp[i] + (nz * noise) / 128 + (int64_t)bias[i] * gBias;
      if (stimNow) x += stimI_[i];
      inp[i] = 0;
      if (x < vMin) x = vMin;
      if (x >= thresh) {
        x = reset_;
        spikeList[nSpk++] = (uint8_t)i;
        spk[i] += 1;
        if (c_.type[i] <= T_EPGT) {
          const uint8_t w = c_.wedge[i];
          if (w < WEDGES) { hx += COS16[w]; hy += SIN16[w]; bins[w] += 1; }
        }
      }
      v[i] = (int32_t)x;
    }
    tickSpikes += nSpk;

    // pass 2: propagate spikes into the next step's input
    for (unsigned k = 0; k < nSpk; ++k) {
      const int i = spikeList[k];
      const int64_t g = p_.gains[c_.type[i]];
      const uint16_t a = c_.offset(i), b = c_.offset(i + 1);
      const uint8_t* q = c_.syn + 2 * (size_t)a;
      for (uint16_t j = a; j < b; ++j, q += 2) {
        const int post = q[0];
        const int64_t w = q[1];
        inp[post] = (int32_t)((int64_t)inp[post] + (w * g) / 16);
      }
    }
    ran += 1;
  }

  // plasticity: fired in >= 1/8 of the steps -> +1 (to BIAS_MAX); silent -> -1 (to -BIAS_MAX)
  for (int i = 0; i < N; ++i) {
    int32_t b = bias[i];
    if ((uint64_t)spk[i] * 8 >= ran) {
      if (b < BIAS_MAX) b += 1;
    } else if (spk[i] == 0) {
      if (b > -BIAS_MAX) b -= 1;
    }
    bias[i] = b;
  }

  // heading memory: the wedge with most EPG spikes this tick (first one on ties), only if any
  int best = 0;
  uint32_t bestCount = 0;
  for (int w = 0; w < WEDGES; ++w) {
    if (bins[w] > bestCount) { bestCount = bins[w]; best = w; }
  }
  if (bestCount > 0 && hist[best] < 0xFFFF) hist[best] += 1;

  // walk
  const int64_t ran64 = ran;
  const int64_t mag = (int64_t)isqrt((uint64_t)(hx * hx + hy * hy));
  if (mag > 0 && mag >= (int64_t)p_.walkThreshold * ran64) {
    posX += (hx * STRIDE * ran64) / mag;
    posY += (hy * STRIDE * ran64) / mag;
  }
  headX = (int32_t)hx;
  headY = (int32_t)hy;

  step = s0 + ran;
  totalSpikes += tickSpikes;
  if (stimActive && step >= stimUntilStep) stimChannel = CH_NONE;

  r.steps = ran; r.spikes = tickSpikes; r.headX = headX; r.headY = headY; r.posX = posX; r.posY = posY;
  return r;
}

// keccak256 of v (int32 LE x N) || bias (int32 LE x N) || hist (u16 LE x 16) || inp (int32 LE x N) || step (u64 LE)
static inline uint8_t* put32(uint8_t* p, int32_t x) {
  const uint32_t u = (uint32_t)x;
  p[0] = (uint8_t)u; p[1] = (uint8_t)(u >> 8); p[2] = (uint8_t)(u >> 16); p[3] = (uint8_t)(u >> 24);
  return p + 4;
}

void Core::stateHash(uint8_t out[32]) const {
  const int N = c_.N;
  uint8_t buf[MAX_N * 12 + WEDGES * 2 + 8];  // 3100 bytes on the stack; call it from a task with room for that
  uint8_t* p = buf;
  for (int i = 0; i < N; ++i) p = put32(p, v[i]);
  for (int i = 0; i < N; ++i) p = put32(p, bias[i]);
  for (int w = 0; w < WEDGES; ++w) { *p++ = (uint8_t)hist[w]; *p++ = (uint8_t)(hist[w] >> 8); }
  for (int i = 0; i < N; ++i) p = put32(p, inp[i]);
  for (int b = 0; b < 8; ++b) *p++ = (uint8_t)(step >> (8 * b));
  keccak256(buf, (size_t)(p - buf), out);
}

void Core::setState(const int16_t* v16, const int8_t* bias8, const uint16_t* hist16, const int32_t* inp32, uint64_t step_,
                    int32_t hx, int32_t hy, int64_t px, int64_t py, uint8_t ch, uint8_t param, uint16_t strength, uint64_t until) {
  const int N = c_.N;
  memset(v, 0, sizeof v);
  memset(bias, 0, sizeof bias);
  memset(inp, 0, sizeof inp);
  memset(lastSpk, 0, sizeof lastSpk);
  memset(lastBins, 0, sizeof lastBins);
  for (int i = 0; i < N; ++i) { v[i] = v16[i]; bias[i] = bias8[i]; inp[i] = inp32[i]; }
  for (int w = 0; w < WEDGES; ++w) hist[w] = hist16[w];
  step = step_; headX = hx; headY = hy; posX = px; posY = py;
  stimChannel = ch; stimParam = param; stimStrength = strength; stimUntil = until;
  // totalSpikes is not part of the view this mirrors; the caller sets it directly (it is public) when it has it
}

}  // namespace flycore
