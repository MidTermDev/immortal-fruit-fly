// The pages (UI.md): Life, Neurons, Waiting, Dead, Hatching, the feed hint; the speech strip and the moments.
// Everything is drawn from the Model onto a Painter; nothing here allocates.
#pragma once
#include <math.h>
#include "painter.h"
#include "model.h"

namespace screen {

// layout (320 x 240)
constexpr int WORLD_W = 200, WORLD_H = 216;            // the Life world viewport
constexpr int WORLD_CX = 100, WORLD_CY = 108;
constexpr float WORLD_BL_ACROSS = 70.f;                // body lengths across the viewport
constexpr float WORLD_K = WORLD_W / WORLD_BL_ACROSS;   // px per body length
constexpr int LIFE_COL_X = 204, LIFE_COL_W = 112;      // the Life right column
constexpr int RASTER_X = 0, RASTER_Y = 4;              // the Neurons raster
constexpr int NEURONS_COL_X = 224, NEURONS_COL_W = 92;
constexpr int STRIP_Y = 216, STRIP_H = 24;             // the speech strip
constexpr float LIFE_FLY_ZOOM = 1.6f;

// the whole screen for the model's page (background included), moments last
void drawScreen(Painter& p, const Model& m);

// the pages, for tests and for the device
void drawLife(Painter& p, const Model& m);
void drawNeurons(Painter& p, const Model& m);
void drawWaiting(Painter& p, const Model& m);
void drawDead(Painter& p, const Model& m);
void drawHatching(Painter& p, const Model& m);
void drawFeedHint(Painter& p, const Model& m);
void drawSpeechStrip(Painter& p, const Model& m);

// helpers shared with the tests
// the camera: world (body lengths, y up) -> the Life viewport
inline int worldX(const Model& m, float wx) { return WORLD_CX + (int)lroundf((wx - m.x) * WORLD_K); }
inline int worldY(const Model& m, float wy) { return WORLD_CY - (int)lroundf((wy - m.y) * WORLD_K); }
// the big word for a fly state ("FOLLOWING A SCENT", ...)
const char* bigWordFor(FlyState s);
// the hunger word for seconds of life
const char* hungerWord(int64_t energy);
// "1h22m" / "12m 05s" / "42 s"
void fmtHms(int64_t e, char* out, int cap);
// 122097417 -> "122,097,417"
void fmtThousands(uint64_t n, char* out, int cap);
// draws `s` in font f at (x, y), dropping characters (with an ellipsis) so it fits in w
void textFit(Painter& p, int x, int y, const char* s, Font f, Color c, int w);
// text as the pages draw it: printable ASCII goes to the Painter, DOT_CH / DEG_CH (model.h) are drawn as
// primitives, any other byte shows as '?'. Every string a page draws goes through these.
void drawLabel(Painter& p, int x, int y, const char* s, Font f, Color c, Align a);
int labelWidth(Painter& p, const char* s, Font f);

}  // namespace screen
