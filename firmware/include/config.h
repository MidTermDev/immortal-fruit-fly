// Deployed addresses and demo knobs. Keep in sync with web/src/lib/config.ts.
#pragma once
#include <stdint.h>
#define CHAIN_ID 56
#define FLY_REGISTRY "0x0eeB0A675720306Ef6f426Bd8560c1288848f813"
#define FLY_TOKEN    "0x23791aa3b031659b593cf141a2bc76b0ad657777"
#define FLY_CORE     "0x90835aceD9b2739658Ff94aBC7c0c45049ea49f3"   // FlyCore on BSC mainnet (block 122089807), verified
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
#define PEBBLE_BLE 1                      // 0 disables BLE entirely (no hand-off) and frees ~60 KB of internal RAM
#define BLE_NAME "FLYPEBBLE"
#define BLE_COMPANY_ID 0xFFFF             // manufacturer-data company id (0xFFFF = test/internal use)
#define BLE_SCAN_S 3
#define SPEAKER_VOLUME 96
