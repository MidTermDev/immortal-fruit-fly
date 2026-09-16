#include "painter.h"

namespace screen {

void Painter::drawRect(int x, int y, int w, int h, Color c) {
  if (w <= 0 || h <= 0) return;
  fillRect(x, y, w, 1, c);
  fillRect(x, y + h - 1, w, 1, c);
  if (h > 2) { fillRect(x, y + 1, 1, h - 2, c); fillRect(x + w - 1, y + 1, 1, h - 2, c); }
}

void Painter::fillPoly(const int16_t* xy, int n, Color c) {
  for (int i = 1; i + 1 < n; ++i) fillTriangle(xy[0], xy[1], xy[2 * i], xy[2 * i + 1], xy[2 * i + 2], xy[2 * i + 3], c);
}

void Painter::drawPoly(const int16_t* xy, int n, Color c) {
  for (int i = 0; i < n; ++i) { int j = (i + 1) % n; drawLine(xy[2 * i], xy[2 * i + 1], xy[2 * j], xy[2 * j + 1], c); }
}

void Painter::drawRaster(int x, int y, const Raster& r, const uint8_t* rowY, const Color* rowColor) {
  const int x0 = x + RASTER_COLS - r.count;
  for (int k = 0; k < r.count; ++k) {
    const uint32_t* w = r.column(k);
    for (int i = 0; i < RASTER_WORDS; ++i) {
      uint32_t v = w[i];
      while (v) {
        int b = __builtin_ctz(v); v &= v - 1;
        int row = i * 32 + b;
        if (row < RASTER_ROWS) drawPixel(x0 + k, y + rowY[row], rowColor[row]);
      }
    }
  }
}

// Without an encoder: a framed placeholder with the three finder squares, so layouts can be judged.
int Painter::drawQR(int x, int y, int maxPx, const char* text, Color fg, Color bg) {
  (void)text;
  fillRect(x, y, maxPx, maxPx, bg);
  int m = maxPx / 12;
  int fx[3] = {x + m, x + maxPx - 4 * m, x + m}, fy[3] = {y + m, y + m, y + maxPx - 4 * m};
  for (int i = 0; i < 3; ++i) { fillRect(fx[i], fy[i], 3 * m, 3 * m, fg); fillRect(fx[i] + m / 2 + 1, fy[i] + m / 2 + 1, 2 * m - 2, 2 * m - 2, bg); fillRect(fx[i] + m, fy[i] + m, m, m, fg); }
  return maxPx;
}

}  // namespace screen
