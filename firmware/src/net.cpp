#include "net.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include "wallet.h"
#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif
#ifndef RPC_URL
#define RPC_URL ""
#endif

NetConfig netConfig() {
  NetConfig c;
  c.ssid = WIFI_SSID; c.pass = WIFI_PASS; c.rpcUrl = RPC_URL;
  c.fromSecrets = !c.ssid.empty();
  if (!c.fromSecrets) { c.ssid = nvsGetString("ssid"); c.pass = nvsGetString("pass"); }
  std::string nvsRpc = nvsGetString("rpc");
  if (!nvsRpc.empty()) c.rpcUrl = nvsRpc;   // the portal's URL wins over secrets.h so a pebble can be re-pointed
  if (c.rpcUrl.empty()) c.rpcUrl = PUBLIC_RPC_URL;
  return c;
}

bool netConnect(const NetConfig& c, uint32_t timeoutMs) {
  if (c.ssid.empty()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(c.ssid.c_str(), c.pass.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

bool netConnected() { return WiFi.status() == WL_CONNECTED; }

void netReconnect() {
  static uint32_t last = 0;
  if (millis() - last < 10000) return;
  last = millis();
  WiFi.reconnect();
}

// ------------------------------------------------------------------ captive portal

static const char PAGE[] =
  "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
  "<title>Fly pebble</title><style>body{font-family:system-ui,sans-serif;margin:2em;max-width:26em}input{width:100%;padding:.5em;margin:.3em 0 1em;box-sizing:border-box}"
  "button{padding:.6em 1.2em;font-size:1em}</style></head><body><h2>Immortal fruit fly pebble</h2>"
  "<p>Give this pebble a Wi-Fi network. It restarts and joins it; the private key stays on the pebble.</p>"
  "<form method='POST' action='/save'><label>Wi-Fi name (SSID)<input name='ssid' required></label>"
  "<label>Password<input name='pass' type='password'></label>"
  "<label>JSON-RPC URL (optional; default " PUBLIC_RPC_URL ")<input name='rpc' placeholder='https://…'></label>"
  "<button type='submit'>Save and restart</button></form></body></html>";

[[noreturn]] void netProvisionPortal(const char* apName, void (*onTick)()) {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName);
  delay(100);
  IPAddress ip = WiFi.softAPIP();
  static DNSServer dns;
  static WebServer web(80);
  dns.start(53, "*", ip);
  web.on("/", HTTP_GET, []() { web.send(200, "text/html", PAGE); });
  web.on("/save", HTTP_POST, []() {
    std::string ssid = web.arg("ssid").c_str(), pass = web.arg("pass").c_str(), rpc = web.arg("rpc").c_str();
    if (ssid.empty()) { web.send(400, "text/plain", "ssid required"); return; }
    nvsPutString("ssid", ssid);
    nvsPutString("pass", pass);
    if (!rpc.empty()) nvsPutString("rpc", rpc); else nvsRemove("rpc");
    web.send(200, "text/html", "<html><body style='font-family:sans-serif;margin:2em'><h2>Saved.</h2><p>The pebble restarts and joins your network.</p></body></html>");
    delay(500);
    ESP.restart();
  });
  // every captive-portal probe (Android generate_204, Apple hotspot-detect, Windows connecttest) lands on the form
  web.onNotFound([]() {
    web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    web.send(302, "text/plain", "");
  });
  web.begin();
  uint32_t lastTick = 0;
  for (;;) {
    dns.processNextRequest();
    web.handleClient();
    if (millis() - lastTick >= 100) { lastTick = millis(); if (onTick) onTick(); }
    delay(2);
  }
}
