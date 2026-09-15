// JSON-RPC to BNB Smart Chain and the typed FlyRegistry / FlyCore wrappers declared in rpc.h.
//
// Two layers:
//   1. the transport, Client::call — on the device: WiFiClientSecure + HTTPClient + ArduinoJson, TLS roots from
//      include/certs.h (or -DINSECURE_TLS=1), one keep-alive connection, a 64 KB PSRAM response buffer, a mutex;
//      on the host (native tests): a hook, rpc::mockCall, that answers canned responses;
//   2. everything above it (quantities, eth_call decoding, signing, the registry/core wrappers), shared, so the
//      native test exercises exactly the code the pebble runs.
// Every function returns false on any transport, HTTP, JSON or decode error and leaves a one-line reason in
// rpc::lastError() (declared by the body in src/pebble.h and by the test; it is not part of the fixed rpc.h).
#include "rpc.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "keccak.h"
#if __has_include("config.h")
#include "config.h"
#endif

#ifndef RPC_TIMEOUT_MS
#define RPC_TIMEOUT_MS 15000
#endif
#ifndef RPC_MAX_RESPONSE
#define RPC_MAX_RESPONSE (64 * 1024)
#endif
#ifndef RPC_RETRIES
#define RPC_RETRIES 2
#endif
#ifndef GAS_PRICE_WEI
#define GAS_PRICE_WEI 50000000ULL
#endif
#ifndef GAS_PRICE_MAX_WEI
#define GAS_PRICE_MAX_WEI 5000000000ULL
#endif
#ifndef CHAIN_ID
#define CHAIN_ID 56
#endif
#ifndef ANCHOR_GAS_BASE
#define ANCHOR_GAS_BASE 600000ULL
#endif
#ifndef ANCHOR_GAS_PER_STEP
#define ANCHOR_GAS_PER_STEP 330000ULL
#endif

namespace rpc {

using ethtx::Bytes;

// ------------------------------------------------------------------ diagnostics

static char s_lastError[160] = "";
static void setError(const char* what, const char* detail = nullptr) {
  if (detail && *detail) snprintf(s_lastError, sizeof s_lastError, "%s: %s", what, detail);
  else snprintf(s_lastError, sizeof s_lastError, "%s", what);
}
const char* lastError() { return s_lastError; }

}  // namespace rpc

// =============================================================================================== transport (device)
#if defined(ARDUINO)

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#define ARDUINOJSON_ENABLE_STD_STRING 1
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#if __has_include("certs.h")
#include "certs.h"
#define HAVE_CERTS 1
#else
#define HAVE_CERTS 0
#endif

namespace rpc {

static void* bigAlloc(size_t n) {
  void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!p) p = malloc(n);
  return p;
}

struct PsramAllocator : ArduinoJson::Allocator {
  void* allocate(size_t n) override { return bigAlloc(n); }
  void deallocate(void* p) override { free(p); }
  void* reallocate(void* p, size_t n) override {
    void* q = heap_caps_realloc(p, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!q) q = realloc(p, n);
    return q;
  }
};
static PsramAllocator s_jsonAlloc;

struct Conn {
  WiFiClientSecure tls;
  HTTPClient http;
  char* buf = nullptr;     // response buffer, PSRAM
  size_t cap = 0;
  uint32_t nextId = 1;
  bool ready = false;
};
static Conn* s_conn = nullptr;
static SemaphoreHandle_t s_lock = nullptr;

static Conn* conn() {
  if (!s_lock) s_lock = xSemaphoreCreateMutex();
  if (!s_conn) {
    s_conn = new Conn();
    s_conn->cap = RPC_MAX_RESPONSE;
    s_conn->buf = (char*)bigAlloc(s_conn->cap + 1);
#if defined(INSECURE_TLS) && INSECURE_TLS
    s_conn->tls.setInsecure();
#elif HAVE_CERTS
    s_conn->tls.setCACert(ROOT_CERTS);
#else
    s_conn->tls.setInsecure();
#endif
    s_conn->tls.setHandshakeTimeout(RPC_TIMEOUT_MS / 1000);
    s_conn->tls.setTimeout(RPC_TIMEOUT_MS / 1000);
    s_conn->http.setReuse(true);
    s_conn->http.setConnectTimeout(RPC_TIMEOUT_MS);
    s_conn->http.setTimeout(RPC_TIMEOUT_MS);
    s_conn->http.useHTTP10(false);
    s_conn->ready = s_conn->buf != nullptr;
  }
  return s_conn;
}

struct Lock {
  Lock() { xSemaphoreTake(s_lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(s_lock); }
};

// Read exactly n bytes into dst before the deadline; false if the connection closes or the deadline passes first.
static bool readExact(WiFiClient* s, uint8_t* dst, size_t n, uint32_t deadline) {
  size_t got = 0;
  while (got < n) {
    if ((int32_t)(millis() - deadline) > 0) return false;
    int a = s->available();
    if (a <= 0) {
      if (!s->connected()) return false;
      delay(2);
      continue;
    }
    size_t want = n - got;
    if ((size_t)a < want) want = (size_t)a;
    int r = s->read(dst + got, want);
    if (r < 0) return false;
    got += (size_t)r;
  }
  return true;
}

// Read one CRLF-terminated line (without the CRLF) into line; false on timeout/close.
static bool readLine(WiFiClient* s, char* line, size_t cap, uint32_t deadline) {
  size_t n = 0;
  for (;;) {
    uint8_t c;
    if (!readExact(s, &c, 1, deadline)) return false;
    if (c == '\n') break;
    if (c != '\r' && n + 1 < cap) line[n++] = (char)c;
  }
  line[n] = 0;
  return true;
}

// Read the body of the current response into c->buf handling Content-Length, chunked and close-delimited bodies
// with an overall deadline (HTTPClient's own writeToStream has no deadline). Returns the body length or -1.
static int readBody(Conn* c, uint32_t deadline) {
  WiFiClient* s = c->http.getStreamPtr();
  if (!s) { setError("no stream"); return -1; }
  size_t len = 0;
  bool chunked = c->http.header("Transfer-Encoding").indexOf("chunked") >= 0;
  if (chunked) {
    char line[32];
    for (;;) {
      if (!readLine(s, line, sizeof line, deadline)) { setError("chunk header timeout"); return -1; }
      if (!line[0]) continue;
      size_t n = (size_t)strtoul(line, nullptr, 16);
      if (n == 0) {
        while (readLine(s, line, sizeof line, deadline) && line[0]) {}   // trailer up to the empty line
        break;
      }
      if (len + n > c->cap) { setError("response too large"); return -1; }
      if (!readExact(s, (uint8_t*)c->buf + len, n, deadline)) { setError("chunk body timeout"); return -1; }
      len += n;
      if (!readLine(s, line, sizeof line, deadline)) { setError("chunk trailer timeout"); return -1; }
    }
  } else {
    int size = c->http.getSize();   // -1: no Content-Length, read until the server closes
    if (size >= 0) {
      if ((size_t)size > c->cap) { setError("response too large"); return -1; }
      if (!readExact(s, (uint8_t*)c->buf, (size_t)size, deadline)) { setError("body timeout"); return -1; }
      len = (size_t)size;
    } else {
      for (;;) {
        if ((int32_t)(millis() - deadline) > 0) { setError("body timeout"); return -1; }
        int a = s->available();
        if (a <= 0) {
          if (!s->connected()) break;
          delay(2);
          continue;
        }
        if (len + (size_t)a > c->cap) { setError("response too large"); return -1; }
        int r = s->read((uint8_t*)c->buf + len, (size_t)a);
        if (r < 0) break;
        len += (size_t)r;
      }
    }
  }
  c->buf[len] = 0;
  return (int)len;
}

bool Client::call(const std::string& method, const std::string& paramsJson, std::string& resultOut) {
  Conn* c = conn();
  if (!c->ready) { setError("rpc: no buffer"); return false; }
  Lock lock;
  if (WiFi.status() != WL_CONNECTED) { setError("wifi down"); return false; }
  if (url.empty()) { setError("no rpc url"); return false; }

  std::string body;
  body.reserve(paramsJson.size() + method.size() + 64);
  body += "{\"jsonrpc\":\"2.0\",\"id\":";
  body += std::to_string(c->nextId++);
  body += ",\"method\":\"";
  body += method;
  body += "\",\"params\":";
  body += paramsJson;
  body += "}";

  for (int attempt = 0; attempt < RPC_RETRIES; ++attempt) {
    if (attempt) { c->http.end(); c->tls.stop(); delay(200); }
    if (!c->http.begin(c->tls, String(url.c_str()))) { setError("http begin failed"); continue; }
    static const char* hdrs[] = {"Transfer-Encoding", "Content-Length"};
    c->http.collectHeaders(hdrs, 2);   // per request: HTTPClient keeps stale values otherwise
    c->http.addHeader("Content-Type", "application/json");
    c->http.addHeader("Accept", "application/json");
    uint32_t t0 = millis();
    int code = c->http.POST((uint8_t*)body.data(), body.size());
    if (code != 200) {
      char d[48]; snprintf(d, sizeof d, "%d %s", code, code < 0 ? HTTPClient::errorToString(code).c_str() : "");
      setError("http", d);
      c->http.end(); c->tls.stop();
      continue;
    }
    int len = readBody(c, t0 + RPC_TIMEOUT_MS);
    if (len < 0) { c->http.end(); c->tls.stop(); continue; }
    c->http.end();   // keeps the socket when the server allowed keep-alive

    JsonDocument doc(&s_jsonAlloc);
    DeserializationError err = deserializeJson(doc, c->buf, (size_t)len);   // zero-copy: strings point into buf
    if (err) { setError("json", err.c_str()); return false; }
    if (!doc["error"].isNull()) {
      const char* msg = doc["error"]["message"] | "rpc error";
      setError("rpc", msg);
      return false;
    }
    JsonVariantConst res = doc["result"];
    if (res.isUnbound()) { setError("rpc: no result"); return false; }
    resultOut.clear();
    serializeJson(res, resultOut);
    return true;
  }
  return false;
}

}  // namespace rpc

// =============================================================================================== transport (host mock)
#else

namespace rpc {

bool (*mockCall)(const std::string& method, const std::string& paramsJson, std::string& resultOut) = nullptr;

bool Client::call(const std::string& method, const std::string& paramsJson, std::string& resultOut) {
  if (url.empty()) { setError("no rpc url"); return false; }
  if (!mockCall) { setError("no transport on the host"); return false; }
  return mockCall(method, paramsJson, resultOut);
}

}  // namespace rpc

#endif

// =============================================================================================== shared layer
namespace rpc {

static bool unquote(const std::string& json, std::string& out) {
  if (json.size() < 2 || json.front() != '"' || json.back() != '"') return false;
  out.assign(json, 1, json.size() - 2);
  return true;
}

static bool hexToU64(const std::string& hex, uint64_t& out) {
  size_t i = (hex.size() >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) ? 2 : 0;
  if (i >= hex.size()) return false;
  uint64_t v = 0;
  for (; i < hex.size(); ++i) {
    char ch = hex[i]; int d;
    if (ch >= '0' && ch <= '9') d = ch - '0';
    else if (ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
    else if (ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
    else return false;
    if (v >> 60) return false;   // more than 64 bits
    v = (v << 4) | (uint64_t)d;
  }
  out = v;
  return true;
}

// the string value of a top-level key in a flat JSON object (skips a nested "logs":[…] array); "" if absent
static std::string jsonStringField(const std::string& json, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t logs = json.find("\"logs\"");
  size_t logsEnd = std::string::npos;
  if (logs != std::string::npos) {
    size_t b = json.find('[', logs);
    if (b != std::string::npos) {
      int depth = 0;
      for (size_t i = b; i < json.size(); ++i) {
        if (json[i] == '[') depth++;
        else if (json[i] == ']' && --depth == 0) { logsEnd = i; break; }
      }
    }
  }
  size_t p = 0;
  for (;;) {
    p = json.find(k, p);
    if (p == std::string::npos) return "";
    if (logs != std::string::npos && p > logs && (logsEnd == std::string::npos || p < logsEnd)) { p += k.size(); continue; }
    size_t q = json.find(':', p + k.size());
    if (q == std::string::npos) return "";
    size_t a = json.find('"', q);
    if (a == std::string::npos) return "";
    size_t e = json.find('"', a + 1);
    if (e == std::string::npos) return "";
    return json.substr(a + 1, e - a - 1);
  }
}

// A quoted 0x-hex quantity → uint64 (false on overflow or bad text)
static bool callQuantity(Client& c, const char* method, const std::string& params, uint64_t& out) {
  std::string r, s;
  if (!c.call(method, params, r)) return false;
  if (!unquote(r, s) || !hexToU64(s, out)) { setError("bad quantity", method); return false; }
  return true;
}

static std::string quotedAddress(const uint8_t addr[20]) { return "\"" + ethtx::toHex(addr, 20) + "\""; }

bool Client::ethCall(const uint8_t to[20], const Bytes& data, Bytes& out) {
  std::string params = "[{\"to\":" + quotedAddress(to) + ",\"data\":\"" + ethtx::toHex(data.data(), data.size()) + "\"},\"latest\"]";
  std::string r, s;
  if (!call("eth_call", params, r)) return false;
  if (!unquote(r, s) || !ethtx::fromHex(s, out)) { setError("bad eth_call result"); return false; }
  return true;
}

bool Client::blockNumber(uint64_t& out) { return callQuantity(*this, "eth_blockNumber", "[]", out); }

bool Client::nonce(const uint8_t addr[20], uint64_t& out) {
  return callQuantity(*this, "eth_getTransactionCount", "[" + quotedAddress(addr) + ",\"pending\"]", out);
}

bool Client::gasPrice(uint64_t& out) { return callQuantity(*this, "eth_gasPrice", "[]", out); }

bool Client::balance(const uint8_t addr[20], uint64_t& weiLow64, bool& overflow) {
  std::string r, s;
  if (!call("eth_getBalance", "[" + quotedAddress(addr) + ",\"latest\"]", r)) return false;
  if (!unquote(r, s)) { setError("bad balance"); return false; }
  Bytes b;
  if (!ethtx::fromHex(s, b) || b.size() > 32) { setError("bad balance"); return false; }
  overflow = false;
  uint64_t v = 0;
  for (size_t i = 0; i < b.size(); ++i) {
    size_t fromEnd = b.size() - 1 - i;
    if (fromEnd >= 8) { if (b[i]) overflow = true; }
    else v |= (uint64_t)b[i] << (8 * fromEnd);
  }
  weiLow64 = v;
  return true;
}

bool Client::sendRaw(const Bytes& raw, uint8_t txHash[32]) {
  std::string r, s;
  if (!call("eth_sendRawTransaction", "[\"" + ethtx::toHex(raw.data(), raw.size()) + "\"]", r)) return false;
  Bytes h;
  if (!unquote(r, s) || !ethtx::fromHex(s, h) || h.size() != 32) { setError("bad tx hash"); return false; }
  memcpy(txHash, h.data(), 32);
  return true;
}

bool Client::receiptStatus(const uint8_t txHash[32], int& status, uint64_t& block) {
  std::string r;
  if (!call("eth_getTransactionReceipt", "[\"" + ethtx::toHex(txHash, 32) + "\"]", r)) return false;
  if (r == "null") { status = -1; block = 0; return true; }
  if (r.empty() || r[0] != '{') { setError("bad receipt"); return false; }
  uint64_t st = 0, bn = 0;
  std::string sts = jsonStringField(r, "status"), bns = jsonStringField(r, "blockNumber");
  if (sts.empty()) { setError("receipt without status"); return false; }
  if (!hexToU64(sts, st)) st = 0;
  if (!hexToU64(bns, bn)) bn = 0;
  status = st ? 1 : 0;
  block = bn;
  return true;
}

// ------------------------------------------------------------------ signed calls

bool sendCall(Client& c, Wallet& w, const uint8_t to[20], const Bytes& data, uint64_t gas, uint8_t txHash[32]) {
  if (!w.nonceKnown) {
    uint64_t n;
    if (!c.nonce(w.addr, n)) return false;
    w.nonce = n; w.nonceKnown = true;
  }
  uint64_t price = GAS_PRICE_WEI, net = 0;
  if (c.gasPrice(net) && net > price) price = net;
  if (price > GAS_PRICE_MAX_WEI) price = GAS_PRICE_MAX_WEI;

  ethtx::Tx tx;
  tx.nonce = w.nonce; tx.gasPrice = price; tx.gas = gas; memcpy(tx.to, to, 20); tx.value = 0; tx.data = data; tx.chainId = CHAIN_ID;
  Bytes raw;
  if (!ethtx::sign(tx, w.priv, raw, txHash)) { setError("sign failed"); return false; }
  if (!c.sendRaw(raw, txHash)) { w.nonceKnown = false; return false; }   // nonce/gas/funds problem: re-fetch next time
  w.nonce += 1;
  return true;
}

// ------------------------------------------------------------------ FlyRegistry

static void parseAddress(const char* hex, uint8_t out[20]) {
  Bytes b;
  if (hex && ethtx::fromHex(hex, b) && b.size() == 20) memcpy(out, b.data(), 20);
  else memset(out, 0, 20);
}

Registry::Registry(Client& client, const char* hexAddr) : c(client) { parseAddress(hexAddr, addr); }

bool Registry::fly(uint64_t id, FlyRecord& out) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("fly(uint256)").uint(id).finish(), ret)) return false;
  // The struct holds a string, so it is a dynamic tuple: word 0 is the offset of the struct; the string offset inside
  // the struct is relative to the struct start. Decode over a view that starts there.
  ethtx::AbiDecoder top(ret);
  uint64_t off = top.uint(0);
  if (ret.size() < 32 || off > ret.size() || ret.size() - off < 16 * 32) { setError("fly: short"); return false; }
  Bytes sub(ret.begin() + (size_t)off, ret.end());
  ethtx::AbiDecoder d(sub);
  out.generation = (uint32_t)d.uint(2);
  out.deaths = (uint32_t)d.uint(3);
  out.parentA = d.uint(4);
  out.parentB = d.uint(5);
  d.bytes32(6, out.stateRoot);
  d.bytes32(7, out.memoryRoot);
  out.stateURI = d.string(8);
  out.brainStep = d.uint(9);
  out.energy = d.uint(10);
  out.bornBlock = d.uint(11);
  out.lastCommitBlock = d.uint(12);
  d.address(13, out.body);
  d.address(14, out.pendingBody);
  out.alive = d.boolean(15);
  return true;
}

bool Registry::flyName(uint64_t id, std::string& out) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("flyName(uint256)").uint(id).finish(), ret)) return false;
  out = ethtx::AbiDecoder(ret).string(0);
  return true;
}

bool Registry::ownerOf(uint64_t id, uint8_t out[20]) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("ownerOf(uint256)").uint(id).finish(), ret)) return false;
  if (ret.size() < 32) { setError("ownerOf: short"); return false; }
  ethtx::AbiDecoder(ret).address(0, out);
  return true;
}

bool Registry::totalMinted(uint64_t& out) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("totalMinted()").finish(), ret)) return false;
  if (ret.size() < 32) { setError("totalMinted: short"); return false; }
  out = ethtx::AbiDecoder(ret).uint(0);
  return true;
}

bool Registry::isBody(const uint8_t who[20], bool& out) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("isBody(address)").address(who).finish(), ret)) return false;
  if (ret.size() < 32) { setError("isBody: short"); return false; }
  out = ethtx::AbiDecoder(ret).boolean(0);
  return true;
}

// bodies(address) is a public mapping getter: its return is the struct's members side by side (string name,
// string uri, uint64 registeredBlock, uint32 flies), not a wrapped tuple like fly(id)
bool Registry::body(const uint8_t who[20], std::string& name, std::string& uri, uint64_t* registeredBlock, uint32_t* flies) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("bodies(address)").address(who).finish(), ret)) return false;
  ethtx::AbiDecoder d(ret);
  if (d.words() < 4) { setError("bodies: short"); return false; }
  uint64_t offName = d.uint(0), offUri = d.uint(1);
  if (offName + 32 > ret.size() || offUri + 32 > ret.size()) { setError("bodies: bad offsets"); return false; }
  name = d.string(0);
  uri = d.string(1);
  if (registeredBlock) *registeredBlock = d.uint(2);
  if (flies) *flies = (uint32_t)d.uint(3);
  return true;
}

// gas limits: HARDWARE.md §4.4 with ~50% headroom (unused gas is refunded)
bool Registry::registerBody(Wallet& w, const std::string& name, const std::string& uri, uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("registerBody(string,string)").string(name).string(uri).finish(), 200000, tx);
}
bool Registry::accept(Wallet& w, uint64_t id, uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("accept(uint256)").uint(id).finish(), 120000, tx);
}
bool Registry::release(Wallet& w, uint64_t id, uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("release(uint256)").uint(id).finish(), 100000, tx);
}
bool Registry::assign(Wallet& w, uint64_t id, const uint8_t body[20], uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("assign(uint256,address)").uint(id).address(body).finish(), 120000, tx);
}
bool Registry::interaction(Wallet& w, uint64_t id, const char* kind, const std::string& data, uint8_t tx[32]) {
  // kind is bytes32: the UTF-8 text left-aligned and zero-padded, as brain/registry.py and the site's decodeKind do
  uint8_t k[32]; memset(k, 0, 32);
  size_t n = kind ? strlen(kind) : 0; if (n > 32) n = 32;
  if (n) memcpy(k, kind, n);
  std::string d = data.size() > 512 ? data.substr(0, 512) : data;
  return sendCall(c, w, addr, ethtx::AbiEncoder("interaction(uint256,bytes32,string)").uint(id).bytes32(k).string(d).finish(), 120000, tx);
}
bool Registry::commit(Wallet& w, uint64_t id, const uint8_t stateRoot[32], const uint8_t memoryRoot[32], const std::string& stateURI, const std::string& metadataURI, uint64_t brainStep, uint64_t energy, const uint8_t historyRoot[32], uint8_t tx[32]) {
  Bytes data = ethtx::AbiEncoder("commit(uint256,bytes32,bytes32,string,string,uint64,uint64,bytes32)")
                   .uint(id).bytes32(stateRoot).bytes32(memoryRoot).string(stateURI).string(metadataURI).uint(brainStep).uint(energy).bytes32(historyRoot).finish();
  return sendCall(c, w, addr, data, 300000, tx);
}
bool Registry::died(Wallet& w, uint64_t id, const uint8_t stateRoot[32], const uint8_t memoryRoot[32], const std::string& stateURI, const std::string& metadataURI, uint64_t brainStep, const std::string& cause, uint8_t tx[32]) {
  Bytes data = ethtx::AbiEncoder("died(uint256,bytes32,bytes32,string,string,uint64,string)")
                   .uint(id).bytes32(stateRoot).bytes32(memoryRoot).string(stateURI).string(metadataURI).uint(brainStep).string(cause).finish();
  return sendCall(c, w, addr, data, 250000, tx);
}
bool Registry::mint(Wallet& w, const std::string& name, uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("mint(string)").string(name).finish(), 400000, tx);
}

bool approveFly(Client& c, Wallet& w, const uint8_t token[20], const uint8_t spender[20], uint8_t tx[32]) {
  uint8_t max[32]; memset(max, 0xff, 32);
  return sendCall(c, w, token, ethtx::AbiEncoder("approve(address,uint256)").address(spender).uint256(max).finish(), 80000, tx);
}

// ------------------------------------------------------------------ FlyCore

Core::Core(Client& client, const char* hexAddr) : c(client) { parseAddress(hexAddr, addr); }

// core(id) returns (int16[] v, int8[] bias, uint16[16] headingHist, int32[] pendingInput, uint64 step, int32 headX,
// int32 headY, int64 posX, int64 posY, uint8 stimChannel, uint8 stimParam, uint16 stimStrength, uint64 stimUntilStep,
// uint64 totalSpikes). Head words: [0] off v, [1] off bias, [2..17] hist (static array, inline), [18] off inp, [19..].
bool Core::state(uint64_t id, CoreState& out) {
  Bytes ret;
  if (!c.ethCall(addr, ethtx::AbiEncoder("core(uint256)").uint(id).finish(), ret)) return false;
  ethtx::AbiDecoder d(ret);
  if (d.words() < 28) { setError("core: short"); return false; }
  size_t n = d.arrayLen(0);
  if (n == 0 || n > 255 || d.arrayLen(1) != n || d.arrayLen(18) != n) { setError("core: bad arrays"); return false; }
  out.v.resize(n); out.bias.resize(n); out.inp.resize(n);
  for (size_t i = 0; i < n; ++i) {
    out.v[i] = (int16_t)d.arrayInt(0, i);
    out.bias[i] = (int8_t)d.arrayInt(1, i);
    out.inp[i] = (int32_t)d.arrayInt(18, i);
  }
  for (int w = 0; w < 16; ++w) out.hist[w] = (uint16_t)d.uint(2 + w);
  out.step = d.uint(19);
  out.headX = (int32_t)d.int_(20);
  out.headY = (int32_t)d.int_(21);
  out.posX = d.int_(22);
  out.posY = d.int_(23);
  out.stimChannel = (uint8_t)d.uint(24);
  out.stimParam = (uint8_t)d.uint(25);
  out.stimStrength = (uint16_t)d.uint(26);
  out.stimUntil = d.uint(27);
  return true;
}

static uint64_t tickGas(uint16_t steps) { return ANCHOR_GAS_BASE + ANCHOR_GAS_PER_STEP * (uint64_t)steps; }

bool Core::stimulateAndTick(Wallet& w, uint64_t id, uint8_t ch, uint8_t param, uint8_t strength, uint16_t steps, uint8_t tx[32]) {
  Bytes data = ethtx::AbiEncoder("stimulate(uint256,uint8,uint8,uint8,uint16)").uint(id).uint(ch).uint(param).uint(strength).uint(steps).finish();
  return sendCall(c, w, addr, data, tickGas(steps), tx);
}

bool Core::tick(Wallet& w, uint64_t id, uint16_t steps, uint8_t tx[32]) {
  return sendCall(c, w, addr, ethtx::AbiEncoder("tick(uint256,uint16)").uint(id).uint(steps).finish(), tickGas(steps), tx);
}

}  // namespace rpc
