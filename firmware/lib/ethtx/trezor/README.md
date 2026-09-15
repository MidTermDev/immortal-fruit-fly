Subset of trezor-crypto (MIT, see LICENSE), taken from the `crypto/` directory of
https://github.com/trezor/trezor-firmware at commit 9e244ba (the old trezor/trezor-crypto
repository is archived and its sources were removed upstream).

Kept: bignum, ecdsa (trimmed to signing + public key), secp256k1 (curve parameters only),
rfc6979 + hmac_drbg, sha2, memzero (portable variant), options.h, byte_order.h.
Added: rand.h/rand.c, a random32() shim for the side-channel blinding (esp_random() on the
ESP32, a PRNG on the host). Dropped: hasher, address/base58/WIF/DER, bip32, ECDH, verify,
recover, tweaks, the zkp dispatch and the precomputed point table (USE_PRECOMPUTED_CP=0).
