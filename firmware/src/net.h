// Wi-Fi: credentials from secrets.h, else from NVS (written by the soft-AP captive portal), plus the RPC URL.
#pragma once
#include <stdint.h>
#include <string>

struct NetConfig { std::string ssid, pass, rpcUrl; bool fromSecrets = false; };

NetConfig netConfig();                       // whatever is configured (ssid empty = nothing)
bool netConnect(const NetConfig& c, uint32_t timeoutMs);   // blocking STA connect
bool netConnected();
void netReconnect();                         // non-blocking nudge when the link dropped

// Soft-AP "FLY-PEBBLE-xxxx" with a captive page that writes ssid/pass/rpc to NVS, then restarts. Never returns.
// `onTick` is called ~10 times a second so the caller can keep the screen/buttons alive.
[[noreturn]] void netProvisionPortal(const char* apName, void (*onTick)());
