"""Migrate every fly from FlyRegistry v2 to v3: recreate each token, in id order, for its current owner with its record
(generation, deaths, parents, brain state root/URI, step, energy, alive), and carry its portrait/metadata over
(setMetadata on v3 while it has no body). Curator only; the v3 contract must still have its migration open.
usage: ../.venv/bin/python migrate_v3.py <v3 address> [--dry]"""
import os, sys, json, time
def b32(x): return x if isinstance(x, (bytes, bytearray)) else bytes.fromhex(x[2:] if str(x).startswith('0x') else str(x))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry
from web3 import Web3
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
V3 = Web3.to_checksum_address(sys.argv[1]); DRY = '--dry' in sys.argv
old = Registry(key_path=os.path.join(ROOT, 'deploy.txt'))
abi = json.load(open(os.path.join(ROOT, 'contracts', 'out', 'FlyRegistryV3.sol', 'FlyRegistryV3.json')))['abi']
new = old.w3.eth.contract(address=V3, abi=abi)
n = old.c.functions.totalMinted().call(); start = new.functions.totalMinted().call() + 1
print(f'v2 has {n} flies; v3 has {start - 1}; migrating #{start}..#{n}' + (' (dry run)' if DRY else ''))
for i in range(start, n + 1):
    f = old.fly(i); owner = old.c.functions.ownerOf(i).call(); name = old.c.functions.flyName(i).call(); uri = old.c.functions.tokenURI(i).call()
    rec = (b32(f['connectome']), int(f['model']), int(f['generation']), int(f['deaths']), int(f['parentA']), int(f['parentB']), b32(f['stateRoot']), b32(f['memoryRoot']), f['stateURI'], int(f['brainStep']), int(f['energy']), int(f['bornBlock']), int(f['lastCommitBlock']), '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', bool(f['alive']))
    print(f'#{i} {name!r} -> {owner[:10]} alive={f["alive"]} gen={f["generation"]} energy={f["energy"]} meta={uri[:40]}')
    if DRY: continue
    def send(fn, *a, gas):
        for attempt in range(4):
            try:
                rc = old.send(fn, *a, gas=gas); assert rc['status'] == 1, i; return rc
            except Exception as e:
                if attempt == 3 or 'nonce' not in str(e): raise
                print('  nonce race, retrying'); time.sleep(4)
    send(new.functions.migrate, owner, name, rec, gas=450_000)
    if uri.startswith('ipfs://'): send(new.functions.setMetadata, i, uri, gas=120_000)
if not DRY and n >= start:
    print('all migrated; the migration stays open until you run close_v3.py (so a fly minted on v2 during the switch can still be carried over)')
