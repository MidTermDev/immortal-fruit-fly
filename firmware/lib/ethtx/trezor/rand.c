// See rand.h. ESP-IDF: esp_random() (hardware RNG, good once Wi-Fi/BT or the
// bootloader's RF calibration has run). Host: xorshift seeded from the clock,
// which only has to be unpredictable enough for blinding in a test binary.
#include "rand.h"

#if defined(ESP_PLATFORM) || defined(ARDUINO_ARCH_ESP32)
#include "esp_random.h"
uint32_t random32(void) { return esp_random(); }
#else
#include <time.h>
static uint32_t s_state[4];
uint32_t random32(void) {
  if (s_state[0] == 0 && s_state[1] == 0 && s_state[2] == 0 && s_state[3] == 0) {
    uint32_t seed = (uint32_t)time(NULL) ^ (uint32_t)clock() ^ (uint32_t)(uintptr_t)&s_state;
    s_state[0] = seed | 1u; s_state[1] = seed * 2654435761u; s_state[2] = ~seed; s_state[3] = seed ^ 0x9e3779b9u;
  }
  uint32_t t = s_state[3];
  uint32_t s = s_state[0];
  s_state[3] = s_state[2]; s_state[2] = s_state[1]; s_state[1] = s;
  t ^= t << 11; t ^= t >> 8;
  s_state[0] = t ^ s ^ (s >> 19);
  return s_state[0];
}
#endif
