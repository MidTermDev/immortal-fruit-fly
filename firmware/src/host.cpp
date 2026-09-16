#include "host.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_heap_caps.h>
#include <time.h>
#include <string.h>
#include <math.h>
#define ARDUINOJSON_ENABLE_STD_STRING 1
#include <ArduinoJson.h>
#include "pebble.h"
#include "net.h"
#include "certs.h"
#if HOST_USE_WS
#include <WebSocketsClient.h>
#endif

namespace {

// ------------------------------------------------------------------ memory: everything big lives in PSRAM

void* bigAlloc(size_t n) {
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
PsramAllocator s_jsonAlloc;

// ------------------------------------------------------------------ diagnostics

char s_lastError[96] = "";
void setError(const char* what, const char* detail = nullptr) {
  if (detail && *detail) snprintf(s_lastError, sizeof s_lastError, "%s: %s", what, detail);
  else snprintf(s_lastError, sizeof s_lastError, "%s", what);
  Serial.printf("[host] %s (heap free %u, largest %u)\n", s_lastError, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  Lock l(g_hostMutex);
  strlcpy(g_host.lastError, s_lastError, sizeof g_host.lastError);
  g_host.lastErrorMs = millis();
}

// ------------------------------------------------------------------ the origin (set by the chain task)

struct Origin { bool https = true; std::string host; uint16_t port = 443; std::string base; };   // base: path prefix, no trailing slash
SemaphoreHandle_t s_originLock = nullptr;
Origin s_origin;
bool s_originKnown = false;
volatile bool s_wantsOrigin = false;
uint32_t s_originVersion = 0;

bool parseOrigin(const std::string& uri, Origin& o) {
  std::string u = uri;
  while (!u.empty() && (u.back() == '/' || u.back() == ' ')) u.pop_back();
  if (u.rfind("https://", 0) == 0) { o.https = true; o.port = 443; u = u.substr(8); }
  else if (u.rfind("http://", 0) == 0) { o.https = false; o.port = 80; u = u.substr(7); }
  else return false;
  size_t slash = u.find('/');
  std::string hp = slash == std::string::npos ? u : u.substr(0, slash);
  o.base = slash == std::string::npos ? "" : u.substr(slash);
  size_t colon = hp.find(':');
  if (colon != std::string::npos) { o.port = (uint16_t)atoi(hp.c_str() + colon + 1); hp = hp.substr(0, colon); }
  o.host = hp;
  return !o.host.empty() && o.port != 0;
}

bool originCopy(Origin& out) {
  xSemaphoreTake(s_originLock, portMAX_DELAY);
  bool known = s_originKnown; if (known) out = s_origin;
  xSemaphoreGive(s_originLock);
  return known;
}

// ------------------------------------------------------------------ the clock: the host's wall time, else SNTP

double s_wallAt = 0; uint32_t s_wallMs = 0; bool s_wallOk = false;
void setWall(double wall) { if (wall > 1.6e9) { s_wallAt = wall; s_wallMs = millis(); s_wallOk = true; } }

// ------------------------------------------------------------------ HTTP to the host (checkpoint / final / sense / frame)

// HTTPClient's own response timeout is a uint16_t of milliseconds (65 s at most) and, once the server has started
// answering, only runs between bytes. A checkpoint keeps the host busy for minutes before its first byte (two Pinata
// pins and a registry read), so this is sendRequest() without the redirect handling and with its own deadline for
// the first byte of the response; the base class parses the status line and headers as usual after that.
struct LongHttp : public HTTPClient {
  int send(const char* type, const uint8_t* payload, size_t size, uint32_t deadline) {
    for (size_t i = 0; i < _headerKeysCount; ++i) if (_currentHeaders[i].value.length()) _currentHeaders[i].value.clear();
    if (!connect()) return returnError(HTTPC_ERROR_CONNECTION_REFUSED);
    if (payload && size) addHeader(F("Content-Length"), String(size));
    if (!sendHeader(type)) return returnError(HTTPC_ERROR_SEND_HEADER_FAILED);
    if (payload && size) {
      size_t sent = 0;
      while (sent < size) {
        size_t n = _client->write(payload + sent, size - sent);
        if (!n) { delay(100); n = _client->write(payload + sent, size - sent); if (!n) break; }
        sent += n;
      }
      if (sent != size) return returnError(HTTPC_ERROR_SEND_PAYLOAD_FAILED);
    }
    while (_client->available() <= 0) {
      if (!_client->connected()) return returnError(HTTPC_ERROR_CONNECTION_LOST);
      if ((int32_t)(millis() - deadline) > 0) return returnError(HTTPC_ERROR_READ_TIMEOUT);   // returnError stops the socket: a late answer never leaks into the next request
      delay(10);
    }
    return returnError(handleHeaderResponse());
  }
};

struct Http {
  WiFiClientSecure tls; WiFiClient plain; LongHttp http;
  char* buf = nullptr; size_t cap = 0; bool ready = false;
};
Http* s_http = nullptr;
SemaphoreHandle_t s_httpLock = nullptr;

Http* http() {
  if (!s_http) {
    s_http = new Http();
    s_http->cap = HOST_HTTP_MAX;
    s_http->buf = (char*)bigAlloc(s_http->cap + 1);
#if defined(INSECURE_TLS) && INSECURE_TLS
    s_http->tls.setInsecure();
#else
    s_http->tls.setCACert(ROOT_CERTS);
#endif
    s_http->tls.setHandshakeTimeout(HOST_HTTP_TIMEOUT_MS / 1000);
    s_http->tls.setTimeout(HOST_HTTP_TIMEOUT_MS / 1000);
    s_http->plain.setTimeout(HOST_HTTP_TIMEOUT_MS / 1000);
    s_http->http.setReuse(true);
    s_http->http.setConnectTimeout(HOST_HTTP_TIMEOUT_MS);
    s_http->http.setTimeout(HOST_HTTP_TIMEOUT_MS);
    s_http->http.useHTTP10(false);
    s_http->ready = s_http->buf != nullptr;
  }
  return s_http;
}

// The one connection to the host, shared by the chain task (checkpoint / final: minutes) and the host task (frame /
// sense: seconds). The host task must not stall behind a checkpoint (its WebSocket loop would starve and the Life
// view go dark), so it waits at most `waitMs` and gives up (`held` false) when the connection is busy.
struct HttpLock {
  bool held;
  explicit HttpLock(uint32_t waitMs = portMAX_DELAY) { held = xSemaphoreTake(s_httpLock, waitMs == portMAX_DELAY ? portMAX_DELAY : pdMS_TO_TICKS(waitMs)) == pdTRUE; }
  ~HttpLock() { if (held) xSemaphoreGive(s_httpLock); }
};

bool readExact(WiFiClient* s, uint8_t* dst, size_t n, uint32_t deadline) {
  size_t got = 0;
  while (got < n) {
    if ((int32_t)(millis() - deadline) > 0) return false;
    int a = s->available();
    if (a <= 0) { if (!s->connected()) return false; delay(2); continue; }
    size_t want = n - got; if ((size_t)a < want) want = (size_t)a;
    int r = s->read(dst + got, want);
    if (r < 0) return false;
    got += (size_t)r;
  }
  return true;
}

bool readLine(WiFiClient* s, char* line, size_t cap, uint32_t deadline) {
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

// the body into h->buf (Content-Length, chunked or close-delimited) before the deadline; its length or -1
int readBody(Http* h, uint32_t deadline) {
  WiFiClient* s = h->http.getStreamPtr();
  if (!s) { setError("no stream"); return -1; }
  size_t len = 0;
  bool chunked = h->http.header("Transfer-Encoding").indexOf("chunked") >= 0;
  if (chunked) {
    char line[32];
    for (;;) {
      if (!readLine(s, line, sizeof line, deadline)) { setError("chunk header timeout"); return -1; }
      if (!line[0]) continue;
      size_t n = (size_t)strtoul(line, nullptr, 16);
      if (n == 0) { while (readLine(s, line, sizeof line, deadline) && line[0]) {} break; }
      if (len + n > h->cap) { setError("response too large"); return -1; }
      if (!readExact(s, (uint8_t*)h->buf + len, n, deadline)) { setError("chunk body timeout"); return -1; }
      len += n;
      if (!readLine(s, line, sizeof line, deadline)) { setError("chunk trailer timeout"); return -1; }
    }
  } else {
    int size = h->http.getSize();
    if (size >= 0) {
      if ((size_t)size > h->cap) { setError("response too large"); return -1; }
      if (!readExact(s, (uint8_t*)h->buf, (size_t)size, deadline)) { setError("body timeout"); return -1; }
      len = (size_t)size;
    } else {
      for (;;) {
        if ((int32_t)(millis() - deadline) > 0) { setError("body timeout"); return -1; }
        int a = s->available();
        if (a <= 0) { if (!s->connected()) break; delay(2); continue; }
        if (len + (size_t)a > h->cap) { setError("response too large"); return -1; }
        int r = s->read((uint8_t*)h->buf + len, (size_t)a);
        if (r < 0) break;
        len += (size_t)r;
      }
    }
  }
  h->buf[len] = 0;
  return (int)len;
}

// One request to <origin><base>/fly/<id><path>. `sign` adds X-Fly-Ts / X-Fly-Sig for that fly. The TCP/TLS connect
// is bounded by HOST_HTTP_TIMEOUT_MS; from the send to the end of the body by `timeoutMs`. `lockWaitMs` is how long
// to wait for the shared connection (portMAX_DELAY: until it is free). Returns the HTTP status (the body in `out`,
// at most HOST_HTTP_MAX bytes) or a negative number on a transport error; REQ_BUSY when the connection stayed busy
// (no error is recorded: the caller decides whether to drop or keep the request).
constexpr int REQ_BUSY = -9;
int request(const char* method, uint64_t id, const char* path, const char* body, bool sign, uint32_t timeoutMs, uint32_t lockWaitMs, std::string& out) {
  Origin o;
  if (!originCopy(o)) { setError("no host origin"); return -1; }
  if (WiFi.status() != WL_CONNECTED) { setError("wifi down"); return -2; }
  Http* h = http();
  if (!h->ready) { setError("no buffer"); return -3; }
  HttpLock lock(lockWaitMs);
  if (!lock.held) return REQ_BUSY;
  char url[256];
  snprintf(url, sizeof url, "%s://%s:%u%s/fly/%llu%s", o.https ? "https" : "http", o.host.c_str(), (unsigned)o.port, o.base.c_str(), (unsigned long long)id, path);
  WiFiClient& client = o.https ? static_cast<WiFiClient&>(h->tls) : static_cast<WiFiClient&>(h->plain);
  if (!h->http.begin(client, String(url))) { setError("http begin failed"); return -4; }
  static const char* hdrs[] = {"Transfer-Encoding", "Content-Length", "Date"};
  h->http.collectHeaders(hdrs, 3);
  h->http.addHeader("Accept", "application/json");
  if (body) h->http.addHeader("Content-Type", "application/json");
  if (sign) {
    uint64_t ts = hostNow();
    if (!ts) { h->http.end(); setError("no clock yet for the auth header"); return -5; }
    uint8_t sig[65];
    if (!hostframe::authSign(id, ts, g_wallet.priv, sig)) { h->http.end(); setError("sign failed"); return -6; }
    char tsb[24]; snprintf(tsb, sizeof tsb, "%llu", (unsigned long long)ts);
    h->http.addHeader("X-Fly-Ts", tsb);
    h->http.addHeader("X-Fly-Sig", hostframe::authSigHex(sig).c_str());
  }
  uint32_t t0 = millis();
  int code = h->http.send(method, (const uint8_t*)body, body ? strlen(body) : 0, t0 + timeoutMs);
  if (code <= 0) {
    char d[48]; snprintf(d, sizeof d, "%d %s", code, HTTPClient::errorToString(code).c_str());
    setError("http", d);
    h->http.end(); h->tls.stop(); h->plain.stop();
    return -7;
  }
  String date = h->http.header("Date");
  if (date.length()) setWall(hostframe::httpDate(date.c_str()));
  int len = readBody(h, t0 + timeoutMs);
  if (len < 0) { h->http.end(); h->tls.stop(); h->plain.stop(); return -8; }
  h->http.end();   // keep-alive when the server allows it
  out.assign(h->buf, (size_t)len);
  return code;
}

// ------------------------------------------------------------------ frames -> g_host (and the speaker)

double s_lastEventT = -1;
uint64_t s_frameFly = 0;

void resetStream(uint64_t id) {
  s_lastEventT = -1; s_frameFly = id;
  Lock l(g_hostMutex);
  g_host.haveFrame = false; g_host.frames = 0; g_host.trailN = 0; g_host.trailHead = 0; g_host.diary[0] = 0; g_host.connected = false;
}

void onFrame(const hostframe::LiteFrame& f) {
  uint32_t now = millis();
  setWall(f.wall);
  int sound = 0;
  double newest = s_lastEventT;
  if (s_lastEventT >= 0) {
    for (int i = 0; i < f.nevents; ++i) {
      if (f.events[i].t_ms > s_lastEventT) { int s = hostframe::eventSound(f.events[i].text); if (s) sound = s; if (f.events[i].t_ms > newest) newest = f.events[i].t_ms; }
    }
  } else if (f.nevents) newest = f.events[f.nevents - 1].t_ms;
  else newest = 0;
  s_lastEventT = newest;
  {
    Lock l(g_hostMutex);
    if (g_host.haveFrame && g_host.frame.generation != f.generation) { g_host.trailN = 0; g_host.trailHead = 0; }
    g_host.frame = f; g_host.haveFrame = true; g_host.frameMs = now; g_host.frames++; g_host.connected = true;
    // the trail: a new point when the fly moved a quarter of a body length
    bool push = g_host.trailN == 0;
    if (!push) {
      int last = (g_host.trailHead + HOST_TRAIL_LEN - 1) % HOST_TRAIL_LEN;
      float dx = f.x - g_host.trailX[last], dy = f.y - g_host.trailY[last];
      push = dx * dx + dy * dy > 0.0625f;
    }
    if (push) {
      g_host.trailX[g_host.trailHead] = f.x; g_host.trailY[g_host.trailHead] = f.y;
      g_host.trailHead = (g_host.trailHead + 1) % HOST_TRAIL_LEN;
      if (g_host.trailN < HOST_TRAIL_LEN) g_host.trailN++;
    }
    if (f.nevents) strlcpy(g_host.diary, f.events[f.nevents - 1].text, sizeof g_host.diary);
  }
  if (sound == 1) g_sound = SND_CHIRP; else if (sound == 2) g_sound = SND_BLIP; else if (sound == 3) g_sound = SND_LOW;
}

bool handleFrameText(const char* text, size_t len) {
  if (len > HOST_FRAME_MAX) { setError("frame too large"); return false; }
  hostframe::LiteFrame f;
  if (!hostframe::parseFrame(text, len, f, &s_jsonAlloc)) { setError("bad frame"); return false; }
  onFrame(f);
  return true;
}

// ------------------------------------------------------------------ the WebSocket

#if HOST_USE_WS
WebSocketsClient* s_ws = nullptr;
volatile bool s_wsOpen = false;

void wsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: s_wsOpen = true; Serial.println("[host] ws connected"); break;
    case WStype_DISCONNECTED: if (s_wsOpen) Serial.println("[host] ws disconnected"); s_wsOpen = false; { Lock l(g_hostMutex); g_host.connected = false; } break;
    case WStype_TEXT: handleFrameText((const char*)payload, length); break;
    case WStype_ERROR: setError("ws error", payload ? (const char*)payload : ""); break;
    default: break;
  }
}
#endif

// ------------------------------------------------------------------ senses -> POST /sense

// 1 sent, 0 failed (or nothing to send), REQ_BUSY when a checkpoint holds the connection (the caller keeps the event)
int postSense(uint64_t id, const SenseEvent& e) {
  char body[64];
  switch (e.kind) {
    case Sense::LANDMARK_L: snprintf(body, sizeof body, "{\"kind\":\"landmark\",\"side\":\"left\"}"); break;
    case Sense::LANDMARK_R: snprintf(body, sizeof body, "{\"kind\":\"landmark\",\"side\":\"right\"}"); break;
    case Sense::LANDMARK_2: snprintf(body, sizeof body, "{\"kind\":\"cue\",\"wedge\":%u}", e.wedge & 15); break;
    case Sense::SHOCK: snprintf(body, sizeof body, "{\"kind\":\"shock\",\"side\":\"%s\"}", HOST_SHOCK_SIDE); break;
    case Sense::TOUCH: snprintf(body, sizeof body, "{\"kind\":\"cue\",\"wedge\":%u}", e.wedge & 15); break;
    default: return 0;
  }
  std::string out;
  int code = request("POST", id, "/sense", body, true, HOST_HTTP_TIMEOUT_MS, HOST_HTTP_BUSY_WAIT_MS, out);
  if (code == REQ_BUSY) return REQ_BUSY;
  if (code == 200) {
    Lock l(g_hostMutex); g_host.sensesSent++;
    Serial.printf("[host] sense %s -> %s\n", body, out.c_str());
    return 1;
  }
  if (code > 0) { char d[16]; snprintf(d, sizeof d, "%d", code); setError("sense", d); }
  return 0;
}

// ------------------------------------------------------------------ the task

void hostTask(void*) {
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");   // SNTP, the fallback clock for the auth header
  uint64_t curId = 0; uint32_t curOriginVersion = 0;
  uint32_t lastPollMs = 0, lastSenseMs = 0, lastFailMs = 0;
  int pollFails = 0;
#if HOST_USE_WS
  bool wsEnabled = true, wsStarted = false;
  uint32_t wsStartMs = 0, wsDisabledMs = 0;
#endif
  for (;;) {
    uint32_t now = millis();
    Phase ph; uint64_t id;
    { Lock l(g_stateMutex); ph = g_state.phase; id = g_state.flyId; }
    // frames are wanted while hosting, and after a death (the host keeps the fly for 10 minutes: /final, the diary)
    bool want = (ph == Phase::HOST || ph == Phase::DEAD) && id != 0 && netConnected();
    Origin o; bool known = originCopy(o);
    bool originChanged = curOriginVersion != s_originVersion;
    if (!want || !known || id != curId || originChanged) {
#if HOST_USE_WS
      if (s_ws && wsStarted) { s_ws->disconnect(); wsStarted = false; s_wsOpen = false; }
#endif
      if (id != curId || originChanged) {
        resetStream(id); curId = id; curOriginVersion = s_originVersion; pollFails = 0;
#if HOST_USE_WS
        wsEnabled = true;
#endif
      }
      { Lock l(g_hostMutex); g_host.connected = false; g_host.originKnown = known; }
      vTaskDelay(pdMS_TO_TICKS(want && !known ? 500 : 250));
      continue;
    }
    uint32_t frameMs; bool have; { Lock l(g_hostMutex); frameMs = g_host.frameMs; have = g_host.haveFrame; g_host.originKnown = true; }

    // the WebSocket: one lite frame every 200 ms. Silent for HOST_WS_GIVEUP_MS -> off for HOST_WS_RETRY_MS.
#if HOST_USE_WS
    if (!wsEnabled && now - wsDisabledMs > HOST_WS_RETRY_MS) wsEnabled = true;
    if (wsEnabled) {
      if (!s_ws) { s_ws = new WebSocketsClient(); s_ws->onEvent(wsEvent); s_ws->setReconnectInterval(HOST_WS_RECONNECT_MS); s_ws->enableHeartbeat(15000, 3000, 2); }
      if (!wsStarted) {
        char path[96]; snprintf(path, sizeof path, "%s/fly/%llu/ws?lite=1", o.base.c_str(), (unsigned long long)id);
        Serial.printf("[host] ws %s://%s:%u%s\n", o.https ? "wss" : "ws", o.host.c_str(), (unsigned)o.port, path);
#if defined(INSECURE_TLS) && INSECURE_TLS
        if (o.https) s_ws->beginSSL(o.host.c_str(), o.port, path); else s_ws->begin(o.host.c_str(), o.port, path);
#else
        if (o.https) s_ws->beginSslWithCA(o.host.c_str(), o.port, path, ROOT_CERTS); else s_ws->begin(o.host.c_str(), o.port, path);
#endif
        wsStarted = true; wsStartMs = now;
      }
      s_ws->loop();
      uint32_t ref = (have && (int32_t)(frameMs - wsStartMs) >= 0) ? frameMs : wsStartMs;
      if (now - ref > HOST_WS_GIVEUP_MS) {
        s_ws->disconnect(); wsStarted = false; s_wsOpen = false;
        wsEnabled = false; wsDisabledMs = now; s_wantsOrigin = true;
        setError("ws silent; polling /frame");
      }
    }
    { Lock l(g_hostMutex); g_host.wsMode = wsEnabled && s_wsOpen; }
#else
    { Lock l(g_hostMutex); g_host.wsMode = false; }
#endif
    // polling /frame: the whole stream without the WebSocket, and the safety net whenever the socket goes quiet
    bool stale = !have || now - frameMs > HOST_STALE_MS / 2;
    if (stale && now - lastPollMs >= HOST_POLL_MS) {
      lastPollMs = now;
      std::string out;
      int code = request("GET", id, "/frame", nullptr, false, HOST_HTTP_TIMEOUT_MS, HOST_HTTP_BUSY_WAIT_MS, out);
      if (code == REQ_BUSY) {}   // a checkpoint holds the connection: not a failure, the next poll comes in HOST_POLL_MS
      else if (code == 200 && handleFrameText(out.c_str(), out.size())) pollFails = 0;
      else {
        pollFails++;
        { Lock l(g_hostMutex); g_host.connected = false; }
        if (code > 0 && code != 200) { char d[16]; snprintf(d, sizeof d, "%d", code); setError("frame", d); }
        if (pollFails >= 3 && now - lastFailMs > HOST_ORIGIN_RETRY_S * 1000UL) { lastFailMs = now; s_wantsOrigin = true; }
        vTaskDelay(pdMS_TO_TICKS(pollFails > 3 ? 2000 : 500));   // do not hammer a dead origin
      }
    }

    // senses -> the host, one a second at most; stale ones are dropped. While a checkpoint holds the connection the
    // event goes back to the front of the queue and is tried again next round (until it is 5 s old)
    if (now - lastSenseMs >= HOST_SENSE_MIN_MS) {
      SenseEvent e;
      while (xQueueReceive(g_hostSenseQueue, &e, 0) == pdTRUE) {
        if (now - e.ms > 5000) continue;
        if (postSense(id, e) == REQ_BUSY) { xQueueSendToFront(g_hostSenseQueue, &e, 0); break; }
        lastSenseMs = now;
        break;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

}  // namespace

// ------------------------------------------------------------------ public

void hostStart() {
  if (!s_originLock) s_originLock = xSemaphoreCreateMutex();
  if (!s_httpLock) s_httpLock = xSemaphoreCreateMutex();
  if (!hostConfigured()) { Serial.println("[host] FLY_HOST_ADDR not set: compass core only"); return; }
  xTaskCreatePinnedToCore(hostTask, "host", 16384, nullptr, 2, nullptr, 0);
}

bool hostConfigured() { return strlen(FLY_HOST_ADDR) == 42; }

void hostSetOrigin(const std::string& uri) {
  if (!s_originLock) s_originLock = xSemaphoreCreateMutex();
  Origin o;
  bool ok = parseOrigin(uri, o);
  xSemaphoreTake(s_originLock, portMAX_DELAY);
  bool changed = ok != s_originKnown || (ok && (o.host != s_origin.host || o.port != s_origin.port || o.base != s_origin.base || o.https != s_origin.https));
  if (ok) s_origin = o;
  s_originKnown = ok;
  if (changed) s_originVersion++;
  xSemaphoreGive(s_originLock);
  s_wantsOrigin = false;
  {
    Lock l(g_hostMutex);
    g_host.originKnown = ok; g_host.originMs = millis();
    if (ok) {
      char port[8] = "";
      if (o.https ? o.port != 443 : o.port != 80) snprintf(port, sizeof port, ":%u", (unsigned)o.port);
      snprintf(g_host.origin, sizeof g_host.origin, "%s://%s%s%s", o.https ? "https" : "http", o.host.c_str(), port, o.base.c_str());
    } else g_host.origin[0] = 0;
  }
  if (ok) Serial.printf("[host] origin %s%s\n", g_host.origin, changed ? " (new)" : "");
  else if (!uri.empty()) setError("bad host uri", uri.c_str());
}

bool hostWantsOrigin() { return s_wantsOrigin; }

bool hostReady() { return s_originLock && s_originKnown; }

// The signed calls wait for the connection and give the host HOST_CHECKPOINT_TIMEOUT_MS to answer: a checkpoint is
// destructive on the host (the interactions it lists are forgotten there, the snapshot is pinned), so giving up
// while it is still working would lose them.
bool hostCheckpoint(uint64_t id, hostframe::Payload& out) {
  if (!hostReady()) { setError("no host origin"); return false; }
  std::string body;
  int code = request("GET", id, "/checkpoint", nullptr, true, HOST_CHECKPOINT_TIMEOUT_MS, portMAX_DELAY, body);
  if (code != 200) { if (code > 0) { char d[80]; snprintf(d, sizeof d, "%d %.60s", code, body.c_str()); setError("checkpoint", d); } return false; }
  if (!hostframe::parsePayload(body.c_str(), body.size(), out, &s_jsonAlloc)) { setError("checkpoint: bad payload"); return false; }
  return true;
}

int hostFinal(uint64_t id, hostframe::Payload& out) {
  if (!hostReady()) { setError("no host origin"); return -1; }
  std::string body;
  int code = request("GET", id, "/final", nullptr, true, HOST_CHECKPOINT_TIMEOUT_MS, portMAX_DELAY, body);
  if (code == 409) return 0;
  if (code != 200) { if (code > 0) { char d[80]; snprintf(d, sizeof d, "%d %.60s", code, body.c_str()); setError("final", d); } return -1; }
  if (!hostframe::parsePayload(body.c_str(), body.size(), out, &s_jsonAlloc)) { setError("final: bad payload"); return -1; }
  return 1;
}

const char* hostLastError() { return s_lastError; }

uint64_t hostNow() {
  if (s_wallOk) return (uint64_t)(s_wallAt + (double)(millis() - s_wallMs) / 1000.0);
  time_t t = time(nullptr);
  if (t > 1600000000) return (uint64_t)t;
  return 0;
}
