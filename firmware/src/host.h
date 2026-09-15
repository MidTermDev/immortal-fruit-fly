// The brain host client (brain/HOST_PROTOCOL.md): a task on core 0 that keeps a WebSocket to
// <origin>/fly/<id>/ws?lite=1 (or polls /frame), parses the lite frames into g_host for the Life view, forwards the
// pebble's senses with POST /sense, and gives the chain task the signed GET /checkpoint and GET /final calls.
// The origin comes from the chain task (bodies(FLY_HOST_ADDR).uri), which is the only task that talks JSON-RPC.
#pragma once
#include <stdint.h>
#include <string>
#include "hostframe.h"

void hostStart();                                   // creates the task; safe to call before Wi-Fi is up

// ---- chain task side
bool hostConfigured();                              // FLY_HOST_ADDR is set (the pebble can be a remote body)
void hostSetOrigin(const std::string& uri);         // the resolved bodies(FLY_HOST_ADDR).uri ("" = unknown)
bool hostWantsOrigin();                             // the stream failed: please re-read the registry (cleared by hostSetOrigin)
bool hostReady();                                   // an origin is known
// GET /fly/<id>/checkpoint with the auth headers; the parsed commit payload. Blocking: the host pins the snapshot and
// the metadata before answering, so this waits up to HOST_CHECKPOINT_TIMEOUT_MS (minutes). The payload is the only
// copy of the interactions it lists (the host forgets them once handed over): the caller keeps it until the chain
// has it (hostframe::Held) rather than fetching another.
bool hostCheckpoint(uint64_t id, hostframe::Payload& out);
// GET /fly/<id>/final (same timeout): 1 = payload (dead on the host), 0 = 409 (alive there), -1 = unreachable / error
int hostFinal(uint64_t id, hostframe::Payload& out);
const char* hostLastError();
// unix seconds from the host's own clock (frames / Date headers), else SNTP; 0 if nothing is known yet
uint64_t hostNow();
