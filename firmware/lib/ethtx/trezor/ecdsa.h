/**
 * Copyright (c) 2013-2014 Tomas Dzetkulic
 * Copyright (c) 2013-2014 Pavol Rusnak
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
 * OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 * OTHER DEALINGS IN THE SOFTWARE.
 */

// Trimmed for the Immortal Fruit Fly pebble firmware (lib/ethtx): see ecdsa.c.

#ifndef __ECDSA_H__
#define __ECDSA_H__

#include <stdint.h>
#include "bignum.h"
#include "options.h"

// curve point x and y
typedef struct {
  bignum256 x, y;
} curve_point;

typedef struct {
  bignum256 prime;       // prime order of the finite field
  curve_point G;         // initial curve point
  bignum256 order;       // order of G
  bignum256 order_half;  // order of G divided by 2
  int a;                 // coefficient 'a' of the elliptic curve
  bignum256 b;           // coefficient 'b' of the elliptic curve

#if USE_PRECOMPUTED_CP
  const curve_point cp[64][8];
#endif

} ecdsa_curve;

#define ECDSA_SCALAR_SIZE 32
#define ECDSA_COORDINATE_SIZE 32
#define ECDSA_PRIVATE_KEY_SIZE ECDSA_SCALAR_SIZE
#define ECDSA_PUBLIC_KEY_SIZE (1 + 2 * ECDSA_COORDINATE_SIZE)
#define ECDSA_PUBLIC_KEY_COMPRESSED_SIZE (1 + ECDSA_COORDINATE_SIZE)
#define ECDSA_RAW_SIGNATURE_SIZE (2 * ECDSA_SCALAR_SIZE)

void point_copy(const curve_point *cp1, curve_point *cp2);
void point_add(const ecdsa_curve *curve, const curve_point *cp1,
               curve_point *cp2);
void point_double(const ecdsa_curve *curve, curve_point *cp);
int point_multiply(const ecdsa_curve *curve, const bignum256 *k,
                   const curve_point *p, curve_point *res);
void point_set_infinity(curve_point *p);
int point_is_infinity(const curve_point *p);
int point_is_equal(const curve_point *p, const curve_point *q);
int point_is_negative_of(const curve_point *p, const curve_point *q);
int scalar_multiply(const ecdsa_curve *curve, const bignum256 *k,
                    curve_point *res);

// Deterministic (RFC 6979) signature of a 32-byte digest. sig = r || s (64 bytes),
// s is always in the low half of the group order. *pby receives the recovery id
// (bit 0: parity of R.y, bit 1: R.x overflowed the order). Returns 0 on success.
int ecdsa_sign_digest(const ecdsa_curve *curve, const uint8_t *priv_key,
                      const uint8_t *digest, uint8_t *sig, uint8_t *pby,
                      int (*is_canonical)(uint8_t by, uint8_t sig[64]));
int ecdsa_get_public_key33(const ecdsa_curve *curve, const uint8_t *priv_key,
                           uint8_t *pub_key);
int ecdsa_get_public_key65(const ecdsa_curve *curve, const uint8_t *priv_key,
                           uint8_t *pub_key);

#endif
