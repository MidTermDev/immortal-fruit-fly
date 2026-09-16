// FlyCore's Stimulated events (contracts/src/FlyCore.sol), read with eth_getLogs: who stimulated a fly's core, on
// which channel, in which block. The pebble watches them for pokes (UI.md "poked by a stranger": a stimulate by
// anyone but the fly's body, which burns $FLY on the site's poke button). Shared layer like rpc.cpp's: no Arduino,
// exercised natively through rpc::Client::call's mock.
#pragma once
#include <stdint.h>
#include <string>
#include <vector>
#include "rpc.h"

namespace rpc {

struct Stimulus {
  uint64_t block = 0; uint32_t logIndex = 0;   // where it landed (logs are ordered by these)
  uint8_t by[20];                              // msg.sender
  uint8_t channel = 0, param = 0;              // flycore::Channel; param = the wedge of a cue
  uint16_t strength = 0;
};

// keccak("Stimulated(uint256,address,uint8,uint8,uint16,uint64,uint256)"): the event's topic 0
void stimulatedTopic(uint8_t out[32]);

// The Stimulated(id, by, ...) events of fly `id` on the core in blocks fromBlock .. toBlock (0 = "latest"), oldest
// first. False on a transport error (rpc::lastError()); a log that does not decode is skipped, a reorged one
// ("removed": true) too.
bool stimulatedEvents(Client& c, const uint8_t core[20], uint64_t id, uint64_t fromBlock, uint64_t toBlock, std::vector<Stimulus>& out);

// "0x8a1f..3c2d": an address as the screen shows it (its first and last four hex digits)
void shortAddress(const uint8_t a[20], char out[16]);

}  // namespace rpc
