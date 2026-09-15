// Ethereum transactions on a microcontroller. See ethtx.h.
// Signing is trezor-crypto's secp256k1 (trezor/, MIT); hashing is lib/keccak.
#include "ethtx.h"
#include <string.h>
#include "keccak.h"
extern "C" {
#include "trezor/ecdsa.h"
#include "trezor/secp256k1.h"
#include "trezor/memzero.h"
}

namespace ethtx {

// ------------------------------------------------------------------ hex

static const char* HEX = "0123456789abcdef";

std::string toHex(const uint8_t* b, size_t n, bool prefix) {
  std::string s;
  s.reserve(n * 2 + 2);
  if (prefix) s += "0x";
  for (size_t i = 0; i < n; i++) { s += HEX[b[i] >> 4]; s += HEX[b[i] & 15]; }
  return s;
}

static int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool fromHex(const std::string& hex, Bytes& out) {
  size_t i = 0, n = hex.size();
  if (n >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) i = 2;
  out.clear();
  out.reserve((n - i + 1) / 2);
  if ((n - i) & 1) {                      // odd length: the first digit is a lone low nibble
    int v = nibble(hex[i++]);
    if (v < 0) return false;
    out.push_back((uint8_t)v);
  }
  for (; i < n; i += 2) {                 // (n - i) is even from here on
    int hi = nibble(hex[i]), lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) { out.clear(); return false; }
    out.push_back((uint8_t)((hi << 4) | lo));
  }
  return true;
}

// ------------------------------------------------------------------ keys and addresses

bool privateKeyToAddress(const uint8_t priv[32], uint8_t addr[20]) {
  uint8_t pub[65];
  if (ecdsa_get_public_key65(&secp256k1, priv, pub) != 0) { memzero(pub, sizeof pub); return false; }
  uint8_t h[32];
  keccak256(pub + 1, 64, h);              // hash of the 64-byte X||Y, without the 0x04 prefix
  memcpy(addr, h + 12, 20);
  memzero(pub, sizeof pub);
  return true;
}

std::string checksumAddress(const uint8_t addr[20]) {
  std::string lower = toHex(addr, 20, false);
  uint8_t h[32];
  keccak256((const uint8_t*)lower.data(), 40, h);
  std::string out = "0x";
  for (size_t i = 0; i < 40; i++) {
    char c = lower[i];
    int hn = (i & 1) ? (h[i / 2] & 15) : (h[i / 2] >> 4);
    if (c >= 'a' && c <= 'f' && hn >= 8) c = (char)(c - 'a' + 'A');
    out += c;
  }
  return out;
}

// ------------------------------------------------------------------ signing

bool signDigest(const uint8_t digest[32], const uint8_t priv[32], uint8_t sig64[64], uint8_t* recid) {
  uint8_t by = 0;
  if (ecdsa_sign_digest(&secp256k1, priv, digest, sig64, &by, NULL) != 0) return false;
  // bit 1 of `by` means R.x >= n, which ecrecover cannot express (probability ~2^-128): treat as failure.
  if (by > 1) { memzero(sig64, 64); return false; }
  if (recid) *recid = by;
  return true;
}

// ------------------------------------------------------------------ RLP

static void beMinimal(uint64_t v, Bytes& out) {  // big-endian, no leading zeros, zero = empty
  out.clear();
  uint8_t tmp[8]; int n = 0;
  while (v) { tmp[n++] = (uint8_t)(v & 0xff); v >>= 8; }
  for (int i = n - 1; i >= 0; i--) out.push_back(tmp[i]);
}

static void rlpLength(Bytes& out, size_t len, uint8_t offset) {  // offset 0x80 for strings, 0xc0 for lists
  if (len <= 55) { out.push_back((uint8_t)(offset + len)); return; }
  Bytes lb; beMinimal((uint64_t)len, lb);
  out.push_back((uint8_t)(offset + 55 + lb.size()));
  out.insert(out.end(), lb.begin(), lb.end());
}

static void rlpBytes(Bytes& out, const uint8_t* b, size_t n) {
  if (n == 1 && b[0] < 0x80) { out.push_back(b[0]); return; }
  rlpLength(out, n, 0x80);
  out.insert(out.end(), b, b + n);
}

static void rlpUint(Bytes& out, uint64_t v) { Bytes m; beMinimal(v, m); rlpBytes(out, m.data(), m.size()); }

static void rlpWord(Bytes& out, const uint8_t w[32]) {  // a 32-byte big-endian integer as a minimal item
  size_t i = 0;
  while (i < 32 && w[i] == 0) i++;
  rlpBytes(out, w + i, 32 - i);
}

static void rlpList(Bytes& out, const Bytes& payload) {
  rlpLength(out, payload.size(), 0xc0);
  out.insert(out.end(), payload.begin(), payload.end());
}

uint64_t rlpDecodeUint(const Bytes& b) {
  if (b.empty()) return 0;
  const uint8_t* p = b.data(); size_t n = b.size();
  if (p[0] < 0x80) return p[0];
  if (p[0] <= 0xb7) { size_t len = p[0] - 0x80; p++; n--; if (len > n) len = n; n = len; }
  else if (p[0] <= 0xbf) { size_t ll = p[0] - 0xb7; if (ll > n - 1) return 0; size_t len = 0; for (size_t i = 0; i < ll; i++) len = (len << 8) | p[1 + i]; p += 1 + ll; n -= 1 + ll; if (len > n) len = n; n = len; }
  else return 0;                          // a list is not an integer
  uint64_t v = 0;
  for (size_t i = 0; i < n; i++) v = (v << 8) | p[i];   // more than 8 bytes: the low 64 bits
  return v;
}

bool sign(const Tx& tx, const uint8_t priv[32], Bytes& rawOut, uint8_t txHash[32]) {
  Bytes body;
  body.reserve(tx.data.size() + 64);
  rlpUint(body, tx.nonce);
  rlpUint(body, tx.gasPrice);
  rlpUint(body, tx.gas);
  rlpBytes(body, tx.to, 20);
  rlpUint(body, tx.value);
  rlpBytes(body, tx.data.data(), tx.data.size());
  // EIP-155: hash rlp[nonce, gasPrice, gas, to, value, data, chainId, 0, 0]
  Bytes unsignedBody = body;
  rlpUint(unsignedBody, tx.chainId);
  rlpUint(unsignedBody, 0);
  rlpUint(unsignedBody, 0);
  Bytes unsignedTx; rlpList(unsignedTx, unsignedBody);
  uint8_t digest[32]; keccak256(unsignedTx.data(), unsignedTx.size(), digest);

  uint8_t sig[64]; uint8_t recid = 0;
  if (!signDigest(digest, priv, sig, &recid)) return false;

  rlpUint(body, tx.chainId * 2 + 35 + recid);   // v
  rlpWord(body, sig);                            // r
  rlpWord(body, sig + 32);                       // s
  rawOut.clear();
  rlpList(rawOut, body);
  if (txHash) keccak256(rawOut.data(), rawOut.size(), txHash);
  memzero(sig, sizeof sig);
  return true;
}

// ------------------------------------------------------------------ ABI encoding

static void putWordUint(Bytes& out, uint64_t v) {
  size_t at = out.size(); out.resize(at + 32, 0);
  for (int i = 0; i < 8; i++) out[at + 31 - i] = (uint8_t)(v >> (8 * i));
}

AbiEncoder::AbiEncoder(const char* signature) {
  uint8_t h[32];
  keccak256((const uint8_t*)signature, strlen(signature), h);
  head_.assign(h, h + 4);
}

AbiEncoder& AbiEncoder::uint(uint64_t v) { putWordUint(head_, v); return *this; }

AbiEncoder& AbiEncoder::uint256(const uint8_t word[32]) { head_.insert(head_.end(), word, word + 32); return *this; }

AbiEncoder& AbiEncoder::int_(int64_t v) {
  size_t at = head_.size(); head_.resize(at + 32, v < 0 ? 0xff : 0x00);
  uint64_t u = (uint64_t)v;
  for (int i = 0; i < 8; i++) head_[at + 31 - i] = (uint8_t)(u >> (8 * i));
  return *this;
}

AbiEncoder& AbiEncoder::address(const uint8_t addr[20]) {
  size_t at = head_.size(); head_.resize(at + 32, 0);
  memcpy(&head_[at + 12], addr, 20);
  return *this;
}

AbiEncoder& AbiEncoder::bytes32(const uint8_t b[32]) { head_.insert(head_.end(), b, b + 32); return *this; }

static Bytes dynamicTail(const uint8_t* b, size_t n) {
  Bytes t; t.reserve(32 + ((n + 31) / 32) * 32);
  putWordUint(t, (uint64_t)n);
  t.insert(t.end(), b, b + n);
  t.resize(32 + ((n + 31) / 32) * 32, 0);
  return t;
}

AbiEncoder& AbiEncoder::string(const std::string& s) {
  tailSlots_.push_back(head_.size());
  putWordUint(head_, 0);                   // offset, patched in finish()
  tails_.push_back(dynamicTail((const uint8_t*)s.data(), s.size()));
  return *this;
}

AbiEncoder& AbiEncoder::bytes(const Bytes& b) {
  tailSlots_.push_back(head_.size());
  putWordUint(head_, 0);
  tails_.push_back(dynamicTail(b.data(), b.size()));
  return *this;
}

Bytes AbiEncoder::finish() {
  Bytes out = head_;
  size_t headLen = head_.size() - 4;       // offsets are relative to the start of the arguments, after the selector
  size_t off = headLen;
  for (size_t i = 0; i < tails_.size(); i++) {
    size_t slot = tailSlots_[i];
    for (int k = 0; k < 8; k++) out[slot + 31 - k] = (uint8_t)((uint64_t)off >> (8 * k));
    off += tails_[i].size();
  }
  for (size_t i = 0; i < tails_.size(); i++) out.insert(out.end(), tails_[i].begin(), tails_[i].end());
  return out;
}

// ------------------------------------------------------------------ ABI decoding

static bool inRange(const Bytes& d, uint64_t off, uint64_t len) {  // [off, off+len) lies inside d, overflow-safe
  return off <= d.size() && len <= d.size() - off;
}

static uint64_t wordAt(const Bytes& d, uint64_t byteOff) {   // low 64 bits of the word starting at byteOff; 0 if out of range
  if (!inRange(d, byteOff, 32)) return 0;
  uint64_t v = 0;
  for (int i = 24; i < 32; i++) v = (v << 8) | d[(size_t)byteOff + i];
  return v;
}

uint64_t AbiDecoder::uint(size_t word) const { return wordAt(d, (uint64_t)word * 32); }

int64_t AbiDecoder::int_(size_t word) const { return (int64_t)wordAt(d, (uint64_t)word * 32); }  // two's complement: the low 64 bits carry the sign-extended value

bool AbiDecoder::boolean(size_t word) const { return uint(word) != 0; }

void AbiDecoder::address(size_t word, uint8_t out[20]) const {
  uint64_t off = (uint64_t)word * 32;
  if (!inRange(d, off, 32)) { memset(out, 0, 20); return; }
  memcpy(out, &d[(size_t)off + 12], 20);
}

void AbiDecoder::bytes32(size_t word, uint8_t out[32]) const {
  uint64_t off = (uint64_t)word * 32;
  if (!inRange(d, off, 32)) { memset(out, 0, 32); return; }
  memcpy(out, &d[(size_t)off], 32);
}

std::string AbiDecoder::string(size_t word) const {
  uint64_t off = uint(word);               // relative to the start of the return data
  if (!inRange(d, off, 32)) return std::string();
  uint64_t len = wordAt(d, off);
  if (!inRange(d, off + 32, len)) return std::string();
  return std::string((const char*)&d[(size_t)off + 32], (size_t)len);
}

size_t AbiDecoder::arrayLen(size_t word) const {
  uint64_t off = uint(word);
  if (!inRange(d, off, 32)) return 0;
  uint64_t len = wordAt(d, off);
  if (len > (d.size() - off - 32) / 32) return 0;   // truncated payload: treat as absent
  return (size_t)len;
}

int64_t AbiDecoder::arrayInt(size_t word, size_t i) const {
  uint64_t off = uint(word);
  if (!inRange(d, off, 32)) return 0;
  uint64_t len = wordAt(d, off);
  if (i >= len) return 0;
  return (int64_t)wordAt(d, off + 32 + (uint64_t)i * 32);
}

}  // namespace ethtx
