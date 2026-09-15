#include "ble.h"
#include <Arduino.h>
#include <string.h>
#include "config.h"
#ifndef PEBBLE_BLE
#define PEBBLE_BLE 1
#endif

#if PEBBLE_BLE
#include <BLEDevice.h>
#include <BLEAdvertising.h>
#include <BLEScan.h>

static bool s_running = false;
static BLEScan* s_scan = nullptr;

// manufacturer data: company id (LE) + "FP" + address
static std::string manufacturerData(const uint8_t addr[20]) {
  std::string d;
  d.push_back((char)(BLE_COMPANY_ID & 0xff));
  d.push_back((char)((BLE_COMPANY_ID >> 8) & 0xff));
  d.push_back('F'); d.push_back('P');
  d.append((const char*)addr, 20);
  return d;
}

bool bleStart(const uint8_t myAddr[20]) {
  if (s_running) return true;
  BLEDevice::init(BLE_NAME);
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  BLEAdvertisementData ad;
  ad.setFlags(0x06);   // LE general discoverable, BR/EDR not supported
  ad.setManufacturerData(manufacturerData(myAddr));   // 3 + 26 bytes: fits the 31-byte advertisement
  BLEAdvertisementData sr;
  sr.setName(BLE_NAME);                               // the name rides in the scan response
  adv->setAdvertisementData(ad);
  adv->setScanResponseData(sr);
  adv->setMinInterval(0x100);   // 160 ms
  adv->setMaxInterval(0x200);
  adv->start();
  s_scan = BLEDevice::getScan();
  s_scan->setActiveScan(true);
  s_scan->setInterval(100);
  s_scan->setWindow(60);
  s_running = true;
  Serial.println("[ble] advertising as " BLE_NAME);
  return true;
}

bool bleRunning() { return s_running; }

bool bleScanNeighbour(const uint8_t myAddr[20], uint8_t out[20], int& rssi, uint32_t seconds) {
  if (!s_running || !s_scan) return false;
  BLEScanResults res = s_scan->start(seconds, false);
  bool found = false; int best = -999;
  for (int i = 0; i < res.getCount(); ++i) {
    BLEAdvertisedDevice d = res.getDevice(i);
    if (!d.haveManufacturerData()) continue;
    std::string m = d.getManufacturerData();
    if (m.size() != 24) continue;
    if ((uint8_t)m[0] != (BLE_COMPANY_ID & 0xff) || (uint8_t)m[1] != ((BLE_COMPANY_ID >> 8) & 0xff) || m[2] != 'F' || m[3] != 'P') continue;
    if (memcmp(m.data() + 4, myAddr, 20) == 0) continue;   // our own echo
    if (d.getRSSI() > best) { best = d.getRSSI(); memcpy(out, m.data() + 4, 20); found = true; }
  }
  s_scan->clearResults();
  rssi = best;
  return found;
}

#else   // PEBBLE_BLE == 0: no radio, hand-off unavailable

bool bleStart(const uint8_t*) { return false; }
bool bleRunning() { return false; }
bool bleScanNeighbour(const uint8_t*, uint8_t*, int& rssi, uint32_t) { rssi = -999; return false; }

#endif
