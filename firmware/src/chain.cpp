#include "chain.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <new>
#include <string.h>
#include "pebble.h"
#include "wallet.h"
#include "net.h"
#include "ble.h"
#include "replica.h"
#include "keccak.h"
#include "../fixtures/params.h"

using flycore::CH_NONE; using flycore::CH_CUE; using flycore::CH_TURN_LEFT; using flycore::CH_TURN_RIGHT; using flycore::CH_SHOCK;

namespace {

struct Chain {
  rpc::Client client;
  rpc::Registry reg;
  rpc::Core core;
  uint8_t token[20];
  bool coreEnabled;
  // the fly we host (HOST) or hosted (DEAD); 0 in WAIT
  uint64_t id = 0;
  rpc::FlyRecord fly;
  bool haveFly = false;
  // energy: the chain's value as of our last commit (plus feeds seen since), and when that became true
  int64_t chainEnergy = 0;
  uint32_t energyEpochMs = 0;
  uint64_t coreStepsSinceCommit = 0;
  std::string history;                 // interaction texts since the last commit (historyRoot = keccak of them)
  // a commit we sent but saw no receipt for: if the record's brainStep reaches it, it landed and the chain's energy
  // baseline moved to what we sent (feeds are detected against that baseline; see reconcileCommit)
  struct PendingCommit { bool active = false; uint64_t brainStep = 0; int64_t energy = 0; uint32_t sentMs = 0; uint64_t steps = 0; size_t historyLen = 0; } pendingCommit;
  // death: at most one died() at a time, never blindly re-sent after a revert
  uint32_t lastDieTryMs = 0; uint8_t dieReverts = 0; bool starving = false;
  // shadow of the chain's core state at the last anchor, replayed locally to check the two kernels agree
  flycore::Core* shadow = nullptr;
  bool haveShadow = false;
  // timers
  uint32_t lastPollMs = 0, lastAnchorMs = 0, lastCommitMs = 0, lastBalanceMs = 0, lastRegisterMs = 0;
  uint64_t scanCursor = 1;
  bool registered = false;

  explicit Chain(const std::string& url) : reg(client, FLY_REGISTRY), core(client, FLY_CORE) {
    client.url = url;
    ethtx::Bytes t;
    if (ethtx::fromHex(FLY_TOKEN, t) && t.size() == 20) memcpy(token, t.data(), 20); else memset(token, 0, 20);
    coreEnabled = strlen(FLY_CORE) == 42;
    void* mem = heap_caps_malloc(sizeof(flycore::Core), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!mem) mem = malloc(sizeof(flycore::Core));
    if (mem) shadow = new (mem) flycore::Core(g_circuit, PARAMS_V2);
  }

  int64_t energyNow() const { return chainEnergy - (int64_t)((millis() - energyEpochMs) / 1000); }
  bool isMe(const uint8_t a[20]) const { return memcmp(a, g_wallet.addr, 20) == 0; }
  static bool isZero(const uint8_t a[20]) { for (int i = 0; i < 20; ++i) if (a[i]) return false; return true; }

  void setPhase(Phase p) { Lock l(g_stateMutex); g_state.phase = p; }
  void setTx(const uint8_t* h) {
    Lock l(g_stateMutex);
    if (h) { g_state.txPending = true; std::string s = ethtx::toHex(h, 32); strlcpy(g_state.txHash, s.c_str(), sizeof g_state.txHash); }
    else { g_state.txPending = false; g_state.txHash[0] = 0; }
  }
  void publishEnergy() { Lock l(g_stateMutex); g_state.energy = energyNow(); }

  // ---- receipts. 1 = mined ok, 0 = reverted, -1 = not seen within RECEIPT_WAIT_S (the nonce is re-fetched next time)
  int waitReceipt(const uint8_t tx[32], const char* what, uint64_t* blockOut = nullptr) {
    setTx(tx);
    std::string h = ethtx::toHex(tx, 32);
    setStatus("%s... tx %.10s", what, h.c_str());
    uint32_t t0 = millis();
    int result = -1;
    while (millis() - t0 < RECEIPT_WAIT_S * 1000UL) {
      vTaskDelay(pdMS_TO_TICKS(RECEIPT_POLL_MS));
      int status; uint64_t block;
      if (!client.receiptStatus(tx, status, block)) continue;
      if (status < 0) continue;
      if (blockOut) *blockOut = block;
      result = status;
      break;
    }
    setTx(nullptr);
    if (result < 0) { g_wallet.nonceKnown = false; setStatus("%s: no receipt after %d s", what, RECEIPT_WAIT_S); }
    else if (result == 0) setStatus("%s: reverted (%.10s)", what, h.c_str());
    return result;
  }

  // ---- balances
  void refreshBalances() {
    uint64_t wei; bool over;
    if (client.balance(g_wallet.addr, wei, over)) {
      Lock l(g_stateMutex); g_state.balanceKnown = true; g_state.balanceWei = wei; g_state.balanceOverflow = over; g_state.rpcOk = true;
    } else { Lock l(g_stateMutex); g_state.rpcOk = false; }
    ethtx::Bytes ret;
    if (client.ethCall(token, ethtx::AbiEncoder("balanceOf(address)").address(g_wallet.addr).finish(), ret) && ret.size() >= 32) {
      bool high = false; for (int i = 0; i < 24; ++i) if (ret[i]) high = true;
      uint64_t low = ethtx::AbiDecoder(ret).uint(0);
      bool enough = high || low >= 1000000000000000000ULL;   // 1 $FLY (18 decimals)
      Lock l(g_stateMutex); g_state.flyTokens = enough;
    }
  }

  // ---- registration
  void registerStep() {
    if (millis() - lastRegisterMs < 20000 && lastRegisterMs) return;
    lastRegisterMs = millis();
    bool body = false;
    if (!reg.isBody(g_wallet.addr, body)) { setStatus("registry unreachable: %s", rpc::lastError()); return; }
    if (body) { registered = true; setStatus("registered as %s", g_state.bodyName); setPhase(Phase::WAIT); return; }
    refreshBalances();
    bool funded; { Lock l(g_stateMutex); funded = g_state.balanceKnown && (g_state.balanceOverflow || g_state.balanceWei >= 2000000000000000ULL); }
    if (!funded) { setStatus("send 0.05 BNB to %s to register", g_state.addrHex); return; }
    uint8_t tx[32];
    std::string name = g_state.bodyName, uri = std::string(SITE_URL) + "/fly/";
    if (!reg.registerBody(g_wallet, name, uri, tx)) { setStatus("registerBody failed: %s", rpc::lastError()); return; }
    if (waitReceipt(tx, "registering") == 1) { registered = true; setStatus("registered as %s", name.c_str()); setPhase(Phase::WAIT); }
  }

  // ---- interactions
  bool sendInteraction(const char* kind, const std::string& text) {
    if (!id) return false;
    uint8_t tx[32];
    if (!reg.interaction(g_wallet, id, kind, text, tx)) { setStatus("interaction failed: %s", rpc::lastError()); return false; }
    history += text; history += '\n';
    std::string h = ethtx::toHex(tx, 32);
    setStatus("%s  tx %.10s", text.c_str(), h.c_str());
    return true;
  }

  void drainSenses() {
    SenseEvent e;
    while (xQueueReceive(g_senseQueue, &e, 0) == pdTRUE) {
      if (!id || g_state.phase != Phase::HOST) continue;
      char b[96];
      switch (e.kind) {
        case Sense::LANDMARK_L: snprintf(b, sizeof b, "landmark on the left (wedge %d, x%d)", e.wedge, e.strength); sendInteraction("landmark", b); break;
        case Sense::LANDMARK_R: snprintf(b, sizeof b, "landmark on the right (wedge %d, x%d)", e.wedge, e.strength); sendInteraction("landmark", b); break;
        case Sense::LANDMARK_2: snprintf(b, sizeof b, "landmark ahead (wedge %d, x%d)", e.wedge, e.strength); sendInteraction("landmark", b); break;
        case Sense::SHOCK: snprintf(b, sizeof b, "spider! shock x%d, the bump collapsed", e.strength); sendInteraction("shock", b); break;
      }
    }
  }

  // ---- core state <-> replica
  void loadState(flycore::Core& c, const rpc::CoreState& s) {
    c.setState(s.v.data(), s.bias.data(), s.hist, s.inp.data(), s.step, s.headX, s.headY, s.posX, s.posY, s.stimChannel, s.stimParam, s.stimStrength, s.stimUntil);
  }

  // Reads core(id) and loads it into the replica. Returns false if the read failed.
  bool syncReplica(uint64_t block, bool checkAgainstShadow, uint8_t ch, uint8_t param, uint8_t strength, uint16_t steps) {
    rpc::CoreState s;
    if (!coreEnabled) return false;
    if (!core.state(id, s)) { setStatus("core read failed: %s", rpc::lastError()); return false; }
    if ((int)s.v.size() != g_circuit.N) { setStatus("core: %u neurons, table has %d", (unsigned)s.v.size(), g_circuit.N); return false; }
    bool mismatch = false;
    if (shadow && checkAgainstShadow && haveShadow) {
      // replay our anchor on the shadow: same stimulus, same steps; the chain must land on the same state
      if (ch != CH_NONE) shadow->stimulate(ch, param, strength);
      if (steps) shadow->tick(steps);
      uint8_t a[32], b[32];
      shadow->stateHash(a);
      loadState(*shadow, s);
      shadow->stateHash(b);
      mismatch = memcmp(a, b, 32) != 0;
    } else if (shadow) {
      loadState(*shadow, s);
    }
    haveShadow = shadow != nullptr;
    {
      Lock l(g_replicaMutex);
      loadState(*g_replica, s);
    }
    {
      Lock l(g_stateMutex);
      g_state.anchored = true; g_state.chainStep = s.step; g_state.chainHeadX = s.headX; g_state.chainHeadY = s.headY;
      g_state.lastAnchorBlock = block; g_state.lastAnchorMs = millis(); g_state.anchorMismatch = mismatch;
    }
    if (mismatch) Serial.println("[chain] local replay differs from the chain state: resynced");
    return true;
  }

  // ---- hosting
  void startHosting(const rpc::FlyRecord& f, bool fresh) {
    haveFly = true; fly = f;
    chainEnergy = (int64_t)f.energy; energyEpochMs = millis();
    coreStepsSinceCommit = 0; history.clear(); haveShadow = false;
    pendingCommit.active = false; lastDieTryMs = 0; dieReverts = 0; starving = false;
    lastAnchorMs = millis(); lastCommitMs = millis();
    std::string name; reg.flyName(id, name);
    {
      Lock l(g_stateMutex);
      g_state.flyId = id; strlcpy(g_state.flyName, name.c_str(), sizeof g_state.flyName);
      g_state.alive = f.alive; g_state.generation = f.generation; g_state.brainStep = f.brainStep; g_state.energy = chainEnergy;
      g_state.anchored = false; g_state.anchorMismatch = false; g_state.hatchArmed = false; g_state.candidate = false; g_state.scanning = false;
      g_state.coreEnabled = coreEnabled;
    }
    nvsPutU64("flyid", id);
    { Lock l(g_replicaMutex); g_replica->reset(); }
    if (coreEnabled) syncReplica(0, false, CH_NONE, 0, 0, 0); else { Lock l(g_stateMutex); g_state.anchored = false; }
    replicaSetHosting(true);
    setPhase(Phase::HOST);
    if (fresh) {
      char b[80]; snprintf(b, sizeof b, "woke up in %s (core only, %llu s of life)", g_state.bodyName, (unsigned long long)f.energy);
      sendInteraction("pebble", b);
    } else setStatus("hosting %s again", name.c_str());
  }

  void stopHosting(const char* why) {
    replicaSetHosting(false);
    haveFly = false;
    pendingCommit.active = false; lastDieTryMs = 0; dieReverts = 0; starving = false;
    nvsRemove("flyid");
    { Lock l(g_stateMutex); g_state.flyId = 0; g_state.flyName[0] = 0; g_state.anchored = false; g_state.candidate = false; g_state.scanning = false; }
    id = 0;
    setPhase(Phase::WAIT);
    setStatus("%s", why);
  }

  // accept(id) then host it
  void acceptAndHost(uint64_t fid) {
    uint8_t tx[32];
    id = fid;
    if (!reg.accept(g_wallet, fid, tx)) { setStatus("accept failed: %s", rpc::lastError()); id = 0; return; }
    if (waitReceipt(tx, "accepting the fly") != 1) { id = 0; return; }
    rpc::FlyRecord f;
    if (!reg.fly(fid, f) || !isMe(f.body)) { setStatus("accepted but the record disagrees; retrying"); id = 0; return; }
    startHosting(f, true);
  }

  // ---- a commit of ours whose receipt we missed: the record's brainStep tells whether it landed. If it did, the
  //      chain's energy baseline is what we sent, as of the moment we sent it (the local counter does not jump: the
  //      value we sent was this counter at that moment), and the steps/history it carried are no longer owed.
  void reconcileCommit(const rpc::FlyRecord& f) {
    if (!pendingCommit.active) return;
    if (f.brainStep < pendingCommit.brainStep) return;   // not mined (yet); the nonce was re-fetched, the next commit carries the interval again
    chainEnergy = pendingCommit.energy; energyEpochMs = pendingCommit.sentMs;
    fly.brainStep = f.brainStep;
    coreStepsSinceCommit = coreStepsSinceCommit > pendingCommit.steps ? coreStepsSinceCommit - pendingCommit.steps : 0;
    history.erase(0, pendingCommit.historyLen < history.size() ? pendingCommit.historyLen : history.size());
    pendingCommit.active = false;
    { Lock l(g_stateMutex); g_state.brainStep = f.brainStep; }
    Serial.printf("[chain] the commit at step %llu landed after all (receipt missed)\n", (unsigned long long)f.brainStep);
  }

  // ---- feeds: the chain's energy is above the baseline we expect (our last commit or accept, plus feeds seen)
  void checkFeed(const rpc::FlyRecord& f) {
    int64_t expected = chainEnergy;
    if ((int64_t)f.energy > expected) {
      int64_t fed = (int64_t)f.energy - expected;
      chainEnergy += fed;
      g_sound = SND_CHIRP;
      std::string by = fedBy();
      char b[80];
      if (by.empty()) snprintf(b, sizeof b, "fed %lld s", (long long)fed); else snprintf(b, sizeof b, "fed %lld s by %s", (long long)fed, by.c_str());
      sendInteraction("fed", b);
    } else if ((int64_t)f.energy < expected) {
      // Only our own commit lowers a living fly's energy, and reconcileCommit handled that. What is left is a read
      // from a node that lags a block or two (public RPCs are load-balanced): the local counter is continuous from
      // the last acknowledged point and is kept; adopting a stale lower number would starve the fly early.
      Serial.printf("[chain] record energy %llu below the expected %lld: stale read, keeping the local counter\n", (unsigned long long)f.energy, (long long)expected);
    }
  }

  // best effort: the `by` of the latest Fed(id) event in the last ~3000 blocks, "0x8a1f.." or ""
  std::string fedBy() {
    uint64_t bn;
    if (!client.blockNumber(bn)) return "";
    uint8_t sig[32]; const char* s = "Fed(uint256,address,uint64,uint256)"; keccak256((const uint8_t*)s, strlen(s), sig);
    char idw[67]; snprintf(idw, sizeof idw, "0x%064llx", (unsigned long long)id);
    char params[320];
    snprintf(params, sizeof params, "[{\"address\":\"%s\",\"fromBlock\":\"0x%llx\",\"toBlock\":\"latest\",\"topics\":[\"%s\",\"%s\"]}]",
             FLY_REGISTRY, (unsigned long long)(bn > 3000 ? bn - 3000 : 0), ethtx::toHex(sig, 32).c_str(), idw);
    std::string r;
    if (!client.call("eth_getLogs", params, r)) return "";
    // the last log's topics[2] is the feeder; find the last occurrence of "topics" and take its third entry
    size_t p = r.rfind("\"topics\"");
    if (p == std::string::npos) return "";
    size_t q = r.find('[', p); if (q == std::string::npos) return "";
    size_t e = r.find(']', q); if (e == std::string::npos) return "";
    std::string arr = r.substr(q, e - q);
    size_t k = 0; int n = 0; std::string by;
    while ((k = arr.find("0x", k)) != std::string::npos) { if (n == 2) { by = arr.substr(k, 66); break; } n++; k += 2; }
    if (by.size() != 66) return "";
    return "0x" + by.substr(26, 4) + ".." + by.substr(62, 4);
  }

  // ---- polling the registry
  void evaluate(uint64_t fid, const rpc::FlyRecord& f) {
    Phase ph = g_state.phase;
    if (ph == Phase::HOST && fid == id) {
      if (!f.alive) { onDeadOnChain(f); return; }
      if (!isMe(f.body)) { stopHosting(isZero(f.body) ? "the fly was released" : "the fly moved to another body"); return; }
      reconcileCommit(f);
      checkFeed(f);
      fly = f;
      { Lock l(g_stateMutex); g_state.alive = f.alive; g_state.generation = f.generation; }
      return;
    }
    // not hosting (WAIT/DEAD): any fly assigned to us?
    if (f.alive && isMe(f.pendingBody)) { setStatus("fly #%llu assigned to this pebble", (unsigned long long)fid); acceptAndHost(fid); return; }
    if (f.alive && isMe(f.body)) { id = fid; startHosting(f, false); return; }
    // the fly whose death we show was resurrected and lives elsewhere: back to waiting
    if (ph == Phase::DEAD && fid == id && f.alive) stopHosting("the fly was resurrected into another body");
  }

  // the fly is dead on-chain (our died() landed, possibly one whose receipt we missed): freeze the brain hash, DEAD screen
  void finishDeath(uint64_t block, uint64_t brainStep) {
    uint8_t h[32];
    { Lock l(g_replicaMutex); g_replica->stateHash(h); }
    replicaSetHosting(false);
    g_sound = SND_DEATH;
    { Lock l(g_stateMutex); g_state.alive = false; g_state.energy = 0; memcpy(g_state.brainHash, h, 32); g_state.deadBlock = (uint32_t)block; if (brainStep) g_state.brainStep = brainStep; }
    setPhase(Phase::DEAD);
    setStatus("%s starved. Brain preserved at block %llu; resurrect it on the site.", g_state.flyName, (unsigned long long)block);
  }

  void onDeadOnChain(const rpc::FlyRecord& f) {
    // only the body may call died(), so this is ours (a receipt we did not see); the record is final
    { Lock l(g_stateMutex); g_state.generation = f.generation; }
    finishDeath(f.lastCommitBlock, f.brainStep);
  }

  // Re-reads fly(id) and runs it through evaluate(): a feed since the last poll, a hand-off, a died() or commit of
  // ours whose receipt was missed all change what we may send next. Returns false if the registry could not be read.
  bool refreshRecord() {
    if (!id) return false;
    rpc::FlyRecord f;
    if (!reg.fly(id, f)) { Lock l(g_stateMutex); g_state.rpcOk = false; return false; }
    { Lock l(g_stateMutex); g_state.rpcOk = true; }
    evaluate(id, f);
    return true;
  }

  void poll() {
    lastPollMs = millis();
    if (id) {   // the fly we host / hosted
      rpc::FlyRecord f;
      if (reg.fly(id, f)) { evaluate(id, f); { Lock l(g_stateMutex); g_state.rpcOk = true; } }
      else { setStatus("poll failed: %s", rpc::lastError()); Lock l(g_stateMutex); g_state.rpcOk = false; }
    }
    if (g_state.phase == Phase::WAIT || g_state.phase == Phase::DEAD) {
      // scan for an assignment: ids 1..min(totalMinted, SCAN_MAX_ID), up to 40 per poll, round robin
      uint64_t total;
      if (!reg.totalMinted(total)) return;
      if (total > SCAN_MAX_ID) total = SCAN_MAX_ID;
      if (total == 0) return;
      if (scanCursor > total) scanCursor = 1;
      for (int n = 0; n < 40 && (g_state.phase == Phase::WAIT || g_state.phase == Phase::DEAD); ++n) {
        uint64_t fid = scanCursor;
        scanCursor = scanCursor >= total ? 1 : scanCursor + 1;
        if (fid == id) continue;   // already read above
        rpc::FlyRecord f;
        if (!reg.fly(fid, f)) continue;
        evaluate(fid, f);
        if (scanCursor == 1) break;   // wrapped: the whole range was covered
      }
    }
  }

  // ---- the anchor: the dominant cue since the last anchor, applied to the same neurons in the EVM
  void anchor() {
    lastAnchorMs = millis();
    if (!coreEnabled || !id) return;
    Accum a;
    { Lock l(g_replicaMutex); a = g_accum; g_accum.clear(); }
    uint8_t ch = CH_NONE, param = 0, strength = 0;
    if (a.shocks) { ch = CH_SHOCK; strength = SHOCK_STRENGTH; }
    else {
      int best = -1; uint32_t bw = 0;
      for (int w = 0; w < flycore::WEDGES; ++w) if (a.cueWeight[w] > bw) { bw = a.cueWeight[w]; best = w; }
      if (best >= 0) { ch = CH_CUE; param = (uint8_t)best; strength = a.cueStrength[best] ? a.cueStrength[best] : HALL_CUE_STRENGTH; }
      else if (fabsf(a.netTurnDeg) >= ANCHOR_TURN_MIN_DEG) {
        ch = a.netTurnDeg > 0 ? CH_TURN_LEFT : CH_TURN_RIGHT;
        int s = (int)(fabsf(a.netTurnDeg) / GYRO_DIV + 0.5f); if (s < 1) s = 1; if (s > TURN_STRENGTH_MAX) s = TURN_STRENGTH_MAX;
        strength = (uint8_t)s;
      } else if (a.magCues && a.magWedge >= 0) { ch = CH_CUE; param = (uint8_t)a.magWedge; strength = MAG_CUE_STRENGTH; }
    }
    uint8_t tx[32];
    bool sent = ch != CH_NONE ? core.stimulateAndTick(g_wallet, id, ch, param, strength, ANCHOR_STEPS, tx) : core.tick(g_wallet, id, ANCHOR_STEPS, tx);
    if (!sent) { setStatus("anchor failed: %s", rpc::lastError()); return; }
    const char* what = ch == CH_SHOCK ? "anchoring shock" : ch == CH_CUE ? "anchoring cue" : ch == CH_NONE ? "anchoring (tick)" : "anchoring turn";
    uint64_t block = 0;
    if (waitReceipt(tx, what, &block) != 1) return;
    coreStepsSinceCommit += ANCHOR_STEPS;
    if (syncReplica(block, true, ch, param, strength, ANCHOR_STEPS)) {
      int hd = headingDeg((float)g_state.chainHeadX, (float)g_state.chainHeadY);
      if (g_state.anchorMismatch) setStatus("anchored at block %llu: chain differs, resynced", (unsigned long long)block);
      else if (hd >= 0) setStatus("anchored at block %llu: on-chain heading %d deg, %d steps", (unsigned long long)block, hd, ANCHOR_STEPS);
      else setStatus("anchored at block %llu, %d steps", (unsigned long long)block, ANCHOR_STEPS);
    }
  }

  // ---- commit: whole-brain roots and uri unchanged, brainStep advanced by the core steps, energy by real seconds
  void commit() {
    lastCommitMs = millis();
    if (!id || !haveFly) return;
    // the energy we commit overwrites the chain's: read the record first so a feed since the last poll is in it
    if (!refreshRecord()) { setStatus("commit postponed: %s", rpc::lastError()); return; }
    if (g_state.phase != Phase::HOST || !haveFly) return;   // dead or moved meanwhile
    uint64_t steps = coreStepsSinceCommit ? coreStepsSinceCommit : 1;
    uint64_t brainStep = fly.brainStep + steps;
    int64_t e = energyNow(); if (e < 0) e = 0;
    size_t historyLen = history.size();
    uint8_t root[32]; keccak256((const uint8_t*)history.data(), historyLen, root);
    uint8_t tx[32];
    uint32_t sentMs = millis();
    if (!reg.commit(g_wallet, id, fly.stateRoot, fly.memoryRoot, fly.stateURI, "", brainStep, (uint64_t)e, root, tx)) { setStatus("commit failed: %s", rpc::lastError()); return; }
    uint64_t block = 0;
    int r = waitReceipt(tx, "committing", &block);
    if (r < 0) {   // unseen: it may still land; reconcileCommit notices by the record's brainStep
      pendingCommit.active = true; pendingCommit.brainStep = brainStep; pendingCommit.energy = e; pendingCommit.sentMs = sentMs;
      pendingCommit.steps = coreStepsSinceCommit; pendingCommit.historyLen = historyLen;
      return;
    }
    if (r != 1) return;   // reverted: nothing changed on the chain; the next poll explains it (moved, dead)
    pendingCommit.active = false;
    fly.brainStep = brainStep;
    chainEnergy = e; energyEpochMs = sentMs;
    coreStepsSinceCommit = 0; history.clear();
    { Lock l(g_stateMutex); g_state.brainStep = brainStep; }
    setStatus("committed at block %llu: step %llu, %lld s of life", (unsigned long long)block, (unsigned long long)brainStep, (long long)e);
  }

  // ---- death. The local counter reached 0. died() does not check energy on the chain (FlyRegistry.died only checks
  //      body and alive), so the pebble must not send it on a stale picture: the record is re-read first, and a feed
  //      that landed since the last poll (or while Wi-Fi was down) brings the fly back instead. A died() of ours that
  //      mined without us seeing the receipt shows up as alive == false and ends in DEAD without another tx; a fly the
  //      owner moved shows up as body != me and ends in WAIT. A revert (NotBody/Dead: the read was from a lagging
  //      node) is followed by an immediate poll, a longer wait and at most DIE_MAX_REVERTS attempts in total.
  //      Returns true while the fly is still ours, alive on the chain and at 0 (anchors and commits pause).
  bool starve() {
    if (!id || !haveFly) return false;
    if (!starving) { starving = true; setStatus("%s is out of energy: checking the registry before reporting", g_state.flyName); }
    uint32_t wait = (uint32_t)DIE_RETRY_S * 1000UL << (dieReverts < 4 ? dieReverts : 4);
    if (lastDieTryMs && millis() - lastDieTryMs < wait) return true;
    lastDieTryMs = millis();
    if (!refreshRecord()) { setStatus("starving, but the registry is unreachable: %s", rpc::lastError()); return true; }
    if (g_state.phase != Phase::HOST || !haveFly) return false;   // dead on-chain (DEAD) or moved (WAIT): nothing to send
    if (energyNow() > 0) { starving = false; dieReverts = 0; setStatus("fed in time: %lld s of life", (long long)energyNow()); return false; }
    if (dieReverts >= DIE_MAX_REVERTS) {   // keep reading the record on the backed-off schedule; send nothing
      setStatus("died() reverted %u times while the registry says alive: not retrying (check BscScan)", (unsigned)dieReverts);
      return true;
    }
    uint64_t steps = coreStepsSinceCommit ? coreStepsSinceCommit : 1;
    uint64_t brainStep = fly.brainStep + steps;
    char cause[64]; snprintf(cause, sizeof cause, "starved in %s", g_state.bodyName);
    uint8_t tx[32];
    if (!reg.died(g_wallet, id, fly.stateRoot, fly.memoryRoot, fly.stateURI, "", brainStep, cause, tx)) { setStatus("died() failed: %s", rpc::lastError()); return true; }
    uint64_t block = 0;
    int r = waitReceipt(tx, "reporting death", &block);
    if (r == 1) { finishDeath(block, brainStep); return false; }
    if (r == 0) { dieReverts++; lastPollMs = 0; }   // NotBody or Dead: the record has the answer; poll now, no blind resend
    // r < 0: no receipt in RECEIPT_WAIT_S. It may still mine: the next attempt re-reads the record first and follows
    // it (alive == false -> DEAD) instead of sending a second died() that would revert with Dead().
    return true;
  }

  // ---- hatch: mint a fly with the pebble's own $FLY and become its body
  void hatch() {
    if (g_state.phase != Phase::WAIT && g_state.phase != Phase::DEAD) return;
    { Lock l(g_stateMutex); g_state.hatching = true; g_state.hatchArmed = false; }
    uint8_t tx[32];
    // allowance(me, registry) >= 1 $FLY?
    ethtx::Bytes ret; bool allowed = false;
    if (client.ethCall(token, ethtx::AbiEncoder("allowance(address,address)").address(g_wallet.addr).address(reg.addr).finish(), ret) && ret.size() >= 32) {
      bool high = false; for (int i = 0; i < 24; ++i) if (ret[i]) high = true;
      allowed = high || ethtx::AbiDecoder(ret).uint(0) >= 1000000000000000000ULL;
    }
    if (!allowed) {
      if (!rpc::approveFly(client, g_wallet, token, reg.addr, tx)) { setStatus("approve failed: %s", rpc::lastError()); goto done; }
      if (waitReceipt(tx, "approving $FLY") != 1) goto done;
    }
    {
      uint64_t before = 0, after = 0;
      reg.totalMinted(before);
      std::string name = g_state.bodyName;
      if (!reg.mint(g_wallet, name, tx)) { setStatus("mint failed: %s", rpc::lastError()); goto done; }
      if (waitReceipt(tx, "hatching (mint)") != 1) goto done;
      if (!reg.totalMinted(after) || after <= before) { setStatus("minted, but could not find the new id"); goto done; }
      uint64_t mine = 0;
      for (uint64_t i = before + 1; i <= after; ++i) { uint8_t o[20]; if (reg.ownerOf(i, o) && isMe(o)) { mine = i; break; } }
      if (!mine) { setStatus("minted, but the new fly is not ours?"); goto done; }
      setStatus("hatched fly #%llu, assigning it to this body", (unsigned long long)mine);
      if (!reg.assign(g_wallet, mine, g_wallet.addr, tx)) { setStatus("assign failed: %s", rpc::lastError()); goto done; }
      if (waitReceipt(tx, "assigning") != 1) goto done;
      { Lock l(g_stateMutex); g_state.phase = Phase::WAIT; g_state.flyId = 0; }
      id = 0;
      acceptAndHost(mine);
    }
  done:
    { Lock l(g_stateMutex); g_state.hatching = false; }
    refreshBalances();
  }

  // ---- hand-off over BLE
  void handoffScan() {
    if (g_state.phase != Phase::HOST || !id) return;
    if (!bleRunning()) { setStatus("BLE is off: no hand-off"); return; }
    { Lock l(g_stateMutex); g_state.scanning = true; g_state.candidate = false; }
    setStatus("looking for a neighbour pebble...");
    uint8_t nb[20]; int rssi = -999;
    bool found = bleScanNeighbour(g_wallet.addr, nb, rssi, BLE_SCAN_S);
    Lock l(g_stateMutex);
    g_state.scanning = false;
    if (found) {
      g_state.candidate = true; memcpy(g_state.neighbour, nb, 20); shortAddr(nb, g_state.neighbourShort); g_state.neighbourRssi = rssi; g_state.candidateMs = millis();
      snprintf(g_state.status, sizeof g_state.status, "neighbour Pebble %s (%d dBm): press B to hand off", g_state.neighbourShort, rssi);
    } else snprintf(g_state.status, sizeof g_state.status, "no neighbour pebble found");
    g_state.statusMs = millis();
  }

  void handoffConfirm() {
    uint8_t nb[20]; char nbShort[5]; bool ok;
    { Lock l(g_stateMutex); ok = g_state.candidate; memcpy(nb, g_state.neighbour, 20); memcpy(nbShort, g_state.neighbourShort, 5); g_state.candidate = false; }
    if (!ok || g_state.phase != Phase::HOST || !id) return;
    uint8_t tx[32];
    if (!reg.assign(g_wallet, id, nb, tx)) { setStatus("assign failed: %s", rpc::lastError()); return; }
    if (waitReceipt(tx, "handing off") != 1) return;
    char b[80]; snprintf(b, sizeof b, "handed off to Pebble %s", nbShort);
    sendInteraction("handoff", b);
    setStatus("handed to Pebble %s: it accepts within a poll", nbShort);
    lastPollMs = 0;   // poll soon to notice the body change
  }

  void handoffCancel() { Lock l(g_stateMutex); g_state.candidate = false; }

  // ---- boot: is a fly cached from before the reboot?
  void resume() {
    uint64_t cached = nvsGetU64("flyid", 0);
    if (!cached) return;
    rpc::FlyRecord f;
    if (!reg.fly(cached, f)) return;
    id = cached;
    if (f.alive && isMe(f.body)) { startHosting(f, false); return; }
    if (f.alive && isMe(f.pendingBody)) { acceptAndHost(cached); return; }
    if (!f.alive) {
      std::string name; reg.flyName(cached, name);
      { Lock l(g_stateMutex); g_state.flyId = cached; strlcpy(g_state.flyName, name.c_str(), sizeof g_state.flyName); g_state.alive = false; g_state.generation = f.generation; g_state.deadBlock = (uint32_t)f.lastCommitBlock; }
      setPhase(Phase::DEAD);
      setStatus("%s is dead (brain preserved); resurrect it on the site", name.c_str());
      return;
    }
    id = 0; nvsRemove("flyid");
  }

  void loop() {
    setPhase(Phase::REGISTER);
    refreshBalances();
    registerStep();
    bool resumed = false;
    for (;;) {
      if (registered && !resumed) { resumed = true; resume(); }
      uint32_t now = millis();
      publishEnergy();
      if (!netConnected()) {
        netReconnect();
        setStatus("wifi lost, reconnecting (the fly keeps running locally)");
        { Lock l(g_stateMutex); g_state.rpcOk = false; }
        vTaskDelay(pdMS_TO_TICKS(1000));
        continue;
      }
      // commands from the buttons
      Cmd cmd;
      while (xQueueReceive(g_cmdQueue, &cmd, 0) == pdTRUE) {
        switch (cmd) {
          case Cmd::HATCH: hatch(); break;
          case Cmd::HANDOFF_SCAN: handoffScan(); break;
          case Cmd::HANDOFF_CONFIRM: handoffConfirm(); break;
          case Cmd::HANDOFF_CANCEL: handoffCancel(); break;
        }
      }
      if (!registered) { registerStep(); vTaskDelay(pdMS_TO_TICKS(500)); continue; }

      Phase ph = g_state.phase;
      if (ph == Phase::HOST) {
        drainSenses();
        // out of energy: reconcile with the chain and report the death (starve()); anchors and commits pause while
        // that is pending, but the poll below keeps running so feeds, hand-offs and a death already on the chain
        // are seen (a fed fly leaves this branch on its own)
        bool paused = energyNow() <= 0 ? starve() : false;
        if (!paused && g_state.phase == Phase::HOST) {
          if (energyNow() > 0) { starving = false; dieReverts = 0; }
          if (coreEnabled && now - lastAnchorMs >= ANCHOR_EVERY_S * 1000UL) anchor();
          if (g_state.phase == Phase::HOST && now - lastCommitMs >= COMMIT_EVERY_S * 1000UL) commit();
        }
      }
      if (now - lastPollMs >= POLL_EVERY_S * 1000UL || lastPollMs == 0) poll();
      if (now - lastBalanceMs >= 60000UL) {
        lastBalanceMs = now; refreshBalances();
        Serial.printf("[heap] internal free %u (largest %u), psram free %u\n", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
      }
      vTaskDelay(pdMS_TO_TICKS(250));
    }
  }
};

Chain* s_chain = nullptr;

void chainTask(void* arg) {
  Chain* c = (Chain*)arg;
  c->loop();
}

}  // namespace

void chainStart(const std::string& rpcUrl) {
  s_chain = new Chain(rpcUrl);
  xTaskCreatePinnedToCore(chainTask, "chain", 20480, s_chain, 2, nullptr, 0);
}
