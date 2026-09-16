#include "replica.h"
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <math.h>
#include <new>
#include "pebble.h"
#include "ui.h"
#include "../fixtures/circuit_table.h"
#include "../fixtures/params.h"

using namespace flycore;

static volatile bool s_hosting = false;

void replicaInit() {
  if (!g_circuit.load(CIRCUIT_TABLE, CIRCUIT_TABLE_LEN)) {
    Serial.println("[replica] circuit table rejected");   // cannot happen: the table is the deployed one
    for (;;) delay(1000);
  }
  // The Core is ~7 KB: keep it in internal RAM (malloc above 4 KB would land in PSRAM on this sdkconfig).
  void* mem = heap_caps_malloc(sizeof(Core), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!mem) mem = malloc(sizeof(Core));
  g_replica = new (mem) Core(g_circuit, PARAMS_V2);
  g_replicaMutex = xSemaphoreCreateMutex();
  g_senseMutex = xSemaphoreCreateMutex();
  memset(&g_ring, 0, sizeof g_ring);
  g_ring.bump = -1;
  g_accum.clear();
  Serial.printf("[replica] N=%d S=%d core ready\n", g_circuit.N, g_circuit.S);
}

void replicaSetHosting(bool on) { s_hosting = on; }
bool replicaHosting() { return s_hosting; }

static inline uint8_t clampStrength(float v, int hi) {
  int s = (int)(v + 0.5f);
  if (s < 1) s = 1;
  if (s > hi) s = hi;
  return (uint8_t)s;
}

// Per-wedge activity like the site's wedgeActivity(): mean of v + pending input over the wedge's EPG/EPGt cells,
// normalised to 0..1 and squared; flat ring (spread < 80) = no bump.
static void computeActivity(const Core& c, float act[WEDGES], int& bump) {
  const Circuit& cc = c.circuit();
  float sum[WEDGES] = {0}; int cnt[WEDGES] = {0};
  for (int i = 0; i < cc.N; ++i) {
    if (cc.type[i] <= T_EPGT && cc.wedge[i] != NO_WEDGE) { sum[cc.wedge[i]] += (float)c.v[i] + (float)c.inp[i]; cnt[cc.wedge[i]]++; }
  }
  float lo = 1e30f, hi = -1e30f, mean[WEDGES];
  for (int w = 0; w < WEDGES; ++w) {
    mean[w] = cnt[w] ? sum[w] / cnt[w] : NAN;
    if (cnt[w]) { if (mean[w] < lo) lo = mean[w]; if (mean[w] > hi) hi = mean[w]; }
  }
  bump = -1;
  if (!(hi - lo > 80)) { for (int w = 0; w < WEDGES; ++w) act[w] = 0; return; }
  float best = -1;
  for (int w = 0; w < WEDGES; ++w) {
    float a = cnt[w] ? (mean[w] - lo) / (hi - lo) : 0;
    act[w] = a * a;
    if (act[w] > best) { best = act[w]; bump = w; }
  }
}

static void pushSense(Sense k, uint8_t wedge, uint8_t strength) {
  SenseEvent e{k, wedge, strength, millis()};
  xQueueSend(g_senseQueue, &e, 0);   // drop when the chain task is behind
}
// the same sense for the brain host (POST /sense); the host task rate-limits it to one a second
static void pushHostSense(Sense k, uint8_t wedge, uint8_t strength) {
  SenseEvent e{k, wedge, strength, millis()};
  if (g_hostSenseQueue) xQueueSend(g_hostSenseQueue, &e, 0);
}

static void replicaTask(void*) {
  const TickType_t period = pdMS_TO_TICKS(1000 / LOCAL_STEPS_PER_S);
  TickType_t last = xTaskGetTickCount();
  uint32_t lastMagMs = 0, lastLandmarkEventMs = 0, lastShockEventMs = 0;
  bool prevL = false, prevR = false, prevLm2 = false, prevSpider = false; int prevTouch = -1;
  uint32_t spikeWindow = 0, windowStartMs = millis();
  float binsDecay[WEDGES] = {0};
  float headX = 0, headY = 0;
  const float dt = 1.0f / LOCAL_STEPS_PER_S;

  for (;;) {
    vTaskDelayUntil(&last, period);
    SenseFrame s;
    { Lock l(g_senseMutex); s = g_sense; }
    uint32_t now = millis();

    // sense edges -> interactions (rate-limited: HARDWARE.md §4.4 counts ~35k gas per interaction) and, when a
    // brain host runs the whole brain, the same edges as sense events in the fly's world (every edge; the host task
    // keeps them to one a second)
    if (s_hosting) {
      bool landmark = (s.hallL && !prevL) || (s.hallR && !prevR) || (s.hallLm2 && !prevLm2);
      if (landmark && now - lastLandmarkEventMs >= LANDMARK_INTERACTION_EVERY_S * 1000UL) {
        lastLandmarkEventMs = now;
        if (s.hallL && !prevL) pushSense(Sense::LANDMARK_L, HALL_L_WEDGE, HALL_CUE_STRENGTH);
        else if (s.hallR && !prevR) pushSense(Sense::LANDMARK_R, HALL_R_WEDGE, HALL_CUE_STRENGTH);
        else pushSense(Sense::LANDMARK_2, HALL_LM2_WEDGE, HALL_CUE_STRENGTH);
      }
      if (s.hallL && !prevL) pushHostSense(Sense::LANDMARK_L, HALL_L_WEDGE, HALL_CUE_STRENGTH);
      if (s.hallR && !prevR) pushHostSense(Sense::LANDMARK_R, HALL_R_WEDGE, HALL_CUE_STRENGTH);
      if (s.hallLm2 && !prevLm2) pushHostSense(Sense::LANDMARK_2, HALL_LM2_WEDGE, HALL_CUE_STRENGTH);
      if (s.hallSpider && !prevSpider && now - lastShockEventMs >= LANDMARK_INTERACTION_EVERY_S * 1000UL) {
        lastShockEventMs = now;
        pushSense(Sense::SHOCK, 0, SHOCK_STRENGTH);
      }
      if (s.hallSpider && !prevSpider) pushHostSense(Sense::SHOCK, 0, SHOCK_STRENGTH);
      if (s.touchWedge >= 0 && s.touchWedge != prevTouch) pushHostSense(Sense::TOUCH, (uint8_t)s.touchWedge, TOUCH_CUE_STRENGTH);
    }
    bool shockEdge = s.hallSpider && !prevSpider;
    if (shockEdge && s_hosting) uiFlash();   // the screen flashes, the fly freezes
    prevL = s.hallL; prevR = s.hallR; prevLm2 = s.hallLm2; prevSpider = s.hallSpider; prevTouch = s.touchWedge;

    // choose this step's stimulus by priority: shock > landmark (hall) > touch > turn > magnetic north
    uint8_t ch = CH_NONE, param = 0, strength = 0; bool isHall = false, isTouch = false, isMag = false;
    if (s.hallSpider) { ch = CH_SHOCK; strength = SHOCK_STRENGTH; }
    else if (s.hallL) { ch = CH_CUE; param = HALL_L_WEDGE; strength = HALL_CUE_STRENGTH; isHall = true; }
    else if (s.hallR) { ch = CH_CUE; param = HALL_R_WEDGE; strength = HALL_CUE_STRENGTH; isHall = true; }
    else if (s.hallLm2) { ch = CH_CUE; param = HALL_LM2_WEDGE; strength = HALL_CUE_STRENGTH; isHall = true; }
    else if (s.touchWedge >= 0) { ch = CH_CUE; param = (uint8_t)s.touchWedge; strength = TOUCH_CUE_STRENGTH; isTouch = true; }
    else if (s.imuOk && fabsf(s.yawRateDps) > GYRO_DEADBAND_DPS) {
      ch = s.yawRateDps > 0 ? CH_TURN_LEFT : CH_TURN_RIGHT;
      strength = clampStrength(fabsf(s.yawRateDps) / GYRO_DIV, TURN_STRENGTH_MAX);
    } else if (s.magOk && now - lastMagMs >= MAG_CUE_EVERY_MS) {
      lastMagMs = now;
      ch = CH_CUE; param = (uint8_t)s.magWedge; strength = MAG_CUE_STRENGTH; isMag = true;
    }

    if (!s_hosting) continue;   // no fly in this body: the ring rests

    {
      Lock l(g_replicaMutex);
      Core& c = *g_replica;
      if (ch != CH_NONE) {
        c.stimulate(ch, param, strength);
        Accum& a = g_accum;
        if (ch == CH_SHOCK) { if (shockEdge || a.shocks == 0) a.shocks++; }
        else if (ch == CH_CUE && (isHall || isTouch)) {
          a.cueWeight[param] += strength; if (strength > a.cueStrength[param]) a.cueStrength[param] = strength;
          if (isHall) a.hallCues++; else a.touchCues++;
        } else if (isMag) { a.magCues++; a.magWedge = param; }
      }
      if (s.imuOk) g_accum.netTurnDeg += s.yawRateDps * dt;

      TickResult r = c.tick(1);
      spikeWindow += r.spikes;
      // this tick's spikes as one raster column for the Neurons page (Core::lastSpk); the UI drains the queue
      {
        if (g_ring.spkColN >= RingData::SPK_COLS) { memmove(g_ring.spkCols[0], g_ring.spkCols[1], sizeof g_ring.spkCols[0] * (RingData::SPK_COLS - 1)); g_ring.spkColN = RingData::SPK_COLS - 1; }
        uint32_t* col = g_ring.spkCols[g_ring.spkColN++];
        memset(col, 0, sizeof(uint32_t) * RingData::SPK_WORDS);
        const int N = c.circuit().N < RingData::SPK_WORDS * 32 ? c.circuit().N : RingData::SPK_WORDS * 32;
        for (int i = 0; i < N; ++i) if (c.lastSpk[i]) col[i >> 5] |= 1u << (i & 31);
      }
      if (now - windowStartMs >= 1000) { g_ring.spikesPerS = spikeWindow; spikeWindow = 0; windowStartMs = now; }
      // a ~100 ms window of EPG spikes per wedge (about 1.4 steps at 14 steps/s): exponential decay
      for (int w = 0; w < WEDGES; ++w) { binsDecay[w] = binsDecay[w] * 0.5f + (float)c.lastBins[w]; g_ring.bins[w] = (uint32_t)(binsDecay[w] + 0.5f); }
      // smoothed population vector; full length at walkThreshold per step, as on the site
      headX = headX * 0.75f + (float)r.headX * 0.25f;
      headY = headY * 0.75f + (float)r.headY * 0.25f;
      g_ring.headX = headX; g_ring.headY = headY;
      float mag = sqrtf(headX * headX + headY * headY) / (float)c.params().walkThreshold;
      g_ring.headMag = mag > 1 ? 1 : mag;
      computeActivity(c, g_ring.act, g_ring.bump);
      memcpy(g_ring.hist, c.hist, sizeof g_ring.hist);
      g_ring.step = c.step;
      g_ring.stimChannel = c.stimChannel; g_ring.stimParam = c.stimParam; g_ring.stimStrength = c.stimStrength;
      g_ring.stimActive = c.stimChannel != CH_NONE && c.step < c.stimUntil;
    }
  }
}

void replicaStart() {
  xTaskCreatePinnedToCore(replicaTask, "replica", 6144, nullptr, 3, nullptr, 1);
}
