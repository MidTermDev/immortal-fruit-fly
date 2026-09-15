// keccak-256 (the Ethereum variant, not SHA3-256 padding). Small, portable, no allocation.
#pragma once
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void keccak256(const uint8_t* in, size_t len, uint8_t out[32]);
#ifdef __cplusplus
}
#endif
