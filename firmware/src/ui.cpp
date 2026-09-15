#include "ui.h"
#include "flyart.h"
#include <M5Unified.h>
#include <math.h>
#include <stdio.h>
#include "qrcode.h"
#include "ethtx.h"

// ---- layout (320×240)
static const int CX = 104, CY = 110;       // ring centre
static const int R_IN = 52, R_OUT = 86;    // activity ring
static const int H_IN = 89, H_OUT = 95;    // heading-histogram ring (the memory)
static const int PX = 200, PW = 116;       // right panel
static const int NARR_Y = 214;             // narration line

static M5Canvas frame(&M5.Display);
static M5Canvas glyph(&frame);
static const uint16_t KEY = 0xF81F;        // transparent colour of the glyph sprite
static uint32_t s_flashUntil = 0;

static inline uint16_t rgb(int r, int g, int b) { return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)); }
static inline uint16_t mix(int r, int g, int b, float a) { if (a < 0) a = 0; if (a > 1) a = 1; return rgb((int)(r * a), (int)(g * a), (int)(b * a)); }

static const uint16_t C_BG = rgb(8, 8, 10), C_TXT = rgb(232, 230, 224), C_DIM = rgb(120, 120, 116), C_GREEN = rgb(80, 220, 120), C_RED = rgb(255, 90, 53), C_AMBER = rgb(240, 180, 41), C_BLUE = rgb(88, 196, 245), C_MAG = rgb(210, 90, 230), C_GREY = rgb(40, 40, 44);

static void drawGlyph() {
  glyph.setColorDepth(16);
  glyph.createSprite(40, 40);
  glyph.fillScreen(KEY);
  // a fly pointing to +x: wings, abdomen, thorax, head, eyes
  glyph.fillEllipse(14, 13, 12, 5, rgb(120, 130, 150));
  glyph.fillEllipse(14, 27, 12, 5, rgb(120, 130, 150));
  glyph.fillEllipse(13, 20, 9, 6, rgb(90, 60, 30));
  glyph.fillEllipse(23, 20, 6, 5, rgb(120, 80, 40));
  glyph.fillCircle(31, 20, 4, rgb(140, 95, 45));
  glyph.fillCircle(33, 17, 2, C_RED);
  glyph.fillCircle(33, 23, 2, C_RED);
}

void uiInit() {
  M5.Display.setBrightness(UI_BRIGHTNESS);
  M5.Display.fillScreen(C_BG);
  frame.setColorDepth(UI_COLOR_DEPTH);
  frame.setPsram(true);
  if (!frame.createSprite(320, 240)) {
    Serial.println("[ui] frame sprite failed; drawing direct");
  }
  frame.setTextWrap(false);
  drawGlyph();
}

void uiFlash() { s_flashUntil = millis() + 120; }

// ---- helpers

static void text(int x, int y, const char* s, uint16_t color, const lgfx::IFont* font = &fonts::Font0, textdatum_t datum = textdatum_t::top_left) {
  frame.setFont(font);
  frame.setTextDatum(datum);
  frame.setTextColor(color);
  frame.drawString(s, x, y);
}

// draw s clipped to width w by dropping characters (with an ellipsis)
static void textFit(int x, int y, const char* s, int w, uint16_t color, const lgfx::IFont* font = &fonts::Font0) {
  frame.setFont(font);
  if (frame.textWidth(s) <= w) { text(x, y, s, color, font); return; }
  char buf[128];
  size_t n = strlen(s); if (n > sizeof buf - 2) n = sizeof buf - 2;
  while (n > 0) {
    memcpy(buf, s, n); buf[n] = '~'; buf[n + 1] = 0;
    if (frame.textWidth(buf) <= w) break;
    --n;
  }
  text(x, y, buf, color, font);
}

// QR codes are regenerated only when the text changes (the modules are cached as a bitmap)
static void drawQR(LovyanGFX& g, const char* txt, int x, int y, int maxPx, uint16_t fg, uint16_t bg) {
  static std::string cachedText;
  static uint8_t cachedSize = 0;
  static uint8_t* cachedModules = nullptr;   // one byte per module, cachedSize² bytes
  if (cachedText != txt || !cachedModules) {
    size_t n = strlen(txt);
    uint8_t version = n <= 53 ? 3 : n <= 78 ? 4 : n <= 106 ? 5 : n <= 134 ? 6 : 8;
    QRCode qr;
    uint8_t* data = (uint8_t*)malloc(qrcode_getBufferSize(version));
    if (!data) return;
    if (qrcode_initText(&qr, data, version, ECC_LOW, txt) != 0) { free(data); return; }
    free(cachedModules);
    cachedModules = (uint8_t*)malloc((size_t)qr.size * qr.size);
    if (!cachedModules) { free(data); return; }
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
}

static void fmtBnb(uint64_t wei, bool overflow, char* out, size_t n) {
  if (overflow) { snprintf(out, n, ">18 BNB"); return; }
  double bnb = (double)wei / 1e18;
  if (bnb >= 1) snprintf(out, n, "%.3f BNB", bnb);
  else snprintf(out, n, "%.4f BNB", bnb);
}

static void drawDots(int x, int y, bool wifi, bool ble) {
  frame.fillCircle(x, y, 3, wifi ? C_GREEN : C_GREY);
  text(x + 7, y - 4, "wifi", wifi ? C_TXT : C_DIM);
  frame.fillCircle(x + 42, y, 3, ble ? C_BLUE : C_GREY);
  text(x + 49, y - 4, "ble", ble ? C_TXT : C_DIM);
}

// ---- the ring

static void drawRing(const RingData& r, const BodyState& s, bool live) {
  // wedge w spans the counter-clockwise angles [w·22.5°, (w+1)·22.5°) from 3 o'clock, as on the site (lib/dial.ts).
  // LGFX arcs are clockwise from 3 o'clock in screen space, so the screen arc is [360 − a1, 360 − a0].
  uint32_t hm = 1;
  for (int w = 0; w < flycore::WEDGES; ++w) if (r.hist[w] > hm) hm = r.hist[w];
  for (int w = 0; w < flycore::WEDGES; ++w) {
    float a0 = w * 22.5f, a1 = a0 + 22.5f - 1.7f;
    float a = live ? r.act[w] : 0;
    float spk = live ? (r.bins[w] > 3 ? 1.f : r.bins[w] / 3.f) : 0;
    float lum = 0.06f + a * 0.85f;
    if (spk > 0 && lum < 0.35f + spk * 0.5f) lum = 0.35f + spk * 0.5f;
    uint16_t col;
    if (a > 0.55f) { float t = (a - 0.55f) * 1.5f; if (t > 1) t = 1; col = mix((int)(240 + (255 - 240) * t), (int)(180 - 90 * t), (int)(41 + 12 * t), lum); }
    else col = mix(240, 180, 41, lum);
    frame.fillArc(CX, CY, R_IN, R_OUT, 360.f - a1, 360.f - a0, col);
    float h = live ? (float)r.hist[w] / (float)hm : 0;
    frame.fillArc(CX, CY, H_IN, H_OUT, 360.f - a1, 360.f - a0, mix(88, 196, 245, 0.07f + 0.6f * h));
  }
  // wedge labels 0 / 4 / 8 / 12, as on the site
  for (int w = 0; w < flycore::WEDGES; w += 4) {
    float a = (w + 0.5f) * 22.5f * 0.01745329f;
    char b[3]; snprintf(b, sizeof b, "%d", w);
    text(CX + (int)(cosf(a) * 102), CY - (int)(sinf(a) * 102), b, C_DIM, &fonts::Font0, textdatum_t::middle_center);
  }
  if (!live) return;
  // the on-chain population vector (last anchor), magenta, thin
  if (s.anchored && (s.chainHeadX || s.chainHeadY)) {
    float a = atan2f((float)s.chainHeadY, (float)s.chainHeadX);
    float m = sqrtf((float)s.chainHeadX * s.chainHeadX + (float)s.chainHeadY * s.chainHeadY) / (64.f * ANCHOR_STEPS);
    if (m > 1) m = 1;
    float L = R_IN * (0.35f + 0.65f * m);
    frame.drawLine(CX, CY, CX + (int)(cosf(a) * L), CY - (int)(sinf(a) * L), C_MAG);
  }
  // the local needle: a white triangle, full length when the bump is strong
  if (r.headX != 0 || r.headY != 0) {
    float a = atan2f(r.headY, r.headX);
    float L = R_IN * (0.35f + 0.65f * r.headMag);
    float tx = CX + cosf(a) * L, ty = CY - sinf(a) * L;
    float px = -sinf(a) * 3, py = -cosf(a) * 3;
    frame.fillTriangle((int)(CX + px), (int)(CY + py), (int)(CX - px), (int)(CY - py), (int)tx, (int)ty, C_TXT);
    // the fly glyph rotated to the heading (screen angles are clockwise)
    glyph.pushRotateZoom(&frame, CX, CY, -a * 57.2957795f, 0.8f, 0.8f, KEY);
  } else {
    glyph.pushRotateZoom(&frame, CX, CY, 0, 0.8f, 0.8f, KEY);
  }
  frame.fillCircle(CX, CY, 3, C_RED);
  // the active stimulus, if any
  if (r.stimActive) {
    const char* names[] = {"", "cue", "turn L", "turn R", "SHOCK"};
    char b[24];
    if (r.stimChannel == flycore::CH_CUE) snprintf(b, sizeof b, "cue w%d x%d", r.stimParam, r.stimStrength);
    else snprintf(b, sizeof b, "%s x%d", names[r.stimChannel < 5 ? r.stimChannel : 0], r.stimStrength);
    text(CX, CY + R_OUT + 12, b, r.stimChannel == flycore::CH_SHOCK ? C_RED : C_AMBER, &fonts::Font0, textdatum_t::middle_center);
  }
}

// ---- the right panel

static void drawPanel(const BodyState& s, const RingData& r, bool wifi) {
  char b[64];
  int y = 4;
  if (s.flyId) {
    textFit(PX, y, s.flyName[0] ? s.flyName : "Fly", PW, C_TXT, &fonts::Font2); y += 18;
    snprintf(b, sizeof b, "#%llu  gen %lu", (unsigned long long)s.flyId, (unsigned long)s.generation);
    text(PX, y, b, C_DIM); y += 12;
  } else {
    text(PX, y, s.bodyName, C_TXT, &fonts::Font2); y += 18;
    text(PX, y, "no fly in this body", C_DIM); y += 12;
  }
  const char* ph = s.phase == Phase::HOST ? (s.alive ? "ALIVE" : "DEAD") : s.phase == Phase::DEAD ? "DEAD" : s.phase == Phase::WAIT ? "WAITING" : s.phase == Phase::REGISTER ? "REGISTERING" : s.phase == Phase::CONNECT ? "CONNECTING" : "BOOT";
  text(PX, y, ph, s.phase == Phase::HOST && s.alive ? C_GREEN : (s.phase == Phase::DEAD ? C_DIM : C_AMBER), &fonts::Font2); y += 18;
  if (s.phase == Phase::HOST) {
    // energy bar: seconds of life, full at one hour
    int64_t e = s.energy < 0 ? 0 : s.energy;
    float fill = e >= 3600 ? 1.f : (float)e / 3600.f;
    frame.drawRect(PX, y, PW, 9, C_DIM);
    frame.fillRect(PX + 1, y + 1, (int)((PW - 2) * fill), 7, e < 120 ? C_RED : e < 600 ? C_AMBER : C_GREEN);
    y += 12;
    if (e >= 3600) snprintf(b, sizeof b, "%lld s  (%lld h %lld m)", (long long)e, (long long)(e / 3600), (long long)((e % 3600) / 60));
    else snprintf(b, sizeof b, "%lld s left", (long long)e);
    text(PX, y, b, C_TXT); y += 12;
    snprintf(b, sizeof b, "%lu spk/s  step %llu", (unsigned long)r.spikesPerS, (unsigned long long)r.step);
    text(PX, y, b, C_DIM); y += 12;
    if (!s.coreEnabled) { text(PX, y, "core: not deployed", C_DIM); y += 12; text(PX, y, "local preview only", C_DIM); y += 12; }
    else if (!s.anchored) { text(PX, y, "anchor: none yet", C_DIM); y += 12; }
    else {
      snprintf(b, sizeof b, "anchor blk %llu", (unsigned long long)s.lastAnchorBlock); text(PX, y, b, C_DIM); y += 12;
      int hc = headingDeg((float)s.chainHeadX, (float)s.chainHeadY), hl = headingDeg(r.headX, r.headY);
      if (hc >= 0) snprintf(b, sizeof b, "chain %d%c", hc, 0xF8); else snprintf(b, sizeof b, "chain --");
      text(PX, y, b, C_MAG);
      if (hl >= 0) snprintf(b, sizeof b, "local %d%c", hl, 0xF8); else snprintf(b, sizeof b, "local --");
      text(PX + 60, y, b, C_TXT); y += 12;
      uint32_t age = (millis() - s.lastAnchorMs) / 1000;
      snprintf(b, sizeof b, "%lu s ago%s", (unsigned long)age, s.anchorMismatch ? " (resynced)" : ""); text(PX, y, b, C_DIM); y += 12;
    }
  } else if (s.phase == Phase::DEAD) {
    snprintf(b, sizeof b, "brain preserved"); text(PX, y, b, C_TXT); y += 12;
    snprintf(b, sizeof b, "at block %lu", (unsigned long)s.deadBlock); text(PX, y, b, C_DIM); y += 12;
    std::string h = ethtx::toHex(s.brainHash, 6); h += "..";
    text(PX, y, h.c_str(), C_DIM); y += 12;
    text(PX, y, "resurrect on the site", C_AMBER); y += 12;
  } else if (s.phase == Phase::WAIT) {
    text(PX, y, "assign a fly to", C_DIM); y += 12;
    text(PX, y, "this address on the", C_DIM); y += 12;
    text(PX, y, "site (Hand it to a", C_DIM); y += 12;
    text(PX, y, "body / another addr)", C_DIM); y += 12;
  } else if (s.phase == Phase::REGISTER) {
    text(PX, y, "send 0.05 BNB here,", C_DIM); y += 12;
    text(PX, y, "then it registers", C_DIM); y += 12;
  }
  y = 152;
  char shortHex[16]; snprintf(shortHex, sizeof shortHex, "%.6s..%s", s.addrHex, s.addrHex[0] ? s.addrHex + 38 : "");
  text(PX, y, shortHex, C_TXT); y += 12;
  if (s.balanceKnown) { fmtBnb(s.balanceWei, s.balanceOverflow, b, sizeof b); text(PX, y, b, s.balanceWei < 5000000000000000ULL && !s.balanceOverflow ? C_RED : C_DIM); }
  else text(PX, y, "balance ?", C_DIM);
  if (s.flyTokens) text(PX + 70, y, "$FLY", C_AMBER);
  y += 12;
  drawDots(PX + 4, y + 4, wifi, s.ble);
  // what the touch buttons under the screen do right now
  y = 190;
  if (s.candidate) { text(PX, y, "B: confirm hand-off", C_AMBER); text(PX, y + 10, "A/C: cancel", C_DIM); }
  else if (s.scanning) { text(PX, y, "scanning BLE...", C_BLUE); }
  else if (s.phase == Phase::HOST) { text(PX, y, "hold B: hand off", C_DIM); text(PX, y + 10, "hold A+C: show key", C_DIM); }
  else if ((s.phase == Phase::WAIT || s.phase == Phase::DEAD) && s.flyTokens) { text(PX, y, s.hatchArmed ? "B again: HATCH" : "B: hatch a fly", s.hatchArmed ? C_AMBER : C_DIM); text(PX, y + 10, "hold A+C: show key", C_DIM); }
  else { text(PX, y, "hold A+C: show key", C_DIM); }
}

int uiFrame(const BodyState& s, const RingData& r, bool wifi, bool hostingRing) {
  bool flash = millis() < s_flashUntil;
  frame.fillScreen(flash ? rgb(120, 20, 20) : (s.phase == Phase::DEAD ? rgb(28, 28, 30) : C_BG));

  int touchWedge = -1;
  if (s.phase == Phase::HOST) {
    drawRing(r, s, hostingRing && s.alive);
    // a finger on the ring cues the wedge under it (like the site's poke)
    auto t = M5.Touch.getDetail();
    if (t.isPressed() && t.y < 240) {
      float dx = t.x - CX, dy = -(t.y - CY), d = sqrtf(dx * dx + dy * dy);
      if (d >= R_IN - 8 && d <= R_OUT + 10) {
        float a = atan2f(dy, dx); if (a < 0) a += 6.2831853f;
        touchWedge = ((int)(a / (6.2831853f / 16))) & 15;
        float a0 = touchWedge * 22.5f;
        frame.drawArc(CX, CY, R_IN - 3, R_OUT + 3, 360.f - (a0 + 22.5f), 360.f - a0, C_TXT);
      }
    }
  } else if (s.phase == Phase::DEAD) {
    char url[96]; snprintf(url, sizeof url, "%s/fly/?id=%llu", SITE_URL, (unsigned long long)s.flyId);
    drawQR(frame, url, 22, 30, 160, rgb(30, 30, 32), C_TXT);
    text(102, 196, "scan to resurrect", C_DIM, &fonts::Font0, textdatum_t::top_center);
  } else {
    // no fly: the pebble's address as a QR (send BNB / assign a fly to it)
    drawQR(frame, s.addrHex[0] ? s.addrHex : "0x", 30, 22, 150, rgb(0, 0, 0), C_TXT);
    text(104, 178, s.addrHex, C_DIM, &fonts::Font0, textdatum_t::top_center);
  }
  drawPanel(s, r, wifi);
  // narration
  frame.drawFastHLine(0, NARR_Y - 4, 320, C_GREY);
  textFit(4, NARR_Y, s.status[0] ? s.status : "", 312, s.txPending ? C_AMBER : C_TXT, &fonts::Font2);
  frame.pushSprite(0, 0);
  return touchWedge;
}

// ---- modal pages

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
