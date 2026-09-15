// Copy to include/secrets.h (gitignored) and fill in. Nothing here is committed.
#pragma once
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"
// Any BSC JSON-RPC endpoint that accepts eth_sendRawTransaction. The public one works; a QuickNode URL is faster.
#define RPC_URL "https://bsc-dataseed.bnbchain.org"
// Optional: a fixed private key (hex, no 0x). Leave empty to let the pebble generate and keep its own in NVS.
#define FIXED_PRIVATE_KEY ""
