// JSON-RPC over TLS to BNB Smart Chain, plus typed wrappers for FlyRegistry and FlyCore.
// Everything here is best-effort and returns false on any network or decode error; callers retry on their schedule.
#pragma once
#include <stdint.h>
#include <string>
#include <vector>
#include "ethtx.h"

namespace rpc {

struct Client {
  std::string url;                       // https://…
  bool call(const std::string& method, const std::string& paramsJson, std::string& resultOut);   // raw JSON-RPC; resultOut = the "result" value as JSON text
  bool ethCall(const uint8_t to[20], const ethtx::Bytes& data, ethtx::Bytes& out);
  bool blockNumber(uint64_t& out);
  bool nonce(const uint8_t addr[20], uint64_t& out);                 // pending
  bool gasPrice(uint64_t& out);
  bool balance(const uint8_t addr[20], uint64_t& weiLow64, bool& overflow);
  bool sendRaw(const ethtx::Bytes& raw, uint8_t txHash[32]);
  bool receiptStatus(const uint8_t txHash[32], int& status, uint64_t& block);   // status: -1 pending, 0 failed, 1 ok
};

struct Wallet { uint8_t priv[32]; uint8_t addr[20]; uint64_t nonce = 0; bool nonceKnown = false; };

// One signed contract call: builds data, fetches the nonce if unknown, signs, sends. Returns the tx hash.
bool sendCall(Client& c, Wallet& w, const uint8_t to[20], const ethtx::Bytes& data, uint64_t gas, uint8_t txHash[32]);

// ---- FlyRegistry (contracts/src/FlyRegistry.sol)
struct FlyRecord { uint64_t brainStep, energy, bornBlock, lastCommitBlock; uint32_t generation, deaths; uint8_t body[20], pendingBody[20]; bool alive; uint8_t stateRoot[32], memoryRoot[32]; std::string stateURI; uint64_t parentA, parentB; };
struct Registry {
  Client& c; uint8_t addr[20];
  Registry(Client& client, const char* hexAddr);
  bool fly(uint64_t id, FlyRecord& out);
  bool flyName(uint64_t id, std::string& out);
  bool ownerOf(uint64_t id, uint8_t out[20]);
  bool totalMinted(uint64_t& out);
  bool isBody(const uint8_t who[20], bool& out);
  bool body(const uint8_t who[20], std::string& name, std::string& uri, uint64_t* registeredBlock = nullptr, uint32_t* flies = nullptr);   // bodies(addr): the brain host's origin lives in uri
  // writes (signed by the pebble)
  bool registerBody(Wallet& w, const std::string& name, const std::string& uri, uint8_t tx[32]);
  bool accept(Wallet& w, uint64_t id, uint8_t tx[32]);
  bool release(Wallet& w, uint64_t id, uint8_t tx[32]);
  bool assign(Wallet& w, uint64_t id, const uint8_t body[20], uint8_t tx[32]);
  bool interaction(Wallet& w, uint64_t id, const char* kind, const std::string& data, uint8_t tx[32]);
  bool commit(Wallet& w, uint64_t id, const uint8_t stateRoot[32], const uint8_t memoryRoot[32], const std::string& stateURI, const std::string& metadataURI, uint64_t brainStep, uint64_t energy, const uint8_t historyRoot[32], uint8_t tx[32]);
  bool died(Wallet& w, uint64_t id, const uint8_t stateRoot[32], const uint8_t memoryRoot[32], const std::string& stateURI, const std::string& metadataURI, uint64_t brainStep, const std::string& cause, uint8_t tx[32]);
  bool mint(Wallet& w, const std::string& name, uint8_t tx[32]);      // needs $FLY allowance first (approveFly)
};
// $FLY approve(registry, max)
bool approveFly(Client& c, Wallet& w, const uint8_t token[20], const uint8_t spender[20], uint8_t tx[32]);

// ---- FlyCore (contracts/src/FlyCore.sol)
struct CoreState { std::vector<int16_t> v; std::vector<int8_t> bias; uint16_t hist[16]; std::vector<int32_t> inp; uint64_t step; int32_t headX, headY; int64_t posX, posY; uint8_t stimChannel, stimParam; uint16_t stimStrength; uint64_t stimUntil; };
struct Core {
  Client& c; uint8_t addr[20];
  Core(Client& client, const char* hexAddr);
  bool state(uint64_t id, CoreState& out);
  bool stimulateAndTick(Wallet& w, uint64_t id, uint8_t ch, uint8_t param, uint8_t strength, uint16_t steps, uint8_t tx[32]);
  bool tick(Wallet& w, uint64_t id, uint16_t steps, uint8_t tx[32]);
};

}  // namespace rpc
