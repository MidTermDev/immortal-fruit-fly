// The pebble's wallet: a secp256k1 private key kept in NVS (Preferences namespace "pebble", key "priv"), created
// from esp_random() on first boot. FIXED_PRIVATE_KEY in secrets.h overrides it (and is not written to NVS).
// Also the small NVS helpers the other modules use (Wi-Fi credentials, RPC URL, the hosted fly id).
#pragma once
#include <stdint.h>
#include <string>
#include "rpc.h"

// Loads or creates the key, derives the address. False only if no valid key could be made (never, in practice).
bool walletInit(rpc::Wallet& w, bool& created, bool& fixed);
// Hex of the private key currently in RAM (for the one-time backup screen only).
std::string walletPrivHex(const rpc::Wallet& w);

// NVS (namespace "pebble")
std::string nvsGetString(const char* key);
void nvsPutString(const char* key, const std::string& v);
uint64_t nvsGetU64(const char* key, uint64_t def = 0);
void nvsPutU64(const char* key, uint64_t v);
void nvsRemove(const char* key);
