// Native renders of every pebble page (UI.md) through lib/screen on a 320x240 RGB buffer: screens/<page>.ppm under
// the firmware dir (tools/ppm2png.py turns them into brand/pebble_screens/*.png). Asserts every page stays inside
// the buffer, paints enough pixels, and that the raster scroller is fast. Also checks the speech rules.
//   cd firmware && ../.venv/bin/pio test -e native -f test_screen -v
#include <unity.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <sys/stat.h>
#include "painter.h"
#include "model.h"
#include "pages.h"
#include "creature.h"
#include "speech.h"
#include "flycore.h"
#include "qrcode.h"
#include "fonts_gen.h"
#include "../../fixtures/circuit_table.h"
#include "../../fixtures/params.h"

using namespace screen;

void setUp() {}
void tearDown() {}

// ---------------------------------------------------------------- the native painter

class RasterPainter : public Painter {
 public:
  uint8_t px[SCREEN_H][SCREEN_W][3];
  long calls = 0;            // primitive calls
  long pixels = 0;           // pixels written
  long outside = 0;          // pixels attempted outside the buffer with no clip active
  int firstOutX = 0, firstOutY = 0;
  bool clip = false; int cl = 0, ct = 0, cr = 0, cb = 0;

  RasterPainter() { clear(col::BG); }
  void clear(Color c) { for (int y = 0; y < SCREEN_H; ++y) for (int x = 0; x < SCREEN_W; ++x) put(x, y, c); }
  static void rgb(Color c, uint8_t* o) { o[0] = (uint8_t)((c >> 11) << 3 | (c >> 13)); o[1] = (uint8_t)(((c >> 5) & 63) << 2 | ((c >> 9) & 3)); o[2] = (uint8_t)((c & 31) << 3 | ((c >> 2) & 7)); }
  inline void put(int x, int y, Color c) {
    if (clip && (x < cl || y < ct || x > cr || y > cb)) return;
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) { if (!outside) { firstOutX = x; firstOutY = y; } outside++; return; }
    rgb(c, px[y][x]); pixels++;
  }
  void setClip(int x, int y, int w, int h) override { clip = true; cl = x; ct = y; cr = x + w - 1; cb = y + h - 1; }
  void clearClip() override { clip = false; }
  void drawPixel(int x, int y, Color c) override { calls++; put(x, y, c); }
  void fillRect(int x, int y, int w, int h, Color c) override { calls++; for (int j = 0; j < h; ++j) for (int i = 0; i < w; ++i) put(x + i, y + j, c); }
  void hline(int x0, int x1, int y, Color c) { if (x0 > x1) { int t = x0; x0 = x1; x1 = t; } for (int x = x0; x <= x1; ++x) put(x, y, c); }
  void drawLine(int x0, int y0, int x1, int y1, Color c) override {
    calls++;
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      put(x0, y0, c);
      if (x0 == x1 && y0 == y1) break;
      int e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  void fillCircle(int cx, int cy, int r, Color c) override {
    calls++;
    for (int dy = -r; dy <= r; ++dy) { int dx = (int)floor(sqrt((double)(r * r - dy * dy)) + 0.5); hline(cx - dx, cx + dx, cy + dy, c); }
  }
  void drawCircle(int cx, int cy, int r, Color c) override {
    calls++;
    int x = r, y = 0, err = 1 - r;
    while (x >= y) {
      put(cx + x, cy + y, c); put(cx + y, cy + x, c); put(cx - y, cy + x, c); put(cx - x, cy + y, c);
      put(cx - x, cy - y, c); put(cx - y, cy - x, c); put(cx + y, cy - x, c); put(cx + x, cy - y, c);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }
  void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, Color c) override {
    calls++;
    // sort by y
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; }
    if (y1 > y2) { int t = y1; y1 = y2; y2 = t; t = x1; x1 = x2; x2 = t; }
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; t = x0; x0 = x1; x1 = t; }
    if (y0 == y2) { int a = x0, b = x0; if (x1 < a) a = x1; if (x1 > b) b = x1; if (x2 < a) a = x2; if (x2 > b) b = x2; hline(a, b, y0, c); return; }
    for (int y = y0; y <= y2; ++y) {
      // the long edge x0->x2 and the short edge (x0->x1 or x1->x2)
      double xa = x0 + (double)(x2 - x0) * (y - y0) / (double)(y2 - y0);
      double xb;
      if (y < y1) xb = y1 == y0 ? x1 : x0 + (double)(x1 - x0) * (y - y0) / (double)(y1 - y0);
      else xb = y2 == y1 ? x1 : x1 + (double)(x2 - x1) * (y - y1) / (double)(y2 - y1);
      hline((int)floor(xa + 0.5), (int)floor(xb + 0.5), y, c);
    }
  }
  // ---- text: the M5GFX glyphs (fonts_gen.h), drawn with the top-left datum like LGFX. Only printable ASCII is a
  //      glyph: anything else is what the device would show for a code its font lacks (a hollow box, M5GFX's
  //      drawCharDummy) and is counted in `badBytes`, so a stray byte shows in the renders and fails the test
  //      instead of being hidden (the pages draw the middle dot and the degree sign themselves: pages.cpp drawLabel)
  long badBytes = 0;
  int cellW(Font f) const { return f == F_SMALL ? 6 : f == F_MED ? SF2_W[0] : 12; }
  int glyphAdvance(unsigned char ch, Font f) const {
    if (ch < 32 || ch > 126) return cellW(f);
    if (f == F_SMALL) return 6;
    if (f == F_MED) return SF2_W[ch - 32];
    return SFB_GLYPHS[ch - 32].adv;
  }
  int textWidth(const char* s, Font f) override { int w = 0; for (const unsigned char* q = (const unsigned char*)s; *q; ++q) w += glyphAdvance(*q, f); return w; }
  void glyph(int x, int y, unsigned char ch, Font f, Color c) {
    if (ch < 32 || ch > 126) {
      badBytes++;
      int w = cellW(f), h = FONT_H[f];
      for (int i = 1; i < w - 1; ++i) { put(x + i, y + 1, c); put(x + i, y + h - 2, c); }
      for (int j = 1; j < h - 1; ++j) { put(x + 1, y + j, c); put(x + w - 2, y + j, c); }
      return;
    }
    if (f == F_SMALL) {
      const uint8_t* d = SF0_DATA + (ch - 32) * 5;
      for (int col = 0; col < 5; ++col) for (int r = 0; r < 7; ++r) if ((d[col] >> r) & 1) put(x + col, y + r, c);
    } else if (f == F_MED) {
      int w = SF2_W[ch - 32];
      const uint16_t* rows = SF2_ROWS + (ch - 32) * 16;
      for (int r = 0; r < 16; ++r) for (int col = 0; col < w - 1; ++col) if ((rows[r] >> (15 - col)) & 1) put(x + col, y + r, c);
    } else {
      const SfbGlyph& g = SFB_GLYPHS[ch - 32];
      int bit = 0;
      for (int r = 0; r < g.h; ++r) for (int col = 0; col < g.w; ++col, ++bit) {
        if ((SFB_BITMAPS[g.off + (bit >> 3)] >> (7 - (bit & 7))) & 1) put(x + g.xo + col, y + SFB_ASCENT + g.yo + r, c);
      }
    }
  }
  void drawText(int x, int y, const char* s, Font f, Color c, Align a) override {
    calls++;
    int w = textWidth(s, f);
    if (a == A_CENTER) x -= w / 2; else if (a == A_RIGHT) x -= w;
    for (const unsigned char* q = (const unsigned char*)s; *q; ++q) { glyph(x, y, *q, f, c); x += glyphAdvance(*q, f); }
  }
  // ---- a real QR code (the same encoder as the device)
  int drawQR(int x, int y, int maxPx, const char* text, Color fg, Color bg) override {
    size_t n = strlen(text);
    uint8_t version = n <= 53 ? 3 : n <= 78 ? 4 : n <= 106 ? 5 : n <= 134 ? 6 : 8;
    QRCode qr;
    uint8_t* data = (uint8_t*)malloc(qrcode_getBufferSize(version));
    if (qrcode_initText(&qr, data, version, ECC_LOW, text) != 0) { free(data); return Painter::drawQR(x, y, maxPx, text, fg, bg); }
    int scale = maxPx / (qr.size + 2); if (scale < 1) scale = 1;
    int side = (qr.size + 2) * scale;
    fillRect(x, y, side, side, bg);
    for (int yy = 0; yy < qr.size; ++yy) for (int xx = 0; xx < qr.size; ++xx) if (qrcode_getModule(&qr, xx, yy)) fillRect(x + (xx + 1) * scale, y + (yy + 1) * scale, scale, scale, fg);
    free(data);
    return side;
  }
  // ---- checks
  long nonBackground() const {
    uint8_t bg[3]; rgb(col::BG, bg);
    long n = 0;
    for (int y = 0; y < SCREEN_H; ++y) for (int x = 0; x < SCREEN_W; ++x) if (memcmp(px[y][x], bg, 3)) n++;
    return n;
  }
  bool writePPM(const char* path) const {
    FILE* f = fopen(path, "wb"); if (!f) return false;
    fprintf(f, "P6\n%d %d\n255\n", SCREEN_W, SCREEN_H);
    fwrite(px, 1, sizeof px, f);
    fclose(f);
    return true;
  }
};

// ---------------------------------------------------------------- where the renders go

static char s_dir[512] = "";
static const char* screensDir() {
  if (s_dir[0]) return s_dir;
  // this file is <firmware>/test/test_screen/test_screen.cpp
  const char* f = __FILE__;
  const char* tail = strstr(f, "test/test_screen/");
  if (tail) snprintf(s_dir, sizeof s_dir, "%.*sscreens", (int)(tail - f), f); else snprintf(s_dir, sizeof s_dir, "screens");
  mkdir(s_dir, 0755);
  return s_dir;
}

static void save(const RasterPainter& p, const char* name) {
  char path[600]; snprintf(path, sizeof path, "%s/%s.ppm", screensDir(), name);
  TEST_ASSERT_TRUE_MESSAGE(p.writePPM(path), path);
}

// ---------------------------------------------------------------- models

static const uint32_t NOW = 1234567;   // the animation clock of the renders

static void baseFly(Model& m) {
  m.nowMs = NOW;
  strcpy(m.flyName, "Big brainny"); m.flyId = 65; strcpy(m.pebbleName, "Pebble 8a1f");
  strcpy(m.addrHex, "0x8A1f3C9b2E4d5F607182930a4B5c6D7e8F901234");
  strcpy(m.flyUrl, "https://midtermdev.github.io/immortal-fruit-fly/fly/?id=65");
  m.hasFly = true; m.alive = true; m.hostFresh = true; m.hostKnown = true; m.generation = 1;
  m.arena = 240.f; m.realtime = 0.8f; m.registered = true;
  m.coreEnabled = true; m.anchored = true; m.lastAnchorBlock = 122097417ULL;
  m.wifi = true; m.hostConnected = true; m.wsMode = true;
  m.windRad = 3.6f;
}

// a trail: a curved walk ending at the fly
static void curvedTrail(Model& m, float ex, float ey, float heading) {
  for (int k = 0; k < 120; ++k) {
    float u = (float)k / 119.f;
    float a = heading + (1.f - u) * 2.2f;
    float d = (1.f - u) * 40.f;
    m.pushTrail(ex - cosf(a) * d + sinf(u * 9.f) * 1.5f, ey - sinf(a) * d + cosf(u * 7.f) * 1.5f);
  }
}

static void bars(Model& m, float smell, float memory, float sight, float steer, float taste) { m.smell = smell; m.memory = memory; m.sight = sight; m.steer = steer; m.taste = taste; }

static Model lifeSurge() {
  Model m; baseFly(m);
  m.page = Page::LIFE;
  m.x = 12.f; m.y = -8.f; m.heading = 0.6f; m.speed = 3.f; m.mode = Mode::SURGE; m.energy = 4920;
  m.nfood = 2;
  m.food[0] = {m.x + cosf(0.6f) * 14.f, m.y + sinf(0.6f) * 14.f, 0.9f, 540, 7};
  m.food[1] = {m.x - 22.f, m.y + 18.f, 0.4f, 240, 3};
  m.npuffs = 1; m.puffs[0] = {m.x + 6.f, m.y - 20.f, 0.8f};
  m.predator = true; m.predX = m.x + 40.f; m.predY = m.y - 25.f; m.predSize = 6.f;   // 47 BL away: a shadow at the edge, not fleeing yet
  bars(m, 0.85f, 0.25f, 0.4f, 0.6f, 0.05f);
  curvedTrail(m, m.x, m.y, m.heading);
  m.txPending = true;
  strcpy(m.speech, "I smell something...");
  strcpy(m.status, "anchoring cue... tx 0x7c3e91a2"); m.statusAgeMs = 1500;
  return m;
}

static Model lifeEating() {
  Model m; baseFly(m);
  m.page = Page::LIFE;
  m.x = -30.f; m.y = 40.f; m.heading = 2.4f; m.speed = 0.f; m.mode = Mode::EAT; m.energy = 5400;
  m.nfood = 1; m.food[0] = {m.x + cosf(2.4f) * 2.5f, m.y + sinf(2.4f) * 2.5f, 0.55f, 330, 9};
  bars(m, 0.3f, 0.6f, 0.2f, 0.1f, 0.95f);
  curvedTrail(m, m.x, m.y, m.heading);
  m.eatMs = NOW - 400;
  m.moments.add(Moment::FED, NOW - 700);
  strcpy(m.speech, "600 s of life, nice");
  return m;
}

static Model lifeStarving() {
  Model m; baseFly(m);
  m.page = Page::LIFE;
  m.x = 70.f; m.y = 95.f; m.heading = -1.1f; m.speed = 1.2f; m.mode = Mode::WANDER; m.energy = 240;
  bars(m, 0.1f, 0.15f, 0.3f, 0.2f, 0.f);
  curvedTrail(m, m.x, m.y, m.heading);
  strcpy(m.speech, "so hungry...");
  m.txPending = false;
  return m;
}

static Model lifeCaught() {
  Model m; baseFly(m);
  m.page = Page::LIFE;
  m.x = 5.f; m.y = 5.f; m.heading = 3.0f; m.speed = 6.f; m.mode = Mode::FLEE; m.energy = 3000;
  m.predator = true; m.predX = m.x + 9.f; m.predY = m.y + 4.f; m.predSize = 6.f;
  m.caughtMs = NOW - 60;
  bars(m, 0.2f, 0.3f, 0.95f, 0.9f, 0.f);
  curvedTrail(m, m.x, m.y, m.heading);
  strcpy(m.speech, "ouch");
  return m;
}

static Model lifePoked() {
  Model m = lifeSurge();
  m.predator = false; m.caughtMs = 0; m.jumpMs = NOW - 120;
  m.moments.add(Moment::POKED, NOW - 200);
  m.moments.add(Moment::ANCHORED, NOW - 100);
  strcpy(m.speech, "0x8a12..9f3c poked me: shock!");
  m.txPending = false; m.status[0] = 0;
  return m;
}

// the raster from the real compass core: `ticks` steps with a cue on wedge 4 so a bump forms
static flycore::Circuit s_circuit;
static void fillFromCore(Model& m, int ticks) {
  TEST_ASSERT_TRUE(s_circuit.load(CIRCUIT_TABLE, CIRCUIT_TABLE_LEN));
  static flycore::Core core(s_circuit, PARAMS_V2);
  core.reset();
  m.nNeurons = s_circuit.N;
  for (int i = 0; i < s_circuit.N; ++i) { m.neuronType[i] = s_circuit.type[i]; m.neuronWedge[i] = s_circuit.wedge[i]; }
  m.buildRows();
  m.raster.clear();
  float hx = 0, hy = 0;
  for (int t = 0; t < ticks; ++t) {
    if (t % 120 == 0) core.stimulate(flycore::CH_CUE, (uint8_t)((4 + t / 120 * 3) & 15), 8);
    flycore::TickResult r = core.tick(1);
    uint32_t words[RASTER_WORDS] = {0};
    for (int i = 0; i < s_circuit.N; ++i) if (core.lastSpk[i]) words[i >> 5] |= 1u << (i & 31);
    m.raster.push(words);
    hx = hx * 0.75f + r.headX * 0.25f; hy = hy * 0.75f + r.headY * 0.25f;
  }
  m.headX = hx; m.headY = hy;
  float mag = sqrtf(hx * hx + hy * hy) / (float)PARAMS_V2.walkThreshold; m.headMag = mag > 1 ? 1 : mag;
  m.localHeadingDeg = (hx == 0 && hy == 0) ? -1 : ((int)lroundf(atan2f(hy, hx) * 57.2957795f) % 360 + 360) % 360;
  // wedge activity like src/replica.cpp computeActivity(): mean v+inp over the wedge's EPG cells, normalised, squared
  float sum[WEDGES] = {0}; int cnt[WEDGES] = {0};
  for (int i = 0; i < s_circuit.N; ++i) if (s_circuit.type[i] <= flycore::T_EPGT && s_circuit.wedge[i] != flycore::NO_WEDGE) { sum[s_circuit.wedge[i]] += (float)core.v[i] + (float)core.inp[i]; cnt[s_circuit.wedge[i]]++; }
  float lo = 1e30f, hi = -1e30f, mean[WEDGES];
  for (int w = 0; w < WEDGES; ++w) { mean[w] = cnt[w] ? sum[w] / cnt[w] : 0; if (cnt[w]) { if (mean[w] < lo) lo = mean[w]; if (mean[w] > hi) hi = mean[w]; } }
  for (int w = 0; w < WEDGES; ++w) { float a = (hi - lo > 80 && cnt[w]) ? (mean[w] - lo) / (hi - lo) : 0; m.wedgeAct[w] = a * a; }
  m.step = core.step; m.spikesPerS = (uint32_t)(core.totalSpikes * 14 / (core.step ? core.step : 1));
}

// a neighbour pebble found by the BLE scan: the hand-off prompt (C confirms, A / B cancel: src/main.cpp)
static Model lifeHandoff() {
  Model m = lifeSurge();
  m.predator = false; m.txPending = false;
  m.candidate = true; strcpy(m.neighbourShort, "9f3c");
  strcpy(m.status, "neighbour Pebble 9f3c (-48 dBm): press C to hand off"); m.statusAgeMs = 800;
  return m;
}

static Model neurons() {
  Model m; baseFly(m);
  m.page = Page::NEURONS;
  fillFromCore(m, 400);
  m.chainHeadingDeg = 210; if (m.localHeadingDeg < 0) m.localHeadingDeg = 212;
  m.hostFresh = false; m.hostOffline = false;
  snprintf(m.speech, sizeof m.speech, "anchored my neurons on-chain %c block 122,097,417", DOT_CH);
  strcpy(m.status, "anchored at block 122097417: on-chain heading 210 deg, 16 steps"); m.statusAgeMs = 3000;
  return m;
}

// the page the device shows by itself when the brain host's frames go stale: the red tag under the legend
static Model neuronsOffline() {
  Model m = neurons();
  m.hostOffline = true; m.hostConnected = false;
  strcpy(m.speech, "my brain host is away; my compass still works");
  return m;
}

static Model waiting() {
  Model m; baseFly(m);
  m.page = Page::WAITING;
  m.hasFly = false; m.flyId = 0; m.flyName[0] = 0; m.flyTokens = true; m.anchored = false;
  strcpy(m.speech, "waiting for a fly...");
  strcpy(m.status, "registered as Pebble 8a1f"); m.statusAgeMs = 2000;
  return m;
}

// a fly assigned to this pebble, the accept tx in flight: the egg's crack
static Model waitingAssigned() {
  Model m = waiting();
  m.assignmentPending = true; m.txPending = true; m.flyTokens = false;
  strcpy(m.status, "accepting the fly... tx 0x7c3e91a2"); m.statusAgeMs = 1200;
  return m;
}

static Model dead() {
  Model m; baseFly(m);
  m.page = Page::DEAD;
  m.alive = false; m.energy = 0; m.deadBlock = 122101880; m.x = 3.f; m.y = -2.f; m.heading = 1.9f;
  curvedTrail(m, m.x, m.y, m.heading);
  m.nfood = 1; m.food[0] = {m.x + 25.f, m.y + 10.f, 0.3f, 120, 2};
  strcpy(m.speech, "resurrect me?");
  return m;
}

static Model hatching() {
  Model m; baseFly(m);
  m.page = Page::HATCHING;
  m.hatchMs = NOW - 750;
  strcpy(m.speech, "hello, world");
  return m;
}

static Model feedHint() {
  Model m = lifeSurge();
  m.page = Page::FEED_HINT;
  strcpy(m.speech, "feed me?");
  m.status[0] = 0;
  return m;
}

// ---------------------------------------------------------------- render + check one page

// renders, checks and saves one page; with `keep` the painter is handed back (for pixel checks) instead of deleted
static long renderPage(const Model& m, const char* name, long minPixels, RasterPainter** keep = nullptr) {
  RasterPainter* p = new RasterPainter();
  clock_t t0 = clock();
  drawScreen(*p, m);
  double ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  long painted = p->nonBackground();
  char msg[200];
  snprintf(msg, sizeof msg, "%s: %ld pixels outside the buffer (first at %d,%d)", name, p->outside, p->firstOutX, p->firstOutY);
  TEST_ASSERT_EQUAL_MESSAGE(0, p->outside, msg);
  snprintf(msg, sizeof msg, "%s: only %ld non-background pixels", name, painted);
  TEST_ASSERT_TRUE_MESSAGE(painted > minPixels, msg);
  snprintf(msg, sizeof msg, "%s: %ld bytes outside printable ASCII reached the painter (the device would draw boxes or wrong glyphs)", name, p->badBytes);
  TEST_ASSERT_EQUAL_MESSAGE(0, p->badBytes, msg);
  save(*p, name);
  printf("  %-16s %6ld px painted, %5ld primitive calls, %.2f ms\n", name, painted, p->calls, ms);
  long calls = p->calls;
  if (keep) *keep = p; else delete p;
  return calls;
}

// pixels of colour c inside the box (x0..x1, y0..y1 inclusive)
static long countColor(const RasterPainter& p, Color c, int x0, int y0, int x1, int y1) {
  uint8_t want[3]; RasterPainter::rgb(c, want);
  long n = 0;
  for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) if (!memcmp(p.px[y][x], want, 3)) n++;
  return n;
}

static void test_life_surge() { renderPage(lifeSurge(), "life_surge", 2000); }
static void test_life_eating() { renderPage(lifeEating(), "life_eating", 2000); }
static void test_life_starving() { renderPage(lifeStarving(), "life_starving", 2000); }
static void test_life_caught() { renderPage(lifeCaught(), "life_caught", 2000); }
static void test_life_poked() { renderPage(lifePoked(), "life_poked", 2000); }
static void test_neurons() { renderPage(neurons(), "neurons", 2000); }
static void test_waiting() { renderPage(waiting(), "waiting", 2000); }

// the hand-off prompt names the button that confirms (C, src/main.cpp), and it is drawn in the column
static void test_life_handoff() {
  RasterPainter* p = nullptr;
  Model m = lifeHandoff();
  renderPage(m, "life_handoff", 2000, &p);
  // the prompt's row is the last of the column: amber pixels there, and "C: hand to 9f3c" starts with the C glyph
  long amber = countColor(*p, col::AMBER, LIFE_COL_X, 190, LIFE_COL_X + LIFE_COL_W - 1, STRIP_Y - 1);
  TEST_ASSERT_TRUE_MESSAGE(amber > 40, "no hand-off prompt in the Life column");
  // the same page without a candidate draws nothing amber on that row
  m.candidate = false; m.status[0] = 0;
  RasterPainter* q = new RasterPainter();
  drawScreen(*q, m);
  TEST_ASSERT_EQUAL(0, countColor(*q, col::AMBER, LIFE_COL_X, 199, LIFE_COL_X + LIFE_COL_W - 1, STRIP_Y - 1));
  delete p; delete q;
}

// the "brain host offline" tag never sits on the legend's row (it used to start on top of "D7")
static void test_neurons_offline() {
  RasterPainter* p = nullptr;
  Model m = neuronsOffline();
  renderPage(m, "neurons_offline", 2000, &p);
  int legendY = RASTER_Y + m.rasterRows + 6 + 11;   // pages.cpp drawNeurons: caption, then the legend 11 px lower
  // the legend row: red only in the PEN swatch (x < 100), never to its right where "D7" and the tag would collide
  TEST_ASSERT_EQUAL_MESSAGE(0, countColor(*p, col::RED, 100, legendY, RASTER_COLS - 1, legendY + 7), "red text on the legend row");
  // the tag is there, on the next row, right-aligned in the raster panel
  TEST_ASSERT_TRUE_MESSAGE(countColor(*p, col::RED, 100, legendY + 11, RASTER_COLS - 1, legendY + 18) > 100, "no 'brain host offline' tag under the legend");
  // and the D7 legend entry (ice text at x 110..121) is intact
  TEST_ASSERT_TRUE(countColor(*p, col::DIM, 110, legendY, 121, legendY + 7) > 10);
  delete p;
}

// an assignment in flight: the egg shows its crack (amber pixels on the egg) and the page says so
static void test_waiting_assigned() {
  RasterPainter* plain = nullptr; RasterPainter* assigned = nullptr;
  renderPage(waiting(), "waiting", 2000, &plain);
  renderPage(waitingAssigned(), "waiting_assigned", 2000, &assigned);
  // the caption under the egg turns amber ("a fly is on its way")
  long amberPlain = countColor(*plain, col::AMBER, 40, 146, 160, 156), amberAssigned = countColor(*assigned, col::AMBER, 40, 146, 160, 156);
  TEST_ASSERT_TRUE_MESSAGE(amberAssigned > amberPlain, "the assignment caption is not amber");
  // the egg is drawn at (100, 96) scale 2 (both renders share the animation clock): the crack is dark (col::BG)
  // lines inside the pale shell, so the two eggs differ in a few pixels, and the assigned one has more ground
  // colour inside the shell
  long diff = 0;
  for (int y = 60; y <= 132; ++y) for (int x = 60; x <= 140; ++x) if (memcmp(plain->px[y][x], assigned->px[y][x], 3)) diff++;
  TEST_ASSERT_TRUE_MESSAGE(diff > 4, "the pending assignment leaves the egg unchanged (no crack)");
  TEST_ASSERT_TRUE(countColor(*assigned, col::BG, 80, 66, 120, 126) > countColor(*plain, col::BG, 80, 66, 120, 126));
  delete plain; delete assigned;
}
static void test_dead() { renderPage(dead(), "dead", 2000); }
static void test_hatching() { renderPage(hatching(), "hatching", 2000); }
static void test_feed_hint() { renderPage(feedHint(), "feedhint", 2000); }

// a Life frame stays cheap: well under 30 ms of primitive calls on the device means a few thousand calls at most
static void test_life_frame_budget() {
  long calls = renderPage(lifeSurge(), "life_surge", 2000);
  TEST_ASSERT_TRUE_MESSAGE(calls < 6000, "a Life frame makes too many primitive calls");
}

// the fly at every state, in a grid (creature review sheet)
static void test_creature_sheet() {
  RasterPainter* p = new RasterPainter();
  static const FlyState states[12] = {FlyState::IDLE, FlyState::WALKING, FlyState::SMELLING, FlyState::SURGING, FlyState::CASTING, FlyState::EATING, FlyState::JUMP, FlyState::FLEEING, FlyState::CAUGHT, FlyState::DEAD, FlyState::HATCHING, FlyState::WALKING};
  static const char* names[12] = {"idle", "walking", "smelling", "surging", "casting", "eating", "jump", "fleeing", "caught", "dead", "hatching", "starving"};
  for (int i = 0; i < 12; ++i) {
    FlyPose pose;
    pose.cx = 44 + (i % 4) * 76; pose.cy = 62 + (i / 4) * 64; pose.heading = 1.5707f; pose.scale = 1.6f; pose.state = states[i]; pose.t = NOW + i * 37; pose.stateMs = 150;
    pose.starving = i == 11; pose.hasPlume = true; pose.plumeRad = 2.4f;
    drawFly(*p, pose);
    p->drawText(pose.cx, pose.cy + 30, names[i], F_SMALL, col::DIM, A_CENTER);
  }
  drawEgg(*p, 292, 204, 0.9f, NOW, 0.5f);
  char msg[80]; snprintf(msg, sizeof msg, "creature sheet: %ld pixels outside (first at %d,%d)", p->outside, p->firstOutX, p->firstOutY);
  TEST_ASSERT_EQUAL_MESSAGE(0, p->outside, msg);
  TEST_ASSERT_TRUE(p->nonBackground() > 2000);
  save(*p, "creature_sheet");
  delete p;
}

// 400 raster columns pushed and redrawn: under 20 ms natively
static void test_raster_scroll_speed() {
  Model* m = new Model();
  fillFromCore(*m, 400);                       // 400 real columns of the compass core
  static uint32_t cols[400][RASTER_WORDS];
  long spikes = 0;
  for (int k = 0; k < 400; ++k) { memcpy(cols[k], m->raster.column(k < RASTER_COLS ? k : RASTER_COLS - 1), sizeof cols[k]); spikes += m->raster.spikesIn(k < RASTER_COLS ? k : RASTER_COLS - 1); }
  m->raster.clear();
  RasterPainter* p = new RasterPainter();
  Color rowColor[RASTER_ROWS];
  for (int i = 0; i < RASTER_ROWS; ++i) rowColor[i] = col::AMBER;
  clock_t t0 = clock();
  for (int k = 0; k < 400; ++k) {
    m->raster.push(cols[k]);
    p->drawRaster(RASTER_X, RASTER_Y, m->raster, m->rowY, rowColor);   // a full redraw every column (the worst case)
  }
  double ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  printf("  400 raster columns pushed + fully redrawn: %.2f ms, %ld pixel writes (%.1f spikes per column)\n", ms, p->pixels, (double)spikes / 400.0);
  TEST_ASSERT_EQUAL(0, p->outside);
  TEST_ASSERT_EQUAL(RASTER_COLS, m->raster.count);
  TEST_ASSERT_EQUAL(400, m->raster.pushed);
  TEST_ASSERT_TRUE_MESSAGE(ms < 20.0, "400 raster columns took 20 ms or more");
  delete p; delete m;
}

// the raster ring: order and bits
static void test_raster_ring() {
  Raster r; r.clear();
  uint32_t w[RASTER_WORDS];
  for (int k = 0; k < RASTER_COLS + 5; ++k) { memset(w, 0, sizeof w); w[(k % RASTER_ROWS) >> 5] = 1u << ((k % RASTER_ROWS) & 31); r.push(w); }
  TEST_ASSERT_EQUAL(RASTER_COLS, r.count);
  TEST_ASSERT_EQUAL(RASTER_COLS + 5, r.pushed);
  // the oldest kept column is push #5, the newest is #224
  TEST_ASSERT_TRUE(r.get(0, 5 % RASTER_ROWS));
  TEST_ASSERT_TRUE(r.get(RASTER_COLS - 1, (RASTER_COLS + 4) % RASTER_ROWS));
  TEST_ASSERT_EQUAL(1, r.spikesIn(3));
  Model m; m.nNeurons = 155;
  for (int i = 0; i < 155; ++i) m.neuronType[i] = i < 47 ? 0 : i < 51 ? 1 : i < 71 ? 2 : i < 91 ? 3 : i < 113 ? 4 : 5;
  m.buildRows();
  TEST_ASSERT_EQUAL(160, m.rasterRows);   // 155 rows + 5 gaps
  TEST_ASSERT_EQUAL(0, m.rowY[0]); TEST_ASSERT_EQUAL(46, m.rowY[46]); TEST_ASSERT_EQUAL(48, m.rowY[47]); TEST_ASSERT_EQUAL(159, m.rowY[154]);
}

// speech: newest wins, each line held >= 2.5 s
static void test_speech_rules() {
  Speech sp; SpeechInput in; in.hasFly = true; in.alive = true; in.energy = 4000; in.mode = Mode::WANDER;
  sp.update(1000, in);
  TEST_ASSERT_EQUAL_STRING("just walking", sp.line());
  in.mode = Mode::SURGE; sp.update(1100, in);
  TEST_ASSERT_EQUAL_STRING("just walking", sp.line());     // held: 2.5 s not over
  sp.update(3600, in);
  TEST_ASSERT_EQUAL_STRING("I smell something...", sp.line());
  in.foodNear = true; sp.update(3700, in);
  in.jumpSeq++; sp.update(3800, in);                        // newest wins: "jumped!" replaces the pending "there!"
  sp.update(6200, in);
  TEST_ASSERT_EQUAL_STRING("jumped!", sp.line());
  in.mode = Mode::CAST; sp.update(8800, in);
  TEST_ASSERT_EQUAL_STRING("where did it go?", sp.line());
  in.fedSeq++; in.fedSecs = 600; strcpy(in.fedBy, "0x8a12.."); sp.update(11400, in);
  TEST_ASSERT_EQUAL_STRING("fed 600 s by 0x8a12.. thanks", sp.line());
  in.anchorSeq++; in.anchorBlock = 122097417ULL; sp.update(14000, in);
  { char want[64]; snprintf(want, sizeof want, "anchored my neurons on-chain %c block 122,097,417", DOT_CH); TEST_ASSERT_EQUAL_STRING(want, sp.line()); }
  in.energy = 200; sp.update(16600, in);
  TEST_ASSERT_EQUAL_STRING("so hungry...", sp.line());
  in.hostOffline = true; sp.update(19200, in);
  TEST_ASSERT_EQUAL_STRING("my brain host is away; my compass still works", sp.line());
  in.pokeSeq++; strcpy(in.pokeBy, "0x8a12..9f3c"); in.pokeChannel = POKE_SHOCK; sp.update(21800, in);
  TEST_ASSERT_EQUAL_STRING("0x8a12..9f3c poked me: shock!", sp.line());
  in.pokeSeq++; in.pokeChannel = POKE_CUE; in.pokeParam = 4; sp.update(24400, in);
  TEST_ASSERT_EQUAL_STRING("0x8a12..9f3c poked me: a cue on wedge 4", sp.line());
  in.pokeSeq++; in.pokeChannel = POKE_TURN_LEFT; in.pokeBy[0] = 0; sp.update(27000, in);
  TEST_ASSERT_EQUAL_STRING("someone poked me: turn left!", sp.line());
  in.caughtSeq++; sp.update(29600, in);
  TEST_ASSERT_EQUAL_STRING("ouch", sp.line());
  Speech egg; SpeechInput none; egg.update(5, none);
  TEST_ASSERT_EQUAL_STRING("waiting for a fly...", egg.line());
  SpeechInput deadIn; deadIn.hasFly = true; deadIn.alive = false; Speech d; d.update(5, deadIn);
  TEST_ASSERT_EQUAL_STRING("resurrect me?", d.line());
}

// the fly state derivation follows UI.md's triggers
static void test_fly_states() {
  Model m; baseFly(m); m.mode = Mode::WANDER; m.speed = 0.f;
  TEST_ASSERT_EQUAL((int)FlyState::IDLE, (int)flyStateOf(m));
  m.speed = 2.f; TEST_ASSERT_EQUAL((int)FlyState::WALKING, (int)flyStateOf(m));
  m.smell = 0.6f; TEST_ASSERT_EQUAL((int)FlyState::SMELLING, (int)flyStateOf(m));
  m.mode = Mode::SURGE; TEST_ASSERT_EQUAL((int)FlyState::SURGING, (int)flyStateOf(m));
  m.mode = Mode::CAST; TEST_ASSERT_EQUAL((int)FlyState::CASTING, (int)flyStateOf(m));
  m.taste = 0.9f; TEST_ASSERT_EQUAL((int)FlyState::EATING, (int)flyStateOf(m));
  m.predator = true; m.predX = m.x + 30; m.predY = m.y; TEST_ASSERT_EQUAL((int)FlyState::FLEEING, (int)flyStateOf(m));
  m.jumpMs = NOW - 100; TEST_ASSERT_EQUAL((int)FlyState::JUMP, (int)flyStateOf(m));
  m.caughtMs = NOW - 100; TEST_ASSERT_EQUAL((int)FlyState::CAUGHT, (int)flyStateOf(m));
  m.alive = false; TEST_ASSERT_EQUAL((int)FlyState::DEAD, (int)flyStateOf(m));
  m.hatchMs = NOW - 500; TEST_ASSERT_EQUAL((int)FlyState::HATCHING, (int)flyStateOf(m));
  m.hasFly = false; TEST_ASSERT_EQUAL((int)FlyState::EGG, (int)flyStateOf(m));
  TEST_ASSERT_EQUAL_STRING("following a scent", bigWordFor(FlyState::SURGING));
  char b[24]; fmtHms(4920, b, sizeof b); TEST_ASSERT_EQUAL_STRING("1h22m", b);
  fmtThousands(122097417ULL, b, sizeof b); TEST_ASSERT_EQUAL_STRING("122,097,417", b);
  TEST_ASSERT_EQUAL_STRING("hungry", hungerWord(600));
}

// the pages' text: the middle dot and the degree sign are drawn, never asked of the painter; other bytes outside
// printable ASCII become '?'; and a raw non-ASCII byte handed straight to a painter is caught by the guard
static void test_label_glyphs() {
  RasterPainter* p = new RasterPainter();
  char s[32];
  snprintf(s, sizeof s, "alive %c gen 1", DOT_CH);
  TEST_ASSERT_EQUAL(p->textWidth("alive ", F_SMALL) + 3 + p->textWidth(" gen 1", F_SMALL), labelWidth(*p, s, F_SMALL));
  drawLabel(*p, 10, 10, s, F_SMALL, col::INK, A_LEFT);
  TEST_ASSERT_EQUAL(0, p->badBytes);
  // the dot: a 2 x 2 block at the middle of the x-height, right after "alive " (6 cells of 6 px)
  uint8_t ink[3]; RasterPainter::rgb(col::INK, ink);
  TEST_ASSERT_EQUAL_MEMORY(ink, p->px[13][46], 3); TEST_ASSERT_EQUAL_MEMORY(ink, p->px[14][47], 3);
  snprintf(s, sizeof s, "chain 210%c", DEG_CH);
  TEST_ASSERT_EQUAL(p->textWidth("chain 210", F_SMALL) + 5, labelWidth(*p, s, F_SMALL));
  long before = p->pixels;
  drawLabel(*p, 10, 40, s, F_SMALL, col::ICE, A_LEFT);
  TEST_ASSERT_TRUE(p->pixels - before > 8);   // the digits plus the ring (8 px)
  snprintf(s, sizeof s, "on-chain %c block 12", DOT_CH);
  drawLabel(*p, 160, 100, s, F_MED, col::INK, A_CENTER);
  drawLabel(*p, 300, 140, s, F_BIG, col::AMBER, A_RIGHT);
  TEST_ASSERT_EQUAL(0, p->badBytes);
  TEST_ASSERT_EQUAL(0, p->outside);
  // a UTF-8 name from the chain is shown with '?' (not with the device's boxes / wrong glyphs)
  drawLabel(*p, 10, 60, "Bj\xc3\xb6rn", F_MED, col::INK, A_LEFT);
  TEST_ASSERT_EQUAL(0, p->badBytes);
  TEST_ASSERT_EQUAL(p->textWidth("Bj??rn", F_MED), labelWidth(*p, "Bj\xc3\xb6rn", F_MED));
  // the guard: the same bytes straight to the painter are what the device would mis-draw
  p->drawText(10, 80, "x\xfa", F_SMALL, col::INK, A_LEFT);
  TEST_ASSERT_EQUAL(1, p->badBytes);
  delete p;
}

// the moments queue expires after 2 s and keeps the newest four
static void test_moments() {
  MomentQ q; q.clear();
  q.add(Moment::FED, 1000); q.add(Moment::POKED, 1500);
  TEST_ASSERT_EQUAL(500, q.age(Moment::FED, 1500));
  TEST_ASSERT_EQUAL(-1, q.age(Moment::ANCHORED, 1500));
  q.expire(3100);
  TEST_ASSERT_EQUAL(-1, q.age(Moment::FED, 3100));
  TEST_ASSERT_EQUAL(1600, q.age(Moment::POKED, 3100));
  for (int i = 0; i < 6; ++i) q.add(Moment::ANCHORED, 4000 + i);
  TEST_ASSERT_EQUAL(MAX_MOMENTS, q.n);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_raster_ring);
  RUN_TEST(test_speech_rules);
  RUN_TEST(test_fly_states);
  RUN_TEST(test_moments);
  RUN_TEST(test_label_glyphs);
  RUN_TEST(test_life_surge);
  RUN_TEST(test_life_eating);
  RUN_TEST(test_life_starving);
  RUN_TEST(test_life_caught);
  RUN_TEST(test_life_poked);
  RUN_TEST(test_life_handoff);
  RUN_TEST(test_neurons);
  RUN_TEST(test_neurons_offline);
  RUN_TEST(test_waiting);
  RUN_TEST(test_waiting_assigned);
  RUN_TEST(test_dead);
  RUN_TEST(test_hatching);
  RUN_TEST(test_feed_hint);
  RUN_TEST(test_creature_sheet);
  RUN_TEST(test_life_frame_budget);
  RUN_TEST(test_raster_scroll_speed);
  return UNITY_END();
}
