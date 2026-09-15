// Senses (HARDWARE.md §4.2/§4.3): gyro yaw and magnetometer from the BMI270/BMM150 via M5.Imu, hall switches on
// Port B (G8/G9) and Port C (G17 spider, G18 landmark 2), touch on the ring. Runs in the UI task, which owns the I2C
// bus (M5.update() and M5.Imu share it); the result goes to g_sense for the replica task.
#pragma once
#include <stdint.h>

void sensorsInit();                 // pin modes + analog/digital hall auto-detection
void sensorsPoll(int touchWedge);   // call once per UI frame after M5.update(); touchWedge from the ring or -1
bool sensorsHallAnalog(int idx);    // 0 = L, 1 = R: did auto-detection pick an analog (49E) board?
