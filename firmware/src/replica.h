// The local bit-exact replica of the fly's on-chain core, ticked at LOCAL_STEPS_PER_S on core 1 with stimuli from the
// senses (HARDWARE.md §4.2), accumulating what it sensed for the next anchor and emitting sense events for interactions.
#pragma once
#include <stdint.h>

void replicaInit();     // loads the circuit table, allocates the Core in internal RAM, creates the locks
void replicaStart();    // creates the task (core 1)
void replicaSetHosting(bool on);   // ticks only while hosting a fly (the ring idles otherwise)
bool replicaHosting();
