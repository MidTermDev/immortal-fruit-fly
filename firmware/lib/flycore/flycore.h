// The fly's on-chain compass core (FlyBrain v2 / FlyCore kernel), bit-exact in C++.
// Mirrors contracts/src/FlyBrain.sol `_tick/_step/_plasticity/_walk` and sim/flysim.py exactly:
// int32 arithmetic with truncating division, keccak256(step) noise, synchronous spikes delivered next step,
// persistent synaptic input, engram plasticity at the end of each tick, walking. Any deviation is a bug.
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace flycore {

constexpr int WEDGES = 16;
constexpr int BIAS_MAX = 24;
constexpr int STRIDE = 16;
enum Channel : uint8_t { CH_NONE = 0, CH_CUE = 1, CH_TURN_LEFT = 2, CH_TURN_RIGHT = 3, CH_SHOCK = 4 };
enum CellType : uint8_t { T_EPG = 0, T_EPGT = 1, T_PEG = 2, T_PEN_A = 3, T_PEN_B = 4, T_DELTA7 = 5 };
constexpr uint8_t NO_WEDGE = 0xFF;

struct Params {  // contracts/data/params.json (v2, deployed)
  int32_t leak, thresh, reset, vMin; int32_t gains[6]; int32_t gBias, noise, stimGain; uint16_t stimTTL, walkThreshold; uint8_t maxSteps; bool persistInput;
};

// The packed circuit table (contracts/data/circuit.hex, keccak 0xffbe0e7f…): version(1) N(1) S(2) type[N] wedge[N] side[N] offsets[N+1] u16 BE, syn[S] (post u8, weight u8), root[N] u64 BE.
struct Circuit {
  const uint8_t* table; size_t len; int N; int S;
  const uint8_t* type; const uint8_t* wedge; const uint8_t* side; const uint8_t* offsets; const uint8_t* syn;
  bool load(const uint8_t* table, size_t len);   // validates like the contract constructor; false on a bad table
  uint16_t offset(int i) const { return (uint16_t)((offsets[2 * i] << 8) | offsets[2 * i + 1]); }
};

struct TickResult { uint16_t steps; uint32_t spikes; int32_t headX, headY; int64_t posX, posY; };

class Core {
 public:
  static constexpr int MAX_N = 255;
  Core(const Circuit& c, const Params& p);
  // --- state (public so the display and the chain sync can read/write it) ---
  int32_t v[MAX_N]; int32_t bias[MAX_N]; int32_t inp[MAX_N]; uint16_t hist[WEDGES];
  uint64_t step = 0; uint64_t totalSpikes = 0; int64_t posX = 0, posY = 0; int32_t headX = 0, headY = 0;
  uint8_t stimChannel = CH_NONE, stimParam = 0; uint16_t stimStrength = 0; uint64_t stimUntil = 0;
  // per-neuron spikes in the last tick and per-wedge EPG bins (for the display)
  uint32_t lastSpk[MAX_N]; uint32_t lastBins[WEDGES];
  // --- actions, same semantics as the contract ---
  void reset();                                                   // genesis: all zero
  bool stimulate(uint8_t channel, uint8_t param, uint8_t strength); // false on bad args
  TickResult tick(uint16_t steps);                                // 1..maxSteps; ignores energy (the registry owns life)
  // sha256-free identity of the state for display/logging: keccak256 of v||bias||hist||inp||step, 32 bytes out
  void stateHash(uint8_t out[32]) const;
  // sync from the chain's `core(id)` view: v[N] int16, bias[N] int8, hist[16] u16, inp[N] int32, step, head, pos, stim
  void setState(const int16_t* v16, const int8_t* bias8, const uint16_t* hist16, const int32_t* inp32, uint64_t step_, int32_t hx, int32_t hy, int64_t px, int64_t py, uint8_t ch, uint8_t param, uint16_t strength, uint64_t until);
  const Circuit& circuit() const { return c_; }
  const Params& params() const { return p_; }
 private:
  const Circuit& c_; Params p_;
  int32_t stimI_[MAX_N];
  void buildStim();
};

// int32 truncating division and integer sqrt exactly as the contract does them
inline int32_t tdiv(int64_t a, int64_t b) { return (int32_t)(a / b); }  // C++ division truncates toward zero, as Solidity
uint64_t isqrt(uint64_t x);

}  // namespace flycore
