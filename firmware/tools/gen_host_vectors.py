"""Generate test vectors for lib/hostframe (the brain host client) -> fixtures/host_vectors.h.
- a sample lite frame (the example in brain/HOST_PROTOCOL.md, made valid JSON, with every rate and a puff) and the
  numbers the parser must extract from it;
- a sample /checkpoint payload and its expected fields (interactions newest first);
- an auth vector: id, ts, the digest keccak256("flyhost|<id>|<ts>"), the signature r||s||v (v = 27 + recid) made
  with the throwaway test key of fixtures/eth_vectors.h (ETH_TEST_PRIV), and the address eth_account recovers
  from it exactly the way the host does (Account._recover_hash);
- the ABI-encoded return of FlyRegistry.bodies(address) for the rpc wrapper the pebble uses to find the host.
Run from the repo root:  .venv/bin/python firmware/tools/gen_host_vectors.py
"""
import hashlib, json, os, re
from eth_account import Account
from eth_keys import keys
from eth_abi import encode
from eth_utils import keccak, to_checksum_address

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
FW = os.path.join(ROOT, 'firmware')
OUT = os.path.join(FW, 'fixtures', 'host_vectors.h')

# ---- the test key: the same derivation as gen_eth_vectors.py, cross-checked against the header it wrote
PRIV = hashlib.sha256(b"immortal fruit fly test key").digest()
hdr = open(os.path.join(FW, 'fixtures', 'eth_vectors.h')).read()
m = re.search(r'ETH_TEST_PRIV\[32\] = \{([^}]*)\}', hdr)
assert m and bytes(int(x, 16) for x in m.group(1).split(',')) == PRIV, 'eth_vectors.h has a different test key'
acct = Account.from_key(PRIV)

# ---- the lite frame (HOST_PROTOCOL.md example, made valid)
rates = {'DNa02_left': 11.0, 'DNa02_right': 40.2, 'DNa01_left': 3.5, 'DNa01_right': 2.25, 'DNg13_left': 0.0, 'DNg13_right': 0.5,
         'DNa_left': 1.2, 'DNa_right': 1.4, 'DNp09_left': 20.0, 'DNp09_right': 21.5, 'MDN_left': 0.1, 'MDN_right': 0.0,
         'DNp01_left': 0.0, 'DNp01_right': 0.0, 'DN_all': 4.8, 'ALPN': 17.25, 'KC': 2.5, 'MBON': 6.75, 'CX': 3.0,
         'LC4_left': 8.0, 'LC4_right': 33.5, 'GRN_labellar': 0.0}
events = [[1200000.0 + 1000 * i, f'diary line {i}'] for i in range(9)] + [[1229000.0, 'smelled food'], [1230000.0, 'a shadow approaches'], [1231000.0, 'giant fiber spike: jumped']]
frame = {
    't_ms': 1234500.0, 'step': 12345000, 'x': 12.3, 'y': -4.5, 'heading': 1.57, 'energy': 812.4, 'alive': True,
    'generation': 0, 'life_ms': 1234500.0, 'spikes_total': 812345678, 'ate': 120.0, 'jumps': 7, 'hits': 0,
    'food': [{'id': 1, 'x': 40.0, 'y': 10.0, 'energy': 550.0, 'energy0': 600.0, 'by': '0x8a1f0000000000000000000000000000000000ab'},
             {'id': 2, 'x': -70.0, 'y': -40.0, 'energy': 300.0, 'energy0': 300.0, 'by': ''}],
    'predator': {'x': 80.1, 'y': -30.2, 'size': 6.0}, 'lamp': [96.0, 96.0], 'arena': 240.0,
    'rates': rates, 'base': {k: 0.5 for k in rates},
    'puffs': [{'x': 30.0, 'y': 25.0, 'strength': 0.6}],
    'steer': 0.4, 'mode': 'surge', 'orn': [12.0, 30.5], 'events': events,
    'wall': 1789500000.0, 'realtime': 0.82, 'chain': {'last_hash': '0x' + 'ab' * 32, 'checkpoints': 3}, 'nrender': 41873}
frame_json = json.dumps(frame, separators=(',', ':'))
assert len(events) == 12

# ---- a /checkpoint payload (interactions listed oldest first by the host; the pebble wants newest first)
inter = [{'t_ms': 1201000.0, 'kind': 'ate', 'data': 'finished a food item worth 600s'},
         {'t_ms': 1231000.0, 'kind': 'jumped', 'data': 'giant fiber spike: jumped'},
         {'t_ms': 1210000.0, 'kind': 'caught', 'data': 'caught by the predator: -60 s'},
         {'t_ms': 1225000.0, 'kind': 'ate', 'data': 'finished a food item worth 300s'}]
history_root = hashlib.sha256(json.dumps(inter, sort_keys=True).encode()).digest()
payload = {'stateRoot': '0x' + hashlib.sha256(b'state').hexdigest(), 'memoryRoot': '0x' + hashlib.sha256(b'memory').hexdigest(),
           'stateURI': 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
           'metadataURI': 'ipfs://bafkreie7ftl6erd2etqbyg5v5tl7ndu5nn7q2nbdpw3jusj2rsvk2wbawu/7.json',
           'brainStep': 142378000, 'energy': 812, 'historyRoot': '0x' + history_root.hex(),
           'interactions': inter, 'age_s': 1234, 'spikes': 812345678, 'generation': 0}
payload_json = json.dumps(payload, separators=(',', ':'))
final_json = json.dumps({**payload, 'energy': 0, 'brainStep': 142400000, 'cause': 'starved in Pebble 8a1f'}, separators=(',', ':'))
newest_first = sorted(inter, key=lambda i: -i['t_ms'])

# ---- auth
FLY_ID, TS = 7, 1789500123
msg = f'flyhost|{FLY_ID}|{TS}'.encode('ascii')
digest = keccak(msg)
sg = keys.PrivateKey(PRIV).sign_msg_hash(digest)
sig = sg.r.to_bytes(32, 'big') + sg.s.to_bytes(32, 'big') + bytes([27 + sg.v])
assert sig[64] in (27, 28)
recovered = Account._recover_hash(digest, signature=sig)      # exactly what the host does
assert recovered == acct.address, (recovered, acct.address)

# ---- bodies(address) return: (string name, string uri, uint64 registeredBlock, uint32 flies)
HOST_NAME, HOST_URI, HOST_BLOCK, HOST_FLIES = 'Brain host', 'https://pebble-host.trycloudflare.com', 122100000, 2
bodies_ret = encode(['string', 'string', 'uint64', 'uint32'], [HOST_NAME, HOST_URI, HOST_BLOCK, HOST_FLIES])


def c_bytes(name, b):
    return f'static const uint8_t {name}[{len(b)}] = {{ ' + ','.join(f'0x{x:02x}' for x in b) + ' };\n'


def c_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


lines = ['// generated by firmware/tools/gen_host_vectors.py — do not edit. Test key only (fixtures/eth_vectors.h): never fund it.',
         '#pragma once', '#include <stdint.h>', '#include <stddef.h>', '',
         '// ---- the lite frame (brain/HOST_PROTOCOL.md example) and what the parser must extract',
         f'static const char HOST_FRAME_JSON[] = {c_str(frame_json)};',
         f'#define HOST_FRAME_T_MS {frame["t_ms"]!r}', f'#define HOST_FRAME_STEP {frame["step"]}ULL',
         f'#define HOST_FRAME_X {frame["x"]!r}f', f'#define HOST_FRAME_Y {frame["y"]!r}f', f'#define HOST_FRAME_HEADING {frame["heading"]!r}f',
         f'#define HOST_FRAME_ENERGY {frame["energy"]!r}f', f'#define HOST_FRAME_ALIVE {int(frame["alive"])}', f'#define HOST_FRAME_GENERATION {frame["generation"]}',
         f'#define HOST_FRAME_SPIKES {frame["spikes_total"]}ULL', f'#define HOST_FRAME_ATE {frame["ate"]!r}f', f'#define HOST_FRAME_JUMPS {frame["jumps"]}',
         f'#define HOST_FRAME_HITS {frame["hits"]}', f'#define HOST_FRAME_ARENA {frame["arena"]!r}f',
         f'#define HOST_FRAME_NFOOD {len(frame["food"])}',
         f'#define HOST_FRAME_FOOD0_X {frame["food"][0]["x"]!r}f', f'#define HOST_FRAME_FOOD0_Y {frame["food"][0]["y"]!r}f',
         f'#define HOST_FRAME_FOOD0_ENERGY {frame["food"][0]["energy"]!r}f', f'#define HOST_FRAME_FOOD0_ENERGY0 {frame["food"][0]["energy0"]!r}f',
         f'#define HOST_FRAME_FOOD1_X {frame["food"][1]["x"]!r}f', f'#define HOST_FRAME_FOOD1_Y {frame["food"][1]["y"]!r}f',
         f'#define HOST_FRAME_PRED_X {frame["predator"]["x"]!r}f', f'#define HOST_FRAME_PRED_Y {frame["predator"]["y"]!r}f', f'#define HOST_FRAME_PRED_SIZE {frame["predator"]["size"]!r}f',
         f'#define HOST_FRAME_NPUFFS {len(frame["puffs"])}', f'#define HOST_FRAME_PUFF0_X {frame["puffs"][0]["x"]!r}f', f'#define HOST_FRAME_PUFF0_Y {frame["puffs"][0]["y"]!r}f', f'#define HOST_FRAME_PUFF0_S {frame["puffs"][0]["strength"]!r}f',
         f'#define HOST_FRAME_DNA02_L {rates["DNa02_left"]!r}f', f'#define HOST_FRAME_DNA02_R {rates["DNa02_right"]!r}f',
         f'#define HOST_FRAME_ALPN {rates["ALPN"]!r}f', f'#define HOST_FRAME_KC {rates["KC"]!r}f', f'#define HOST_FRAME_MBON {rates["MBON"]!r}f',
         f'#define HOST_FRAME_LC4_L {rates["LC4_left"]!r}f', f'#define HOST_FRAME_LC4_R {rates["LC4_right"]!r}f', f'#define HOST_FRAME_GRN {rates["GRN_labellar"]!r}f',
         f'#define HOST_FRAME_DN_ALL {rates["DN_all"]!r}f', f'#define HOST_FRAME_STEER {frame["steer"]!r}f',
         f'#define HOST_FRAME_MODE {c_str(frame["mode"])}', f'#define HOST_FRAME_REALTIME {frame["realtime"]!r}f', f'#define HOST_FRAME_WALL {frame["wall"]!r}',
         f'#define HOST_FRAME_CHECKPOINTS {frame["chain"]["checkpoints"]}',
         f'#define HOST_FRAME_NEVENTS_TOTAL {len(events)}',
         f'#define HOST_FRAME_EVENT_LAST_T {events[-1][0]!r}', f'#define HOST_FRAME_EVENT_LAST_TEXT {c_str(events[-1][1])}',
         f'#define HOST_FRAME_EVENT_FIRSTKEPT6_T {events[-6][0]!r}', f'#define HOST_FRAME_EVENT_FIRSTKEPT6_TEXT {c_str(events[-6][1])}',
         '',
         '// ---- the /checkpoint payload and the /final payload',
         f'static const char HOST_PAYLOAD_JSON[] = {c_str(payload_json)};',
         f'static const char HOST_FINAL_JSON[] = {c_str(final_json)};',
         c_bytes('HOST_PAYLOAD_STATE_ROOT', hashlib.sha256(b'state').digest()).rstrip('\n'),
         c_bytes('HOST_PAYLOAD_MEMORY_ROOT', hashlib.sha256(b'memory').digest()).rstrip('\n'),
         c_bytes('HOST_PAYLOAD_HISTORY_ROOT', history_root).rstrip('\n'),
         f'#define HOST_PAYLOAD_STATE_URI {c_str(payload["stateURI"])}', f'#define HOST_PAYLOAD_META_URI {c_str(payload["metadataURI"])}',
         f'#define HOST_PAYLOAD_BRAIN_STEP {payload["brainStep"]}ULL', f'#define HOST_PAYLOAD_ENERGY {payload["energy"]}ULL',
         f'#define HOST_PAYLOAD_AGE_S {payload["age_s"]}ULL', f'#define HOST_PAYLOAD_SPIKES {payload["spikes"]}ULL', f'#define HOST_PAYLOAD_GENERATION {payload["generation"]}',
         f'#define HOST_PAYLOAD_NINTER {len(inter)}',
         f'#define HOST_FINAL_BRAIN_STEP 142400000ULL', f'#define HOST_FINAL_CAUSE "starved in Pebble 8a1f"',
         '// interactions newest first, as the pebble sends them']
for i, it in enumerate(newest_first):
    lines += [f'#define HOST_PAYLOAD_INTER{i}_T {it["t_ms"]!r}', f'#define HOST_PAYLOAD_INTER{i}_KIND {c_str(it["kind"])}', f'#define HOST_PAYLOAD_INTER{i}_DATA {c_str(it["data"])}']
lines += ['',
          '// ---- auth: digest = keccak256(ascii "flyhost|<id>|<ts>"), signed raw, r||s||v with v = 27 + recid',
          f'#define HOST_AUTH_ID {FLY_ID}ULL', f'#define HOST_AUTH_TS {TS}ULL', f'#define HOST_AUTH_MESSAGE {c_str(msg.decode())}',
          c_bytes('HOST_AUTH_DIGEST', digest).rstrip('\n'),
          c_bytes('HOST_AUTH_SIG', sig).rstrip('\n'),
          f'#define HOST_AUTH_SIG_HEX "0x{sig.hex()}"',
          f'#define HOST_AUTH_RECOVERED "{recovered}"',
          c_bytes('HOST_AUTH_RECOVERED_BYTES', bytes.fromhex(recovered[2:])).rstrip('\n'),
          '',
          '// ---- FlyRegistry.bodies(address) return data (eth_abi): (string name, string uri, uint64 registeredBlock, uint32 flies)',
          c_bytes('HOST_BODIES_RET', bodies_ret).rstrip('\n'),
          f'#define HOST_BODIES_NAME {c_str(HOST_NAME)}', f'#define HOST_BODIES_URI {c_str(HOST_URI)}',
          f'#define HOST_BODIES_BLOCK {HOST_BLOCK}ULL', f'#define HOST_BODIES_FLIES {HOST_FLIES}', '']
open(OUT, 'w').write('\n'.join(lines))
print(f'wrote {OUT}: frame {len(frame_json)} bytes, payload {len(payload_json)} bytes, sig v={sig[64]}, recovered {recovered}')
