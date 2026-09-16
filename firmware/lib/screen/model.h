// The Model: everything a page needs, filled by src/ui.cpp from the pebble's state (and by the native test by hand).
// Nothing in here decides layout; nothing in here allocates. Pure C++17.
#pragma once
#include <stdint.h>
#include <string.h>
#include "raster.h"

namespace screen {

enum class Page : uint8_t { LIFE, NEURONS, WAITING, DEAD, HATCHING, FEED_HINT };

// UI.md "The creature": states and animations
enum class FlyState : uint8_t { IDLE, WALKING, SMELLING, SURGING, CASTING, EATING, JUMP, FLEEING, CAUGHT, DEAD, EGG, HATCHING };

// the host's locomotion mode (hostframe::Mode, mirrored so lib/screen needs no ArduinoJson)
enum class Mode : uint8_t { WANDER = 0, SURGE, CAST, EAT, FLEE, STILL, UNKNOWN };

enum class Moment : uint8_t { NONE = 0, FED, ANCHORED, POKED, STREAM_LOST };

// Two glyphs the pages draw themselves (pages.cpp drawLabel): the middle dot of "alive · gen 1" and the degree sign
// of "chain 210°". Neither is a glyph a Painter can be asked for: Font2 has nothing above 0x7F and Font0's cp437
// glyphs sit behind a text-style flag M5GFX leaves off (0xFA comes out as '√'). Their bytes are the CP437 codes;
// a string holding them goes through drawLabel, never straight to Painter::drawText.
constexpr char DOT_CH = (char)0xFA;
constexpr char DEG_CH = (char)0xF8;

constexpr int MAX_FOOD = 8;
constexpr int MAX_PUFFS = 4;
constexpr int TRAIL_LEN = 120;
constexpr int MAX_MOMENTS = 4;
constexpr int WEDGES = 16;
constexpr int NEURON_TYPES = 6;   // EPG, EPGt, PEG, PEN_a, PEN_b, Delta7 (flycore::CellType order)
constexpr uint32_t MOMENT_MS = 2000;
constexpr uint32_t HATCH_MS = 1500;
constexpr uint32_t JUMP_MS = 300;
constexpr uint32_t CAUGHT_MS = 600;
constexpr uint32_t CAUGHT_FLASH_MS = 120;
constexpr uint32_t ANCHOR_FLASH_MS = 300;

struct FoodM { float x, y; float left; int secs; uint32_t id; };   // left = energy / energy0 (0..1), secs = energy
struct PuffM { float x, y, strength; };

struct MomentQ {
  struct { Moment kind; uint32_t startMs; } q[MAX_MOMENTS];
  int n = 0;
  void clear() { n = 0; }
  void add(Moment k, uint32_t now) {
    if (n == MAX_MOMENTS) { for (int i = 1; i < n; ++i) q[i - 1] = q[i]; n--; }
    q[n].kind = k; q[n].startMs = now; n++;
  }
  void expire(uint32_t now) {
    int w = 0;
    for (int i = 0; i < n; ++i) if ((uint32_t)(now - q[i].startMs) < MOMENT_MS) q[w++] = q[i];
    n = w;
  }
  // ms since the newest moment of that kind began, or -1
  int32_t age(Moment k, uint32_t now) const {
    int32_t best = -1;
    for (int i = 0; i < n; ++i) if (q[i].kind == k) { int32_t a = (int32_t)(now - q[i].startMs); if (best < 0 || a < best) best = a; }
    return best;
  }
};

struct Model {
  Page page = Page::WAITING;
  uint32_t nowMs = 0;                 // the animation clock (10 fps animations key off nowMs / 100)

  // ---- who
  char flyName[40] = "";
  uint64_t flyId = 0;
  char pebbleName[24] = "";
  char addrHex[43] = "";              // the pebble's EIP-55 address
  char flyUrl[96] = "";               // the fly page on the site (QR on the dead / feed-hint pages)
  char speech[96] = "";               // the first-person line (speech.h decides it)
  char status[96] = "";               // the narration line (tx hashes, errors); shown small while fresh
  uint32_t statusAgeMs = 0xFFFFFFFFu; // ms since it was set
  bool txPending = false;

  // ---- the fly (the host's frame, or the local counter without a host)
  bool hasFly = false;                // a fly is hosted (else: the egg)
  bool alive = true;
  bool hostFresh = false;             // frames < HOST_STALE_MS old
  bool hostOffline = false;           // hosting, an origin is known, but no fresh frames
  bool hostKnown = false;             // an origin was ever known (else "no brain host")
  uint32_t generation = 0;
  float x = 0, y = 0, heading = 0;    // world position (body lengths, y up) and heading (rad, CCW from +x)
  float speed = 0;                    // body lengths per second (from successive frames)
  float arena = 240.f;
  int64_t energy = 0;                 // seconds of life
  Mode mode = Mode::UNKNOWN;
  int nfood = 0; FoodM food[MAX_FOOD];
  int npuffs = 0; PuffM puffs[MAX_PUFFS];
  bool predator = false; float predX = 0, predY = 0, predSize = 6;
  float smell = 0, memory = 0, sight = 0, steer = 0, taste = 0;   // the five thought bars, 0..1
  float realtime = 0;
  float windRad = 3.6f;               // where the plumes drift (rad, world frame)
  // the trail: a ring of the last TRAIL_LEN positions, oldest first
  int trailN = 0, trailHead = 0; float trailX[TRAIL_LEN], trailY[TRAIL_LEN];
  // event clocks: when the last jump / catch / hatch began (0 = never), on nowMs' clock
  uint32_t jumpMs = 0, caughtMs = 0, hatchMs = 0, eatMs = 0;
  bool assignmentPending = false;     // the egg shows a crack
  bool registered = false;            // the pebble is a body on the registry (else: "send 0.05 BNB to register")
  bool flyTokens = false;             // a hatch is possible (button hint)
  bool hatchArmed = false;

  // ---- the replica (the on-chain compass core, bit-exact locally)
  Raster raster;
  int nNeurons = 0;
  uint8_t neuronType[RASTER_ROWS];    // flycore::CellType per neuron
  uint8_t neuronWedge[RASTER_ROWS];   // 0..15 or 0xFF
  uint8_t rowY[RASTER_ROWS];          // raster row per neuron (grouped by type with 1-px gaps); buildRows()
  int rasterRows = 0;                 // rows incl. gaps
  float wedgeAct[WEDGES];             // 0..1 EPG activity per wedge
  float headX = 0, headY = 0;         // the local population vector
  float headMag = 0;                  // 0..1
  uint32_t spikesPerS = 0; uint64_t step = 0;
  int chainHeadingDeg = -1, localHeadingDeg = -1;

  // ---- the chain
  bool coreEnabled = false, anchored = false;
  uint64_t lastAnchorBlock = 0;
  uint32_t deadBlock = 0;
  bool wifi = false, ble = false, wsMode = false, hostConnected = false;
  bool candidate = false, scanning = false; char neighbourShort[5] = "";

  MomentQ moments;

  Model() { memset(neuronType, 0, sizeof neuronType); memset(neuronWedge, 0xFF, sizeof neuronWedge); memset(rowY, 0, sizeof rowY); memset(wedgeAct, 0, sizeof wedgeAct); raster.clear(); }

  // rows grouped by type (EPG, EPGt, PEG, PEN_a, PEN_b, Delta7) with a 1-px gap between groups, in neuron order within a group
  void buildRows() {
    int y = 0; bool any = false;
    for (int t = 0; t < NEURON_TYPES; ++t) {
      bool found = false;
      for (int i = 0; i < nNeurons; ++i) if (neuronType[i] == t) { if (!found && any) y++; found = true; any = true; rowY[i] = (uint8_t)y++; }
    }
    rasterRows = y;
  }
  void pushTrail(float px, float py) {
    trailX[trailHead] = px; trailY[trailHead] = py;
    trailHead = (trailHead + 1) % TRAIL_LEN;
    if (trailN < TRAIL_LEN) trailN++;
  }
  // trail point k, 0 = oldest
  void trail(int k, float& px, float& py) const { int i = (trailHead + TRAIL_LEN - trailN + k) % TRAIL_LEN; px = trailX[i]; py = trailY[i]; }
};

}  // namespace screen
