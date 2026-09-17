"""Fast migration v2 -> v3: reads every remaining record in batches, then streams signed transactions with sequential
nonces (at most INFLIGHT unmined at a time), holding the operator send lock for the whole run so nothing else races.
Same ids, same owners, names, records and portraits as v2. Re-runnable: it always resumes at v3.totalMinted()+1.
   ../.venv/bin/python migrate_v3_fast.py"""
import os, sys, json, time, fcntl
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry, REGISTRY_V2, SENDLOCK
from web3 import Web3
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
INFLIGHT = int(os.environ.get('INFLIGHT', '14')); GAS_PRICE = 50_000_000
def b32(x): return bytes.fromhex(x[2:] if str(x).startswith('0x') else str(x))
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
r = Registry(key_path=os.path.join(ROOT, 'deploy.txt')); w3 = r.w3; new = r.c
old = w3.eth.contract(address=Web3.to_checksum_address(REGISTRY_V2), abi=new.abi)
ZERO = '0x0000000000000000000000000000000000000000'

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

with open(SENDLOCK, 'w') as lf:
    fcntl.flock(lf, fcntl.LOCK_EX)
    n2 = old.functions.totalMinted().call(); start = new.functions.totalMinted().call() + 1
    ids = list(range(start, n2 + 1)); log(f'v2 {n2} flies, v3 {start - 1}: migrating {len(ids)} (#{start}..#{n2})')
    if not ids: sys.exit(0)
    t0 = time.time()
    recs = [r._fly_dict(i, x) for i, x in zip(ids, batched(lambda i: old.functions.fly(i), ids))]
    owners = batched(lambda i: old.functions.ownerOf(i), ids); names = batched(lambda i: old.functions.flyName(i), ids); uris = batched(lambda i: old.functions.tokenURI(i), ids)
    log(f'read {len(ids)} records in {time.time() - t0:.0f} s')
    nonce = w3.eth.get_transaction_count(r.address, 'pending'); first_nonce = nonce
    txs = []   # (label, signed)
    for i, f, owner, name, uri in zip(ids, recs, owners, names, uris):
        rec = (b32(f['connectome']), int(f['model']), int(f['generation']), int(f['deaths']), int(f['parentA']), int(f['parentB']), b32(f['stateRoot']), b32(f['memoryRoot']), f['stateURI'], int(f['brainStep']), int(f['energy']), int(f['bornBlock']), int(f['lastCommitBlock']), ZERO, ZERO, bool(f['alive']))
        tx = new.functions.migrate(owner, name, rec).build_transaction({'from': r.address, 'nonce': nonce, 'gas': 420_000, 'gasPrice': GAS_PRICE, 'chainId': 56}); txs.append((f'migrate #{i}', r.acct.sign_transaction(tx))); nonce += 1
        if uri.startswith('ipfs://'):
            tx = new.functions.setMetadata(i, uri).build_transaction({'from': r.address, 'nonce': nonce, 'gas': 110_000, 'gasPrice': GAS_PRICE, 'chainId': 56}); txs.append((f'meta #{i}', r.acct.sign_transaction(tx))); nonce += 1
    log(f'signed {len(txs)} transactions (nonces {first_nonce}..{nonce - 1})')
    sent = 0; hashes = []
    while sent < len(txs):
        mined = w3.eth.get_transaction_count(r.address)
        room = INFLIGHT - (first_nonce + sent - mined)
        if room <= 0: time.sleep(1.5); continue
        for _ in range(min(room, len(txs) - sent)):
            label, s = txs[sent]
            try: hashes.append(w3.eth.send_raw_transaction(s.raw_transaction))
            except Exception as e:
                if 'already known' in str(e) or 'nonce too low' in str(e): hashes.append(None)
                else: log(f'{label}: send failed: {str(e)[:120]}'); time.sleep(2); break
            sent += 1
        if sent % 200 < INFLIGHT: log(f'{sent}/{len(txs)} sent, {mined - first_nonce} mined')
    while w3.eth.get_transaction_count(r.address) < nonce: time.sleep(2)
    got = new.functions.totalMinted().call(); log(f'done: v3 has {got} flies (expected {n2}) in {time.time() - t0:.0f} s')
    # verify a sample
    import random
    for i in random.sample(ids, min(12, len(ids))):
        assert new.functions.ownerOf(i).call() == old.functions.ownerOf(i).call(), i
        assert new.functions.flyName(i).call() == old.functions.flyName(i).call(), i
    log('sample of owners and names verified')
