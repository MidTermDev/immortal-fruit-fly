// The screen (UI.md, HARDWARE.md §4.6), drawn on one PSRAM sprite per frame so nothing flickers.
#pragma once
#include <stdint.h>
#include <string>
#include "pebble.h"

void uiInit();
// one frame from copies of the shared state; returns the wedge under a finger on the halo (or -1) for the senses.
// `life` asks for the Life page (the brain host's stream in h) instead of the Neurons page (the on-chain core's
// raster); the pages themselves live in lib/screen (UI.md), ui.cpp only feeds the Model and paints on the sprite.
int uiFrame(const BodyState& s, const RingData& r, const HostView& h, bool wifi, bool hostingRing, bool life);
// button A: the feed hint page (address QR + the fly page URL) for 6 s
void uiFeedHint();
// full-screen modal pages
void uiBootMessage(const char* line1, const char* line2 = nullptr);
void uiShowKey(const std::string& privHex, const char* addr);   // blocks until a button is pressed
void uiProvisionPage(const char* apName);                        // drawn once; the portal loop keeps M5.update() alive
// the flick of the screen on a shock
void uiFlash();
