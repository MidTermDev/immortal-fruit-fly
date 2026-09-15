// Shared state of the pebble body: what the three tasks (UI/sensors on the Arduino loop, the replica task on core 1,
// the chain task on core 0) exchange, and how. Every shared object names its lock.
//
//   g_state        BodyState      chain task writes, UI copies       -> g_stateMutex
//   g_replica      flycore::Core  replica ticks, chain setState, UI reads its display fields -> g_replicaMutex
//   g_ring         RingData       replica writes, UI copies          -> g_replicaMutex
//   g_accum        Accum          replica adds, chain takes+clears   -> g_replicaMutex
//   g_sense        SenseFrame     UI/sensors write, replica reads    -> g_senseMutex
//   g_cmdQueue     Cmd            UI -> chain task
//   g_senseQueue   SenseEvent     replica -> chain task (interactions)
//   g_sound        int (atomic)   chain -> UI (speaker)
#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <stdint.h>
#include <string>
#include "flycore.h"
#include "rpc.h"
#include "config.h"

namespace rpc { const char* lastError(); }   // implemented in lib/rpc/rpc.cpp (not part of the fixed rpc.h)

enum class Phase : uint8_t { BOOT, PROVISION, CONNECT, REGISTER, WAIT, HOST, DEAD };
enum class Cmd : uint8_t { HATCH, HANDOFF_SCAN, HANDOFF_CONFIRM, HANDOFF_CANCEL };
enum class Sense : uint8_t { LANDMARK_L, LANDMARK_R, LANDMARK_2, SHOCK };
struct SenseEvent { Sense kind; uint8_t wedge; uint8_t strength; };
enum Sound : int { SND_NONE = 0, SND_CHIRP = 1, SND_DEATH = 2, SND_TICK = 3 };

// What the senses say right now (written by the UI task, which owns the I2C bus, read by the replica task).
struct SenseFrame {
  float yawRateDps = 0;          // gyro yaw, deg/s, positive = turning left (counter-clockwise seen from above)
  bool imuOk = false;
  bool hallL = false, hallR = false, hallSpider = false, hallLm2 = false;
  bool magOk = false; int magWedge = -1;   // wedge (0..15, ring frame) that faces magnetic north
  int touchWedge = -1;           // wedge under a finger on the ring, or -1
};

// What the replica sensed since the last anchor (guarded by g_replicaMutex).
struct Accum {
  uint32_t cueWeight[flycore::WEDGES]; uint8_t cueStrength[flycore::WEDGES];
  uint32_t hallCues, touchCues, magCues, shocks; int magWedge; float netTurnDeg;
  void clear() { memset(this, 0, sizeof *this); magWedge = -1; }
};

// The replica's display data (guarded by g_replicaMutex).
struct RingData {
  float act[flycore::WEDGES];    // 0..1 activity per wedge (mean v+inp over the wedge's EPG cells, squared, like the site)
  uint32_t bins[flycore::WEDGES];// EPG spikes per wedge in the last ~100 ms
  uint16_t hist[flycore::WEDGES];
  float headX, headY;            // smoothed population vector
  float headMag;                 // 0..1
  uint32_t spikesPerS;
  uint64_t step;
  uint8_t stimChannel, stimParam; uint16_t stimStrength; bool stimActive;
  int bump;                      // wedge with the highest activity, -1 if flat
};

struct BodyState {
  Phase phase = Phase::BOOT;
  bool ble = false, rpcOk = false;
  char addrHex[43] = "";         // EIP-55 address
  char addrShort[5] = "";        // last 4 hex, lower-case
  char bodyName[24] = "";        // "Pebble 8a1f"
  uint64_t balanceWei = 0; bool balanceKnown = false, balanceOverflow = false;
  bool flyTokens = false;        // at least 1 $FLY on the pebble: hatch possible
  uint64_t flyId = 0; char flyName[40] = ""; bool alive = false; uint32_t generation = 0;
  int64_t energy = 0;            // local seconds of life
  uint64_t brainStep = 0;        // as last committed
  bool coreEnabled = false;      // FLY_CORE configured
  bool anchored = false; uint64_t chainStep = 0; int32_t chainHeadX = 0, chainHeadY = 0; uint64_t lastAnchorBlock = 0; uint32_t lastAnchorMs = 0;
  bool anchorMismatch = false;   // the replica's hash differed from the chain at the last anchor (resynced)
  char status[96] = "";          // the narration line
  uint32_t statusMs = 0;
  bool txPending = false; char txHash[67] = "";
  bool scanning = false, candidate = false; uint8_t neighbour[20] = {0}; char neighbourShort[5] = ""; int neighbourRssi = 0; uint32_t candidateMs = 0;
  bool hatchArmed = false; uint32_t hatchArmedMs = 0; bool hatching = false;
  uint8_t brainHash[32] = {0};
  uint32_t deadBlock = 0;
  bool showedKey = false;
};

extern BodyState g_state;
extern SemaphoreHandle_t g_stateMutex;
extern flycore::Core* g_replica;
extern flycore::Circuit g_circuit;
extern SemaphoreHandle_t g_replicaMutex;
extern RingData g_ring;
extern Accum g_accum;
extern SenseFrame g_sense;
extern SemaphoreHandle_t g_senseMutex;
extern QueueHandle_t g_cmdQueue;
extern QueueHandle_t g_senseQueue;
extern volatile int g_sound;
extern rpc::Wallet g_wallet;

// narration (thread-safe; printf-style, truncated to the status line)
void setStatus(const char* fmt, ...);
// copy of the state for the UI (thread-safe)
void copyState(BodyState& out);
// "8a1f": the last four hex digits of an address
void shortAddr(const uint8_t a[20], char out[5]);
// heading in degrees 0..359 of a population vector, or -1 when it is zero
int headingDeg(float x, float y);

struct Lock {   // RAII mutex
  SemaphoreHandle_t m;
  explicit Lock(SemaphoreHandle_t mm) : m(mm) { xSemaphoreTake(m, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(m); }
};
