#include "creature.h"
#include <math.h>

namespace screen {

namespace {

constexpr float PI_F = 3.14159265f;

// the fly's frame -> screen: sx = cx + S(fx cos h - fy sin h), sy = cy - S(fx sin h + fy cos h)
struct Xf {
  float cx, cy, c, s, S;
  Xf(float cx_, float cy_, float heading, float S_) : cx(cx_), cy(cy_), c(cosf(heading)), s(sinf(heading)), S(S_) {}
  int X(float fx, float fy) const { return (int)lroundf(cx + S * (fx * c - fy * s)); }
  int Y(float fx, float fy) const { return (int)lroundf(cy - S * (fx * s + fy * c)); }
};

constexpr int MAX_PTS = 16;

// a rotated ellipse (centre ex,ey; radii rx,ry; rot rad in the fly frame) as an n-gon in screen coordinates
int ellipsePts(const Xf& xf, float ex, float ey, float rx, float ry, float rot, int n, int16_t* out) {
  float cr = cosf(rot), sr = sinf(rot);
  for (int k = 0; k < n; ++k) {
    float a = 2 * PI_F * k / n, ca = cosf(a), sa = sinf(a);
    float px = ex + rx * ca * cr - ry * sa * sr, py = ey + rx * ca * sr + ry * sa * cr;
    out[2 * k] = (int16_t)xf.X(px, py); out[2 * k + 1] = (int16_t)xf.Y(px, py);
  }
  return n;
}

void ellipse(Painter& p, const Xf& xf, float ex, float ey, float rx, float ry, float rot, Color fill, Color outline, bool doFill) {
  int16_t pts[2 * MAX_PTS];
  int n = xf.S < 40 ? 12 : 16;
  ellipsePts(xf, ex, ey, rx, ry, rot, n, pts);
  if (doFill) p.fillPoly(pts, n, fill);
  p.drawPoly(pts, n, outline);
}

void line(Painter& p, const Xf& xf, float x0, float y0, float x1, float y1, Color c) { p.drawLine(xf.X(x0, y0), xf.Y(x0, y0), xf.X(x1, y1), xf.Y(x1, y1), c); }

// legs: hip, knee, foot per leg (front, middle, hind) on the left side; the right side mirrors y
struct Leg { float hx, hy, kx, ky, fx, fy; };
const Leg LEGS[3] = {{0.16f, 0.10f, 0.32f, 0.30f, 0.46f, 0.36f}, {0.04f, 0.12f, 0.02f, 0.34f, 0.06f, 0.48f}, {-0.08f, 0.10f, -0.26f, 0.30f, -0.42f, 0.42f}};

void drawLegs(Painter& p, const Xf& xf, float swing, bool curled, Color c) {
  // tripod gait: front-left, middle-right, hind-left swing together, the other three opposite
  for (int side = 0; side < 2; ++side) {
    float m = side ? -1.f : 1.f;
    for (int i = 0; i < 3; ++i) {
      const Leg& L = LEGS[i];
      float group = ((i + side) & 1) ? -1.f : 1.f;
      float dx = swing * group;
      if (curled) {
        // on its back: knees up and out, feet folded in over the belly
        line(p, xf, L.hx, m * L.hy, L.hx + 0.12f, m * 0.40f, c);
        line(p, xf, L.hx + 0.12f, m * 0.40f, L.hx + 0.28f, m * 0.18f, c);
      } else {
        line(p, xf, L.hx, m * L.hy, L.kx + dx * 0.5f, m * L.ky, c);
        line(p, xf, L.kx + dx * 0.5f, m * L.ky, L.fx + dx, m * L.fy, c);
      }
    }
  }
}

void drawWings(Painter& p, const Xf& xf, float sweep, Color c, bool fill) {
  // two translucent ellipses swept back: a faint membrane fill (optional), the outline and one vein
  for (int side = 0; side < 2; ++side) {
    float m = side ? -1.f : 1.f;
    float cxw = 0.02f - 0.40f * cosf(sweep), cyw = m * (0.10f + 0.40f * sinf(sweep));
    ellipse(p, xf, cxw, cyw, 0.42f, 0.14f, m * (PI_F - sweep), mixc(col::BG, col::DIM, 34), c, fill);
    line(p, xf, 0.0f, m * 0.12f, cxw - 0.30f * cosf(sweep), cyw + m * 0.30f * sinf(sweep), c);   // one vein
  }
}

void drawAntennae(Painter& p, const Xf& xf, float angle, Color c) {
  // from the head, angle = how far forward they point (0 = straight ahead, larger = out to the sides)
  for (int side = 0; side < 2; ++side) {
    float m = side ? -1.f : 1.f;
    float bx = 0.45f, by = m * 0.06f;
    float tx = bx + 0.13f * cosf(angle), ty = by + m * 0.13f * sinf(angle);
    line(p, xf, bx, by, tx, ty, c);
    p.drawPixel(xf.X(tx + 0.02f * cosf(angle + m * 1.2f), ty + 0.02f * sinf(angle + m * 1.2f)), xf.Y(tx + 0.02f * cosf(angle + m * 1.2f), ty + 0.02f * sinf(angle + m * 1.2f)), c);
  }
}

}  // namespace

// ------------------------------------------------------------------ the fly

void drawFly(Painter& p, const FlyPose& pose) {
  const FlyState st = pose.state;
  const uint32_t t = pose.starving ? pose.t / 2 : pose.t;   // starving: half speed
  float cx = (float)pose.cx, cy = (float)pose.cy, heading = pose.heading, scale = pose.scale;

  // ---- state-driven parameters
  float breathe = 1.f, legSwing = 0.f, antAngle = 0.55f, headYaw = 0.f, eyeR = 0.08f, wingSweep = 0.45f;
  bool legsCurled = false, proboscis = false, wingBlur = false, dead = st == FlyState::DEAD;
  Color outline = col::INK, bodyFill = mixc(col::BG, col::AMBER, 70), thoraxFill = mixc(col::BG, col::AMBER, 96), legC = mixc(col::DIM, col::INK, 60), wingC = mixc(col::BG, col::DIM, 175), eyeC = mixc(col::RED, col::INK, 25);
  float antDrift = 0.12f * sinf(2 * PI_F * (float)(t % 1700) / 1700.f);
  auto cycle = [&](uint32_t periodMs) {   // 4-frame leg cycle: +1 0 -1 0
    static const float ph[4] = {1.f, 0.f, -1.f, 0.f};
    return ph[(t / (periodMs / 4)) & 3] * 0.06f;
  };
  switch (st) {
    case FlyState::IDLE: breathe = 1.f + 0.03f * sinf(2 * PI_F * (float)(t % 1000) / 1000.f); antAngle += antDrift; break;
    case FlyState::WALKING: legSwing = cycle(400); antAngle += antDrift; break;
    case FlyState::SMELLING: legSwing = cycle(400); antAngle = 0.35f + 0.25f * ((t / 60) & 1 ? 1.f : -1.f); break;
    case FlyState::SURGING: legSwing = cycle(240); antAngle = 0.15f; break;
    case FlyState::CASTING: legSwing = cycle(700); headYaw = 0.44f * sinf(2 * PI_F * 0.7f * (float)(t % 10000) / 1000.f); antAngle += antDrift; break;
    case FlyState::EATING: proboscis = true; antAngle = 0.7f; break;
    case FlyState::JUMP: wingBlur = true; legSwing = 0.06f; cy -= 6.f * sinf(PI_F * (float)(pose.stateMs < JUMP_MS ? pose.stateMs : JUMP_MS) / (float)JUMP_MS); break;
    case FlyState::FLEEING: legSwing = cycle(200); eyeR = 0.11f; bodyFill = mixc(bodyFill, col::RED, 90); thoraxFill = mixc(thoraxFill, col::RED, 90); antAngle = 0.2f; break;
    case FlyState::CAUGHT: legSwing = 0.06f; if (pose.stateMs < CAUGHT_MS) { cx += ((t / 50) & 1) ? 3.f : -3.f; } bodyFill = mixc(bodyFill, col::RED, 60); break;
    case FlyState::DEAD: legsCurled = true; heading += PI_F; outline = col::DIM; bodyFill = mixc(col::BG, col::DIM, 60); thoraxFill = mixc(col::BG, col::DIM, 80); legC = col::DIM2; wingC = mixc(col::BG, col::DIM, 70); eyeC = col::DIM; break;
    case FlyState::HATCHING: legSwing = cycle(500); antAngle = 0.5f; break;
    default: break;
  }
  if (pose.starving && !dead) { outline = col::DIM; bodyFill = mixc(col::BG, bodyFill, 140); thoraxFill = mixc(col::BG, thoraxFill, 140); legC = col::DIM2; eyeC = mixc(col::BG, eyeC, 170); }

  const float S = BODY_PX * scale * breathe;
  Xf xf(cx, cy, heading, S);
  const bool small = S < 24;

  // ---- back to front: wings, legs, abdomen, thorax, head
  if (wingBlur) {
    // three quick alternating outlines
    static const float sweeps[3] = {0.15f, 0.5f, 0.9f};
    int k = (int)((pose.t / 33) % 3);
    drawWings(p, xf, sweeps[(k + 2) % 3], mixc(col::BG, col::DIM, 70), false);
    drawWings(p, xf, sweeps[(k + 1) % 3], mixc(col::BG, col::DIM, 120), false);
    drawWings(p, xf, sweeps[k], col::DIM, false);
  } else {
    drawWings(p, xf, legsCurled ? 0.9f : wingSweep, wingC, !small);
  }
  drawLegs(p, xf, legSwing, legsCurled, legC);
  // abdomen (striped) and thorax
  ellipse(p, xf, -0.30f, 0, 0.27f, 0.17f, 0, bodyFill, outline, true);
  {
    Color stripe = mixc(bodyFill, col::BG, 150);
    for (int i = 0; i < 3; ++i) {
      float sx = -0.20f - 0.12f * i, hw = 0.17f * sqrtf(1.f - ((sx + 0.30f) / 0.27f) * ((sx + 0.30f) / 0.27f)) * 0.9f;
      line(p, xf, sx, -hw, sx, hw, stripe);
    }
  }
  ellipse(p, xf, 0.06f, 0, 0.20f, 0.17f, 0, thoraxFill, outline, true);
  // the head yaws about the neck when casting
  Xf hx(xf.X(0.24f, 0), xf.Y(0.24f, 0), heading + headYaw, S);
  int headR = (int)lroundf(0.14f * S); if (headR < 2) headR = 2;
  p.fillCircle(hx.X(0.13f, 0), hx.Y(0.13f, 0), headR, thoraxFill);
  p.drawCircle(hx.X(0.13f, 0), hx.Y(0.13f, 0), headR, outline);
  // eyes: big, red-tinted domes on the sides of the head, one highlight pixel; dead: x marks
  int er = (int)lroundf(eyeR * S); if (er < 1) er = 1;
  for (int side = 0; side < 2; ++side) {
    float m = side ? -1.f : 1.f;
    int ex = hx.X(0.16f, m * 0.12f), ey = hx.Y(0.16f, m * 0.12f);
    if (dead) {
      int d = er < 2 ? 2 : er;
      p.drawLine(ex - d, ey - d, ex + d, ey + d, col::DIM); p.drawLine(ex - d, ey + d, ex + d, ey - d, col::DIM);
    } else {
      p.fillCircle(ex, ey, er, eyeC);
      if (!small) p.drawCircle(ex, ey, er, col::RED_DARK);
      if (!small) p.drawPixel(hx.X(0.16f + 0.035f, m * (0.12f - 0.035f)), hx.Y(0.16f + 0.035f, m * (0.12f - 0.035f)), col::INK);
    }
  }
  if (!dead) drawAntennae(p, hx, antAngle, outline);
  // the proboscis and its crumbs when eating
  if (proboscis) {
    line(p, hx, 0.22f, 0, 0.34f, 0, legC);
    for (int i = 0; i < 3; ++i) {
      float u = (float)(((t / 100) + i * 3) % 9) / 9.f;
      float px = 0.34f + 0.12f * u, py = (i - 1) * 0.06f * (0.3f + u);
      p.drawPixel(hx.X(px, py), hx.Y(px, py), mixc(col::AMBER, col::BG, (int)(u * 180)));
    }
  }
  // smelling: amber particles drift toward the head from the plume side
  if (st == FlyState::SMELLING && pose.hasPlume) {
    float dxp = cosf(pose.plumeRad), dyp = sinf(pose.plumeRad);
    float hxw = cx + S * 0.36f * cosf(heading), hyw = cy - S * 0.36f * sinf(heading);
    for (int i = 0; i < 6; ++i) {
      float u = (float)(((pose.t / 40) + i * 25) % 150) / 150.f;   // 1 = at the head
      float d = (1.f - u) * 1.3f * S;
      float lat = 0.18f * S * sinf(u * 9.f + i);
      int px = (int)(hxw + dxp * d - dyp * lat), py = (int)(hyw - dyp * d - dxp * lat);
      Color c = mixc(col::BG, col::AMBER, 60 + (int)(u * 180));
      if (u > 0.6f) p.fillRect(px, py, 2, 2, c); else p.drawPixel(px, py, c);
    }
  }
}

// ------------------------------------------------------------------ the egg

void drawEgg(Painter& p, int cx, int cy, float scale, uint32_t t, float crack) {
  float pulse = 1.f + 0.04f * sinf(2 * PI_F * (float)(t % 2000) / 2000.f);   // 0.5 Hz
  float S = BODY_PX * scale * pulse;
  Xf xf((float)cx, (float)cy, PI_F / 2, S);   // long axis vertical
  Color shell = mixc(col::BG, col::INK, 165), rim = col::INK, glow = mixc(col::BG, col::AMBER, 30);
  int16_t pts[2 * MAX_PTS];
  int n = ellipsePts(xf, 0, 0, 0.78f, 0.55f, 0, 16, pts);
  // a faint warm glow around it
  int16_t g[2 * MAX_PTS];
  Xf gx((float)cx, (float)cy, PI_F / 2, S * 1.18f);
  ellipsePts(gx, 0, 0, 0.78f, 0.55f, 0, 16, g);
  p.fillPoly(g, 16, glow);
  p.fillPoly(pts, n, shell);
  p.drawPoly(pts, n, rim);
  // a highlight
  p.fillCircle(xf.X(0.35f, 0.22f), xf.Y(0.35f, 0.22f), (int)(0.08f * S) + 1, mixc(shell, col::INK, 120));
  if (crack > 0) {
    // a zigzag in from the right-hand shell (where the fly steps out), widening into a dark gap
    float w = crack * 0.14f;
    static const float zig[6][2] = {{0.02f, -0.56f}, {0.11f, -0.42f}, {-0.02f, -0.28f}, {0.09f, -0.14f}, {0.0f, 0.0f}, {0.07f, 0.14f}};   // (fx, fy): in from the right rim
    int nz = crack < 0.15f ? 3 : crack < 0.4f ? 4 : 6;
    for (int i = 0; i + 1 < nz; ++i) {
      line(p, xf, zig[i][0], zig[i][1], zig[i + 1][0], zig[i + 1][1], col::BG);
      if (w > 0.02f) {
        line(p, xf, zig[i][0] + w, zig[i][1], zig[i + 1][0] + w, zig[i + 1][1], col::BG);
        line(p, xf, zig[i][0] - w, zig[i][1], zig[i + 1][0] - w, zig[i + 1][1], col::BG);
      }
      if (w > 0.05f) {
        int16_t q[8] = {(int16_t)xf.X(zig[i][0] - w, zig[i][1]), (int16_t)xf.Y(zig[i][0] - w, zig[i][1]), (int16_t)xf.X(zig[i][0] + w, zig[i][1]), (int16_t)xf.Y(zig[i][0] + w, zig[i][1]),
                        (int16_t)xf.X(zig[i + 1][0] + w, zig[i + 1][1]), (int16_t)xf.Y(zig[i + 1][0] + w, zig[i + 1][1]), (int16_t)xf.X(zig[i + 1][0] - w, zig[i + 1][1]), (int16_t)xf.Y(zig[i + 1][0] - w, zig[i + 1][1])};
        p.fillPoly(q, 4, col::BG);
      }
    }
  }
}

// ------------------------------------------------------------------ the head from above (Neurons page)

void drawFlyHead(Painter& p, int cx, int cy, int r, float heading, uint32_t t) {
  float S = (float)r / 0.13f;   // head radius 0.13 BL
  Xf xf((float)cx, (float)cy, heading, S);
  Color fill = mixc(col::BG, col::AMBER, 96);
  // the neck stub behind the head
  int16_t pts[2 * MAX_PTS];
  ellipsePts(xf, -0.14f, 0, 0.07f, 0.09f, 0, 12, pts);
  p.fillPoly(pts, 12, mixc(col::BG, col::AMBER, 62));
  p.drawPoly(pts, 12, col::DIM);
  p.fillCircle(cx, cy, r, fill);
  p.drawCircle(cx, cy, r, col::INK);
  // eyes: big red domes with a highlight
  int er = (int)(r * 0.62f);
  for (int side = 0; side < 2; ++side) {
    float m = side ? -1.f : 1.f;
    int ex = xf.X(0.04f, m * 0.10f), ey = xf.Y(0.04f, m * 0.10f);
    p.fillCircle(ex, ey, er, mixc(col::RED, col::INK, 30));
    p.drawCircle(ex, ey, er, col::RED_DARK);
    p.fillCircle(xf.X(0.07f, m * 0.08f), xf.Y(0.07f, m * 0.08f), er / 4 > 0 ? er / 4 : 1, col::INK);
  }
  // ocelli: three tiny dots on top
  p.drawPixel(xf.X(-0.02f, 0), xf.Y(-0.02f, 0), col::AMBER);
  p.drawPixel(xf.X(-0.05f, 0.03f), xf.Y(-0.05f, 0.03f), col::AMBER);
  p.drawPixel(xf.X(-0.05f, -0.03f), xf.Y(-0.05f, -0.03f), col::AMBER);
  // antennae drifting
  float drift = 0.12f * sinf(2 * PI_F * (float)(t % 1700) / 1700.f);
  Xf hx(xf.X(-0.12f, 0), xf.Y(-0.12f, 0), heading, S);
  drawAntennae(p, hx, 0.55f + drift, col::INK);
}

// ------------------------------------------------------------------ the state of a model

FlyState flyStateOf(const Model& m) {
  const uint32_t now = m.nowMs;
  if (!m.hasFly) return FlyState::EGG;
  if (m.hatchMs && (uint32_t)(now - m.hatchMs) < HATCH_MS + 800) return FlyState::HATCHING;
  if (!m.alive) return FlyState::DEAD;
  if (m.caughtMs && (uint32_t)(now - m.caughtMs) < CAUGHT_MS) return FlyState::CAUGHT;
  if (m.jumpMs && (uint32_t)(now - m.jumpMs) < JUMP_MS) return FlyState::JUMP;
  if (m.predator) {
    float dx = m.predX - m.x, dy = m.predY - m.y;
    if (dx * dx + dy * dy < 40.f * 40.f) return FlyState::FLEEING;
  }
  if (m.mode == Mode::FLEE) return FlyState::FLEEING;
  if (m.mode == Mode::EAT || m.taste > 0.5f || (m.eatMs && (uint32_t)(now - m.eatMs) < 2500)) return FlyState::EATING;
  if (m.mode == Mode::SURGE) return FlyState::SURGING;
  if (m.mode == Mode::CAST) return FlyState::CASTING;
  if (m.smell > 0.35f) return FlyState::SMELLING;
  if (m.mode == Mode::STILL || m.speed < 0.3f) return FlyState::IDLE;
  return FlyState::WALKING;
}

}  // namespace screen
