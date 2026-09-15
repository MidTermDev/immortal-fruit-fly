// Host mock test for lib/rpc: the transport is replaced by rpc::mockCall, which answers canned JSON-RPC responses
// (fixtures/rpc_vectors.h, generated from eth_abi / eth_account) and records what the wrappers sent, so the ABI
// plumbing between the pebble and FlyRegistry / FlyCore is checked byte-for-byte without a network.
#include <unity.h>
#include <string.h>
#include <string>
#include <vector>
#include "rpc.h"
#include "ethtx.h"
#include "keccak.h"
#include "../../fixtures/rpc_vectors.h"
#include "../../fixtures/eth_vectors.h"

namespace rpc { extern bool (*mockCall)(const std::string&, const std::string&, std::string&); const char* lastError(); }
using ethtx::Bytes;

// ---- the mock node
struct Call { std::string method, params; };
static std::vector<Call> s_calls;
static std::string s_ethCallResult;        // JSON text answered to eth_call
static std::string s_receipt = "null";
static std::string s_balance = "\"0x0\"";
static std::string s_gasPrice = "\"0x1\"";
static std::string s_nonce = "\"0x2a\"";
static bool s_fail = false;
static Bytes s_lastRaw;

static bool mock(const std::string& method, const std::string& params, std::string& out) {
  s_calls.push_back({method, params});
  if (s_fail) return false;
  if (method == "eth_call") { out = s_ethCallResult; return true; }
  if (method == "eth_getTransactionCount") { out = s_nonce; return true; }
  if (method == "eth_gasPrice") { out = s_gasPrice; return true; }
  if (method == "eth_getBalance") { out = s_balance; return true; }
  if (method == "eth_blockNumber") { out = "\"0x75bcd15\""; return true; }
  if (method == "eth_getTransactionReceipt") { out = s_receipt; return true; }
  if (method == "eth_sendRawTransaction") {
    // params = ["0x…"]: decode, hash, answer the hash like a node
    std::string hex = params.substr(2, params.size() - 4);
    if (!ethtx::fromHex(hex, s_lastRaw)) return false;
    uint8_t h[32]; keccak256(s_lastRaw.data(), s_lastRaw.size(), h);
    out = "\"" + ethtx::toHex(h, 32) + "\"";
    return true;
  }
  return false;
}

static std::string hexResult(const uint8_t* b, size_t n) { return "\"" + ethtx::toHex(b, n) + "\""; }

// the "data" field of the last eth_call's params
static Bytes lastCallData() {
  const std::string& p = s_calls.back().params;
  size_t a = p.find("\"data\":\"");
  TEST_ASSERT_TRUE(a != std::string::npos);
  a += 8;
  size_t e = p.find('"', a);
  Bytes d; TEST_ASSERT_TRUE(ethtx::fromHex(p.substr(a, e - a), d));
  return d;
}
static std::string lastCallTo() {
  const std::string& p = s_calls.back().params;
  size_t a = p.find("\"to\":\"") + 6;
  return p.substr(a, 42);
}

static rpc::Client client;
static rpc::Wallet wallet;

void setUp() {
  s_calls.clear(); s_fail = false; s_receipt = "null"; s_gasPrice = "\"0x1\""; s_nonce = "\"0x2a\""; s_lastRaw.clear();
  client.url = "https://mock";
  rpc::mockCall = mock;
  memcpy(wallet.priv, ETH_TEST_PRIV, 32); memcpy(wallet.addr, ETH_TEST_ADDR, 20);
  wallet.nonce = 0; wallet.nonceKnown = false;
}
void tearDown() {}

// ---- quantities and results

void test_block_number_and_gas_price() {
  uint64_t v = 0;
  TEST_ASSERT_TRUE(client.blockNumber(v));
  TEST_ASSERT_EQUAL_UINT64(0x75bcd15ULL, v);
  TEST_ASSERT_EQUAL_STRING("eth_blockNumber", s_calls.back().method.c_str());
  TEST_ASSERT_EQUAL_STRING("[]", s_calls.back().params.c_str());
  s_gasPrice = "\"0x3b9aca00\"";
  TEST_ASSERT_TRUE(client.gasPrice(v));
  TEST_ASSERT_EQUAL_UINT64(1000000000ULL, v);
  s_gasPrice = "\"0x\"";
  TEST_ASSERT_FALSE(client.gasPrice(v));
  s_gasPrice = "\"0x10000000000000000\"";   // 2^64: overflow
  TEST_ASSERT_FALSE(client.gasPrice(v));
  s_gasPrice = "0x1";                        // unquoted: not a JSON string
  TEST_ASSERT_FALSE(client.gasPrice(v));
}

void test_nonce_params() {
  uint64_t n = 0;
  TEST_ASSERT_TRUE(client.nonce(wallet.addr, n));
  TEST_ASSERT_EQUAL_UINT64(42, n);
  TEST_ASSERT_EQUAL_STRING("[\"" ETH_TEST_ADDR_LOWER "\",\"pending\"]", s_calls.back().params.c_str());
}

void test_balance() {
  uint64_t wei = 0; bool over = true;
  s_balance = "\"0xb1a2bc2ec50000\"";   // 0.05 BNB
  TEST_ASSERT_TRUE(client.balance(wallet.addr, wei, over));
  TEST_ASSERT_EQUAL_UINT64(50000000000000000ULL, wei);
  TEST_ASSERT_FALSE(over);
  s_balance = "\"0x400000000000000000\"";   // 2^70: above 64 bits
  TEST_ASSERT_TRUE(client.balance(wallet.addr, wei, over));
  TEST_ASSERT_TRUE(over);
  TEST_ASSERT_EQUAL_UINT64(0, wei);
  s_balance = "\"0x0\"";
  TEST_ASSERT_TRUE(client.balance(wallet.addr, wei, over));
  TEST_ASSERT_EQUAL_UINT64(0, wei); TEST_ASSERT_FALSE(over);
}

void test_receipt() {
  int st = 5; uint64_t bn = 1;
  TEST_ASSERT_TRUE(client.receiptStatus(RPC_TX_HASH, st, bn));
  TEST_ASSERT_EQUAL_INT(-1, st);
  // a geth-style receipt with a log that carries its own blockNumber before the top-level fields
  s_receipt = "{\"logs\":[{\"address\":\"0x0eeb\",\"blockNumber\":\"0x1\",\"topics\":[],\"data\":\"0x\",\"status\":\"0x0\"}],"
              "\"blockNumber\":\"0x75bcd15\",\"status\":\"0x1\",\"transactionHash\":\"0xabc\"}";
  TEST_ASSERT_TRUE(client.receiptStatus(RPC_TX_HASH, st, bn));
  TEST_ASSERT_EQUAL_INT(1, st);
  TEST_ASSERT_EQUAL_UINT64(0x75bcd15ULL, bn);
  s_receipt = "{\"blockNumber\":\"0x10\",\"logs\":[],\"status\":\"0x0\"}";
  TEST_ASSERT_TRUE(client.receiptStatus(RPC_TX_HASH, st, bn));
  TEST_ASSERT_EQUAL_INT(0, st);
  TEST_ASSERT_EQUAL_UINT64(16, bn);
  s_receipt = "{\"blockNumber\":\"0x10\"}";   // no status at all
  TEST_ASSERT_FALSE(client.receiptStatus(RPC_TX_HASH, st, bn));
}

void test_transport_failure_propagates() {
  s_fail = true;
  uint64_t v; bool b; rpc::FlyRecord f; rpc::CoreState cs; uint8_t tx[32];
  rpc::Registry reg(client, RPC_REGISTRY);
  rpc::Core core(client, RPC_CORE);
  TEST_ASSERT_FALSE(client.blockNumber(v));
  TEST_ASSERT_FALSE(reg.totalMinted(v));
  TEST_ASSERT_FALSE(reg.isBody(wallet.addr, b));
  TEST_ASSERT_FALSE(reg.fly(1, f));
  TEST_ASSERT_FALSE(core.state(1, cs));
  TEST_ASSERT_FALSE(reg.accept(wallet, 1, tx));
  TEST_ASSERT_FALSE(wallet.nonceKnown);
  client.url = "";
  s_fail = false;
  TEST_ASSERT_FALSE(client.blockNumber(v));
  TEST_ASSERT_EQUAL_STRING("no rpc url", rpc::lastError());
}

// ---- registry views

void test_registry_fly_decode() {
  rpc::Registry reg(client, RPC_REGISTRY);
  s_ethCallResult = hexResult(RPC_FLY_RET, sizeof RPC_FLY_RET);
  rpc::FlyRecord f;
  TEST_ASSERT_TRUE(reg.fly(RPC_FLY_ID, f));
  TEST_ASSERT_EQUAL_STRING("eth_call", s_calls.back().method.c_str());
  TEST_ASSERT_EQUAL_STRING("0x0eeb0a675720306ef6f426bd8560c1288848f813", lastCallTo().c_str());
  Bytes d = lastCallData();
  TEST_ASSERT_EQUAL_UINT(sizeof RPC_CALL_FLY, d.size());
  TEST_ASSERT_EQUAL_MEMORY(RPC_CALL_FLY, d.data(), sizeof RPC_CALL_FLY);
  TEST_ASSERT_EQUAL_UINT32(RPC_FLY_GENERATION, f.generation);
  TEST_ASSERT_EQUAL_UINT32(RPC_FLY_DEATHS, f.deaths);
  TEST_ASSERT_EQUAL_UINT64(0, f.parentA);
  TEST_ASSERT_EQUAL_UINT64(0, f.parentB);
  TEST_ASSERT_EQUAL_MEMORY(RPC_FLY_STATEROOT, f.stateRoot, 32);
  TEST_ASSERT_EQUAL_MEMORY(RPC_FLY_MEMROOT, f.memoryRoot, 32);
  TEST_ASSERT_EQUAL_STRING(RPC_FLY_URI, f.stateURI.c_str());
  TEST_ASSERT_EQUAL_UINT64(RPC_FLY_BRAINSTEP, f.brainStep);
  TEST_ASSERT_EQUAL_UINT64(RPC_FLY_ENERGY, f.energy);
  TEST_ASSERT_EQUAL_UINT64(RPC_FLY_BORN, f.bornBlock);
  TEST_ASSERT_EQUAL_UINT64(RPC_FLY_LASTCOMMIT, f.lastCommitBlock);
  TEST_ASSERT_EQUAL_MEMORY(RPC_FLY_BODY, f.body, 20);
  TEST_ASSERT_EQUAL_MEMORY(RPC_FLY_PENDING, f.pendingBody, 20);
  TEST_ASSERT_EQUAL_MEMORY(ETH_TEST_ADDR, f.pendingBody, 20);   // the pebble is the pending body in this vector
  TEST_ASSERT_TRUE(f.alive);
  // a reverting call (nonexistent token) is an rpc error -> false
  s_fail = true;
  TEST_ASSERT_FALSE(reg.fly(999, f));
  s_fail = false;
  // a truncated payload is rejected, not misread
  s_ethCallResult = hexResult(RPC_FLY_RET, 200);
  TEST_ASSERT_FALSE(reg.fly(RPC_FLY_ID, f));
}

void test_registry_simple_views() {
  rpc::Registry reg(client, RPC_REGISTRY);
  uint8_t w[32]; memset(w, 0, 32); w[31] = 9;
  s_ethCallResult = hexResult(w, 32);
  uint64_t total = 0;
  TEST_ASSERT_TRUE(reg.totalMinted(total));
  TEST_ASSERT_EQUAL_UINT64(9, total);
  TEST_ASSERT_EQUAL_MEMORY(RPC_CALL_TOTALMINTED, lastCallData().data(), 4);
  TEST_ASSERT_EQUAL_UINT(4, lastCallData().size());
  w[31] = 1;
  s_ethCallResult = hexResult(w, 32);
  bool body = false;
  TEST_ASSERT_TRUE(reg.isBody(wallet.addr, body));
  TEST_ASSERT_TRUE(body);
  TEST_ASSERT_EQUAL_MEMORY(RPC_CALL_ISBODY, lastCallData().data(), sizeof RPC_CALL_ISBODY);
  memset(w, 0, 32); memcpy(w + 12, ETH_TEST_ADDR, 20);
  s_ethCallResult = hexResult(w, 32);
  uint8_t owner[20];
  TEST_ASSERT_TRUE(reg.ownerOf(1, owner));
  TEST_ASSERT_EQUAL_MEMORY(ETH_TEST_ADDR, owner, 20);
  // flyName: a string return
  static const uint8_t nameRet[96] = {
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0x20,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11,
    'P','e','b','b','l','e',' ','9','1','a','0',0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0};
  s_ethCallResult = hexResult(nameRet, 96);
  std::string name;
  TEST_ASSERT_TRUE(reg.flyName(1, name));
  TEST_ASSERT_EQUAL_STRING("Pebble 91a0", name.c_str());
  // short return data
  s_ethCallResult = "\"0x\"";
  TEST_ASSERT_FALSE(reg.totalMinted(total));
}

// ---- core view

void test_core_state_decode() {
  rpc::Core core(client, RPC_CORE);
  s_ethCallResult = hexResult(RPC_CORE_RET, sizeof RPC_CORE_RET);
  rpc::CoreState s;
  TEST_ASSERT_TRUE(core.state(RPC_FLY_ID, s));
  TEST_ASSERT_EQUAL_STRING("0x00000000000000000000000000000000000000ff", lastCallTo().c_str());
  TEST_ASSERT_EQUAL_MEMORY(RPC_CALL_CORE, lastCallData().data(), sizeof RPC_CALL_CORE);
  TEST_ASSERT_EQUAL_UINT(RPC_CORE_N, s.v.size());
  TEST_ASSERT_EQUAL_UINT(RPC_CORE_N, s.bias.size());
  TEST_ASSERT_EQUAL_UINT(RPC_CORE_N, s.inp.size());
  for (int i = 0; i < RPC_CORE_N; ++i) {
    TEST_ASSERT_EQUAL_INT16(RPC_CORE_V[i], s.v[i]);
    TEST_ASSERT_EQUAL_INT8(RPC_CORE_BIAS[i], s.bias[i]);
    TEST_ASSERT_EQUAL_INT32(RPC_CORE_INP[i], s.inp[i]);
  }
  for (int w = 0; w < 16; ++w) TEST_ASSERT_EQUAL_UINT16(RPC_CORE_HIST[w], s.hist[w]);
  TEST_ASSERT_EQUAL_UINT64((uint64_t)RPC_CORE_STEP, s.step);
  TEST_ASSERT_EQUAL_INT32((int32_t)RPC_CORE_HEADX, s.headX);
  TEST_ASSERT_EQUAL_INT32((int32_t)RPC_CORE_HEADY, s.headY);
  TEST_ASSERT_EQUAL_INT64(RPC_CORE_POSX, s.posX);
  TEST_ASSERT_EQUAL_INT64(RPC_CORE_POSY, s.posY);
  TEST_ASSERT_EQUAL_UINT8((uint8_t)RPC_CORE_STIMCHANNEL, s.stimChannel);
  TEST_ASSERT_EQUAL_UINT8((uint8_t)RPC_CORE_STIMPARAM, s.stimParam);
  TEST_ASSERT_EQUAL_UINT16((uint16_t)RPC_CORE_STIMSTRENGTH, s.stimStrength);
  TEST_ASSERT_EQUAL_UINT64((uint64_t)RPC_CORE_STIMUNTIL, s.stimUntil);
  // the 13-field shape from eth_vectors.h (no totalSpikes) decodes the same way
  s_ethCallResult = hexResult(CORE_RET, sizeof CORE_RET);
  TEST_ASSERT_TRUE(core.state(1, s));
  TEST_ASSERT_EQUAL_UINT(155, s.v.size());
  // truncated: rejected
  s_ethCallResult = hexResult(RPC_CORE_RET, 29 * 32 + 40);
  TEST_ASSERT_FALSE(core.state(RPC_FLY_ID, s));
}

// ---- signed calls

void test_send_call_signs_like_eth_account() {
  rpc::Registry reg(client, RPC_REGISTRY);
  uint8_t tx[32];
  TEST_ASSERT_FALSE(wallet.nonceKnown);
  TEST_ASSERT_TRUE(reg.accept(wallet, 1, tx));
  // sequence: nonce fetch, gas price, send
  TEST_ASSERT_EQUAL_UINT(3, s_calls.size());
  TEST_ASSERT_EQUAL_STRING("eth_getTransactionCount", s_calls[0].method.c_str());
  TEST_ASSERT_EQUAL_STRING("eth_gasPrice", s_calls[1].method.c_str());
  TEST_ASSERT_EQUAL_STRING("eth_sendRawTransaction", s_calls[2].method.c_str());
  TEST_ASSERT_EQUAL_UINT(sizeof RPC_TX_RAW, s_lastRaw.size());
  TEST_ASSERT_EQUAL_MEMORY(RPC_TX_RAW, s_lastRaw.data(), sizeof RPC_TX_RAW);
  TEST_ASSERT_EQUAL_MEMORY(RPC_TX_HASH, tx, 32);
  TEST_ASSERT_TRUE(wallet.nonceKnown);
  TEST_ASSERT_EQUAL_UINT64(43, wallet.nonce);
  // the anchor: nonce 43 comes from the wallet (no fetch), gas price from the node (1 gwei > floor), gas by steps
  rpc::Core core(client, RPC_CORE);
  s_gasPrice = "\"0x3b9aca00\"";
  s_calls.clear();
  TEST_ASSERT_TRUE(core.stimulateAndTick(wallet, 7, 4, 0, 20, 16, tx));
  TEST_ASSERT_EQUAL_UINT(2, s_calls.size());
  TEST_ASSERT_EQUAL_STRING("eth_gasPrice", s_calls[0].method.c_str());
  TEST_ASSERT_EQUAL_UINT(sizeof RPC_TX2_RAW, s_lastRaw.size());
  TEST_ASSERT_EQUAL_MEMORY(RPC_TX2_RAW, s_lastRaw.data(), sizeof RPC_TX2_RAW);
  TEST_ASSERT_EQUAL_MEMORY(RPC_TX2_HASH, tx, 32);
  TEST_ASSERT_EQUAL_UINT64(44, wallet.nonce);
  // a rejected send (nonce too low, no funds…) forgets the nonce so the next call re-fetches it
  s_fail = true;
  TEST_ASSERT_FALSE(reg.accept(wallet, 1, tx));
  TEST_ASSERT_FALSE(wallet.nonceKnown);
}

void test_gas_price_is_capped() {
  rpc::Registry reg(client, RPC_REGISTRY);
  uint8_t tx[32];
  s_gasPrice = "\"0x2540be400\"";   // 10 gwei: above the 5 gwei cap
  TEST_ASSERT_TRUE(reg.accept(wallet, 1, tx));
  // decode the gasPrice from the raw RLP: item 2 of the list (after nonce)
  // raw = f8 xx | nonce(2a) | gasPrice(85 01 2a 05 f2 00 = 5 gwei) …
  TEST_ASSERT_EQUAL_HEX8(0x2a, s_lastRaw[2]);
  TEST_ASSERT_EQUAL_HEX8(0x85, s_lastRaw[3]);
  static const uint8_t fiveGwei[5] = {0x01, 0x2a, 0x05, 0xf2, 0x00};
  TEST_ASSERT_EQUAL_MEMORY(fiveGwei, &s_lastRaw[4], 5);
}

static Bytes lastTxData() {
  // the data item is the 6th RLP item; simplest: search the raw bytes for the 4-byte selector of the expected calldata
  return s_lastRaw;
}

void test_interaction_kind_and_data_encoding() {
  rpc::Registry reg(client, RPC_REGISTRY);
  uint8_t tx[32];
  TEST_ASSERT_TRUE(reg.interaction(wallet, 7, "landmark", "landmark on the left (wedge 4, x8)", tx));
  Bytes raw = lastTxData();
  // the calldata must appear verbatim inside the signed transaction
  bool found = false;
  for (size_t i = 0; i + sizeof RPC_CALL_INTERACTION <= raw.size(); ++i)
    if (memcmp(&raw[i], RPC_CALL_INTERACTION, sizeof RPC_CALL_INTERACTION) == 0) { found = true; break; }
  TEST_ASSERT_TRUE_MESSAGE(found, "interaction(uint256,bytes32,string) calldata with a zero-padded kind");
  // died(): empty metadataURI, cause string
  TEST_ASSERT_TRUE(reg.died(wallet, 7, RPC_FLY_STATEROOT, RPC_FLY_MEMROOT, RPC_FLY_URI, "", RPC_FLY_BRAINSTEP + 16, "starved in Pebble 91a0", tx));
  raw = lastTxData(); found = false;
  for (size_t i = 0; i + sizeof RPC_CALL_DIED <= raw.size(); ++i)
    if (memcmp(&raw[i], RPC_CALL_DIED, sizeof RPC_CALL_DIED) == 0) { found = true; break; }
  TEST_ASSERT_TRUE_MESSAGE(found, "died(...) calldata");
  // approve(registry, max)
  uint8_t token[20], spender[20]; Bytes t;
  ethtx::fromHex(RPC_TOKEN, t); memcpy(token, t.data(), 20);
  ethtx::fromHex(RPC_REGISTRY, t); memcpy(spender, t.data(), 20);
  TEST_ASSERT_TRUE(rpc::approveFly(client, wallet, token, spender, tx));
  raw = lastTxData(); found = false;
  for (size_t i = 0; i + sizeof RPC_CALL_APPROVE <= raw.size(); ++i)
    if (memcmp(&raw[i], RPC_CALL_APPROVE, sizeof RPC_CALL_APPROVE) == 0) { found = true; break; }
  TEST_ASSERT_TRUE_MESSAGE(found, "approve(address,uint256) calldata");
  // a 600-char interaction text is cut to 512 like brain/registry.py does
  std::string longText(600, 'x');
  TEST_ASSERT_TRUE(reg.interaction(wallet, 7, "note", longText, tx));
  raw = lastTxData();
  size_t xs = 0; for (uint8_t b : raw) if (b == 'x') xs++;
  TEST_ASSERT_EQUAL_UINT(512, xs);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_block_number_and_gas_price);
  RUN_TEST(test_nonce_params);
  RUN_TEST(test_balance);
  RUN_TEST(test_receipt);
  RUN_TEST(test_transport_failure_propagates);
  RUN_TEST(test_registry_fly_decode);
  RUN_TEST(test_registry_simple_views);
  RUN_TEST(test_core_state_decode);
  RUN_TEST(test_send_call_signs_like_eth_account);
  RUN_TEST(test_gas_price_is_capped);
  RUN_TEST(test_interaction_kind_and_data_encoding);
  return UNITY_END();
}
