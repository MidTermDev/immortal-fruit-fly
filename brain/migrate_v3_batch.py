"""Batched migration v2 -> v3 through the operator account's own EIP-7702 delegation (MetaMask's stateless delegator):
one transaction executes up to BATCH flies' migrate + setMetadata calls, so the delegated-account limit of one in-flight
transaction does not matter. msg.sender inside the registry is the operator (the curator), exactly as with direct calls.
Re-runnable: resumes at v3.totalMinted()+1.   ../.venv/bin/python migrate_v3_batch.py [--dry]"""
import os, sys, json, time, fcntl
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry, REGISTRY_V2, SENDLOCK
from web3 import Web3
from eth_abi import encode
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
BATCH = int(os.environ.get('BATCH', '45')); DRY = '--dry' in sys.argv; GAS_PRICE = 50_000_000
MODE_BATCH = bytes([0x01]) + bytes(31)   # ERC-7821: batch of calls, default execution
EXECUTE = Web3.keccak(text='execute(bytes32,bytes)')[:4]
def b32(x): return bytes.fromhex(x[2:] if str(x).startswith('0x') else str(x))
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
r = Registry(key_path=os.path.join(ROOT, 'deploy.txt')); w3 = r.w3; new = r.c
old = w3.eth.contract(address=Web3.to_checksum_address(REGISTRY_V2), abi=new.abi)
ZERO = '0x0000000000000000000000000000000000000000'
assert w3.eth.get_code(r.address)[:3] == bytes.fromhex('ef0100'), 'the operator is not a delegated account'

def batched(fn_of_id, ids, size=40):
    out = []
    for k in range(0, len(ids), size):
        chunk = ids[k:k + size]
        try:
            with w3.batch_requests() as batch:
                for i in chunk: batch.add(fn_of_id(i))
                out += batch.execute()
        except Exception:
            out += [fn_of_id(i).call() for i in chunk]
    return out

def calls_for(ids, recs, owners, names, uris):
    calls = []
    for i, f, owner, name, uri in zip(ids, recs, owners, names, uris):
        rec = (b32(f['connectome']), int(f['model']), int(f['generation']), int(f['deaths']), int(f['parentA']), int(f['parentB']), b32(f['stateRoot']), b32(f['memoryRoot']), f['stateURI'], int(f['brainStep']), int(f['energy']), int(f['bornBlock']), int(f['lastCommitBlock']), ZERO, ZERO, bool(f['alive']))
        calls.append((new.address, 0, bytes.fromhex(new.functions.migrate(owner, name, rec)._encode_transaction_data()[2:])))
        if uri.startswith('ipfs://'): calls.append((new.address, 0, bytes.fromhex(new.functions.setMetadata(i, uri)._encode_transaction_data()[2:])))
    return calls

with open(SENDLOCK, 'w') as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)
    n2 = old.functions.totalMinted().call(); start = new.functions.totalMinted().call() + 1
    ids = list(range(start, n2 + 1)); log(f'v2 {n2} flies, v3 {start - 1}: migrating {len(ids)} (#{start}..#{n2}) in batches of {BATCH}' + (' [dry]' if DRY else ''))
    if not ids: sys.exit(0)
    t0 = time.time()
    recs = [r._fly_dict(i, x) for i, x in zip(ids, batched(lambda i: old.functions.fly(i), ids))]
    owners = batched(lambda i: old.functions.ownerOf(i), ids); names = batched(lambda i: old.functions.flyName(i), ids); uris = batched(lambda i: old.functions.tokenURI(i), ids)
    log(f'read {len(ids)} records in {time.time() - t0:.0f} s')
    for k in range(0, len(ids), BATCH):
        sl = slice(k, k + BATCH)
        calls = calls_for(ids[sl], recs[sl], owners[sl], names[sl], uris[sl])
        data = EXECUTE + encode(['bytes32', 'bytes'], [MODE_BATCH, encode(['(address,uint256,bytes)[]'], [calls])])
        tx = {'from': r.address, 'to': r.address, 'data': data, 'value': 0, 'chainId': 56, 'gasPrice': GAS_PRICE}
        gas = w3.eth.estimate_gas(tx); tx['gas'] = min(int(gas * 1.15), 16_700_000)
        if DRY: log(f'batch #{ids[sl][0]}..#{ids[sl][-1]}: {len(calls)} calls, gas {gas:,}'); continue
        tx['nonce'] = w3.eth.get_transaction_count(r.address, 'pending')
        h = w3.eth.send_raw_transaction(r.acct.sign_transaction(tx).raw_transaction); rc = w3.eth.wait_for_transaction_receipt(h, timeout=180)
        assert rc['status'] == 1, f'batch at #{ids[sl][0]} reverted: {h.hex()}'
        log(f'batch #{ids[sl][0]}..#{ids[sl][-1]}: {len(calls)} calls, gas {rc["gasUsed"]:,}, tx {h.hex()}; v3 now {new.functions.totalMinted().call()}')
    got = new.functions.totalMinted().call(); log(f'done: v3 has {got} flies (v2 {n2}) in {time.time() - t0:.0f} s')
    import random
    for i in random.sample(ids, min(15, len(ids))):
        assert new.functions.ownerOf(i).call() == old.functions.ownerOf(i).call(), i
        assert new.functions.flyName(i).call() == old.functions.flyName(i).call(), i
        assert new.functions.tokenURI(i).call() == old.functions.tokenURI(i).call() or not old.functions.tokenURI(i).call().startswith('ipfs://'), i
    log('sample of owners, names and portraits verified')
