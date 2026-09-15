// The chain task (core 0): registers the body, polls the registry for an assignment, accepts, anchors the on-chain
// core, sends interactions and commits, reports death, hatches and hands off. Everything that touches HTTPS runs here.
#pragma once
#include <string>

void chainStart(const std::string& rpcUrl);
