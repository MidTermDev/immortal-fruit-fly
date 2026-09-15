#include "wallet.h"
#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>
#include <string.h>
#include "ethtx.h"
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef FIXED_PRIVATE_KEY
#define FIXED_PRIVATE_KEY ""
#endif

static const char* NS = "pebble";

static bool keyValid(const uint8_t k[32]) {
  uint8_t addr[20];
  return ethtx::privateKeyToAddress(k, addr);   // rejects 0 and >= n
}

bool walletInit(rpc::Wallet& w, bool& created, bool& fixed) {
  created = false; fixed = false;
  memset(w.priv, 0, 32);
  w.nonce = 0; w.nonceKnown = false;

  // 1. a compiled-in key (development / a pebble whose wallet you manage elsewhere)
  const char* fixedHex = FIXED_PRIVATE_KEY;
  if (fixedHex && *fixedHex) {
    ethtx::Bytes b;
    if (ethtx::fromHex(fixedHex, b) && b.size() == 32 && keyValid(b.data())) {
      memcpy(w.priv, b.data(), 32);
      fixed = true;
      return ethtx::privateKeyToAddress(w.priv, w.addr);
    }
    Serial.println("[wallet] FIXED_PRIVATE_KEY is not a valid key; using NVS");
  }

  // 2. NVS
  Preferences p;
  p.begin(NS, false);
  bool have = p.isKey("priv") && p.getBytesLength("priv") == 32 && p.getBytes("priv", w.priv, 32) == 32 && keyValid(w.priv);
  if (!have) {
    // 3. a fresh key from the hardware RNG. esp_random() is a true RNG only while the RF subsystem is running, so
    //    main.cpp switches the Wi-Fi radio on (WiFi.mode) before calling walletInit.
    for (int tries = 0; tries < 8; ++tries) {
      uint32_t words[8];
      for (int i = 0; i < 8; ++i) words[i] = esp_random();
      memcpy(w.priv, words, 32);
      memset(words, 0, sizeof words);
      if (keyValid(w.priv)) break;
    }
    if (!keyValid(w.priv)) { p.end(); return false; }
    p.putBytes("priv", w.priv, 32);
    created = true;
  }
  p.end();
  return ethtx::privateKeyToAddress(w.priv, w.addr);
}

std::string walletPrivHex(const rpc::Wallet& w) { return ethtx::toHex(w.priv, 32, false); }

std::string nvsGetString(const char* key) {
  Preferences p;
  p.begin(NS, true);
  String s = p.isKey(key) ? p.getString(key, "") : String("");
  p.end();
  return std::string(s.c_str());
}

void nvsPutString(const char* key, const std::string& v) {
  Preferences p;
  p.begin(NS, false);
  p.putString(key, v.c_str());
  p.end();
}

uint64_t nvsGetU64(const char* key, uint64_t def) {
  Preferences p;
  p.begin(NS, true);
  uint64_t v = p.isKey(key) ? p.getULong64(key, def) : def;
  p.end();
  return v;
}

void nvsPutU64(const char* key, uint64_t v) {
  Preferences p;
  p.begin(NS, false);
  p.putULong64(key, v);
  p.end();
}

void nvsRemove(const char* key) {
  Preferences p;
  p.begin(NS, false);
  if (p.isKey(key)) p.remove(key);
  p.end();
}
