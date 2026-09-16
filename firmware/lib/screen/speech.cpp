#include "speech.h"
#include <stdio.h>
#include <string.h>

namespace screen {

void fmtSecs(int64_t s, char* out, int cap) {
  if (s < 0) s = 0;
  if (s >= 3600) snprintf(out, cap, "%lldh%02lld", (long long)(s / 3600), (long long)((s % 3600) / 60));
  else snprintf(out, cap, "%lld s", (long long)s);
}

void Speech::queue(const char* text) {
  if (!text || !*text) return;
  strncpy(pending_, text, SPEECH_LEN - 1); pending_[SPEECH_LEN - 1] = 0;
  havePending_ = true;
}

void Speech::flush(uint32_t now) {
  if (!havePending_) return;
  if (started_ && (uint32_t)(now - sinceMs_) < SPEECH_HOLD_MS) return;   // the current line is held
  havePending_ = false;
  if (started_ && !strcmp(pending_, line_)) return;                      // nothing new to say
  memcpy(line_, pending_, SPEECH_LEN);
  sinceMs_ = now; started_ = true; lastRestateMs_ = now;
}

void Speech::say(uint32_t nowMs, const char* text) { queue(text); flush(nowMs); }

void Speech::update(uint32_t now, const SpeechInput& in) {
  char b[SPEECH_LEN], secs[16];
  const SpeechInput& p = prev_;
  const bool first = !havePrev_;

  // ---- edge events: the newest wins (queued in the order they are noticed; the last one queued shows)
  if (!first) {
    if (in.hostOffline && !p.hostOffline) queue("my brain host is away; my compass still works");
    if (in.hasFly && in.alive) {
      if (in.mode == Mode::SURGE && p.mode != Mode::SURGE) { queue("I smell something..."); saidThere_ = false; }
      if (in.mode == Mode::SURGE && in.foodNear && !saidThere_) { queue("there!"); saidThere_ = true; }
      if (in.mode == Mode::CAST && p.mode != Mode::CAST) queue("where did it go?");
      if (in.eating && !p.eating) queue("yum");
      if (in.predatorNear && !p.predatorNear) queue("a shadow!");
      int level = in.energy < 300 ? 2 : in.energy < 1200 ? 1 : 0;
      if (level > hungerLevel_) queue(level == 2 ? "so hungry..." : "getting hungry...");
      hungerLevel_ = level;
    }
    if (in.ateSeq != p.ateSeq) {
      if (in.ateSecs > 0) { fmtSecs(in.ateSecs, secs, sizeof secs); snprintf(b, sizeof b, "%s of life, nice", secs); queue(b); }
      else queue("yum");
    }
    if (in.jumpSeq != p.jumpSeq) queue("jumped!");
    if (in.caughtSeq != p.caughtSeq) queue("ouch");
    if (in.fedSeq != p.fedSeq) {
      fmtSecs(in.fedSecs, secs, sizeof secs);
      if (in.fedBy[0]) snprintf(b, sizeof b, "fed %s by %s thanks", secs, in.fedBy); else snprintf(b, sizeof b, "fed %s, thanks", secs);
      queue(b);
    }
    if (in.anchorSeq != p.anchorSeq && in.anchorBlock) {
      unsigned long long n = in.anchorBlock;
      // thousands separators
      char num[32]; int len = snprintf(num, sizeof num, "%llu", n);
      char sep[40]; int o = 0;
      for (int i = 0; i < len; ++i) { if (i && (len - i) % 3 == 0) sep[o++] = ','; sep[o++] = num[i]; }
      sep[o] = 0;
      snprintf(b, sizeof b, "anchored my neurons on-chain %c block %s", DOT_CH, sep);   // the dot: drawLabel draws it
      queue(b);
    }
    if (in.pokeSeq != p.pokeSeq) {
      char what[24];
      if (in.pokeChannel == POKE_CUE) snprintf(what, sizeof what, "a cue on wedge %u", (unsigned)(in.pokeParam & 15));
      else snprintf(what, sizeof what, "%s", in.pokeChannel == POKE_TURN_LEFT ? "turn left!" : in.pokeChannel == POKE_TURN_RIGHT ? "turn right!" : "shock!");
      snprintf(b, sizeof b, "%s poked me: %s", in.pokeBy[0] ? in.pokeBy : "someone", what);
      queue(b);
    }
  } else {
    hungerLevel_ = in.energy < 300 ? 2 : in.energy < 1200 ? 1 : 0;
  }

  // ---- the standing line: what it would say about its state right now (shown first, and restated when quiet)
  const char* base;
  if (!in.hasFly) base = "waiting for a fly...";
  else if (in.hatching) base = "hello, world";
  else if (!in.alive) base = "resurrect me?";
  else if (in.hostOffline) base = "my brain host is away; my compass still works";
  else if (in.eating) base = "yum";
  else if (in.predatorNear) base = "a shadow!";
  else if (in.energy < 300) base = "so hungry...";
  else if (in.mode == Mode::SURGE) base = in.foodNear ? "there!" : "I smell something...";
  else if (in.mode == Mode::CAST) base = "where did it go?";
  else if (in.energy < 1200) base = "getting hungry...";
  else if (in.mode == Mode::STILL) base = "resting";
  else base = "just walking";
  if (!started_ && !havePending_) queue(base);
  else if (!havePending_ && (uint32_t)(now - lastRestateMs_) > 20000 && strcmp(base, line_)) { queue(base); lastRestateMs_ = now; }

  flush(now);
  prev_ = in; havePrev_ = true;
}

}  // namespace screen
