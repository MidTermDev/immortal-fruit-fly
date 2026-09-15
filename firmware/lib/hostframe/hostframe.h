// The brain host protocol as seen by the pebble (brain/HOST_PROTOCOL.md): the lite frame parsed into a compact
// struct, the checkpoint / final payload, and the auth digest + signature. Pure code: ArduinoJson + lib/keccak +
// lib/ethtx, no network, so it compiles natively for test/test_host and on the pebble unchanged.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <ArduinoJson.h>

namespace hostframe {

constexpr int MAX_FOOD = 8;
constexpr int MAX_PUFFS = 4;
constexpr int MAX_EVENTS = 6;
constexpr int EVENT_LEN = 56;
constexpr int MAX_INTERACTIONS = 8;
constexpr int KIND_LEN = 16;
constexpr int DATA_LEN = 96;

enum Mode : uint8_t { M_WANDER = 0, M_SURGE, M_CAST, M_EAT, M_FLEE, M_STILL, M_UNKNOWN };

struct Food { float x, y, energy, energy0; };
struct Puff { float x, y, strength; };            // strength 0..1 (from "s"/"strength", or 1 if the host omits it)
struct Predator { bool present; float x, y, size; };
struct Rates {                                    // the subset the Life view lights up
  float dna02L, dna02R;                           // steering: |L - R|
  float alpn;                                     // smell
  float kc, mbon;                                 // memory
  float lc4L, lc4R;                               // sight
  float grn;                                      // taste
  float dnAll;
};
struct Event { double t_ms; char text[EVENT_LEN]; };

struct LiteFrame {
  double t_ms = 0; uint64_t step = 0;
  float x = 0, y = 0, heading = 0, energy = 0;
  bool alive = false; uint32_t generation = 0;
  double life_ms = 0; uint64_t spikesTotal = 0;
  float ate = 0; uint32_t jumps = 0, hits = 0;
  float arena = 240.f;
  int nfood = 0; Food food[MAX_FOOD];
  Predator predator = {false, 0, 0, 0};
  int npuffs = 0; Puff puffs[MAX_PUFFS];
  Rates rates = {0, 0, 0, 0, 0, 0, 0, 0, 0};
  float steer = 0;
  Mode mode = M_UNKNOWN; char modeText[12] = "";
  int nevents = 0; Event events[MAX_EVENTS];      // the newest MAX_EVENTS of the frame's diary, oldest first
  float realtime = 0; double wall = 0;
  uint32_t checkpoints = 0;
};

// Parses a lite frame (JSON text, `len` bytes). `alloc` may be null (ArduinoJson's default allocator). False if the
// text is not a frame (no "x"/"alive"), too large for the document, or not JSON. Unknown keys are ignored.
bool parseFrame(const char* json, size_t len, LiteFrame& out, ArduinoJson::Allocator* alloc = nullptr);

// The word the Life view shows for a mode: wandering / following a scent / casting / eating / fleeing / still.
Mode modeFromText(const char* s);
const char* modeWord(Mode m);
// what a diary line means for the speaker: 1 ate, 2 jumped, 3 caught, 0 nothing
int eventSound(const char* text);

// ---- /checkpoint and /final payloads
struct Interaction { double t_ms; char kind[KIND_LEN]; char data[DATA_LEN]; };
struct Payload {
  uint8_t stateRoot[32], memoryRoot[32], historyRoot[32];
  std::string stateURI, metadataURI, cause;
  uint64_t brainStep = 0, energy = 0, age_s = 0, spikes = 0; uint32_t generation = 0;
  int ninteractions = 0; Interaction interactions[MAX_INTERACTIONS];   // newest first (sorted by t_ms, descending)
  int listed = 0;                                                      // how many the host listed in total
};
// False if a required field (stateRoot, memoryRoot, stateURI, brainStep) is missing or malformed.
bool parsePayload(const char* json, size_t len, Payload& out, ArduinoJson::Allocator* alloc = nullptr);

// ---- the held checkpoint (the chain task's commit). Fetching /checkpoint is destructive on the host: it pins the
// snapshot and hands over the interactions since the previous checkpoint, which it then forgets. So a payload the
// chain has not accepted yet is kept and re-sent as it is (a new fetch would lose those interactions and orphan the
// pinned snapshot); only its energy is drained by the seconds since the fetch, as the host's own clock drains it.
struct Held {
  bool active = false; Payload p; uint32_t fetchedMs = 0; uint8_t sends = 0, reverts = 0;
  void take(const Payload& payload, uint32_t nowMs) { p = payload; fetchedMs = nowMs; sends = 0; reverts = 0; active = true; }
  void clear() { active = false; sends = 0; reverts = 0; }
  // still the payload to commit: the chain's brainStep is below its own. Once the chain is at or past it, the commit
  // landed (a receipt or the record said so) and only its interactions may still be owed
  bool pending(uint64_t chainStep) const { return active && p.brainStep > chainStep; }
  // the energy to commit now: the host's value at the fetch minus the whole seconds since, never below 0
  uint64_t energyAt(uint32_t nowMs) const;
};
// When the next commit attempt is due: every `everyMs`; or `retryMs` after the last attempt when a held payload waits
// for a send that failed (`retry`). Never early while a sent commit still awaits its receipt (that is not `retry`).
bool commitDue(uint32_t nowMs, uint32_t lastMs, uint32_t everyMs, bool retry, uint32_t retryMs);

// ---- auth: digest = keccak256(ascii "flyhost|<id>|<ts>"), signed raw (no EIP-191 prefix), sig = r||s||v, v = 27 + recid
size_t authMessage(uint64_t id, uint64_t ts, char* out, size_t cap);   // the ascii text; returns its length
void authDigest(uint64_t id, uint64_t ts, uint8_t out[32]);
bool authSign(uint64_t id, uint64_t ts, const uint8_t priv[32], uint8_t sig65[65]);
std::string authSigHex(const uint8_t sig65[65]);                          // "0x" + 130 hex digits (X-Fly-Sig)

// hex helpers used by the parser (0x-prefixed, exactly 32 bytes)
bool hex32(const char* s, uint8_t out[32]);
// an HTTP Date header ("Tue, 15 Sep 2026 12:34:56 GMT") as unix seconds, 0 if unparsable: a clock for X-Fly-Ts
double httpDate(const char* s);

}  // namespace hostframe
