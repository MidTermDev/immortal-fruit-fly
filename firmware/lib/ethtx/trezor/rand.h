// random32(): entropy for trezor-crypto's side-channel blinding (not for the
// signature itself, which is deterministic per RFC 6979). Not trezor's rand.c:
// on the ESP32 it is the hardware RNG, on the host a plain PRNG (tests only).
#ifndef __RAND_H__
#define __RAND_H__

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t random32(void);

#ifdef __cplusplus
}
#endif

#endif
