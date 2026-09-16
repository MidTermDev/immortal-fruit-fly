// The abstract painter every page draws on (UI.md "Implementation contract"). Pure C++17: no Arduino, no M5GFX.
// src/ui.cpp implements it on the M5GFX sprite; test/test_screen implements it on an RGB buffer.
//
// Coordinates are screen pixels (320 x 240, y down). Colours are RGB565. Text is drawn with its top-left (or
// top-centre / top-right) at (x, y) in one of three fonts: 0 = Font0 (5x7, 8 px line), 1 = Font2 (16 px),
// 2 = FreeSansBold12pt7b (23 px line, the one big word).
#pragma once
#include <stdint.h>
#include "raster.h"

namespace screen {

typedef uint16_t Color;

constexpr Color rgb565(int r, int g, int b) { return (Color)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | ((b & 0xF8) >> 3)); }
constexpr int red5(Color c) { return (c >> 11) & 31; }
constexpr int green6(Color c) { return (c >> 5) & 63; }
constexpr int blue5(Color c) { return c & 31; }
// a + (b - a) * t / 256
constexpr Color mixc(Color a, Color b, int t) {
  return (Color)((((red5(a) + ((red5(b) - red5(a)) * t) / 256) & 31) << 11) | (((green6(a) + ((green6(b) - green6(a)) * t) / 256) & 63) << 5) |
                 ((blue5(a) + ((blue5(b) - blue5(a)) * t) / 256) & 31));
}

// UI.md palette (the site's, on the dark ground)
namespace col {
constexpr Color BG = rgb565(0x0d, 0x0f, 0x12);
constexpr Color BG2 = rgb565(0x16, 0x1a, 0x1f);
constexpr Color INK = rgb565(0xe8, 0xe6, 0xe0);
constexpr Color DIM = rgb565(0x8a, 0x91, 0x9c);
constexpr Color AMBER = rgb565(0xf0, 0xb4, 0x29);
constexpr Color RED = rgb565(0xff, 0x5a, 0x35);
constexpr Color ICE = rgb565(0x58, 0xc4, 0xf5);
constexpr Color GREEN = rgb565(0x42, 0xb8, 0x9e);
constexpr Color VIOLET = rgb565(0xd9, 0x73, 0xbf);
// derived shades used everywhere (blends toward the ground)
constexpr Color GRID = mixc(BG, DIM, 40);
constexpr Color DIM2 = mixc(BG, DIM, 128);
constexpr Color AMBER_DIM = mixc(BG, AMBER, 110);
constexpr Color AMBER_DARK = mixc(BG, AMBER, 48);
constexpr Color ICE_DARK = mixc(BG, ICE, 60);
constexpr Color ICE_DIM = mixc(BG, ICE, 130);
constexpr Color RED_DARK = mixc(BG, RED, 90);
}  // namespace col

enum Font : uint8_t { F_SMALL = 0, F_MED = 1, F_BIG = 2 };
enum Align : uint8_t { A_LEFT = 0, A_CENTER = 1, A_RIGHT = 2 };
constexpr int FONT_H[3] = {8, 16, 23};   // line heights of Font0, Font2, FreeSansBold12pt7b (ascent 17 + descent 6)

constexpr int SCREEN_W = 320, SCREEN_H = 240;

class Painter {
 public:
  virtual ~Painter() {}
  virtual int width() const { return SCREEN_W; }
  virtual int height() const { return SCREEN_H; }
  // ---- primitives (implemented by the backend)
  virtual void fillRect(int x, int y, int w, int h, Color c) = 0;
  virtual void drawLine(int x0, int y0, int x1, int y1, Color c) = 0;
  virtual void fillCircle(int cx, int cy, int r, Color c) = 0;
  virtual void drawCircle(int cx, int cy, int r, Color c) = 0;
  virtual void fillTriangle(int x0, int y0, int x1, int y1, int x2, int y2, Color c) = 0;
  virtual void drawText(int x, int y, const char* s, Font f, Color c, Align a) = 0;
  virtual int textWidth(const char* s, Font f) = 0;
  // ---- optional (defaults build on the primitives)
  virtual void drawPixel(int x, int y, Color c) { fillRect(x, y, 1, 1, c); }
  virtual void drawRect(int x, int y, int w, int h, Color c);
  // a convex polygon (xy = x0,y0,x1,y1,...): a fan of triangles / a closed outline
  virtual void fillPoly(const int16_t* xy, int n, Color c);
  virtual void drawPoly(const int16_t* xy, int n, Color c);
  // clipping: pages keep everything inside their panels anyway; backends may ignore it
  virtual void setClip(int x, int y, int w, int h) { (void)x; (void)y; (void)w; (void)h; }
  virtual void clearClip() {}
  // the live raster (Neurons page): column k of the ring drawn at x + RASTER_COLS - count + k, one pixel per spike at
  // row y + rowY[neuron] in rowColor[neuron]. The default draws every set bit as a pixel; the device keeps the raster
  // in a scrolling off-screen sprite and only draws the new columns.
  virtual void drawRaster(int x, int y, const Raster& r, const uint8_t* rowY, const Color* rowColor);
  // a QR code of `text` at most maxPx wide (the backend owns the encoder); returns the side drawn in px. The default
  // draws a placeholder frame.
  virtual int drawQR(int x, int y, int maxPx, const char* text, Color fg, Color bg);
};

}  // namespace screen
