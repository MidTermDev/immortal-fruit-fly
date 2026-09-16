// The speech strip's first-person lines (UI.md "Speech lines"): newest wins, each shown >= SPEECH_HOLD_MS.
// Pure logic: src/ui.cpp feeds it once per frame from the pebble's state; the native test drives it directly.
#pragma once
#include <stdint.h>
#include "model.h"

namespace screen {

constexpr uint32_t SPEECH_HOLD_MS = 2500;
constexpr int SPEECH_LEN = 96;

// What the speaker looks at each frame. Edge events (`*Seq` counters) are counted by the feeder: a change means
// "it happened again"; the strings that go with them describe the newest one.
struct SpeechInput {
  bool hasFly = false, alive = true, hatching = false;
  bool hostOffline = false;          // hosting, but no fresh frames from the brain host
  Mode mode = Mode::UNKNOWN;
  bool foodNear = false;             // a food within 10 body lengths
  bool eating = false;               // GRN rate high / on food
  bool predatorNear = false;         // within 40 body lengths
  int64_t energy = 0;                // seconds of life
  uint32_t jumpSeq = 0, caughtSeq = 0, ateSeq = 0, fedSeq = 0, anchorSeq = 0, pokeSeq = 0;
  int fedSecs = 0; char fedBy[16] = "";       // "0x8a.." or ""
  int ateSecs = 0;
  uint64_t anchorBlock = 0;
  char pokeBy[16] = "";              // "0x8a12..9f3c" from the Stimulated event, or ""
  uint8_t pokeChannel = 0, pokeParam = 0;   // flycore's channel (mirrored: 1 cue on wedge pokeParam, 2 turn left, 3 turn right, 4 shock)
};
enum PokeChannel : uint8_t { POKE_NONE = 0, POKE_CUE = 1, POKE_TURN_LEFT = 2, POKE_TURN_RIGHT = 3, POKE_SHOCK = 4 };

class Speech {
 public:
  Speech() { line_[0] = 0; pending_[0] = 0; }
  // decide the line for this frame
  void update(uint32_t nowMs, const SpeechInput& in);
  const char* line() const { return line_; }
  uint32_t shownMs(uint32_t now) const { return now - sinceMs_; }
  // a line from outside the rules (tests, or the pebble's own narration); goes through the same hold
  void say(uint32_t nowMs, const char* text);

 private:
  char line_[SPEECH_LEN];
  char pending_[SPEECH_LEN];
  bool havePending_ = false;
  uint32_t sinceMs_ = 0;
  bool started_ = false;
  SpeechInput prev_;
  bool havePrev_ = false;
  int hungerLevel_ = 0;              // 0 fine, 1 < 20 min, 2 < 5 min
  bool saidThere_ = false;
  uint32_t lastRestateMs_ = 0;
  void queue(const char* text);
  void flush(uint32_t now);
};

// the seconds as "600 s" / "1h22" style words used by the lines
void fmtSecs(int64_t s, char* out, int cap);

}  // namespace screen
