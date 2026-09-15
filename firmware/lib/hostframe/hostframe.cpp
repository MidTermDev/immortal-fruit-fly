#include "hostframe.h"
#include <string.h>
#include <stdio.h>
#include <math.h>
#include "keccak.h"
#include "ethtx.h"

namespace hostframe {

using namespace ArduinoJson;

// ------------------------------------------------------------------ small helpers

static void copyText(char* dst, size_t cap, const char* src) {
  if (!src) { dst[0] = 0; return; }
  size_t n = strlen(src); if (n >= cap) n = cap - 1;
  memcpy(dst, src, n); dst[n] = 0;
}

static float num(JsonVariantConst v, float def = 0.f) { return v.is<float>() ? v.as<float>() : def; }
static double dnum(JsonVariantConst v, double def = 0.0) { return v.is<double>() ? v.as<double>() : def; }
static uint64_t u64(JsonVariantConst v) {
  if (v.is<unsigned long long>()) return v.as<unsigned long long>();
  if (v.is<long long>()) { long long x = v.as<long long>(); return x < 0 ? 0 : (uint64_t)x; }
  if (v.is<double>()) { double d = v.as<double>(); return d < 0 ? 0 : (uint64_t)d; }
  return 0;
}

bool hex32(const char* s, uint8_t out[32]) {
  if (!s) return false;
  if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
  if (strlen(s) != 64) return false;
  for (int i = 0; i < 32; ++i) {
    int v = 0;
    for (int k = 0; k < 2; ++k) {
      char c = s[2 * i + k]; int d;
      if (c >= '0' && c <= '9') d = c - '0';
      else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
      else return false;
      v = (v << 4) | d;
    }
    out[i] = (uint8_t)v;
  }
  return true;
}

double httpDate(const char* s) {
  if (!s) return 0;
  static const char* mons = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char mon[4] = {0}; int d, y, hh, mm, ss;
  const char* p = strchr(s, ',');
  p = p ? p + 1 : s;
  if (sscanf(p, " %d %3s %d %d:%d:%d", &d, mon, &y, &hh, &mm, &ss) != 6) return 0;
  const char* m = strstr(mons, mon); if (!m || y < 1970) return 0;
  int mo = (int)(m - mons) / 3;   // 0..11
  // days from civil (Howard Hinnant's algorithm)
  y -= mo < 2 ? 1 : 0;
  int era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (mo + (mo > 1 ? -2 : 10)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = era * 146097L + (long)doe - 719468L;
  return (double)days * 86400.0 + hh * 3600.0 + mm * 60.0 + ss;
}

// ------------------------------------------------------------------ modes and diary lines

Mode modeFromText(const char* s) {
  if (!s) return M_UNKNOWN;
  if (!strcmp(s, "wander") || !strcmp(s, "walk")) return M_WANDER;
  if (!strcmp(s, "surge")) return M_SURGE;
  if (!strcmp(s, "cast")) return M_CAST;
  if (!strcmp(s, "eat")) return M_EAT;
  if (!strcmp(s, "flee")) return M_FLEE;
  if (!strcmp(s, "still")) return M_STILL;
  return M_UNKNOWN;
}

const char* modeWord(Mode m) {
  switch (m) {
    case M_WANDER: return "wandering";
    case M_SURGE: return "following a scent";
    case M_CAST: return "casting";
    case M_EAT: return "eating";
    case M_FLEE: return "fleeing";
    case M_STILL: return "still";
    default: return "";
  }
}

int eventSound(const char* t) {
  if (!t) return 0;
  if (strstr(t, "caught")) return 3;
  if (strstr(t, "jumped")) return 2;
  if (strstr(t, "finished a food") || strstr(t, " ate ") || !strncmp(t, "ate ", 4)) return 1;
  return 0;
}

// ------------------------------------------------------------------ the lite frame

bool parseFrame(const char* json, size_t len, LiteFrame& out, Allocator* alloc) {
  if (!json || len == 0) return false;
  // only what the pebble uses is kept: the frame carries ~22 "rates" and as many "base" entries
  JsonDocument filter;
  static const char* keys[] = {"t_ms", "step", "x", "y", "heading", "energy", "alive", "generation", "life_ms", "spikes_total",
                               "ate", "jumps", "hits", "arena", "predator", "steer", "mode", "realtime", "wall", nullptr};
  for (int i = 0; keys[i]; ++i) filter[keys[i]] = true;
  filter["food"][0]["x"] = true; filter["food"][0]["y"] = true; filter["food"][0]["energy"] = true; filter["food"][0]["energy0"] = true;
  filter["puffs"][0] = true;
  filter["events"][0] = true;
  filter["chain"]["checkpoints"] = true;
  static const char* rateKeys[] = {"DNa02_left", "DNa02_right", "ALPN", "KC", "MBON", "LC4_left", "LC4_right", "GRN_labellar", "DN_all", nullptr};
  for (int i = 0; rateKeys[i]; ++i) filter["rates"][rateKeys[i]] = true;

  JsonDocument doc(alloc ? alloc : detail::DefaultAllocator::instance());
  DeserializationError err = deserializeJson(doc, json, len, DeserializationOption::Filter(filter));
  if (err) return false;
  JsonObjectConst o = doc.as<JsonObjectConst>();
  if (o.isNull() || o["x"].isNull() || o["alive"].isNull()) return false;

  LiteFrame f;
  f.t_ms = dnum(o["t_ms"]); f.step = u64(o["step"]);
  f.x = num(o["x"]); f.y = num(o["y"]); f.heading = num(o["heading"]); f.energy = num(o["energy"]);
  f.alive = o["alive"].as<bool>(); f.generation = (uint32_t)u64(o["generation"]);
  f.life_ms = dnum(o["life_ms"]); f.spikesTotal = u64(o["spikes_total"]);
  f.ate = num(o["ate"]); f.jumps = (uint32_t)u64(o["jumps"]); f.hits = (uint32_t)u64(o["hits"]);
  f.arena = num(o["arena"], 240.f); if (!(f.arena > 1.f)) f.arena = 240.f;
  f.steer = num(o["steer"]);
  f.realtime = num(o["realtime"]); f.wall = dnum(o["wall"]);
  f.checkpoints = (uint32_t)u64(o["chain"]["checkpoints"]);
  copyText(f.modeText, sizeof f.modeText, o["mode"].as<const char*>());
  f.mode = modeFromText(f.modeText);

  f.nfood = 0;
  for (JsonObjectConst fo : o["food"].as<JsonArrayConst>()) {
    if (f.nfood >= MAX_FOOD) break;
    Food& d = f.food[f.nfood++];
    d.x = num(fo["x"]); d.y = num(fo["y"]); d.energy = num(fo["energy"]); d.energy0 = num(fo["energy0"], d.energy);
    if (!(d.energy0 > 0)) d.energy0 = d.energy > 0 ? d.energy : 1.f;
  }
  JsonVariantConst p = o["predator"];
  if (p.is<JsonObjectConst>()) { f.predator.present = true; f.predator.x = num(p["x"]); f.predator.y = num(p["y"]); f.predator.size = num(p["size"], 6.f); }
  else f.predator = {false, 0, 0, 0};
  f.npuffs = 0;
  for (JsonVariantConst pv : o["puffs"].as<JsonArrayConst>()) {
    if (f.npuffs >= MAX_PUFFS) break;
    Puff& q = f.puffs[f.npuffs];
    if (pv.is<JsonObjectConst>()) {
      q.x = num(pv["x"]); q.y = num(pv["y"]);
      JsonVariantConst s = pv["strength"]; if (s.isNull()) s = pv["s"];
      q.strength = s.isNull() ? 1.f : num(s, 1.f);
    } else if (pv.is<JsonArrayConst>() && pv.size() >= 2) {
      q.x = num(pv[0]); q.y = num(pv[1]); q.strength = pv.size() >= 3 ? num(pv[2], 1.f) : 1.f;
    } else continue;
    if (q.strength < 0) q.strength = 0;
    if (q.strength > 1) q.strength = 1;
    f.npuffs++;
  }
  JsonObjectConst r = o["rates"];
  f.rates.dna02L = num(r["DNa02_left"]); f.rates.dna02R = num(r["DNa02_right"]);
  f.rates.alpn = num(r["ALPN"]); f.rates.kc = num(r["KC"]); f.rates.mbon = num(r["MBON"]);
  f.rates.lc4L = num(r["LC4_left"]); f.rates.lc4R = num(r["LC4_right"]); f.rates.grn = num(r["GRN_labellar"]);
  f.rates.dnAll = num(r["DN_all"]);
  // events: the last MAX_EVENTS of the frame's diary, in order
  JsonArrayConst ev = o["events"].as<JsonArrayConst>();
  size_t n = ev.size(), skip = n > (size_t)MAX_EVENTS ? n - MAX_EVENTS : 0, i = 0;
  f.nevents = 0;
  for (JsonVariantConst e : ev) {
    if (i++ < skip) continue;
    if (!e.is<JsonArrayConst>() || e.size() < 2) continue;
    Event& d = f.events[f.nevents++];
    d.t_ms = dnum(e[0]);
    copyText(d.text, sizeof d.text, e[1].as<const char*>());
  }
  out = f;
  return true;
}

// ------------------------------------------------------------------ the commit / death payload

bool parsePayload(const char* json, size_t len, Payload& out, Allocator* alloc) {
  if (!json || len == 0) return false;
  JsonDocument doc(alloc ? alloc : detail::DefaultAllocator::instance());
  if (deserializeJson(doc, json, len)) return false;
  JsonObjectConst o = doc.as<JsonObjectConst>();
  if (o.isNull()) return false;
  Payload p;
  if (!hex32(o["stateRoot"].as<const char*>(), p.stateRoot)) return false;
  if (!hex32(o["memoryRoot"].as<const char*>(), p.memoryRoot)) return false;
  if (!hex32(o["historyRoot"].as<const char*>(), p.historyRoot)) memset(p.historyRoot, 0, 32);
  const char* su = o["stateURI"].as<const char*>(); if (!su || !*su) return false;
  p.stateURI = su;
  const char* mu = o["metadataURI"].as<const char*>(); p.metadataURI = mu ? mu : "";
  const char* cs = o["cause"].as<const char*>(); p.cause = cs ? cs : "";
  if (o["brainStep"].isNull()) return false;
  p.brainStep = u64(o["brainStep"]);
  p.energy = u64(o["energy"]); p.age_s = u64(o["age_s"]); p.spikes = u64(o["spikes"]); p.generation = (uint32_t)u64(o["generation"]);
  p.ninteractions = 0; p.listed = 0;
  for (JsonObjectConst io : o["interactions"].as<JsonArrayConst>()) {
    p.listed++;
    Interaction it; it.t_ms = dnum(io["t_ms"]);
    copyText(it.kind, sizeof it.kind, io["kind"].as<const char*>());
    copyText(it.data, sizeof it.data, io["data"].as<const char*>());
    if (!it.kind[0]) continue;
    // insert keeping t_ms descending (newest first); ties keep the host's order
    int pos = p.ninteractions;
    while (pos > 0 && p.interactions[pos - 1].t_ms < it.t_ms) pos--;
    if (pos >= MAX_INTERACTIONS) continue;
    int last = p.ninteractions < MAX_INTERACTIONS ? p.ninteractions : MAX_INTERACTIONS - 1;
    for (int k = last; k > pos; --k) p.interactions[k] = p.interactions[k - 1];
    p.interactions[pos] = it;
    if (p.ninteractions < MAX_INTERACTIONS) p.ninteractions++;
  }
  out = p;
  return true;
}

// ------------------------------------------------------------------ the held checkpoint

uint64_t Held::energyAt(uint32_t nowMs) const {
  uint64_t drained = (uint64_t)((uint32_t)(nowMs - fetchedMs) / 1000);
  return p.energy > drained ? p.energy - drained : 0;
}

bool commitDue(uint32_t nowMs, uint32_t lastMs, uint32_t everyMs, bool retry, uint32_t retryMs) {
  uint32_t since = nowMs - lastMs;   // unsigned wrap: fine across the 49-day millis() rollover
  return since >= everyMs || (retry && since >= retryMs);
}

// ------------------------------------------------------------------ auth

size_t authMessage(uint64_t id, uint64_t ts, char* out, size_t cap) {
  int n = snprintf(out, cap, "flyhost|%llu|%llu", (unsigned long long)id, (unsigned long long)ts);
  return n < 0 ? 0 : (size_t)n;
}

void authDigest(uint64_t id, uint64_t ts, uint8_t out[32]) {
  char msg[64];
  size_t n = authMessage(id, ts, msg, sizeof msg);
  keccak256((const uint8_t*)msg, n, out);
}

bool authSign(uint64_t id, uint64_t ts, const uint8_t priv[32], uint8_t sig65[65]) {
  uint8_t d[32]; authDigest(id, ts, d);
  uint8_t recid = 0;
  if (!ethtx::signDigest(d, priv, sig65, &recid)) return false;
  sig65[64] = (uint8_t)(27 + (recid & 1));
  return true;
}

std::string authSigHex(const uint8_t sig65[65]) { return ethtx::toHex(sig65, 65, true); }

}  // namespace hostframe
