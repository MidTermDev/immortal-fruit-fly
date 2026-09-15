"""Vectors for lib/rpc's host mock test (test/test_rpc): canned eth_call return data for FlyRegistry.fly(id) and
FlyCore.core(id) shaped exactly like the deployed ABIs, the calldata the wrappers must produce, and one fully signed
transaction (accept(1) from the test wallet with nonce 42) so sendCall's signing + nonce handling is checked
byte-for-byte against eth_account. The key is the same throwaway as gen_eth_vectors.py (never funded).
Run from the repo root:  .venv/bin/python firmware/tools/gen_rpc_vectors.py
"""
import hashlib, os, random
from eth_account import Account
from eth_abi import encode
from eth_utils import keccak, to_checksum_address

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OUT = os.path.join(ROOT, 'firmware', 'fixtures', 'rpc_vectors.h')

PRIV = hashlib.sha256(b"immortal fruit fly test key").digest()
acct = Account.from_key(PRIV)
REGISTRY = '0x0eeB0A675720306Ef6f426Bd8560c1288848f813'
TOKEN = '0x23791aa3b031659b593cf141a2bc76b0ad657777'
CORE = to_checksum_address('0x00000000000000000000000000000000000000ff')
BODY = to_checksum_address('0x47005543c06246124480D196a275327325695BEd')     # the arena body
PENDING = acct.address                                                     # the pebble itself

def selector(sig): return keccak(text=sig)[:4]
def calldata(sig, types, args): return selector(sig) + encode(types, args)

# ---- fly(id): FlyRegistry.Fly as a dynamic tuple (it holds a string)
FLY_TYPES = '(bytes32,uint32,uint32,uint32,uint256,uint256,bytes32,bytes32,string,uint64,uint64,uint64,uint64,address,address,bool)'
fly = dict(connectome=hashlib.sha256(b'connectome').digest(), model=2, generation=3, deaths=2, parentA=0, parentB=0,
           stateRoot=hashlib.sha256(b'state').digest(), memoryRoot=hashlib.sha256(b'memory').digest(),
           stateURI='ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
           brainStep=123456789012, energy=3599, bornBlock=122001234, lastCommitBlock=123000000, body=BODY, pendingBody=PENDING, alive=True)
fly_ret = encode([FLY_TYPES], [tuple(fly.values())])
assert fly_ret[:32] == (32).to_bytes(32, 'big')   # word 0 = offset of the struct

# ---- core(id): 14 outputs, N = 155
N = 155
rng = random.Random(7)
core_v = [rng.randrange(-32768, 32768) for _ in range(N)]; core_v[0] = -32768; core_v[1] = 32767; core_v[154] = -1
core_bias = [rng.randrange(-24, 25) for _ in range(N)]; core_bias[0] = -24; core_bias[1] = 24
core_hist = [rng.randrange(0, 65536) for _ in range(16)]; core_hist[0] = 65535; core_hist[15] = 1
core_inp = [rng.randrange(-2**31, 2**31) for _ in range(N)]; core_inp[0] = -2**31; core_inp[1] = 2**31 - 1
core_scalars = dict(step=987654321, headX=-1234, headY=5678, posX=-(2**40), posY=2**40 + 1, stimChannel=1, stimParam=12, stimStrength=8, stimUntil=987654321 + 64, totalSpikes=44556677)
core_ret = encode(['int16[]', 'int8[]', 'uint16[16]', 'int32[]', 'uint64', 'int32', 'int32', 'int64', 'int64', 'uint8', 'uint8', 'uint16', 'uint64', 'uint64'],
                  [core_v, core_bias, core_hist, core_inp, *core_scalars.values()])

# ---- calldata the wrappers must send
KIND = b'landmark'.ljust(32, b'\0')
calls = [
    ('CALL_FLY', calldata('fly(uint256)', ['uint256'], [7])),
    ('CALL_ISBODY', calldata('isBody(address)', ['address'], [acct.address])),
    ('CALL_TOTALMINTED', selector('totalMinted()')),
    ('CALL_CORE', calldata('core(uint256)', ['uint256'], [7])),
    ('CALL_ACCEPT', calldata('accept(uint256)', ['uint256'], [1])),
    ('CALL_INTERACTION', calldata('interaction(uint256,bytes32,string)', ['uint256', 'bytes32', 'string'], [7, KIND, 'landmark on the left (wedge 4, x8)'])),
    ('CALL_STIMULATE', calldata('stimulate(uint256,uint8,uint8,uint8,uint16)', ['uint256', 'uint8', 'uint8', 'uint8', 'uint16'], [7, 4, 0, 20, 16])),
    ('CALL_APPROVE', calldata('approve(address,uint256)', ['address', 'uint256'], [REGISTRY, 2**256 - 1])),
    ('CALL_DIED', calldata('died(uint256,bytes32,bytes32,string,string,uint64,string)', ['uint256', 'bytes32', 'bytes32', 'string', 'string', 'uint64', 'string'],
                           [7, fly['stateRoot'], fly['memoryRoot'], fly['stateURI'], '', fly['brainStep'] + 16, 'starved in Pebble 91a0'])),
]

# ---- one signed tx: accept(1), nonce 42, gasPrice 0.05 gwei (the floor: the node says 0x1), gas 120000
tx = dict(nonce=42, gasPrice=50_000_000, gas=120_000, to=REGISTRY, value=0, data=calldata('accept(uint256)', ['uint256'], [1]), chainId=56)
signed = acct.sign_transaction(tx)
# the anchor: stimulate(7, SHOCK, 0, 20, 16) with nonce 43, gasPrice 1 gwei (network above the floor), gas 600000 + 330000*16
tx2 = dict(nonce=43, gasPrice=1_000_000_000, gas=600_000 + 330_000 * 16, to=CORE, value=0, data=calls[6][1], chainId=56)
signed2 = acct.sign_transaction(tx2)

def carr(b): return ','.join(f'0x{x:02x}' for x in b)
def rows(b, per=24): return '\n'.join('  ' + carr(b[i:i + per]) + ',' for i in range(0, len(b), per))
def cbytes(name, b): return f'static const uint8_t {name}[{len(b)}] = {{\n{rows(b)}\n}};\n'
def ints(xs): return ','.join(str(x) for x in xs)

out = ['// generated by firmware/tools/gen_rpc_vectors.py — do not edit\n#pragma once\n#include <stdint.h>\n']
out.append(f'#define RPC_REGISTRY "{REGISTRY}"\n#define RPC_TOKEN "{TOKEN}"\n#define RPC_CORE "{CORE}"\n')
out.append(f'#define RPC_FLY_ID 7ULL\n#define RPC_FLY_GENERATION {fly["generation"]}\n#define RPC_FLY_DEATHS {fly["deaths"]}\n#define RPC_FLY_BRAINSTEP {fly["brainStep"]}ULL\n#define RPC_FLY_ENERGY {fly["energy"]}ULL\n#define RPC_FLY_BORN {fly["bornBlock"]}ULL\n#define RPC_FLY_LASTCOMMIT {fly["lastCommitBlock"]}ULL\n#define RPC_FLY_URI "{fly["stateURI"]}"\n#define RPC_FLY_ALIVE 1\n')
out.append(cbytes('RPC_FLY_STATEROOT', fly['stateRoot']))
out.append(cbytes('RPC_FLY_MEMROOT', fly['memoryRoot']))
out.append(cbytes('RPC_FLY_BODY', bytes.fromhex(BODY[2:])))
out.append(cbytes('RPC_FLY_PENDING', bytes.fromhex(PENDING[2:])))
out.append(cbytes('RPC_FLY_RET', fly_ret))
out.append(f'#define RPC_CORE_N {N}\n')
out.append(f'static const int16_t RPC_CORE_V[{N}] = {{{ints(core_v)}}};\n')
out.append(f'static const int8_t RPC_CORE_BIAS[{N}] = {{{ints(core_bias)}}};\n')
out.append(f'static const uint16_t RPC_CORE_HIST[16] = {{{ints(core_hist)}}};\n')
out.append(f'static const int32_t RPC_CORE_INP[{N}] = {{{ints(core_inp)}}};\n')
for k, v in core_scalars.items(): out.append(f'#define RPC_CORE_{k.upper()} ({v}LL)\n')
out.append(cbytes('RPC_CORE_RET', core_ret))
for name, b in calls: out.append(cbytes('RPC_' + name, b))
out.append('#define RPC_TX_NONCE 42ULL\n#define RPC_TX_GASPRICE 50000000ULL\n#define RPC_TX_GAS 120000ULL\n')
out.append(cbytes('RPC_TX_RAW', bytes(signed.raw_transaction)))
out.append(cbytes('RPC_TX_HASH', bytes(signed.hash)))
out.append('#define RPC_TX2_NONCE 43ULL\n#define RPC_TX2_GASPRICE 1000000000ULL\n#define RPC_TX2_GAS 5880000ULL\n')
out.append(cbytes('RPC_TX2_RAW', bytes(signed2.raw_transaction)))
out.append(cbytes('RPC_TX2_HASH', bytes(signed2.hash)))
open(OUT, 'w').write(''.join(out))
print('wrote', OUT, len(''.join(out)), 'bytes')
