// memzero(): wipe secrets so the compiler cannot optimise the store away.
// Portable variant of trezor-crypto's memzero.c (MIT; see LICENSE): the volatile
// loop only, so it needs no platform headers on host gcc or xtensa newlib.
#include <string.h>
#include "memzero.h"

void memzero(void *const pnt, const size_t len) {
  volatile unsigned char *volatile pnt_ = (volatile unsigned char *volatile)pnt;
  size_t i = (size_t)0U;
  while (i < len) {
    pnt_[i++] = 0U;
  }
}
