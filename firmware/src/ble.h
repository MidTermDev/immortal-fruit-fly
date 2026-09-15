// BLE hand-off discovery: every pebble advertises as BLE_NAME with its 20-byte address in the manufacturer data
// (company id BLE_COMPANY_ID, then 'F','P', then the address); a scan returns the strongest neighbouring pebble.
#pragma once
#include <stdint.h>

bool bleStart(const uint8_t myAddr[20]);                       // init + advertise; false if BLE could not start
bool bleScanNeighbour(const uint8_t myAddr[20], uint8_t out[20], int& rssi, uint32_t seconds);   // blocking
bool bleRunning();
