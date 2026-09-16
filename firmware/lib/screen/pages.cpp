#include "pages.h"
#include "creature.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace screen {

namespace {

constexpr float PI_F = 3.14159265f;
constexpr char DOT = DOT_CH, DEG = DEG_CH;   // drawn by drawLabel (model.h)

inline uint32_t hash32(uint32_t x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }
inline float frac(float v) { return v - floorf(v); }
inline int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

// uppercase copy
void upper(const char* s, char* out, int cap) {
  int i = 0;
  for (; s[i] && i < cap - 1; ++i) out[i] = (s[i] >= 'a' && s[i] <= 'z') ? (char)(s[i] - 32) : s[i];
  out[i] = 0;
}

// ---- text. Every string a page draws goes through drawLabel / labelWidth: the runs of printable ASCII go to the
//      Painter, DOT_CH and DEG_CH (model.h) are drawn here as primitives sized for the font, and any other byte
//      outside 32..126 shows as '?'. So the Painter only ever sees glyphs both backends have (UI.md: M5GFX
//      built-ins only, everything else is drawn), and the dot and the degree sign look the same on the device and
//      in the native renders.
inline bool plainAscii(unsigned char ch) { return ch >= 32 && ch <= 126; }
inline int dotAdvance(Font f) { return f == F_BIG ? 5 : 3; }
inline int degAdvance(Font f) { return f == F_SMALL ? 5 : f == F_MED ? 6 : 8; }
void ring(Painter& p, int x, int y, int s, Color c) {   // an s x s ring with its corners cut: a small circle
  p.fillRect(x + 1, y, s - 2, 1, c); p.fillRect(x + 1, y + s - 1, s - 2, 1, c);
  p.fillRect(x, y + 1, 1, s - 2, c); p.fillRect(x + s - 1, y + 1, 1, s - 2, c);
}
void dotGlyph(Painter& p, int x, int y, Font f, Color c) {   // 2 x 2 at the middle of the x-height (3 x 3 in the big font)
  if (f == F_SMALL) p.fillRect(x, y + 3, 2, 2, c);
  else if (f == F_MED) p.fillRect(x, y + 8, 2, 2, c);
  else p.fillRect(x, y + 11, 3, 3, c);
}
void degGlyph(Painter& p, int x, int y, Font f, Color c) {   // a ring at the top of the digits
  if (f == F_SMALL) ring(p, x, y, 4, c);
  else if (f == F_MED) ring(p, x, y + 3, 5, c);
  else ring(p, x, y + 2, 6, c);
}

// walks `s`: `run` gets the ASCII runs, `glyph` the drawn glyphs; both advance x
template <typename Run, typename Glyph>
void walkLabel(const char* s, Run run, Glyph glyph) {
  char b[128]; int n = 0;
  for (const unsigned char* q = (const unsigned char*)s; *q; ++q) {
    if (*q == (unsigned char)DOT_CH || *q == (unsigned char)DEG_CH) {
      if (n) { b[n] = 0; run(b); n = 0; }
      glyph((char)*q);
    } else {
      if (n == (int)sizeof b - 1) { b[n] = 0; run(b); n = 0; }
      b[n++] = plainAscii(*q) ? (char)*q : '?';
    }
  }
  if (n) { b[n] = 0; run(b); }
}

}  // namespace

int labelWidth(Painter& p, const char* s, Font f) {
  int w = 0;
  walkLabel(s, [&](const char* run) { w += p.textWidth(run, f); }, [&](char g) { w += g == DOT_CH ? dotAdvance(f) : degAdvance(f); });
  return w;
}

void drawLabel(Painter& p, int x, int y, const char* s, Font f, Color c, Align a) {
  bool plain = true;
  for (const unsigned char* q = (const unsigned char*)s; *q; ++q) if (!plainAscii(*q)) { plain = false; break; }
  if (plain) { p.drawText(x, y, s, f, c, a); return; }
  if (a != A_LEFT) { int w = labelWidth(p, s, f); x -= a == A_CENTER ? w / 2 : w; }
  walkLabel(s, [&](const char* run) { p.drawText(x, y, run, f, c, A_LEFT); x += p.textWidth(run, f); },
            [&](char g) { if (g == DOT_CH) { dotGlyph(p, x, y, f, c); x += dotAdvance(f); } else { degGlyph(p, x, y, f, c); x += degAdvance(f); } });
}

namespace {

// ---- the one big word: wrapped into lines that fit `w`, in the big font when every line fits, else the medium one.
//      Returns the y below the last line.
int bigWord(Painter& p, int x, int y, int w, const char* text, Color c) {
  char up[40]; upper(text, up, sizeof up);
  for (int attempt = 0; attempt < 2; ++attempt) {
    Font f = attempt == 0 ? F_BIG : F_MED;
    // greedy wrap; fail when one word alone is wider than w
    char line[48] = ""; int yy = y; bool fail = false;
    const char* s = up;
    while (*s) {
      while (*s == ' ') s++;
      const char* e = s; while (*e && *e != ' ') e++;
      char word[40]; int wl = (int)(e - s); if (wl > 39) wl = 39; memcpy(word, s, wl); word[wl] = 0;
      if (labelWidth(p, word, f) > w) { fail = true; break; }
      char trial[96];
      if (line[0]) snprintf(trial, sizeof trial, "%s %s", line, word); else snprintf(trial, sizeof trial, "%s", word);
      if (labelWidth(p, trial, f) <= w) { strncpy(line, trial, sizeof line - 1); line[sizeof line - 1] = 0; }
      else { drawLabel(p, x, yy, line, f, c, A_LEFT); yy += FONT_H[f] + 1; strncpy(line, word, sizeof line - 1); line[sizeof line - 1] = 0; }
      s = e;
    }
    if (fail && attempt == 0) continue;
    if (line[0]) { drawLabel(p, x, yy, line, f, c, A_LEFT); yy += FONT_H[f] + 1; }
    return yy;
  }
  return y;
}

// ---- small glyphs drawn from primitives
void heart(Painter& p, int cx, int cy, int r, Color c) {   // r ~ 3..5
  p.fillCircle(cx - r / 2 - (r > 3 ? 1 : 0), cy - r / 3, r / 2 + 1, c);
  p.fillCircle(cx + r / 2 + (r > 3 ? 1 : 0), cy - r / 3, r / 2 + 1, c);
  p.fillTriangle(cx - r - 1, cy - r / 3 + 1, cx + r + 1, cy - r / 3 + 1, cx, cy + r, c);
}
void chainLink(Painter& p, int x, int y, Color c) {   // two linked ovals, 11 x 7
  p.drawRect(x, y + 1, 6, 5, c); p.drawRect(x + 5, y + 1, 6, 5, c);
  p.drawPixel(x, y + 1, col::BG); p.drawPixel(x + 10, y + 1, col::BG); p.drawPixel(x, y + 5, col::BG); p.drawPixel(x + 10, y + 5, col::BG);
}
void quoteMark(Painter& p, int x, int y, Color c) {   // a small opening quotation mark
  p.fillRect(x, y, 2, 2, c); p.fillRect(x + 4, y, 2, 2, c);
  p.drawPixel(x, y + 2, c); p.drawPixel(x + 4, y + 2, c);
}
void wifiDot(Painter& p, int x, int y, bool on, const char* label, Color onC) {
  p.fillCircle(x + 3, y + 3, 3, on ? onC : mixc(col::BG, col::DIM, 60));
  drawLabel(p, x + 9, y, label, F_SMALL, on ? col::INK : col::DIM2, A_LEFT);
}

// ---- the status line while it is fresh (tx hashes, errors), small and dim
void statusLine(Painter& p, const Model& m, int x, int y, int w) {
  if (!m.status[0] || m.statusAgeMs > 12000) return;
  textFit(p, x, y, m.status, F_SMALL, m.txPending ? col::AMBER_DIM : col::DIM, w);
}

// ---- the world panel (Life and Dead): grid, walls, trail, plumes, food, puffs, predator, the fly

void worldGrid(Painter& p, const Model& m, bool dim) {
  Color grid = dim ? mixc(col::BG, col::DIM, 22) : col::GRID;
  const float half = WORLD_BL_ACROSS * 0.5f, halfY = WORLD_H / WORLD_K * 0.5f;
  float gx0 = ceilf((m.x - half) / 10.f) * 10.f;
  for (float gx = gx0; gx <= m.x + half; gx += 10.f) { int sx = worldX(m, gx); if (sx >= 0 && sx < WORLD_W) p.fillRect(sx, 0, 1, WORLD_H, grid); }
  float gy0 = ceilf((m.y - halfY) / 10.f) * 10.f;
  for (float gy = gy0; gy <= m.y + halfY; gy += 10.f) { int sy = worldY(m, gy); if (sy >= 0 && sy < WORLD_H) p.fillRect(0, sy, WORLD_W, 1, grid); }
  // the arena wall when it is in view
  Color wall = dim ? col::DIM2 : col::DIM;
  float a = m.arena * 0.5f;
  int l = worldX(m, -a), r = worldX(m, a), t = worldY(m, a), b = worldY(m, -a);
  if (l >= 0 && l < WORLD_W) p.fillRect(l - 1, 0, 2, WORLD_H, wall);
  if (r >= 0 && r < WORLD_W) p.fillRect(r, 0, 2, WORLD_H, wall);
  if (t >= 0 && t < WORLD_H) p.fillRect(0, t - 1, WORLD_W, 2, wall);
  if (b >= 0 && b < WORLD_H) p.fillRect(0, b, WORLD_W, 2, wall);
}

void worldTrail(Painter& p, const Model& m, bool dim) {
  for (int k = 0; k < m.trailN; ++k) {
    float wx, wy; m.trail(k, wx, wy);
    int sx = worldX(m, wx), sy = worldY(m, wy);
    if (sx < 0 || sy < 0 || sx >= WORLD_W || sy >= WORLD_H) continue;
    int t = 30 + 150 * k / (m.trailN > 1 ? m.trailN - 1 : 1);
    p.drawPixel(sx, sy, mixc(col::BG, col::DIM, dim ? t / 2 : t));
  }
}

// the plume of one food: 12 amber particles seeded by the food id, drifting downwind, spreading and fading
void plume(Painter& p, const Model& m, const FoodM& f) {
  float wx = cosf(m.windRad), wy = sinf(m.windRad);
  // a faint cone downwind (three soft discs), then the particles
  for (int k = 4; k >= 1; --k) {
    int sx = worldX(m, f.x + wx * 6.5f * k), sy = worldY(m, f.y + wy * 6.5f * k);
    int r = 6 + 4 * k;
    if (sx < -r || sy < -r || sx >= WORLD_W + r || sy >= WORLD_H + r) continue;
    p.fillCircle(sx, sy, r, mixc(col::BG, col::AMBER, (int)((52 - 10 * k) * (0.5f + 0.5f * f.left))));
  }
  for (int i = 0; i < 12; ++i) {
    uint32_t h = hash32(f.id * 977u + (uint32_t)i * 7919u + 1u);
    float phase = (float)(h & 1023) / 1024.f;
    float u = frac((float)m.nowMs / 5000.f + phase);
    float dist = u * 34.f;
    float lat = sinf(u * 7.f + (float)((h >> 10) & 63)) * (1.5f + 7.f * u);
    float px = f.x + wx * dist - wy * lat, py = f.y + wy * dist + wx * lat;
    int sx = worldX(m, px), sy = worldY(m, py);
    if (sx < 0 || sy < 0 || sx >= WORLD_W - 1 || sy >= WORLD_H - 1) continue;
    int bright = (int)((1.f - u) * (130.f + 100.f * f.left));
    Color c = mixc(col::BG, col::AMBER, 40 + bright);
    if (u < 0.25f) p.fillCircle(sx, sy, 1, c);
    else if (u < 0.6f) p.fillRect(sx, sy, 2, 2, c);
    else p.drawPixel(sx, sy, c);
  }
}

void puffBurst(Painter& p, const Model& m, const PuffM& q) {
  for (int i = 0; i < 8; ++i) {
    float u = frac((float)m.nowMs / 3000.f + (float)i / 8.f);
    float a = (float)i * (PI_F / 4) + 0.6f * sinf((float)m.nowMs / 900.f + i);
    float d = 2.f + u * 12.f;
    int sx = worldX(m, q.x + cosf(a) * d), sy = worldY(m, q.y + sinf(a) * d);
    if (sx < 0 || sy < 0 || sx >= WORLD_W || sy >= WORLD_H) continue;
    p.drawPixel(sx, sy, mixc(col::BG, col::AMBER, (int)((1.f - u) * 110.f * q.strength) + 20));
  }
  int sx = worldX(m, q.x), sy = worldY(m, q.y);
  if (sx >= 0 && sy >= 0 && sx < WORLD_W && sy < WORLD_H) p.fillCircle(sx, sy, 2, mixc(col::BG, col::AMBER, 60 + (int)(80 * q.strength)));
}

bool underFly(const Model& m, const FoodM& f) { float ddx = f.x - m.x, ddy = f.y - m.y; return ddx * ddx + ddy * ddy < 5.f * 5.f; }

// a food the fly stands on is drawn after the fly, at its mouth (the fly is drawn far above the world's scale)
void foodBlob(Painter& p, const Model& m, const FoodM& f, bool dim, float zoom) {
  int sx = worldX(m, f.x), sy = worldY(m, f.y);
  if (sx < -20 || sy < -20 || sx >= WORLD_W + 20 || sy >= WORLD_H + 20) return;
  int r = 3 + (int)(4 * f.left);
  Color a = dim ? col::DIM : col::AMBER;
  if (underFly(m, f)) {
    float S = BODY_PX * zoom;
    sx = WORLD_CX + (int)lroundf(cosf(m.heading) * 0.62f * S); sy = WORLD_CY - (int)lroundf(sinf(m.heading) * 0.62f * S);
    r = 2 + (int)(3 * f.left);
  }
  p.fillCircle(sx, sy, r + 4, mixc(col::BG, a, 45));
  p.fillCircle(sx, sy, r + 1, mixc(col::BG, a, 120));
  p.fillCircle(sx, sy, r - 1 > 1 ? r - 1 : 1, a);
  if (underFly(m, f)) return;   // the big word says "eating"
  char b[16]; snprintf(b, sizeof b, "%d s", f.secs);
  int tx = sx + r + 5; if (tx + labelWidth(p, b, F_SMALL) > WORLD_W - 2) tx = sx - r - 5 - labelWidth(p, b, F_SMALL);
  int ty = clampi(sy - 4, 0, WORLD_H - 9);
  drawLabel(p, tx, ty, b, F_SMALL, dim ? col::DIM : col::AMBER, A_LEFT);
}

void predatorShadow(Painter& p, const Model& m) {
  if (!m.predator) return;
  int sx = worldX(m, m.predX), sy = worldY(m, m.predY);
  int r = (int)(m.predSize * WORLD_K * 2.f); if (r < 6) r = 6;
  if (sx < -r * 2 || sy < -r * 2 || sx >= WORLD_W + r * 2 || sy >= WORLD_H + r * 2) return;
  // a soft edge: nested discs, dim to bright
  p.fillCircle(sx, sy, r + 8, mixc(col::BG, col::ICE, 22));
  p.fillCircle(sx, sy, r + 3, mixc(col::BG, col::ICE, 40));
  p.fillCircle(sx, sy, r, mixc(col::BG, col::ICE, 70));
  p.fillCircle(sx, sy, r / 2, mixc(col::BG, col::ICE, 110));
  // two pinpoint eyes facing the fly
  float a = atan2f((float)(WORLD_CY - sy), (float)(WORLD_CX - sx));
  int ex = sx + (int)(cosf(a) * r * 0.55f), ey = sy + (int)(sinf(a) * r * 0.55f);
  int ox = (int)(-sinf(a) * r * 0.22f), oy = (int)(cosf(a) * r * 0.22f);
  p.fillCircle(ex + ox, ey + oy, 1, col::ICE); p.fillCircle(ex - ox, ey - oy, 1, col::ICE);
}

void nearestScent(const Model& m, bool& has, float& rad) {
  has = false; float best = 1e30f;
  for (int i = 0; i < m.nfood; ++i) { float dx = m.food[i].x - m.x, dy = m.food[i].y - m.y, d = dx * dx + dy * dy; if (d < best) { best = d; rad = atan2f(dy, dx); has = true; } }
  for (int i = 0; i < m.npuffs; ++i) { float dx = m.puffs[i].x - m.x, dy = m.puffs[i].y - m.y, d = dx * dx + dy * dy; if (d < best) { best = d; rad = atan2f(dy, dx); has = true; } }
}

FlyPose lifePose(const Model& m, FlyState st, float zoom) {
  FlyPose pose;
  pose.cx = WORLD_CX; pose.cy = WORLD_CY; pose.heading = m.heading; pose.scale = zoom; pose.state = st; pose.t = m.nowMs;
  pose.stateMs = st == FlyState::JUMP ? m.nowMs - m.jumpMs : st == FlyState::CAUGHT ? m.nowMs - m.caughtMs : st == FlyState::HATCHING ? m.nowMs - m.hatchMs : 0;
  pose.starving = m.alive && m.energy < 300;
  nearestScent(m, pose.hasPlume, pose.plumeRad);
  return pose;
}

void worldPanel(Painter& p, const Model& m, FlyState st, bool dim, float zoom) {
  int32_t caught = m.caughtMs ? (int32_t)(m.nowMs - m.caughtMs) : -1;
  bool flash = caught >= 0 && caught < (int32_t)CAUGHT_FLASH_MS;
  p.fillRect(0, 0, WORLD_W, WORLD_H, flash ? mixc(col::BG, col::RED, 130) : col::BG);
  p.setClip(0, 0, WORLD_W, WORLD_H);
  worldGrid(p, m, dim);
  worldTrail(p, m, dim);
  if (!dim) for (int i = 0; i < m.nfood; ++i) plume(p, m, m.food[i]);
  for (int i = 0; i < m.npuffs; ++i) puffBurst(p, m, m.puffs[i]);
  for (int i = 0; i < m.nfood; ++i) if (!underFly(m, m.food[i])) foodBlob(p, m, m.food[i], dim, zoom);
  if (!dim) predatorShadow(p, m);
  drawFly(p, lifePose(m, st, zoom));
  for (int i = 0; i < m.nfood; ++i) if (underFly(m, m.food[i])) foodBlob(p, m, m.food[i], dim, zoom);
  p.clearClip();
}

// ---- moments over the Life world
void lifeMoments(Painter& p, const Model& m) {
  int32_t fed = m.moments.age(Moment::FED, m.nowMs);
  if (fed >= 0) {
    // amber sparkles falling around the fly
    for (int i = 0; i < 14; ++i) {
      uint32_t h = hash32(i * 1234567u + 99u);
      float u = frac((float)fed / (float)MOMENT_MS + (float)(h & 255) / 256.f);
      int sx = WORLD_CX - 46 + (int)((h >> 8) % 92), sy = WORLD_CY - 50 + (int)(u * 100.f);
      Color c = mixc(col::BG, col::AMBER, 90 + (int)((1.f - u) * 160.f));
      if (i & 1) { p.fillRect(sx - 1, sy, 3, 1, c); p.fillRect(sx, sy - 1, 1, 3, c); } else p.drawPixel(sx, sy, c);
    }
  }
  int32_t anch = m.moments.age(Moment::ANCHORED, m.nowMs);
  if (anch >= 0 && anch < (int32_t)ANCHOR_FLASH_MS) { p.drawCircle(WORLD_CX, WORLD_CY, 30, col::ICE); p.drawCircle(WORLD_CX, WORLD_CY, 31, col::ICE_DIM); }
  int32_t poke = m.moments.age(Moment::POKED, m.nowMs);
  if (poke >= 0 && poke < 900) {
    // an ice bolt from the top edge to the fly, jittering
    int x = WORLD_CX + 36, y = 0;
    uint32_t j = hash32((uint32_t)(m.nowMs / 60));
    int steps = 5;
    for (int i = 1; i <= steps; ++i) {
      int nx = WORLD_CX + (36 * (steps - i)) / steps + (i < steps ? (int)((j >> (i * 4)) % 17) - 8 : 0);
      int ny = (WORLD_CY - 10) * i / steps;
      p.drawLine(x, y, nx, ny, poke < 400 ? col::ICE : col::ICE_DIM);
      p.drawLine(x + 1, y, nx + 1, ny, col::ICE_DARK);
      x = nx; y = ny;
    }
    if (poke < 250) p.drawCircle(WORLD_CX, WORLD_CY, 14 + poke / 12, col::ICE);
  }
  if (m.moments.age(Moment::STREAM_LOST, m.nowMs) >= 0 || m.hostOffline) drawLabel(p, WORLD_W - 4, 4, "host?", F_SMALL, col::RED, A_RIGHT);
}

// ---- the Life right column
void lifeColumn(Painter& p, const Model& m, FlyState st) {
  const int X = LIFE_COL_X, W = LIFE_COL_W;
  char b[64];
  int y = 4;
  snprintf(b, sizeof b, "#%llu %s", (unsigned long long)m.flyId, m.flyName[0] ? m.flyName : "fly");
  textFit(p, X, y, b, F_MED, col::INK, W); y += 18;
  p.fillCircle(X + 3, y + 3, 3, m.alive ? col::GREEN : col::RED);
  snprintf(b, sizeof b, "%s %c gen %lu", m.alive ? "alive" : "dead", DOT, (unsigned long)m.generation);
  drawLabel(p, X + 10, y, b, F_SMALL, m.alive ? col::GREEN : col::RED, A_LEFT); y += 14;
  // the one big word
  Color wc = st == FlyState::FLEEING || st == FlyState::CAUGHT ? col::ICE : st == FlyState::EATING ? col::GREEN : col::AMBER;
  if (m.alive && m.energy < 300) wc = col::DIM;
  y = bigWord(p, X, y, W, bigWordFor(st), wc);
  if (y < 98) y = 98;
  // belly: 7 segments, full at one hour, the h/m/s and the hunger word
  drawLabel(p, X, y, "belly", F_SMALL, col::DIM, A_LEFT);
  {
    int64_t e = m.energy < 0 ? 0 : m.energy;
    int filled = e >= 3600 ? 7 : (int)((e * 7 + 3599) / 3600);
    Color fc = e < 300 ? col::RED : e < 1200 ? col::AMBER : col::GREEN;
    for (int i = 0; i < 7; ++i) {
      int bx = X + 36 + i * 10;
      if (i < filled) p.fillRect(bx, y, 8, 7, fc); else p.drawRect(bx, y, 8, 7, col::DIM2);
    }
    y += 10;
    fmtHms(e, b, sizeof b);
    drawLabel(p, X, y, b, F_SMALL, col::INK, A_LEFT);
    drawLabel(p, X + W, y, hungerWord(e), F_SMALL, e < 300 ? col::RED : e < 1200 ? col::AMBER : col::DIM, A_RIGHT);
    y += 13;
  }
  // five thought bars, tiny
  struct Bar { const char* name; float v; } bars[5] = {{"smell", m.smell}, {"memory", m.memory}, {"sight", m.sight}, {"steer", m.steer}, {"taste", m.taste}};
  for (int i = 0; i < 5; ++i) {
    drawLabel(p, X, y, bars[i].name, F_SMALL, col::DIM, A_LEFT);
    float v = bars[i].v < 0 ? 0 : bars[i].v > 1 ? 1 : bars[i].v;
    int ticks = (int)(v * 5.f + 0.5f);
    for (int k = 0; k < 5; ++k) {
      int bx = X + 44 + k * 12;
      if (k < ticks) p.fillRect(bx, y + 1, 10, 6, mixc(col::AMBER_DIM, col::AMBER, 60 + k * 45)); else p.drawRect(bx, y + 1, 10, 6, col::DIM2);
    }
    y += 10;
  }
  y += 4;
  // radio dots
  wifiDot(p, X, y, m.wifi, "wifi", col::GREEN);
  wifiDot(p, X + 44, y, m.hostConnected, m.wsMode ? "ws" : "poll", col::GREEN);
  y += 12;
  // the last anchor block; the heart pulses while a tx is in flight
  if (m.anchored && m.lastAnchorBlock) {
    chainLink(p, X, y, col::ICE);
    fmtThousands(m.lastAnchorBlock, b, sizeof b);
    drawLabel(p, X + 14, y, b, F_SMALL, col::ICE, A_LEFT);
  } else if (!m.coreEnabled) drawLabel(p, X, y, "core: not deployed", F_SMALL, col::DIM, A_LEFT);
  else drawLabel(p, X, y, "no anchor yet", F_SMALL, col::DIM, A_LEFT);
  if (m.txPending) {
    float pulse = 0.5f + 0.5f * sinf(2 * PI_F * (float)(m.nowMs % 900) / 900.f);
    heart(p, X + W - 6, y + 3, 3 + (pulse > 0.5f ? 1 : 0), mixc(col::RED_DARK, col::RED, (int)(pulse * 255)));
  }
  y += 12;
  // the hand-off prompt: C confirms, A or B cancels (src/main.cpp handleButtons; README "Buttons")
  if (m.candidate) { snprintf(b, sizeof b, "C: hand to %s", m.neighbourShort); textFit(p, X, y, b, F_SMALL, col::AMBER, W); }
  else if (m.scanning) drawLabel(p, X, y, "scanning BLE...", F_SMALL, col::ICE, A_LEFT);
}

// ---- the Neurons page's halo: 16 wedges around the head, glowing by EPG activity
void halo(Painter& p, const Model& m, int cx, int cy, int r0, int r1, bool flash) {
  int16_t pts[10];
  for (int w = 0; w < WEDGES; ++w) {
    float a0 = ((float)w * 22.5f + 1.2f) * (PI_F / 180.f), a1 = ((float)(w + 1) * 22.5f - 1.2f) * (PI_F / 180.f), am = (a0 + a1) * 0.5f;
    float a = m.wedgeAct[w]; if (a < 0) a = 0; if (a > 1) a = 1;
    Color c;
    if (flash) c = mixc(col::ICE_DIM, col::ICE, (int)(a * 255));
    else if (a > 0.55f) c = mixc(col::AMBER, col::RED, (int)((a - 0.55f) * 2.2f * 255));
    else c = mixc(mixc(col::BG, col::AMBER, 28), col::AMBER, (int)(a / 0.55f * 255));
    pts[0] = (int16_t)(cx + (int)lroundf(cosf(a0) * r0)); pts[1] = (int16_t)(cy - (int)lroundf(sinf(a0) * r0));
    pts[2] = (int16_t)(cx + (int)lroundf(cosf(a0) * r1)); pts[3] = (int16_t)(cy - (int)lroundf(sinf(a0) * r1));
    pts[4] = (int16_t)(cx + (int)lroundf(cosf(am) * (r1 + 1))); pts[5] = (int16_t)(cy - (int)lroundf(sinf(am) * (r1 + 1)));
    pts[6] = (int16_t)(cx + (int)lroundf(cosf(a1) * r1)); pts[7] = (int16_t)(cy - (int)lroundf(sinf(a1) * r1));
    pts[8] = (int16_t)(cx + (int)lroundf(cosf(a1) * r0)); pts[9] = (int16_t)(cy - (int)lroundf(sinf(a1) * r0));
    p.fillPoly(pts, 5, c);
  }
}

void needle(Painter& p, int cx, int cy, float rad, int r0, int r1, Color c, bool thick) {
  float cs = cosf(rad), sn = sinf(rad);
  int x0 = cx + (int)lroundf(cs * r0), y0 = cy - (int)lroundf(sn * r0), x1 = cx + (int)lroundf(cs * r1), y1 = cy - (int)lroundf(sn * r1);
  if (thick) {
    int px = (int)lroundf(-sn * 3), py = (int)lroundf(-cs * 3);
    p.fillTriangle(x0 + px, y0 + py, x0 - px, y0 - py, x1, y1, c);
  } else p.drawLine(x0, y0, x1, y1, c);
}

void neuronsColumn(Painter& p, const Model& m) {
  const int cx = NEURONS_COL_X + NEURONS_COL_W / 2, cy = 62;
  bool flash = m.moments.age(Moment::ANCHORED, m.nowMs) >= 0 && m.moments.age(Moment::ANCHORED, m.nowMs) < (int32_t)ANCHOR_FLASH_MS;
  halo(p, m, cx, cy, 24, 40, flash);
  float heading = (m.headX != 0 || m.headY != 0) ? atan2f(m.headY, m.headX) : PI_F / 2;
  drawFlyHead(p, cx, cy, 11, heading, m.nowMs);
  if (m.localHeadingDeg >= 0) needle(p, cx, cy, heading, 41, 50 + (int)(6 * m.headMag), col::INK, true);
  if (m.chainHeadingDeg >= 0) needle(p, cx, cy, (float)m.chainHeadingDeg * (PI_F / 180.f), 41, 54, col::ICE, false);
  char b[40];
  int y = 118;
  if (m.chainHeadingDeg >= 0) snprintf(b, sizeof b, "chain %d%c", m.chainHeadingDeg, DEG); else snprintf(b, sizeof b, "chain --");
  drawLabel(p, NEURONS_COL_X, y, b, F_SMALL, col::ICE, A_LEFT); y += 11;
  if (m.localHeadingDeg >= 0) snprintf(b, sizeof b, "local %d%c", m.localHeadingDeg, DEG); else snprintf(b, sizeof b, "local --");
  drawLabel(p, NEURONS_COL_X, y, b, F_SMALL, col::INK, A_LEFT); y += 11;
  snprintf(b, sizeof b, "FlyCore #%llu", (unsigned long long)m.flyId);
  drawLabel(p, NEURONS_COL_X, y, b, F_SMALL, col::DIM, A_LEFT); y += 14;
  if (m.anchored && m.lastAnchorBlock) { chainLink(p, NEURONS_COL_X, y, col::ICE); fmtThousands(m.lastAnchorBlock, b, sizeof b); drawLabel(p, NEURONS_COL_X + 14, y, b, F_SMALL, col::ICE, A_LEFT); }
  else drawLabel(p, NEURONS_COL_X, y, m.coreEnabled ? "no anchor yet" : "core: not deployed", F_SMALL, col::DIM, A_LEFT);
  y += 11;
  if (m.txPending) {
    float pulse = 0.5f + 0.5f * sinf(2 * PI_F * (float)(m.nowMs % 900) / 900.f);
    heart(p, NEURONS_COL_X + 4, y + 3, 3 + (pulse > 0.5f ? 1 : 0), mixc(col::RED_DARK, col::RED, (int)(pulse * 255)));
    drawLabel(p, NEURONS_COL_X + 14, y, "tx in flight", F_SMALL, col::DIM, A_LEFT);
  }
  y += 12;
  snprintf(b, sizeof b, "%lu spk/s", (unsigned long)m.spikesPerS); drawLabel(p, NEURONS_COL_X, y, b, F_SMALL, col::DIM, A_LEFT); y += 11;
  snprintf(b, sizeof b, "step %llu", (unsigned long long)m.step); textFit(p, NEURONS_COL_X, y, b, F_SMALL, col::DIM, NEURONS_COL_W); y += 14;
  wifiDot(p, NEURONS_COL_X, y, m.wifi, "wifi", col::GREEN);
  wifiDot(p, NEURONS_COL_X + 44, y, m.hostConnected, m.wsMode ? "ws" : "poll", col::GREEN);
}

// ---- the address in lines of `perLine` characters
int addressLines(Painter& p, int x, int y, int perLine, const char* addr, Color c) {
  int n = (int)strlen(addr);
  for (int i = 0; i < n; i += perLine) {
    char b[48]; int len = n - i < perLine ? n - i : perLine; memcpy(b, addr + i, len); b[len] = 0;
    drawLabel(p, x, y, b, F_SMALL, c, A_LEFT); y += 10;
  }
  return y;
}

}  // namespace

// ------------------------------------------------------------------ helpers

const char* bigWordFor(FlyState s) {
  switch (s) {
    case FlyState::IDLE: return "still";
    case FlyState::WALKING: return "wandering";
    case FlyState::SMELLING: return "smelling";
    case FlyState::SURGING: return "following a scent";
    case FlyState::CASTING: return "casting";
    case FlyState::EATING: return "eating";
    case FlyState::JUMP: return "jumped!";
    case FlyState::FLEEING: return "fleeing";
    case FlyState::CAUGHT: return "caught";
    case FlyState::DEAD: return "dead";
    case FlyState::EGG: return "waiting";
    case FlyState::HATCHING: return "hatching";
  }
  return "";
}

const char* hungerWord(int64_t e) {
  if (e >= 3600) return "full";
  if (e >= 1800) return "fine";
  if (e >= 1200) return "peckish";
  if (e >= 300) return "hungry";
  if (e >= 60) return "starving";
  return "fading";
}

void fmtHms(int64_t e, char* out, int cap) {
  if (e < 0) e = 0;
  if (e >= 3600) snprintf(out, cap, "%lldh%02lldm", (long long)(e / 3600), (long long)((e % 3600) / 60));
  else if (e >= 60) snprintf(out, cap, "%lldm %02llds", (long long)(e / 60), (long long)(e % 60));
  else snprintf(out, cap, "%lld s", (long long)e);
}

void fmtThousands(uint64_t n, char* out, int cap) {
  char num[24]; int len = snprintf(num, sizeof num, "%llu", (unsigned long long)n);
  int o = 0;
  for (int i = 0; i < len && o < cap - 1; ++i) { if (i && (len - i) % 3 == 0 && o < cap - 1) out[o++] = ','; out[o++] = num[i]; }
  out[o] = 0;
}

void textFit(Painter& p, int x, int y, const char* s, Font f, Color c, int w) {
  if (labelWidth(p, s, f) <= w) { drawLabel(p, x, y, s, f, c, A_LEFT); return; }
  char b[128];
  int n = (int)strlen(s); if (n > (int)sizeof b - 3) n = (int)sizeof b - 3;
  while (n > 0) {
    memcpy(b, s, n); b[n] = '.'; b[n + 1] = '.'; b[n + 2] = 0;
    if (labelWidth(p, b, f) <= w) break;
    --n;
  }
  drawLabel(p, x, y, b, f, c, A_LEFT);
}

// ------------------------------------------------------------------ the speech strip

void drawSpeechStrip(Painter& p, const Model& m) {
  p.fillRect(0, STRIP_Y, SCREEN_W, STRIP_H, col::BG);
  p.fillRect(0, STRIP_Y, SCREEN_W, 1, col::BG2);
  quoteMark(p, 6, STRIP_Y + 6, col::DIM);
  const char* s = m.speech[0] ? m.speech : "...";
  const int x0 = 16, avail = SCREEN_W - x0 - 4;
  int w = labelWidth(p, s, F_MED);
  if (w <= avail) { drawLabel(p, x0, STRIP_Y + 4, s, F_MED, col::INK, A_LEFT); return; }
  // too long: it slides left (pause 2 s, scroll at 40 px/s, pause 2 s, repeat)
  int over = w - avail;
  uint32_t cycle = 2000 + (uint32_t)over * 25 + 2000, t = m.nowMs % cycle;
  int off = t < 2000 ? 0 : t < 2000 + (uint32_t)over * 25 ? (int)((t - 2000) / 25) : over;
  p.setClip(x0, STRIP_Y, avail, STRIP_H);
  drawLabel(p, x0 - off, STRIP_Y + 4, s, F_MED, col::INK, A_LEFT);
  p.clearClip();
}

// ------------------------------------------------------------------ the pages

void drawLife(Painter& p, const Model& m) {
  FlyState st = flyStateOf(m);
  worldPanel(p, m, st, false, LIFE_FLY_ZOOM);
  char b[48];
  if (m.hostFresh) snprintf(b, sizeof b, "brain on host %c %.1fx", DOT, m.realtime);
  else if (m.hostOffline) snprintf(b, sizeof b, "host: %s", m.hostError[0] ? m.hostError : "offline");
  else snprintf(b, sizeof b, "no brain host %c compass only", DOT);
  drawLabel(p, 4, WORLD_H - 10, b, F_SMALL, m.hostFresh ? col::DIM : col::RED, A_LEFT);
  statusLine(p, m, 4, 4, WORLD_W - 40);
  p.fillRect(WORLD_W, 0, SCREEN_W - WORLD_W, STRIP_Y, col::BG);
  lifeColumn(p, m, st);
  drawSpeechStrip(p, m);
  lifeMoments(p, m);
}

void drawNeurons(Painter& p, const Model& m) {
  p.fillRect(0, 0, SCREEN_W, STRIP_Y, col::BG);
  // row colours by cell type: EPG/EPGt amber, PEG dim amber, PEN red, Delta7 ice
  static const Color typeColor[NEURON_TYPES] = {col::AMBER, col::AMBER, col::AMBER_DIM, col::RED, col::RED, col::ICE};
  Color rowColor[RASTER_ROWS];
  for (int i = 0; i < m.nNeurons && i < RASTER_ROWS; ++i) rowColor[i] = typeColor[m.neuronType[i] < NEURON_TYPES ? m.neuronType[i] : 0];
  if (m.nNeurons > 0) p.drawRaster(RASTER_X, RASTER_Y, m.raster, m.rowY, rowColor);
  int y = RASTER_Y + (m.rasterRows > 0 ? m.rasterRows : RASTER_ROWS) + 6;
  char b[48];
  snprintf(b, sizeof b, "%d real neurons %c on-chain", m.nNeurons > 0 ? m.nNeurons : RASTER_ROWS, DOT);
  drawLabel(p, 4, y, b, F_SMALL, col::DIM, A_LEFT);
  // the legend
  int lx = 4; y += 11;
  struct L { const char* name; Color c; } legend[4] = {{"EPG", col::AMBER}, {"PEG", col::AMBER_DIM}, {"PEN", col::RED}, {"D7", col::ICE}};
  for (int i = 0; i < 4; ++i) { p.fillRect(lx, y + 2, 4, 4, legend[i].c); drawLabel(p, lx + 7, y, legend[i].name, F_SMALL, col::DIM, A_LEFT); lx += 7 + labelWidth(p, legend[i].name, F_SMALL) + 8; }
  // the brain host's state on its own row: right-aligned on the legend row, "brain host offline" (108 px) would
  // start at x = 110, on top of the legend's "D7" (x 110..121)
  y += 11;
  if (m.hostOffline) drawLabel(p, RASTER_X + RASTER_COLS - 2, y, m.hostError[0] ? m.hostError : "brain host offline", F_SMALL, col::RED, A_RIGHT);
  else if (!m.hostKnown) drawLabel(p, RASTER_X + RASTER_COLS - 2, y, "no brain host", F_SMALL, col::DIM, A_RIGHT);
  y += 11;
  statusLine(p, m, 4, y, RASTER_COLS - 8);
  neuronsColumn(p, m);
  drawSpeechStrip(p, m);
}

void drawWaiting(Painter& p, const Model& m) {
  p.fillRect(0, 0, SCREEN_W, STRIP_Y, col::BG);
  drawEgg(p, 100, 96, 2.0f, m.nowMs, m.assignmentPending ? 0.12f : 0.f);
  drawLabel(p, 100, 150, m.assignmentPending ? "a fly is on its way" : "no fly in this body", F_SMALL, m.assignmentPending ? col::AMBER : col::DIM, A_CENTER);
  statusLine(p, m, 4, 196, WORLD_W - 8);
  const int X = 204;
  int y = 6;
  textFit(p, X, y, m.pebbleName[0] ? m.pebbleName : "Pebble", F_MED, col::INK, 112); y += 20;
  if (!m.registered) { drawLabel(p, X, y, "send 0.05 BNB here", F_SMALL, col::AMBER, A_LEFT); y += 10; drawLabel(p, X, y, "to register", F_SMALL, col::AMBER, A_LEFT); y += 12; }
  else { drawLabel(p, X, y, "assign a fly to me", F_SMALL, col::AMBER, A_LEFT); y += 10; drawLabel(p, X, y, "on the site", F_SMALL, col::DIM, A_LEFT); y += 12; }
  y = addressLines(p, X, y, 14, m.addrHex[0] ? m.addrHex : "0x", col::DIM);
  y += 2;
  y += p.drawQR(X + 2, y, 108, m.addrHex[0] ? m.addrHex : "0x", col::INK, col::BG) + 3;
  if (m.flyTokens) textFit(p, X, y, m.hatchArmed ? "C again: HATCH" : "C, C: hatch a fly", F_SMALL, m.hatchArmed ? col::AMBER : col::DIM, 112);
  else textFit(p, X, y, "hold A+C: show key", F_SMALL, col::DIM2, 112);
  drawSpeechStrip(p, m);
}

void drawDead(Painter& p, const Model& m) {
  worldPanel(p, m, FlyState::DEAD, true, 1.8f);
  char b[48];
  statusLine(p, m, 4, 4, WORLD_W - 8);
  p.fillRect(WORLD_W, 0, SCREEN_W - WORLD_W, STRIP_Y, col::BG);
  const int X = LIFE_COL_X, W = LIFE_COL_W;
  int y = 4;
  snprintf(b, sizeof b, "#%llu %s", (unsigned long long)m.flyId, m.flyName[0] ? m.flyName : "fly");
  textFit(p, X, y, b, F_MED, col::DIM, W); y += 18;
  p.fillCircle(X + 3, y + 3, 3, col::RED);
  snprintf(b, sizeof b, "dead %c gen %lu", DOT, (unsigned long)m.generation);
  drawLabel(p, X + 10, y, b, F_SMALL, col::RED, A_LEFT); y += 14;
  y = bigWord(p, X, y, W, "dead", col::DIM);
  y += 2;
  drawLabel(p, X, y, "brain preserved", F_SMALL, col::INK, A_LEFT); y += 10;
  if (m.deadBlock) { fmtThousands(m.deadBlock, b, sizeof b); char c[64]; snprintf(c, sizeof c, "block %s", b); drawLabel(p, X, y, c, F_SMALL, col::DIM, A_LEFT); }
  y += 12;
  y += p.drawQR(X + 2, y, 108, m.flyUrl[0] ? m.flyUrl : "https://", mixc(col::BG, col::INK, 210), col::BG) + 3;
  textFit(p, X, y, m.flyTokens ? "C, C: hatch anew" : "scan to resurrect", F_SMALL, col::DIM, W);
  drawSpeechStrip(p, m);
}

void drawHatching(Painter& p, const Model& m) {
  p.fillRect(0, 0, SCREEN_W, STRIP_Y, col::BG);
  uint32_t ms = m.hatchMs ? m.nowMs - m.hatchMs : 0;
  float crack = (float)ms / (float)HATCH_MS; if (crack > 1) crack = 1;
  drawEgg(p, 88, 104, 2.0f, m.nowMs, crack);
  if (ms > 400) {
    float u = (float)(ms - 400) / 1400.f; if (u > 1) u = 1;
    FlyPose pose;
    pose.cx = 112 + (int)(u * 64); pose.cy = 100; pose.heading = -0.15f; pose.scale = 0.9f + 0.7f * u; pose.state = FlyState::HATCHING; pose.t = m.nowMs; pose.stateMs = ms;
    drawFly(p, pose);
  }
  const int X = LIFE_COL_X, W = LIFE_COL_W;
  int y = 4;
  char b[48];
  snprintf(b, sizeof b, "#%llu %s", (unsigned long long)m.flyId, m.flyName[0] ? m.flyName : "fly");
  textFit(p, X, y, b, F_MED, col::INK, W); y += 18;
  p.fillCircle(X + 3, y + 3, 3, col::GREEN);
  snprintf(b, sizeof b, "alive %c gen %lu", DOT, (unsigned long)m.generation);
  drawLabel(p, X + 10, y, b, F_SMALL, col::GREEN, A_LEFT); y += 14;
  y = bigWord(p, X, y, W, "hatching", col::AMBER);
  y += 4;
  // a progress bar
  p.drawRect(X, y, W, 6, col::DIM2);
  p.fillRect(X + 1, y + 1, (int)((W - 2) * crack), 4, col::AMBER);
  y += 12;
  textFit(p, X, y, "compass: on-chain", F_SMALL, col::DIM, W); y += 10;
  textFit(p, X, y, "brain: on the host", F_SMALL, col::DIM, W);
  statusLine(p, m, 4, 196, WORLD_W - 8);
  drawSpeechStrip(p, m);
}

void drawFeedHint(Painter& p, const Model& m) {
  p.fillRect(0, 0, SCREEN_W, STRIP_Y, col::BG);
  int side = p.drawQR(8, 8, 150, m.addrHex[0] ? m.addrHex : "0x", col::INK, col::BG);
  drawLabel(p, 8 + side / 2, 12 + side, "the pebble's address", F_SMALL, col::DIM, A_CENTER);
  const int X = 170, W = 146;
  int y = 8;
  char b[64];
  snprintf(b, sizeof b, "feed #%llu", (unsigned long long)m.flyId);
  drawLabel(p, X, y, b, F_MED, col::AMBER, A_LEFT); y += 20;
  drawLabel(p, X, y, "send $FLY or BNB here:", F_SMALL, col::INK, A_LEFT); y += 11;
  y = addressLines(p, X, y, 24, m.addrHex[0] ? m.addrHex : "0x", col::DIM);
  y += 4;
  drawLabel(p, X, y, "or open the fly page:", F_SMALL, col::INK, A_LEFT); y += 11;
  const char* url = m.flyUrl[0] ? m.flyUrl : "";
  int n = (int)strlen(url);
  for (int i = 0; i < n && y < 150; i += 24) { int len = n - i < 24 ? n - i : 24; memcpy(b, url + i, len); b[len] = 0; drawLabel(p, X, y, b, F_SMALL, col::DIM, A_LEFT); y += 10; }
  y += 6;
  drawLabel(p, X, y, "$FLY buys seconds of life", F_SMALL, col::AMBER, A_LEFT); y += 12;
  drawLabel(p, X, 200, "A: back", F_SMALL, col::DIM2, A_LEFT);
  (void)W;
  statusLine(p, m, 8, 180, 150);
  drawSpeechStrip(p, m);
}

void drawScreen(Painter& p, const Model& m) {
  switch (m.page) {
    case Page::LIFE: drawLife(p, m); break;
    case Page::NEURONS: drawNeurons(p, m); break;
    case Page::WAITING: drawWaiting(p, m); break;
    case Page::DEAD: drawDead(p, m); break;
    case Page::HATCHING: drawHatching(p, m); break;
    case Page::FEED_HINT: drawFeedHint(p, m); break;
  }
}

}  // namespace screen
