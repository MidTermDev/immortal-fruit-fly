// The screen (HARDWARE.md §4.6), drawn on one PSRAM sprite per frame so nothing flickers.
#pragma once
#include <stdint.h>
#include <string>
#include "pebble.h"

void uiInit();
// one frame from copies of the shared state; returns the wedge under a finger on the ring (or -1) for the senses
int uiFrame(const BodyState& s, const RingData& r, bool wifi, bool hostingRing);
// full-screen modal pages
void uiBootMessage(const char* line1, const char* line2 = nullptr);
void uiShowKey(const std::string& privHex, const char* addr);   // blocks until a button is pressed
void uiProvisionPage(const char* apName);                        // drawn once; the portal loop keeps M5.update() alive
// the flick of the screen on a shock
void uiFlash();
