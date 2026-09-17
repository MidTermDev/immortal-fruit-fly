"""Seed fly <id>'s core on a new FlyCore from its state on the previous FlyCore (continuity across a redeploy).
usage: ../.venv/bin/python seed_core_from_core.py <oldCore> <newCore> [id=1]   (curator key: ../deploy.txt)"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry
from web3 import Web3
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
old_addr, new_addr = Web3.to_checksum_address(sys.argv[1]), Web3.to_checksum_address(sys.argv[2]); fid = int(sys.argv[3]) if len(sys.argv) > 3 else 1
abi = json.load(open(os.path.join(ROOT, 'contracts', 'out', 'FlyCore.sol', 'FlyCore.json')))['abi']
r = Registry(key_path=os.path.join(ROOT, 'deploy.txt'))
old = r.w3.eth.contract(address=old_addr, abi=abi); new = r.w3.eth.contract(address=new_addr, abi=abi)
c = old.functions.core(fid).call()
v, bias, hist, inp, step, headX, headY = list(c[0]), list(c[1]), list(c[2]), list(c[3]), int(c[4]), int(c[5]), int(c[6])
print(f'old core #{fid}: step {step} head ({headX},{headY}) spikes {int(c[13])}')
if new.functions.core(fid).call()[4] != 0: print('new core already ticked; refusing'); sys.exit(1)
rc = r.send(new.functions.seed, fid, v, bias, hist, inp, step, headX, headY, gas=1_500_000)
print('seeded: status', rc['status'], 'tx', rc['transactionHash'].hex(), '| new core step', new.functions.core(fid).call()[4])
