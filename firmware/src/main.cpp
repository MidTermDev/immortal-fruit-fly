// The pebble body (HARDWARE.md §4): boot -> wallet -> Wi-Fi -> register -> wait -> host -> dead, with the screen,
// buttons and senses on the Arduino loop (core 1), the bit-exact replica on its own task (core 1) and everything
// that talks to BNB Smart Chain on the chain task (core 0). See src/pebble.h for how the tasks share state.
#include <Arduino.h>
#include <M5Unified.h>
#include <WiFi.h>
#include <stdarg.h>
#include "pebble.h"
#include "wallet.h"
#include "net.h"
#include "sensors.h"
#include "replica.h"
#include "chain.h"
#include "host.h"
#include "ble.h"
#include "ui.h"

// ---- shared state (see pebble.h)
BodyState g_state;
SemaphoreHandle_t g_stateMutex = nullptr;
flycore::Core* g_replica = nullptr;
flycore::Circuit g_circuit;
SemaphoreHandle_t g_replicaMutex = nullptr;
RingData g_ring;
Accum g_accum;
SenseFrame g_sense;
SemaphoreHandle_t g_senseMutex = nullptr;
QueueHandle_t g_cmdQueue = nullptr;
QueueHandle_t g_senseQueue = nullptr;
HostView g_host;
SemaphoreHandle_t g_hostMutex = nullptr;
QueueHandle_t g_hostSenseQueue = nullptr;
volatile int g_sound = SND_NONE;
rpc::Wallet g_wallet;
static bool s_viewLife = true;   // button B: Life (the brain host's stream) or Neurons (the on-chain core's raster)

void setStatus(const char* fmt, ...) {
  char b[sizeof g_state.status];
  va_list ap; va_start(ap, fmt); vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  Serial.printf("[status] %s\n", b);
  if (!g_stateMutex) { strlcpy(g_state.status, b, sizeof g_state.status); return; }
  Lock l(g_stateMutex);
  strlcpy(g_state.status, b, sizeof g_state.status);
  g_state.statusMs = millis();
}

void copyState(BodyState& out) { Lock l(g_stateMutex); out = g_state; }

void shortAddr(const uint8_t a[20], char out[5]) { snprintf(out, 5, "%02x%02x", a[18], a[19]); }

int headingDeg(float x, float y) {
  if (x == 0 && y == 0) return -1;
  int d = (int)lroundf(atan2f(y, x) * 57.2957795f);
  return ((d % 360) + 360) % 360;
}

static char s_apName[24];

static void provisionTick() { M5.update(); }

void setup() {
  auto cfg = M5.config();
  cfg.internal_imu = true;
  cfg.internal_spk = true;
  cfg.internal_mic = false;
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Speaker.setVolume(SPEAKER_VOLUME);
  g_stateMutex = xSemaphoreCreateMutex();
  g_hostMutex = xSemaphoreCreateMutex();
  g_cmdQueue = xQueueCreate(4, sizeof(Cmd));
  g_senseQueue = xQueueCreate(8, sizeof(SenseEvent));
  g_hostSenseQueue = xQueueCreate(8, sizeof(SenseEvent));
  uiInit();
  uiBootMessage("booting", "immortal fruit fly pebble");

  // the radio must be on for esp_random() to be a true RNG (the first boot makes the key)
  WiFi.mode(WIFI_STA);
  bool created = false, fixed = false;
  if (!walletInit(g_wallet, created, fixed)) { uiBootMessage("wallet error", "could not make a key"); for (;;) delay(1000); }
  {
    std::string cs = ethtx::checksumAddress(g_wallet.addr);
    Lock l(g_stateMutex);
    strlcpy(g_state.addrHex, cs.c_str(), sizeof g_state.addrHex);
    shortAddr(g_wallet.addr, g_state.addrShort);
    snprintf(g_state.bodyName, sizeof g_state.bodyName, "%s%s", BODY_NAME_PREFIX, g_state.addrShort);
    g_state.coreEnabled = strlen(FLY_CORE) == 42;
  }
  snprintf(s_apName, sizeof s_apName, "FLY-PEBBLE-%s", g_state.addrShort);
  Serial.printf("[wallet] %s (%s)\n", g_state.addrHex, fixed ? "fixed key" : created ? "new key in NVS" : "key from NVS");
  uiBootMessage(g_state.bodyName, g_state.addrHex);

  replicaInit();
  sensorsInit();

  // Wi-Fi: secrets.h, else NVS, else the captive portal
  NetConfig nc = netConfig();
  if (nc.ssid.empty()) {
    setStatus("no Wi-Fi configured: join %s", s_apName);
    { Lock l(g_stateMutex); g_state.phase = Phase::PROVISION; }
    uiProvisionPage(s_apName);
    netProvisionPortal(s_apName, provisionTick);   // never returns
  }
  { Lock l(g_stateMutex); g_state.phase = Phase::CONNECT; }
  uiBootMessage("joining Wi-Fi", "the fly is waking up");   // the network name stays off the screen
  if (!netConnect(nc, 20000)) {
    if (nc.fromSecrets) {
      // wrong secrets and no way to fix them from the device: keep trying in the background, the UI says so
      setStatus("Wi-Fi not reachable; retrying");
    } else {
      // NVS credentials that do not work: offer the portal again
      setStatus("Wi-Fi failed: join %s to fix", s_apName);
      uiProvisionPage(s_apName);
      netProvisionPortal(s_apName, provisionTick);
    }
  } else {
    setStatus("Wi-Fi connected");
  }
  Serial.printf("[net] rpc %s\n", nc.rpcUrl.c_str());

  // radios and tasks
  bool ble = bleStart(g_wallet.addr);
  { Lock l(g_stateMutex); g_state.ble = ble; }
  replicaStart();
  hostStart();
  chainStart(nc.rpcUrl);
}

// ---- the UI loop: buttons, senses, one frame

static void playSounds() {
  int s = g_sound;
  if (s == SND_NONE) return;
  g_sound = SND_NONE;
  if (s == SND_CHIRP) { M5.Speaker.tone(1760, 60); delay(70); M5.Speaker.tone(2349, 60); delay(70); M5.Speaker.tone(2960, 90); }
  else if (s == SND_DEATH) { M5.Speaker.tone(196, 700); }
  else if (s == SND_TICK) { M5.Speaker.tone(1200, 15); }
  else if (s == SND_BLIP) { M5.Speaker.tone(3520, 25); }                                   // jumped
  else if (s == SND_LOW) { M5.Speaker.tone(147, 250); delay(260); M5.Speaker.tone(110, 350); }   // caught
}

static void handleButtons(BodyState& s) {
  // hold A + C for KEY_SHOW_HOLD_MS: the private key, once
  static uint32_t bothSince = 0;
  static bool keyShown = false;
  bool both = M5.BtnA.isPressed() && M5.BtnC.isPressed();
  if (both) {
    if (!bothSince) bothSince = millis();
    else if (!keyShown && millis() - bothSince >= KEY_SHOW_HOLD_MS) {
      keyShown = true;
      { Lock l(g_stateMutex); g_state.showedKey = true; }
      uiShowKey(walletPrivHex(g_wallet), s.addrHex);
      return;
    }
  } else bothSince = 0;

  // UI.md "Buttons": A = the feed hint page (6 s), B = Life <-> Neurons, C = hatch / hand-off
  // hosting: hold C to scan for a hand-off, C to confirm, A/B to cancel
  if (s.phase == Phase::HOST) {
    if (s.candidate) {
      if (M5.BtnC.wasClicked()) { Cmd c = Cmd::HANDOFF_CONFIRM; xQueueSend(g_cmdQueue, &c, 0); }
      else if (M5.BtnA.wasClicked() || M5.BtnB.wasClicked() || millis() - s.candidateMs > HANDOFF_CONFIRM_S * 1000UL) { Cmd c = Cmd::HANDOFF_CANCEL; xQueueSend(g_cmdQueue, &c, 0); }
    } else if (M5.BtnC.wasHold() && !s.scanning) { Cmd c = Cmd::HANDOFF_SCAN; xQueueSend(g_cmdQueue, &c, 0); }
    else if (M5.BtnB.wasClicked()) s_viewLife = !s_viewLife;
    else if (M5.BtnA.wasClicked()) uiFeedHint();
    return;
  }
  if (s.phase == Phase::DEAD && M5.BtnA.wasClicked()) uiFeedHint();
  // hatch: C twice within HATCH_CONFIRM_S on a pebble that has $FLY and no fly
  if ((s.phase == Phase::WAIT || s.phase == Phase::DEAD) && s.flyTokens && !s.hatching) {
    if (M5.BtnC.wasClicked()) {
      Lock l(g_stateMutex);
      if (g_state.hatchArmed && millis() - g_state.hatchArmedMs <= HATCH_CONFIRM_S * 1000UL) {
        g_state.hatchArmed = false;
        Cmd c = Cmd::HATCH; xQueueSend(g_cmdQueue, &c, 0);
        snprintf(g_state.status, sizeof g_state.status, "hatching: approve + mint + assign (1 $FLY)");
      } else {
        g_state.hatchArmed = true; g_state.hatchArmedMs = millis();
        snprintf(g_state.status, sizeof g_state.status, "press C again within %d s to hatch a fly (burns 1 $FLY)", HATCH_CONFIRM_S);
      }
    } else if (s.hatchArmed && millis() - s.hatchArmedMs > HATCH_CONFIRM_S * 1000UL) {
      Lock l(g_stateMutex); g_state.hatchArmed = false;
    }
  }
}

void loop() {
  static int touchWedge = -1;
  const uint32_t framePeriod = 1000 / UI_FPS;
  uint32_t t0 = millis();

  M5.update();
  playSounds();
  sensorsPoll(touchWedge);

  BodyState s; copyState(s);
  handleButtons(s);

  static RingData r;   // the raster columns make it ~400 bytes: a static copy
  { Lock l(g_replicaMutex); r = g_ring; g_ring.spkColN = 0; }   // the UI takes this frame's raster columns
  static HostView h;   // ~5 KB: a static copy, not a stack one
  { Lock l(g_hostMutex); h = g_host; }
  // the Life page while the host's frames are fresh (and the user did not switch to the Neurons page); else Neurons
  bool life = s_viewLife && s.phase == Phase::HOST && hostFresh(h, millis()) && h.frame.generation == s.generation;
  touchWedge = uiFrame(s, r, h, netConnected(), replicaHosting(), life);

  // pace the loop to UI_FPS without ever blocking on the network
  uint32_t spent = millis() - t0;
  if (spent < framePeriod) delay(framePeriod - spent);
}
