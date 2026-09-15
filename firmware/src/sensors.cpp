#include "sensors.h"
#include <M5Unified.h>
#include <math.h>
#include "pebble.h"

// Port B pins are ADC1 channels (G8 = ADC1_CH7, G9 = ADC1_CH8) so a 49E analog board can be auto-detected there.
// Port C (G17/G18) is ADC2, which is unusable while Wi-Fi is on: digital switches only.
struct Hall { uint8_t pin; bool analog; int idleMv; bool state; };
static Hall s_hall[4] = {{HALL_L_PIN, false, 3300, false}, {HALL_R_PIN, false, 3300, false}, {HALL_SPIDER_PIN, false, 3300, false}, {HALL_LM2_PIN, false, 3300, false}};

static float s_magMin[3] = {1e9f, 1e9f, 1e9f}, s_magMax[3] = {-1e9f, -1e9f, -1e9f};

void sensorsInit() {
  for (int i = 0; i < 4; ++i) {
    pinMode(s_hall[i].pin, INPUT_PULLUP);
  }
  delay(5);
  // auto-detect on Port B: a digital switch idles at 3.3 V (pulled up, open collector), a 49E at ~1.65 V
  for (int i = 0; i < 2; ++i) {
    int mv = 0;
    for (int k = 0; k < 8; ++k) mv += analogReadMilliVolts(s_hall[i].pin);
    mv /= 8;
    s_hall[i].idleMv = mv;
    s_hall[i].analog = mv > 1100 && mv < 2400;
    Serial.printf("[sensors] hall %c on G%d idles at %d mV -> %s\n", i ? 'R' : 'L', s_hall[i].pin, mv, s_hall[i].analog ? "analog 49E" : "digital switch");
    if (!s_hall[i].analog) pinMode(s_hall[i].pin, INPUT_PULLUP);   // analogRead may have reconfigured the pad
  }
  Serial.printf("[sensors] imu %s\n", M5.Imu.isEnabled() ? "ok" : "absent");
}

bool sensorsHallAnalog(int idx) { return idx >= 0 && idx < 2 && s_hall[idx].analog; }

static bool readHall(int i) {
  Hall& h = s_hall[i];
  if (h.analog) {
    int mv = analogReadMilliVolts(h.pin);
    int dev = abs(mv - h.idleMv);
    // hysteresis around ±15% of the idle value
    int on = h.idleMv * 15 / 100, off = h.idleMv * 10 / 100;
    if (!h.state && dev > on) h.state = true;
    else if (h.state && dev < off) h.state = false;
    return h.state;
  }
  return digitalRead(h.pin) == LOW;   // active low
}

void sensorsPoll(int touchWedge) {
  SenseFrame f;
  f.touchWedge = touchWedge;
  f.hallL = readHall(0);
  f.hallR = readHall(1);
  f.hallSpider = readHall(2);
  f.hallLm2 = readHall(3);

  static SenseFrame prev;
  if (M5.Imu.isEnabled()) {
    auto upd = M5.Imu.update();
    if (!upd) {   // no new sample this frame: keep the last one
      f.imuOk = prev.imuOk; f.yawRateDps = prev.yawRateDps; f.magOk = prev.magOk; f.magWedge = prev.magWedge;
    } else {
      const auto& d = M5.Imu.getImuData();
      f.imuOk = true;
      float yaw = d.gyro.z;   // deg/s about the screen normal; positive = counter-clockwise seen from above (a left turn)
#if GYRO_INVERT
      yaw = -yaw;
#endif
      f.yawRateDps = yaw;
      // magnetometer: centre each axis on its running min/max (a crude hard-iron fix; rotate the pebble once), then the
      // heading of magnetic north in the screen plane, x right, y up
      float m[3] = {d.mag.x, d.mag.y, d.mag.z};
      bool magPresent = !(m[0] == 0 && m[1] == 0 && m[2] == 0);
      if (magPresent) {
        for (int i = 0; i < 3; ++i) { if (m[i] < s_magMin[i]) s_magMin[i] = m[i]; if (m[i] > s_magMax[i]) s_magMax[i] = m[i]; }
        float cx = (s_magMin[0] + s_magMax[0]) * 0.5f, cy = (s_magMin[1] + s_magMax[1]) * 0.5f;
        float mx = m[0] - cx, my = m[1] - cy;
        if ((s_magMax[0] - s_magMin[0]) > 5.0f && (s_magMax[1] - s_magMin[1]) > 5.0f && (mx != 0 || my != 0)) {
          float deg = atan2f(my, mx) * 57.2957795f + MAG_HEADING_OFFSET_DEG;
          while (deg < 0) deg += 360.f;
          while (deg >= 360.f) deg -= 360.f;
          f.magOk = true;
          f.magWedge = ((int)(deg / 22.5f)) & 15;
        }
      }
    }
  }
  prev = f;
  {
    Lock l(g_senseMutex);
    g_sense = f;
  }
}
