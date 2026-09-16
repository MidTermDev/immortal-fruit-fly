// The creature (UI.md): a fly drawn from primitives in its own frame (+x forward, +y to its left, body length 1.0),
// rotated by heading and scaled (1.0 = 28 px), with every state and animation of the table, deterministic from the
// animation clock. Also the egg and the head-from-above of the Neurons page.
#pragma once
#include <stdint.h>
#include "painter.h"
#include "model.h"

namespace screen {

constexpr float BODY_PX = 28.f;   // pixels per body length at scale 1

struct FlyPose {
  int cx = 0, cy = 0;            // screen position of the body centre
  float heading = 0;             // rad, CCW from +x in the y-up world
  float scale = 1.f;
  FlyState state = FlyState::IDLE;
  uint32_t t = 0;                // animation clock, ms
  uint32_t stateMs = 0;          // ms since the state began (jump / caught / hatching)
  bool starving = false;         // half speed, drawn dim
  bool hasPlume = false;         // smelling: where the scent comes from
  float plumeRad = 0;            // world rad
};

// the fly (all states except EGG; HATCHING draws the emerging fly only, the egg is drawEgg)
void drawFly(Painter& p, const FlyPose& pose);
// the egg: a pale ellipse pulsing 0.5 Hz; `crack` 0 = none, 0..1 = the crack widening
void drawEgg(Painter& p, int cx, int cy, float scale, uint32_t t, float crack);
// the fly's head from above (Neurons page), r = head radius in px, heading as above
void drawFlyHead(Painter& p, int cx, int cy, int r, float heading, uint32_t t);
// the fly state of a model right now (UI.md's trigger column)
FlyState flyStateOf(const Model& m);
// the animation frame of a 10 fps clock
inline uint32_t animFrame(uint32_t t) { return t / 100; }

}  // namespace screen
