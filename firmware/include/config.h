// Deployed addresses and demo knobs. Keep in sync with web/src/lib/config.ts.
#pragma once
#include <stdint.h>
#define CHAIN_ID 56
#define FLY_REGISTRY "0x69DA3239B69c0B7C9C063F105c4DDf008FFb8F53"   // FlyRegistry v3 (life in BNB, nothing burned); v2 0x0eeB…f813 is history
#define FLY_TOKEN    "0x23791aa3b031659b593cf141a2bc76b0ad657777"
#define FLY_CORE     "0x77F6066B2ab12072DCEFb7D9DB998944C4ec28C2"   // FlyCore for v3 (block 122449461), verified
#define FLY_HOST_ADDR "0x4fC3E7D1fAD1A8E7FAC849DAa5BfF0C8333fe2a6"  // the brain host body: bodies(FLY_HOST_ADDR).uri is its public origin (brain/HOST_PROTOCOL.md)
#define SITE_URL     "https://midtermdev.github.io/immortal-fruit-fly"
#define ANCHOR_EVERY_S 45          // stimulate+tick the on-chain core this often (gas!)
#define ANCHOR_STEPS   16          // EVM steps per anchor (16 ≈ 4.6M gas)
#define COMMIT_EVERY_S 600         // registry.commit cadence
#define POLL_EVERY_S   15          // read registry state (assignment, feeds, resurrection)
#define LOCAL_STEPS_PER_S 14       // preview replica speed between anchors (same as the website)
#define GAS_PRICE_WEI  50000000ULL // 0.05 gwei; BSC accepts it

// ---- body (src/) knobs added with the pebble firmware. Everything below has a sane default; override in secrets.h
//      or with -D flags in platformio.ini.
#define BODY_NAME_PREFIX "Pebble "        // registry body name = prefix + last 4 hex of the address ("Pebble 8a1f")
#define PUBLIC_RPC_URL "https://bsc-dataseed.bnbchain.org"   // used when secrets.h/NVS give no RPC_URL
#define SCAN_MAX_ID    200                // WAIT polls fly ids 1..min(totalMinted, SCAN_MAX_ID) looking for an assignment
#define RECEIPT_WAIT_S 90                 // how long a signed tx is waited for before the nonce is re-fetched
#define RECEIPT_POLL_MS 3000
#define GAS_PRICE_MAX_WEI 5000000000ULL   // never pay more than 5 gwei even if eth_gasPrice says so
#define ANCHOR_GAS_BASE 600000ULL         // gas limit for stimulate+tick = base + per-step × steps (unused gas is refunded)
#define ANCHOR_GAS_PER_STEP 330000ULL
#define RPC_TIMEOUT_MS 15000              // TLS connect + response timeout per JSON-RPC call
#define RPC_MAX_RESPONSE (64 * 1024)      // cap on one JSON-RPC response (core(id) is ~32 KB of hex); lives in PSRAM
#define RPC_RETRIES 2                     // transport retries per call
#define DIE_RETRY_S 30                    // energy at 0: seconds between attempts to report the death (each attempt
                                          // re-reads fly(id) first; doubles after every reverted died())
#define DIE_MAX_REVERTS 3                 // reverted died() transactions after which the pebble stops sending and only
                                          // polls (a feed, a hand-off or the death showing up on the chain resolve it)

// brain host (brain/HOST_PROTOCOL.md): the whole brain of a hosted fly runs on the VPS; the pebble streams its life
#define INTERACTIONS_PER_COMMIT 3         // interaction(id, kind, data) sent after a host commit, newest first
#ifndef HOST_USE_WS
#define HOST_USE_WS 1                     // 1: wss <origin>/fly/<id>/ws?lite=1 (arduinoWebSockets); 0: poll GET /frame only (-DHOST_USE_WS=0)
#endif
#define HOST_POLL_MS 300                  // /frame polling period (also the fallback while the WebSocket is down)
#define HOST_STALE_MS 3000                // frames older than this: "brain host offline", Compass view
#define HOST_FRAME_MAX 6144               // a lite frame longer than this is dropped (PSRAM buffers)
#define HOST_HTTP_MAX 8192                // cap on one HTTP response from the host (checkpoint / final / frame)
#define HOST_HTTP_TIMEOUT_MS 12000        // TLS connect + response timeout per host request (/frame, /sense)
#define HOST_CHECKPOINT_TIMEOUT_MS 300000 // response timeout for the signed GET /checkpoint and /final: before answering the host
                                          // saves + pins the snapshot (Pinata, up to 300 s), reads the registry (60 s) and pins the
                                          // metadata again, and its supervisor's proxy allows 900 s. Giving up early loses the
                                          // interactions the host handed over (it forgets them once listed) and orphans the pin
#define HOST_HTTP_BUSY_WAIT_MS 100        // the host task's /frame and /sense wait this long for the shared connection while a
                                          // checkpoint holds it (minutes): a poll is skipped, a sense kept for the next round
#define COMMIT_RETRY_S 60                 // a host checkpoint whose commit could not be sent is re-sent (same payload, energy drained
                                          // by the seconds since) this often instead of waiting COMMIT_EVERY_S for a new one
#define COMMIT_HOLD_MAX_REVERTS 3         // ...and dropped after this many reverted sends (NotBody / Dead resolve at the next poll)
#define HOST_ORIGIN_REFRESH_S 300         // re-read bodies(FLY_HOST_ADDR).uri this often (and after a failure)
#define HOST_ORIGIN_RETRY_S 30            // ...but never more often than this
#define HOST_WS_RECONNECT_MS 5000         // WebSocket reconnect interval
#define HOST_WS_GIVEUP_MS 8000            // no frame this long after a WebSocket start: poll /frame instead for a while
#define HOST_WS_RETRY_MS 60000            // ...and try the WebSocket again after this long
#define HOST_SENSE_MIN_MS 1000            // POST /sense at most once a second (the host drops extras anyway)
#define HOST_SHOCK_SIDE "right"           // the spider sensor has no side of its own: where the predator appears from
#define HOST_TRAIL_LEN 400                // positions kept for the trail on the Life view
#define LIFE_SCALE_SMELL 20.0f            // rates (Hz) at which the Life view's bars are ~63% full: 1 - exp(-rate/scale)
#define LIFE_SCALE_MEMORY 8.0f            //   memory = KC + MBON
#define LIFE_SCALE_SIGHT 30.0f            //   sight = LC4 L + R
#define LIFE_SCALE_STEER 15.0f            //   steering = |DNa02 L - R|
#define LIFE_SCALE_TASTE 30.0f            //   taste = GRN
// pokes: FlyCore's Stimulated events by anyone but this body, read with eth_getLogs at every poll while hosting
// (the screen's ice bolt and "0x8a.. poked me: shock!"; needs an RPC that serves eth_getLogs, like the feeder's name)
#define POKE_LOOKBACK_BLOCKS 2000         // never scan further back than this after a gap (Wi-Fi down); older pokes are skipped
#define POKE_OVERLAP_BLOCKS 8             // consecutive scans overlap by this many blocks (load-balanced RPC nodes lag each other)
#define POKE_FAIL_BACKOFF 3               // eth_getLogs failing this often in a row (an RPC that refuses it): retry only every
#define POKE_RETRY_S 300                  //   this many seconds

// senses (HARDWARE.md §4.2/§4.3)
#define HALL_L_PIN 8                      // Port B, hall left  -> CH_CUE wedge HALL_L_WEDGE
#define HALL_R_PIN 9                      // Port B, hall right -> CH_CUE wedge HALL_R_WEDGE
#define HALL_SPIDER_PIN 17                // Port C (hero pebble): spider -> CH_SHOCK
#define HALL_LM2_PIN 18                   // Port C: landmark 2 -> CH_CUE wedge HALL_LM2_WEDGE
#define HALL_L_WEDGE 4
#define HALL_R_WEDGE 12
#define HALL_LM2_WEDGE 0
#define HALL_CUE_STRENGTH 8
#define SHOCK_STRENGTH 20
#define TOUCH_CUE_STRENGTH 6
#define MAG_CUE_STRENGTH 2
#define MAG_CUE_EVERY_MS 2000
#define MAG_HEADING_OFFSET_DEG 0.0f       // magnetometer heading correction (declination + board orientation)
#define GYRO_DEADBAND_DPS 12.0f           // yaw rates below this are noise
#define GYRO_DIV 8.0f                     // turn strength = |deg/s| / GYRO_DIV, clamped 1..TURN_STRENGTH_MAX
#define TURN_STRENGTH_MAX 40
#define GYRO_INVERT 0                     // set 1 if turning the pebble left drives CH_TURN_RIGHT on your unit
#define ANCHOR_TURN_MIN_DEG 20.0f         // net rotation since the last anchor below this is not worth a turn stimulus
#define LANDMARK_INTERACTION_EVERY_S 10   // rate limit for interaction(id, "landmark", …)
#define KEY_SHOW_HOLD_MS 3000             // hold BtnA + BtnC this long to show the private key once
#define HANDOFF_CONFIRM_S 20              // a found neighbour must be confirmed within this many seconds
#define HATCH_CONFIRM_S 8                 // second press within this window mints

// screen / sound / radio
#define UI_FPS 20
#define UI_COLOR_DEPTH 16                 // 16 or 8 (8 halves the SPI push time if the frame rate is short)
#define UI_BRIGHTNESS 128
#define PEBBLE_BLE 0                      // 1 enables BLE hand-off between pebbles; it shares the antenna with Wi-Fi and made the first pebble drop its connection, so it is off by default
#define BLE_NAME "FLYPEBBLE"
#define BLE_COMPANY_ID 0xFFFF             // manufacturer-data company id (0xFFFF = test/internal use)
#define BLE_SCAN_S 3
#define SPEAKER_VOLUME 96
