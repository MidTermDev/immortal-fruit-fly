"""Seed a fly's on-chain core (FlyCore) from FlyBrain v2's current state, once, for continuity.
usage: ../.venv/bin/python seed_core.py <coreAddress> [flyId=1]   (signs with ../deploy.txt, the curator)"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry, RPC
from web3 import Web3
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
core_addr = Web3.to_checksum_address(sys.argv[1]); fid = int(sys.argv[2]) if len(sys.argv) > 2 else 1
BRAIN = '0xee80f8cB5309C572343c38b5D717283BBBb517c5'
BRAIN_ABI = [{"name": "brainState", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [
    {"name": "v", "type": "int16[]"}, {"name": "bias", "type": "int8[]"}, {"name": "headingHist", "type": "uint16[16]"}, {"name": "pendingInput", "type": "int32[]"},
    {"name": "step", "type": "uint64"}, {"name": "energy", "type": "uint64"}, {"name": "alive", "type": "bool"}, {"name": "generation", "type": "uint32"},
    {"name": "posX", "type": "int64"}, {"name": "posY", "type": "int64"}, {"name": "headX", "type": "int32"}, {"name": "headY", "type": "int32"}]}]
core_abi = json.load(open(os.path.join(ROOT, 'contracts', 'out', 'FlyCore.sol', 'FlyCore.json')))['abi']
r = Registry(key='0x' + open(os.path.join(ROOT, 'deploy.txt')).read().strip())
brain = r.w3.eth.contract(address=BRAIN, abi=BRAIN_ABI); core = r.w3.eth.contract(address=core_addr, abi=core_abi)
v, bias, hist, inp, step, energy, alive, gen, posX, posY, headX, headY = brain.functions.brainState().call()
print(f'FlyBrain v2: step {step} energy {energy} gen {gen} head ({headX},{headY}) spikes-ish: {sum(1 for x in v if x > 0)} depolarised of {len(v)}')
cur = core.functions.core(fid).call()
if cur[4] != 0: print('core already ticked; seed refused by design'); sys.exit(1)
rc = r.send(core.functions.seed, fid, list(v), list(bias), list(hist), list(inp), int(step), int(headX), int(headY), gas=1_500_000)
print('seeded fly #%d: status %d tx %s block %d' % (fid, rc['status'], rc['transactionHash'].hex(), rc['blockNumber']))
print('core(id) step now', core.functions.core(fid).call()[4])
