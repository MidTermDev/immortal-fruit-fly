// The screen: UI.md's pages are drawn by lib/screen onto an abstract Painter; this file implements that Painter on
// the M5GFX frame sprite, feeds the Model from the pebble's state every frame (the host frame, the replica's raster
// columns, the chain, the speech rules) and keeps the modal pages (boot, key, provisioning) as they were.
#include "ui.h"
#include "flyart.h"
#include <M5Unified.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "qrcode.h"
#include "ethtx.h"
#include "hostframe.h"
#include "painter.h"
#include "model.h"
#include "pages.h"
#include "creature.h"
#include "speech.h"

using namespace screen;

static M5Canvas frame(&M5.Display);
static M5Canvas rasterSprite(&frame);      // the Neurons raster, scrolled in PSRAM
static bool s_rasterOk = false;
static uint32_t s_flashUntil = 0;
static uint32_t s_feedHintUntil = 0;
static const uint16_t C_BG = col::BG, C_TXT = col::INK, C_DIM = col::DIM, C_AMBER = col::AMBER, C_RED = col::RED, C_GREEN = col::GREEN;

static inline uint16_t rgb(int r, int g, int b) { return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)); }

// ---- helpers kept from the first screen

static void text(int x, int y, const char* s, uint16_t color, const lgfx::IFont* font = &fonts::Font0, textdatum_t datum = textdatum_t::top_left) {
  frame.setFont(font);
  frame.setTextDatum(datum);
  frame.setTextColor(color);
  frame.drawString(s, x, y);
}

// QR codes are regenerated only when the text changes (the modules are cached as a bitmap); returns the side in px
static int drawQR(LovyanGFX& g, const char* txt, int x, int y, int maxPx, uint16_t fg, uint16_t bg) {
  static std::string cachedText;
  static uint8_t cachedSize = 0;
  static uint8_t* cachedModules = nullptr;   // one byte per module, cachedSize² bytes
  if (cachedText != txt || !cachedModules) {
    size_t n = strlen(txt);
    uint8_t version = n <= 53 ? 3 : n <= 78 ? 4 : n <= 106 ? 5 : n <= 134 ? 6 : 8;
    QRCode qr;
    uint8_t* data = (uint8_t*)malloc(qrcode_getBufferSize(version));
    if (!data) return 0;
    if (qrcode_initText(&qr, data, version, ECC_LOW, txt) != 0) { free(data); return 0; }
    free(cachedModules);
    cachedModules = (uint8_t*)malloc((size_t)qr.size * qr.size);
    if (!cachedModules) { free(data); return 0; }
    for (int yy = 0; yy < qr.size; ++yy)
      for (int xx = 0; xx < qr.size; ++xx) cachedModules[yy * qr.size + xx] = qrcode_getModule(&qr, xx, yy) ? 1 : 0;
    cachedSize = qr.size;
    cachedText = txt;
    free(data);
  }
  int scale = maxPx / (cachedSize + 2); if (scale < 1) scale = 1;
  int side = (cachedSize + 2) * scale;
  g.fillRect(x, y, side, side, bg);
  for (int yy = 0; yy < cachedSize; ++yy)
    for (int xx = 0; xx < cachedSize; ++xx)
      if (cachedModules[yy * cachedSize + xx]) g.fillRect(x + (xx + 1) * scale, y + (yy + 1) * scale, scale, scale, fg);
  return side;
}

// ---- the Painter on the frame sprite

class M5Painter : public Painter {
 public:
  static const lgfx::IFont* fontOf(Font f) { return f == F_SMALL ? (const lgfx::IFont*)&fonts::Font0 : f == F_MED ? (const lgfx::IFont*)&fonts::Font2 : (const lgfx::IFont*)&fonts::FreeSansBold12pt7b; }
  void fillRect(int x, int y, int w, int h, Color c) override { frame.fillRect(x, y, w, h, c); }
  void drawLine(int x0, int y0, int x1, int y1, Color c) override { frame.drawLine(x0, y0, x1, y1, c); }
  void fillCircle(int cx, int cy, int r, Color c) override { frame.fillCircle(cx, cy, r, c); }
  void drawCircle(int cx, int cy, int r, Color c) override { frame.drawCircle(cx, cy, r, c); }
  void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, Color c) override { frame.fillTriangle(x0, y0, x1, y1, x2, y2, c); }
  void drawPixel(int x, int y, Color c) override { frame.drawPixel(x, y, c); }
  void drawRect(int x, int y, int w, int h, Color c) override { frame.drawRect(x, y, w, h, c); }
  void drawText(int x, int y, const char* s, Font f, Color c, Align a) override {
    text(x, y, s, c, fontOf(f), a == A_LEFT ? textdatum_t::top_left : a == A_CENTER ? textdatum_t::top_center : textdatum_t::top_right);
  }
  int textWidth(const char* s, Font f) override { frame.setFont(fontOf(f)); return frame.textWidth(s); }
  void setClip(int x, int y, int w, int h) override { frame.setClipRect(x, y, w, h); }
  void clearClip() override { frame.clearClipRect(); }
  int drawQR(int x, int y, int maxPx, const char* txt, Color fg, Color bg) override { return ::drawQR(frame, txt, x, y, maxPx, fg, bg); }
  // The raster lives in its own sprite: new columns are drawn at the right edge after a scroll-left blit, then the
  // sprite is pushed into the frame. Nothing pushes 155 x 220 pixels one by one.
  void drawRaster(int x, int y, const Raster& r, const uint8_t* rowY, const Color* rowColor) override {
    if (!s_rasterOk) { Painter::drawRaster(x, y, r, rowY, rowColor); return; }
    uint32_t n = r.pushed - drawnPushed_;
    if (!primed_ || r.pushed < drawnPushed_ || n >= (uint32_t)RASTER_COLS) {
      rasterSprite.fillScreen(col::BG);
      for (int k = 0; k < r.count; ++k) column(RASTER_COLS - r.count + k, r.column(k), rowY, rowColor);
      primed_ = true;
    } else if (n > 0) {
      rasterSprite.scroll(-(int)n, 0);
      for (uint32_t j = 0; j < n; ++j) column(RASTER_COLS - (int)n + (int)j, r.column(r.count - (int)n + (int)j), rowY, rowColor);
    }
    drawnPushed_ = r.pushed;
    rasterSprite.pushSprite(&frame, x, y);
  }
  void reset() { primed_ = false; }

 private:
  bool primed_ = false;
  uint32_t drawnPushed_ = 0;
  void column(int sx, const uint32_t* w, const uint8_t* rowY, const Color* rowColor) {
    for (int i = 0; i < RASTER_WORDS; ++i) {
      uint32_t v = w[i];
      while (v) {
        int b = __builtin_ctz(v); v &= v - 1;
        int row = i * 32 + b;
        if (row < RASTER_ROWS) rasterSprite.drawPixel(sx, rowY[row], rowColor[row]);
      }
    }
  }
};

static M5Painter s_painter;
static Model* s_model = nullptr;      // ~6 KB: allocated once at init (PSRAM is fine, it is read every frame)
static Speech s_speech;

void uiInit() {
  M5.Display.setBrightness(UI_BRIGHTNESS);
  M5.Display.fillScreen(C_BG);
  frame.setColorDepth(UI_COLOR_DEPTH);
  frame.setPsram(true);
  if (!frame.createSprite(320, 240)) {
    Serial.println("[ui] frame sprite failed; drawing direct");
  }
  frame.setTextWrap(false);
  rasterSprite.setColorDepth(16);
  rasterSprite.setPsram(true);
  s_rasterOk = rasterSprite.createSprite(RASTER_COLS, RASTER_ROWS + NEURON_TYPES) != nullptr;
  if (s_rasterOk) { rasterSprite.setBaseColor(col::BG); rasterSprite.fillScreen(col::BG); }
  else Serial.println("[ui] raster sprite failed; drawing the raster pixel by pixel");
  s_model = new Model();
}

void uiFlash() { s_flashUntil = millis() + 120; }
void uiFeedHint() { s_feedHintUntil = millis() + 6000; }

// ---- feeding the Model

static uint32_t hashPos(float x, float y) { uint32_t h = (uint32_t)(int32_t)lroundf(x * 10) * 2654435761u ^ (uint32_t)(int32_t)lroundf(y * 10) * 40503u; h ^= h >> 15; return h; }

static void feedReplica(Model& m, const RingData& r) {
  if (m.nNeurons == 0 && g_circuit.N > 0) {
    m.nNeurons = g_circuit.N < RASTER_ROWS ? g_circuit.N : RASTER_ROWS;
    for (int i = 0; i < m.nNeurons; ++i) { m.neuronType[i] = g_circuit.type[i]; m.neuronWedge[i] = g_circuit.wedge[i]; }
    m.buildRows();
  }
  for (int i = 0; i < r.spkColN && i < RingData::SPK_COLS; ++i) m.raster.push(r.spkCols[i]);
  for (int w = 0; w < WEDGES; ++w) m.wedgeAct[w] = r.act[w];
  m.headX = r.headX; m.headY = r.headY; m.headMag = r.headMag;
  m.spikesPerS = r.spikesPerS; m.step = r.step;
  m.localHeadingDeg = headingDeg(r.headX, r.headY);
}

static void feedHost(Model& m, const HostView& h, const BodyState& s, uint32_t now, SpeechInput& in) {
  static uint32_t lastFrames = 0; static float lastX = 0, lastY = 0; static double lastT = 0; static double lastEventT = -1; static uint64_t lastFly = 0;
  const hostframe::LiteFrame& f = h.frame;
  if (s.flyId != lastFly) { lastFly = s.flyId; lastFrames = 0; lastEventT = -1; m.trailN = 0; m.trailHead = 0; m.speed = 0; }
  if (!h.haveFrame) return;
  m.x = f.x; m.y = f.y; m.heading = f.heading; m.arena = f.arena; m.realtime = f.realtime;
  m.mode = (Mode)(f.mode <= hostframe::M_UNKNOWN ? f.mode : hostframe::M_UNKNOWN);
  m.nfood = f.nfood;
  for (int i = 0; i < f.nfood; ++i) {
    float left = f.food[i].energy0 > 0 ? f.food[i].energy / f.food[i].energy0 : 1.f;
    m.food[i] = {f.food[i].x, f.food[i].y, left < 0 ? 0 : left > 1 ? 1 : left, (int)f.food[i].energy, hashPos(f.food[i].x, f.food[i].y)};
  }
  m.npuffs = f.npuffs;
  for (int i = 0; i < f.npuffs; ++i) m.puffs[i] = {f.puffs[i].x, f.puffs[i].y, f.puffs[i].strength};
  m.predator = f.predator.present; m.predX = f.predator.x; m.predY = f.predator.y; m.predSize = f.predator.size;
  m.smell = 1 - expf(-f.rates.alpn / LIFE_SCALE_SMELL);
  m.memory = 1 - expf(-(f.rates.kc + f.rates.mbon) / LIFE_SCALE_MEMORY);
  m.sight = 1 - expf(-(f.rates.lc4L + f.rates.lc4R) / LIFE_SCALE_SIGHT);
  m.steer = 1 - expf(-fabsf(f.rates.dna02L - f.rates.dna02R) / LIFE_SCALE_STEER);
  m.taste = 1 - expf(-f.rates.grn / LIFE_SCALE_TASTE);
  // the trail: the newest TRAIL_LEN of the host's ring
  m.trailN = 0; m.trailHead = 0;
  int take = h.trailN < TRAIL_LEN ? h.trailN : TRAIL_LEN;
  for (int i = 0; i < take; ++i) { int k = (h.trailHead + HOST_TRAIL_LEN - take + i) % HOST_TRAIL_LEN; m.pushTrail(h.trailX[k], h.trailY[k]); }
  if (h.frames != lastFrames) {
    // speed from successive frames (simulated seconds)
    if (lastFrames && f.t_ms > lastT) { float dx = f.x - lastX, dy = f.y - lastY; float v = sqrtf(dx * dx + dy * dy) / (float)((f.t_ms - lastT) / 1000.0); m.speed = m.speed * 0.5f + v * 0.5f; }
    lastX = f.x; lastY = f.y; lastT = f.t_ms; lastFrames = h.frames;
    // new diary lines -> events (jumped / caught / ate)
    double newest = lastEventT;
    for (int i = 0; i < f.nevents; ++i) {
      const hostframe::Event& e = f.events[i];
      if (lastEventT >= 0 && e.t_ms > lastEventT) {
        if (strstr(e.text, "jumped")) { m.jumpMs = now; in.jumpSeq++; }
        else if (strstr(e.text, "caught")) { m.caughtMs = now; in.caughtSeq++; }
        else if (strstr(e.text, "finished a food") || !strncmp(e.text, "ate ", 4)) { m.eatMs = now; in.ateSeq++; const char* w = strstr(e.text, "worth "); in.ateSecs = w ? atoi(w + 6) : 0; }
      }
      if (e.t_ms > newest) newest = e.t_ms;
    }
    lastEventT = newest < 0 ? 0 : newest;
  }
}

int uiFrame(const BodyState& s, const RingData& r, const HostView& h, bool wifi, bool hostingRing, bool life) {
  (void)hostingRing;
  const uint32_t now = millis();
  Model& m = *s_model;
  static Phase prevPhase = Phase::BOOT;
  static uint64_t prevAnchorBlock = 0; static uint32_t prevFedSeq = 0, prevPokeSeq = 0; static bool prevFresh = false;
  static SpeechInput in;

  m.nowMs = now;
  m.moments.expire(now);
  // ---- who
  strlcpy(m.flyName, s.flyName, sizeof m.flyName); m.flyId = s.flyId;
  strlcpy(m.pebbleName, s.bodyName, sizeof m.pebbleName);
  strlcpy(m.addrHex, s.addrHex, sizeof m.addrHex);
  snprintf(m.flyUrl, sizeof m.flyUrl, "%s/fly/?id=%llu", SITE_URL, (unsigned long long)s.flyId);
  strlcpy(m.status, s.status, sizeof m.status); m.statusAgeMs = s.statusMs ? now - s.statusMs : 0xFFFFFFFFu; m.txPending = s.txPending;
  // ---- the fly
  bool fresh = hostFresh(h, now) && h.frame.generation == s.generation;
  m.hasFly = (s.phase == Phase::HOST || s.phase == Phase::DEAD) && s.flyId != 0;
  m.alive = s.phase == Phase::HOST ? s.alive : false;
  m.hostFresh = fresh; m.hostKnown = h.originKnown; m.hostOffline = s.phase == Phase::HOST && h.originKnown && !fresh;
  m.generation = s.generation; m.energy = s.energy;
  m.registered = s.phase != Phase::REGISTER && s.phase != Phase::CONNECT && s.phase != Phase::BOOT;
  m.assignmentPending = s.assignmentPending; m.flyTokens = s.flyTokens; m.hatchArmed = s.hatchArmed;
  m.coreEnabled = s.coreEnabled; m.anchored = s.anchored; m.lastAnchorBlock = s.lastAnchorBlock; m.deadBlock = s.deadBlock;
  m.chainHeadingDeg = s.anchored ? headingDeg((float)s.chainHeadX, (float)s.chainHeadY) : -1;
  m.wifi = wifi; m.ble = s.ble; m.wsMode = h.wsMode; m.hostConnected = h.connected;
  m.candidate = s.candidate; m.scanning = s.scanning; strlcpy(m.neighbourShort, s.neighbourShort, sizeof m.neighbourShort);
  feedReplica(m, r);
  feedHost(m, h, s, now, in);
  if (!h.haveFrame || !m.hasFly) { m.nfood = 0; m.npuffs = 0; m.predator = false; m.mode = Mode::UNKNOWN; }
  // ---- events -> moments
  if (s.phase == Phase::HOST && prevPhase != Phase::HOST) { m.hatchMs = now; s_painter.reset(); m.raster.clear(); }
  if (s.phase != Phase::HOST && s.phase != Phase::DEAD) m.hatchMs = 0;
  if (s.lastAnchorBlock != prevAnchorBlock && s.anchored && s.lastAnchorBlock) { m.moments.add(Moment::ANCHORED, now); in.anchorSeq++; in.anchorBlock = s.lastAnchorBlock; }
  prevAnchorBlock = s.lastAnchorBlock;
  if (s.fedSeq != prevFedSeq) { m.moments.add(Moment::FED, now); in.fedSeq = s.fedSeq; in.fedSecs = s.fedSecs; strlcpy(in.fedBy, s.fedBy, sizeof in.fedBy); }
  prevFedSeq = s.fedSeq;
  if (s.pokeSeq != prevPokeSeq) { m.moments.add(Moment::POKED, now); in.pokeSeq = s.pokeSeq; strlcpy(in.pokeBy, s.pokeBy, sizeof in.pokeBy); in.pokeChannel = s.pokeChannel; in.pokeParam = s.pokeParam; }
  prevPokeSeq = s.pokeSeq;
  if (prevFresh && !fresh && s.phase == Phase::HOST) m.moments.add(Moment::STREAM_LOST, now);
  prevFresh = fresh;
  static uint32_t prevFlashUntil = 0;
  if (s_flashUntil != prevFlashUntil) { prevFlashUntil = s_flashUntil; m.caughtMs = now; }   // the spider sensor: the same red flash + shake
  // ---- speech
  in.hasFly = m.hasFly; in.alive = m.alive; in.hatching = m.hatchMs && now - m.hatchMs < HATCH_MS + 800;
  in.hostOffline = m.hostOffline; in.mode = m.mode; in.energy = m.energy;
  in.eating = flyStateOf(m) == FlyState::EATING;
  in.foodNear = false; for (int i = 0; i < m.nfood; ++i) { float dx = m.food[i].x - m.x, dy = m.food[i].y - m.y; if (dx * dx + dy * dy < 100.f) in.foodNear = true; }
  in.predatorNear = m.predator && ((m.predX - m.x) * (m.predX - m.x) + (m.predY - m.y) * (m.predY - m.y) < 1600.f);
  s_speech.update(now, in);
  strlcpy(m.speech, s_speech.line(), sizeof m.speech);
  // ---- the page
  if (now < s_feedHintUntil && m.hasFly) m.page = Page::FEED_HINT;
  else if (s.phase == Phase::DEAD) m.page = Page::DEAD;
  else if (s.phase == Phase::HOST) m.page = (m.hatchMs && now - m.hatchMs < HATCH_MS + 800) ? Page::HATCHING : (life && fresh) ? Page::LIFE : Page::NEURONS;
  else m.page = Page::WAITING;
  prevPhase = s.phase;

  drawScreen(s_painter, m);

  // a finger on the halo (Neurons page) cues the wedge under it, as the ring did
  int touchWedge = -1;
  if (m.page == Page::NEURONS) {
    auto t = M5.Touch.getDetail();
    if (t.isPressed() && t.y < 240) {
      const int cx = NEURONS_COL_X + NEURONS_COL_W / 2, cy = 62;
      float dx = t.x - cx, dy = -(t.y - cy), d = sqrtf(dx * dx + dy * dy);
      if (d >= 16 && d <= 52) {
        float a = atan2f(dy, dx); if (a < 0) a += 6.2831853f;
        touchWedge = ((int)(a / (6.2831853f / 16))) & 15;
        frame.drawCircle(cx, cy, 43, C_TXT);
      }
    }
  }
  frame.pushSprite(0, 0);
  return touchWedge;
}

// ---- modal pages (unchanged)

// The ASCII fly from brand/fly.txt, drawn as a silhouette: Font0 scaled so 57 columns fit in 320 px.
static void drawAsciiFly(int cx, int top, uint16_t color) {
  const float scale = 0.9f;                 // 6 px advance × 0.9 = 5.4 px → 57 cols ≈ 308 px
  const int lineH = (int)(8 * scale + 0.5f);
  frame.setFont(&fonts::Font0);
  frame.setTextSize(scale);
  frame.setTextDatum(textdatum_t::top_center);
  frame.setTextColor(color);
  for (int i = 0; i < FLYART_LINES; i++) frame.drawString(FLYART[i], cx, top + i * lineH);
  frame.setTextSize(1.0f);
}

void uiBootMessage(const char* l1, const char* l2) {
  frame.fillScreen(C_BG);
  text(160, 8, "Immortal Fruit Fly", C_AMBER, &fonts::Font2, textdatum_t::top_center);
  drawAsciiFly(160, 36, C_TXT);
  text(160, 172, l1, C_TXT, &fonts::Font2, textdatum_t::top_center);
  if (l2) text(160, 198, l2, C_DIM, &fonts::Font0, textdatum_t::top_center);
  frame.pushSprite(0, 0);
}

void uiShowKey(const std::string& priv, const char* addr) {
  frame.fillScreen(rgb(40, 0, 0));
  text(160, 6, "PRIVATE KEY - shown once, back it up", C_RED, &fonts::Font2, textdatum_t::top_center);
  drawQR(frame, priv.c_str(), 8, 34, 140, rgb(40, 0, 0), C_TXT);
  for (int i = 0; i < 4; ++i) {
    std::string part = priv.substr(i * 16, 16);
    text(158, 44 + i * 24, part.c_str(), C_TXT, &fonts::Font2);
  }
  text(158, 146, "64 hex digits, no 0x", C_DIM);
  text(160, 190, addr, C_DIM, &fonts::Font0, textdatum_t::top_center);
  text(160, 222, "press any button to hide", C_DIM, &fonts::Font0, textdatum_t::top_center);
  frame.pushSprite(0, 0);
  // wait for a release, then a fresh press
  do { M5.update(); delay(20); } while (M5.BtnA.isPressed() || M5.BtnB.isPressed() || M5.BtnC.isPressed());
  for (;;) { M5.update(); if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed() || M5.BtnC.wasPressed()) break; delay(20); }
  frame.fillScreen(C_BG);
  frame.pushSprite(0, 0);
  drawQR(frame, "0x", 0, 0, 1, C_BG, C_BG);   // evict the key from the QR cache
  frame.fillScreen(C_BG);
}

void uiProvisionPage(const char* apName) {
  frame.fillScreen(C_BG);
  text(160, 20, "Wi-Fi setup", C_AMBER, &fonts::Font2, textdatum_t::top_center);
  text(160, 50, "1. join the Wi-Fi network", C_TXT, &fonts::Font2, textdatum_t::top_center);
  text(160, 74, apName, C_GREEN, &fonts::Font2, textdatum_t::top_center);
  text(160, 104, "2. open http://192.168.4.1", C_TXT, &fonts::Font2, textdatum_t::top_center);
  text(160, 128, "(or wait for the sign-in page)", C_DIM, &fonts::Font0, textdatum_t::top_center);
  text(160, 150, "3. enter your Wi-Fi name and password", C_TXT, &fonts::Font0, textdatum_t::top_center);
  text(160, 170, "or put them in include/secrets.h and reflash", C_DIM, &fonts::Font0, textdatum_t::top_center);
  frame.pushSprite(0, 0);
}
