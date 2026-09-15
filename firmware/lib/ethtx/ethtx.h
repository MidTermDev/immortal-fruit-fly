// Ethereum transactions on a microcontroller: secp256k1 signing with recovery id, RLP, EIP-155 legacy tx,
// address derivation, and just enough ABI encoding/decoding for FlyRegistry and FlyCore.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <vector>

namespace ethtx {

using Bytes = std::vector<uint8_t>;

bool privateKeyToAddress(const uint8_t priv[32], uint8_t addr[20]);   // false if the key is invalid
std::string toHex(const uint8_t* b, size_t n, bool prefix = true);
std::string checksumAddress(const uint8_t addr[20]);                    // EIP-55
bool fromHex(const std::string& hex, Bytes& out);                       // accepts 0x prefix, odd length

// Legacy (type 0) transaction, EIP-155 signed for `chainId`. Returns the raw RLP bytes for eth_sendRawTransaction.
struct Tx { uint64_t nonce; uint64_t gasPrice; uint64_t gas; uint8_t to[20]; uint64_t value = 0; Bytes data; uint64_t chainId = 56; };
bool sign(const Tx& tx, const uint8_t priv[32], Bytes& rawOut, uint8_t txHash[32]);

// Deterministic (RFC 6979) secp256k1 signature of a 32-byte digest; recid is 0 or 1.
bool signDigest(const uint8_t digest[32], const uint8_t priv[32], uint8_t sig64[64], uint8_t* recid);

// ABI helpers. Words are 32 bytes big-endian.
class AbiEncoder {
 public:
  explicit AbiEncoder(const char* signature);         // e.g. "tick(uint256,uint16)" → 4-byte selector
  AbiEncoder& uint(uint64_t v);                       // any uintN / bool
  AbiEncoder& uint256(const uint8_t word[32]);
  AbiEncoder& int_(int64_t v);                        // any intN
  AbiEncoder& address(const uint8_t addr[20]);
  AbiEncoder& bytes32(const uint8_t b[32]);
  AbiEncoder& string(const std::string& s);           // dynamic; tail appended at finish()
  AbiEncoder& bytes(const Bytes& b);                  // dynamic
  Bytes finish();
 private:
  Bytes head_; std::vector<Bytes> tails_; std::vector<size_t> tailSlots_;
};
struct AbiDecoder {                                    // over the return data of eth_call
  const Bytes& d; explicit AbiDecoder(const Bytes& data) : d(data) {}
  uint64_t uint(size_t word) const;                    // low 64 bits of word `word`
  int64_t int_(size_t word) const;                     // sign-extended
  bool boolean(size_t word) const;
  void address(size_t word, uint8_t out[20]) const;
  void bytes32(size_t word, uint8_t out[32]) const;
  std::string string(size_t word) const;               // follows the offset in `word`
  size_t arrayLen(size_t word) const;                  // for dynamic arrays: length at the offset
  int64_t arrayInt(size_t word, size_t i) const;       // element i of a dynamic intN[]/uintN[] array at `word`
  size_t words() const { return d.size() / 32; }
};

uint64_t rlpDecodeUint(const Bytes& b);  // small helper for receipts if needed

}  // namespace ethtx
