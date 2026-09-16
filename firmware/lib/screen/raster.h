// The Neurons page's raster: a ring of up to RASTER_COLS columns, one per replica tick, each a bitset of the neurons
// that spiked in that tick (bit i = neuron i, up to RASTER_ROWS = 155). Fixed storage, no allocation.
#pragma once
#include <stdint.h>
#include <string.h>

namespace screen {

constexpr int RASTER_ROWS = 155;
constexpr int RASTER_COLS = 220;
constexpr int RASTER_WORDS = (RASTER_ROWS + 31) / 32;   // 5

struct Raster {
  uint32_t bits[RASTER_COLS][RASTER_WORDS];
  uint16_t head = 0;      // where the next column goes
  uint16_t count = 0;     // columns held (<= RASTER_COLS)
  uint32_t pushed = 0;    // columns ever pushed (the device's painter counts new ones by this)

  void clear() { memset(bits, 0, sizeof bits); head = 0; count = 0; pushed = 0; }
  void push(const uint32_t words[RASTER_WORDS]) {
    memcpy(bits[head], words, sizeof(uint32_t) * RASTER_WORDS);
    head = (uint16_t)((head + 1) % RASTER_COLS);
    if (count < RASTER_COLS) count++;
    pushed++;
  }
  // column k, 0 = oldest .. count-1 = newest
  const uint32_t* column(int k) const { return bits[(head + RASTER_COLS - count + k) % RASTER_COLS]; }
  static bool bitAt(const uint32_t* w, int row) { return (w[row >> 5] >> (row & 31)) & 1u; }
  bool get(int k, int row) const { return bitAt(column(k), row); }
  int spikesIn(int k) const {
    const uint32_t* w = column(k); int n = 0;
    for (int i = 0; i < RASTER_WORDS; ++i) { uint32_t v = w[i]; while (v) { v &= v - 1; n++; } }
    return n;
  }
};

}  // namespace screen
