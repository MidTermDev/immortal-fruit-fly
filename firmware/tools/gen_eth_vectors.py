"""Generate signing/ABI test vectors for lib/ethtx from eth_account / eth_keys / eth_abi.
- fixtures/eth_vectors.h : a throwaway test key, its address, EIP-155 legacy txs on chain 56 (raw bytes + hash),
                           raw digest signatures (r, s, recid), ABI encodings for the registry/core calls the
                           pebble makes, and one core(id)-shaped return payload for the decoder.
The key is sha256(b"immortal fruit fly test key"): a test vector, never funded, never a real wallet.
Run from the repo root:  .venv/bin/python firmware/tools/gen_eth_vectors.py
"""
import hashlib, os, random
from eth_account import Account
from eth_keys import keys
from eth_abi import encode
from eth_utils import keccak, to_checksum_address

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OUT = os.path.join(ROOT, 'firmware', 'fixtures'); os.makedirs(OUT, exist_ok=True)
CHAIN = 56

PRIV = hashlib.sha256(b"immortal fruit fly test key").digest()
acct = Account.from_key(PRIV)
addr = bytes.fromhex(acct.address[2:])
assert to_checksum_address(acct.address) == acct.address

REGISTRY = '0x0eeB0A675720306Ef6f426Bd8560c1288848f813'
CORE_STANDIN = to_checksum_address('0x00000000000000000000000000000000000000ff')   # FlyCore is not deployed yet; any address works for a vector

def selector(sig): return keccak(text=sig)[:4]
def calldata(sig, types, args): return selector(sig) + encode(types, args)

# ---- transactions (legacy type 0, EIP-155, chain 56)
rng = random.Random(0x5EED)
data200 = bytes(rng.randrange(256) for _ in range(200))
txs = [
    ('call_with_data',       dict(nonce=7,     gasPrice=50_000_000,    gas=4_600_000, to=CORE_STANDIN, value=0,      data=calldata('tick(uint256,uint16)', ['uint256', 'uint16'], [1, 16]))),
    ('empty_data_nonce0',    dict(nonce=0,     gasPrice=1_000_000_000, gas=21_000,    to=REGISTRY,     value=0,      data=b'')),
    ('nonce1000_value1wei',  dict(nonce=1000,  gasPrice=3_000_000_000, gas=21_000,    to=REGISTRY,     value=1,      data=b'')),
    ('data200_gasprice5B',   dict(nonce=255,   gasPrice=0x1_0000_0000, gas=90_000,    to=REGISTRY,     value=0,      data=data200)),
    ('value1bnb_nonce65536', dict(nonce=65536, gasPrice=5_000_000_000, gas=21_000,    to=acct.address, value=10**18, data=b'')),
]
# one tx whose r or s has a leading zero byte, to pin the minimal-integer RLP rule for r/s
n = 2000
while True:
    t = dict(nonce=n, gasPrice=1_000_000_000, gas=60_000, to=REGISTRY, value=0, data=calldata('accept(uint256)', ['uint256'], [1]), chainId=CHAIN)
    s = acct.sign_transaction(t)
    if s.r < 2**248 or s.s < 2**248:
        del t['chainId']; txs.append(('leading_zero_rs', t)); break
    n += 1
signed = []
for name, t in txs:
    s = acct.sign_transaction(dict(t, chainId=CHAIN))
    assert s.v in (CHAIN * 2 + 35, CHAIN * 2 + 36)
    assert keccak(s.raw_transaction) == s.hash
    signed.append((name, t, bytes(s.raw_transaction), bytes(s.hash), s.v))

# ---- raw digest signatures
pk = keys.PrivateKey(PRIV)
digests = [keccak(text='immortal fruit fly'), hashlib.sha256(b'pebble 3').digest(), bytes(range(1, 33))]
i = 0
while len({pk.sign_msg_hash(d).v for d in digests}) < 2:   # make sure both recovery ids are covered
    digests[-1] = keccak(text=f'fly {i}'); i += 1
sigs = []
for d in digests:
    sg = pk.sign_msg_hash(d)
    assert sg.v in (0, 1)
    assert keys.Signature(vrs=(sg.v, sg.r, sg.s)).recover_public_key_from_msg_hash(d) == pk.public_key
    sigs.append((d, sg.r.to_bytes(32, 'big'), sg.s.to_bytes(32, 'big'), sg.v))
assert {v for _, _, _, v in sigs} == {0, 1}

# ---- ABI encodings: the exact calls the pebble makes (arguments are exported as macros so the test uses the same)
ABI_NAME = 'Pebble 3'
ABI_URI = 'https://midtermdev.github.io/immortal-fruit-fly/fly/?id=1'
ABI_KIND = keccak(text='landmark')                      # bytes32 kind
ABI_INTER_DATA = 'left wedge 4, strength 7'
ABI_STATE_ROOT = hashlib.sha256(b'state').digest()
ABI_MEM_ROOT = hashlib.sha256(b'memory').digest()
ABI_HIST_ROOT = hashlib.sha256(b'history').digest()
ABI_STATE_URI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
ABI_META_URI = 'ipfs://bafkreie7ftl6erd2etqbyg5v5tl7ndu5nn7q2nbdpw3jusj2rsvk2wbawu/1.json'
ABI_STEP = 123456789012
ABI_ENERGY = 3599
ABI_EMPTY = ''
abis = [
    ('registerBody', calldata('registerBody(string,string)', ['string', 'string'], [ABI_NAME, ABI_URI])),
    ('accept',       calldata('accept(uint256)', ['uint256'], [1])),
    ('interaction',  calldata('interaction(uint256,bytes32,string)', ['uint256', 'bytes32', 'string'], [1, ABI_KIND, ABI_INTER_DATA])),
    ('commit',       calldata('commit(uint256,bytes32,bytes32,string,string,uint64,uint64,bytes32)',
                              ['uint256', 'bytes32', 'bytes32', 'string', 'string', 'uint64', 'uint64', 'bytes32'],
                              [1, ABI_STATE_ROOT, ABI_MEM_ROOT, ABI_STATE_URI, ABI_META_URI, ABI_STEP, ABI_ENERGY, ABI_HIST_ROOT])),
    ('stimulate',    calldata('stimulate(uint256,uint8,uint8,uint8,uint16)', ['uint256', 'uint8', 'uint8', 'uint8', 'uint16'], [1, 3, 12, 200, 65535])),
    ('interaction_empty', calldata('interaction(uint256,bytes32,string)', ['uint256', 'bytes32', 'string'], [2**64 - 1, b'\x00' * 32, ABI_EMPTY])),
    ('assign',       calldata('assign(uint256,address)', ['uint256', 'address'], [1, acct.address])),
    ('feed_bytes',   selector('debug(bytes,int32)') + encode(['bytes', 'int32'], [data200[:33], -12345])),
]

# ---- decode vector: FlyCore.core(id)-shaped return data
# (int16[] v, int8[] bias, uint16[16] hist, int32[] inp, uint64 step, int32 headX, int32 headY, int64 posX, int64 posY,
#  uint8 stimChannel, uint8 stimParam, uint16 stimStrength, uint64 stimUntilStep)
N = 155
drng = random.Random(155)
core_v = [drng.randrange(-32768, 32768) for _ in range(N)]; core_v[0] = -32768; core_v[1] = 32767; core_v[2] = 0; core_v[3] = -1
core_bias = [drng.randrange(-128, 128) for _ in range(N)]; core_bias[0] = -128; core_bias[1] = 127; core_bias[2] = -1
core_hist = [drng.randrange(0, 65536) for _ in range(16)]; core_hist[0] = 65535; core_hist[15] = 0
core_inp = [drng.randrange(-2**31, 2**31) for _ in range(N)]; core_inp[0] = -2**31; core_inp[1] = 2**31 - 1; core_inp[2] = -1
core_scalars = dict(step=987654321, headX=-2**31, headY=2**31 - 1, posX=-(2**63), posY=2**63 - 1, stimChannel=2, stimParam=9, stimStrength=1234, stimUntil=2**64 - 1)
core_ret = encode(['int16[]', 'int8[]', 'uint16[16]', 'int32[]', 'uint64', 'int32', 'int32', 'int64', 'int64', 'uint8', 'uint8', 'uint16', 'uint64'],
                  [core_v, core_bias, core_hist, core_inp, core_scalars['step'], core_scalars['headX'], core_scalars['headY'], core_scalars['posX'], core_scalars['posY'],
                   core_scalars['stimChannel'], core_scalars['stimParam'], core_scalars['stimStrength'], core_scalars['stimUntil']])
# a string-returning view too (name(id) → string), with a long string that spans several words
core_name = 'Specimen 001 — the first immortal fruit fly, hatched 2026'
name_ret = encode(['string'], [core_name])
# and a tuple with a string sitting after static words, to pin offsets relative to the start of the return data
tuple_ret = encode(['uint256', 'bool', 'address', 'string', 'int8'], [42, True, acct.address, 'body', -7])

# ---- emit
def carr(b): return ','.join(f'0x{x:02x}' for x in b)
def cbytes_lit(s):  # a UTF-8 string as a C string literal with \x escapes (safe for non-ASCII, no trigraph/concat issues)
    return '"' + ''.join(chr(c) if 32 <= c < 127 and chr(c) not in '"\\?' else f'\\{c:03o}' for c in s.encode('utf-8')) + '"'
def rows(b, per=24):
    return '\n'.join('  ' + carr(b[i:i + per]) + ',' for i in range(0, len(b), per))
def ints(xs): return ','.join(str(x) for x in xs)

with open(os.path.join(OUT, 'eth_vectors.h'), 'w') as f:
    w = f.write
    w('// generated by firmware/tools/gen_eth_vectors.py (eth_account %s) — do not edit. Test key only: never fund it.\n' % __import__('eth_account').__version__)
    w('#pragma once\n#include <stdint.h>\n#include <stddef.h>\n\n')
    w(f'#define ETH_CHAIN_ID {CHAIN}ULL\n')
    w(f'static const uint8_t ETH_TEST_PRIV[32] = {{ {carr(PRIV)} }};\n')
    w(f'static const uint8_t ETH_TEST_ADDR[20] = {{ {carr(addr)} }};\n')
    w(f'#define ETH_TEST_ADDR_CHECKSUM "{acct.address}"\n')
    w(f'#define ETH_TEST_ADDR_LOWER "{acct.address.lower()}"\n\n')
    # transactions
    for i, (name, t, raw, h, v) in enumerate(signed):
        w(f'// tx {i}: {name}\n')
        w(f'static const uint8_t ETH_TX{i}_DATA[{max(1, len(t["data"]))}] = {{ {carr(t["data"]) if t["data"] else "0"} }};\n')
        w(f'static const uint8_t ETH_TX{i}_RAW[{len(raw)}] = {{\n{rows(raw)}\n}};\n')
    w('struct EthTxVector { const char* name; uint64_t nonce, gasPrice, gas; uint8_t to[20]; uint64_t value; const uint8_t* data; size_t dataLen; const uint8_t* raw; size_t rawLen; uint8_t hash[32]; uint64_t v; };\n')
    w(f'static const EthTxVector ETH_TX_VECTORS[{len(signed)}] = {{\n')
    for i, (name, t, raw, h, v) in enumerate(signed):
        to = bytes.fromhex(t['to'][2:])
        w(f'  {{ "{name}", {t["nonce"]}ULL, {t["gasPrice"]}ULL, {t["gas"]}ULL, {{{carr(to)}}}, {t["value"]}ULL, ETH_TX{i}_DATA, {len(t["data"])}, ETH_TX{i}_RAW, {len(raw)}, {{{carr(h)}}}, {v}ULL }},\n')
    w('};\n\n')
    # digest signatures
    w('struct EthSigVector { uint8_t digest[32]; uint8_t r[32]; uint8_t s[32]; uint8_t recid; };\n')
    w(f'static const EthSigVector ETH_SIG_VECTORS[{len(sigs)}] = {{\n')
    for d, r, s, v in sigs:
        w(f'  {{ {{{carr(d)}}}, {{{carr(r)}}}, {{{carr(s)}}}, {v} }},\n')
    w('};\n\n')
    # ABI
    w(f'#define ABI_NAME {cbytes_lit(ABI_NAME)}\n#define ABI_URI {cbytes_lit(ABI_URI)}\n')
    w(f'static const uint8_t ABI_KIND[32] = {{ {carr(ABI_KIND)} }};\n#define ABI_INTER_DATA {cbytes_lit(ABI_INTER_DATA)}\n')
    w(f'static const uint8_t ABI_STATE_ROOT[32] = {{ {carr(ABI_STATE_ROOT)} }};\nstatic const uint8_t ABI_MEM_ROOT[32] = {{ {carr(ABI_MEM_ROOT)} }};\nstatic const uint8_t ABI_HIST_ROOT[32] = {{ {carr(ABI_HIST_ROOT)} }};\n')
    w(f'#define ABI_STATE_URI {cbytes_lit(ABI_STATE_URI)}\n#define ABI_META_URI {cbytes_lit(ABI_META_URI)}\n#define ABI_STEP {ABI_STEP}ULL\n#define ABI_ENERGY {ABI_ENERGY}ULL\n')
    w(f'static const uint8_t ABI_BYTES33[33] = {{ {carr(data200[:33])} }};\n#define ABI_INT32_NEG (-12345)\n')
    for name, enc in abis:
        w(f'static const uint8_t ABI_{name.upper()}[{len(enc)}] = {{\n{rows(enc)}\n}};\n')
    w('\n')
    # decode
    w(f'#define CORE_N {N}\n')
    w(f'static const int16_t CORE_V[{N}] = {{ {ints(core_v)} }};\n')
    w(f'static const int8_t CORE_BIAS[{N}] = {{ {ints(core_bias)} }};\n')
    w(f'static const uint16_t CORE_HIST[16] = {{ {ints(core_hist)} }};\n')
    w(f'static const int32_t CORE_INP[{N}] = {{ {ints(core_inp)} }};\n')
    for k, v in core_scalars.items():
        w(f'#define CORE_{k.upper()} ({v}{"LL" if v < 0 else "ULL"})\n' if k not in ('posX',) else f'#define CORE_{k.upper()} (-9223372036854775807LL - 1)\n')
    w(f'static const uint8_t CORE_RET[{len(core_ret)}] = {{\n{rows(core_ret)}\n}};\n')
    w(f'#define CORE_NAME {cbytes_lit(core_name)}\n')
    w(f'static const uint8_t NAME_RET[{len(name_ret)}] = {{\n{rows(name_ret)}\n}};\n')
    w(f'static const uint8_t TUPLE_RET[{len(tuple_ret)}] = {{\n{rows(tuple_ret)}\n}};\n')
print('wrote', os.path.join(OUT, 'eth_vectors.h'), 'txs', len(signed), 'sigs', len(sigs), 'abi', len(abis), 'core_ret bytes', len(core_ret), 'address', acct.address)
