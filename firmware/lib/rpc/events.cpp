#include "events.h"
#include <stdio.h>
#include <string.h>
#include "keccak.h"

namespace rpc {

using ethtx::Bytes;

void stimulatedTopic(uint8_t out[32]) {
  static const char* sig = "Stimulated(uint256,address,uint8,uint8,uint16,uint64,uint256)";
  keccak256((const uint8_t*)sig, strlen(sig), out);
}

void shortAddress(const uint8_t a[20], char out[16]) {
  std::string h = ethtx::toHex(a, 20);   // "0x" + 40 lower-case hex digits
  snprintf(out, 16, "0x%.4s..%.4s", h.c_str() + 2, h.c_str() + 38);
}

namespace {

// A log object as a node returns it is flat but for its "topics" array of strings, and every value is a hex
// string, a small hex quantity or a boolean, so this is enough of a JSON reader.

// the string value of "key" in obj, "" when absent
std::string strField(const std::string& obj, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = obj.find(k);
  if (p == std::string::npos) return "";
  size_t q = obj.find(':', p + k.size()); if (q == std::string::npos) return "";
  size_t a = obj.find_first_not_of(" \t\r\n", q + 1); if (a == std::string::npos || obj[a] != '"') return "";
  size_t e = obj.find('"', a + 1); if (e == std::string::npos) return "";
  return obj.substr(a + 1, e - a - 1);
}

// the strings of "key": [ "a", "b", ... ] in obj, at most `max`; returns how many
int strArray(const std::string& obj, const char* key, std::string* out, int max) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = obj.find(k);
  if (p == std::string::npos) return 0;
  size_t a = obj.find('[', p); if (a == std::string::npos) return 0;
  size_t e = obj.find(']', a); if (e == std::string::npos) return 0;
  int n = 0;
  size_t i = a;
  while (n < max) {
    size_t q0 = obj.find('"', i); if (q0 == std::string::npos || q0 > e) break;
    size_t q1 = obj.find('"', q0 + 1); if (q1 == std::string::npos || q1 > e) break;
    out[n++] = obj.substr(q0 + 1, q1 - q0 - 1);
    i = q1 + 1;
  }
  return n;
}

bool hexU64(const std::string& hex, uint64_t& out) {
  size_t i = (hex.size() >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) ? 2 : 0;
  if (i >= hex.size()) return false;
  uint64_t v = 0;
  for (; i < hex.size(); ++i) {
    char ch = hex[i]; int d;
    if (ch >= '0' && ch <= '9') d = ch - '0';
    else if (ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
    else if (ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
    else return false;
    if (v >> 60) return false;
    v = (v << 4) | (uint64_t)d;
  }
  out = v;
  return true;
}

// one log -> a Stimulus; false when it is not one (reorged, or not the shape FlyCore emits)
bool decodeLog(const std::string& obj, const uint8_t sig[32], Stimulus& s) {
  if (obj.find("\"removed\":true") != std::string::npos || obj.find("\"removed\": true") != std::string::npos) return false;
  std::string topics[3];
  if (strArray(obj, "topics", topics, 3) != 3) return false;
  Bytes t0, t2, data;
  if (!ethtx::fromHex(topics[0], t0) || t0.size() != 32 || memcmp(t0.data(), sig, 32) != 0) return false;
  if (!ethtx::fromHex(topics[2], t2) || t2.size() != 32) return false;
  memcpy(s.by, t2.data() + 12, 20);
  // channel, param, strength, untilStep, tokensBurned: five words
  if (!ethtx::fromHex(strField(obj, "data"), data) || data.size() < 96) return false;
  s.channel = data[31]; s.param = data[63]; s.strength = (uint16_t)((data[94] << 8) | data[95]);
  uint64_t v;
  if (!hexU64(strField(obj, "blockNumber"), v)) return false;
  s.block = v;
  s.logIndex = hexU64(strField(obj, "logIndex"), v) ? (uint32_t)v : 0;
  return true;
}

}  // namespace

bool stimulatedEvents(Client& c, const uint8_t core[20], uint64_t id, uint64_t fromBlock, uint64_t toBlock, std::vector<Stimulus>& out) {
  out.clear();
  uint8_t sig[32]; stimulatedTopic(sig);
  char to[24];
  if (toBlock) snprintf(to, sizeof to, "\"0x%llx\"", (unsigned long long)toBlock); else snprintf(to, sizeof to, "\"latest\"");
  char params[320];
  snprintf(params, sizeof params, "[{\"address\":\"%s\",\"fromBlock\":\"0x%llx\",\"toBlock\":%s,\"topics\":[\"%s\",\"0x%064llx\"]}]",
           ethtx::toHex(core, 20).c_str(), (unsigned long long)fromBlock, to, ethtx::toHex(sig, 32).c_str(), (unsigned long long)id);
  std::string r;
  if (!c.call("eth_getLogs", params, r)) return false;
  // the result is an array of log objects (flat but for their topics arrays: a '}' ends one)
  size_t i = r.find('{');
  while (i != std::string::npos) {
    size_t e = r.find('}', i);
    if (e == std::string::npos) break;
    Stimulus s;
    if (decodeLog(r.substr(i, e - i + 1), sig, s)) out.push_back(s);
    i = r.find('{', e + 1);
  }
  return true;
}

}  // namespace rpc
