"""The life keeper: keeps flies alive from the LifeFund. Every LOOP_S it looks at every alive fly that is running somewhere
(body or pending body set) and, when its energy at the last checkpoint is under LOW_S, feeds it from the fund:
sponsored credit first (LifeFund.keep, up to TOPUP_S), else the free daily allowance (LifeFund.grant), so that a fly
in the Colony, the arena or a pebble never starves while someone has paid a little BNB for it, and gets a couple of
free hours a day from the operator regardless. Runs with the operator key (the fund's owner/keeper) through the shared
send lock.   ../.venv/bin/python lifekeeper.py"""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry
from web3 import Web3
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
FUND = Web3.to_checksum_address(os.environ.get('LIFE_FUND', '0xB0e5Bf6c12207C7AFbB2A8f794809E3f072d93F3'))
LOOP_S = int(os.environ.get('LOOP_S', '120')); LOW_S = int(os.environ.get('LOW_S', '1800')); TOPUP_S = int(os.environ.get('TOPUP_S', '7200')); FREE_CHUNK_S = int(os.environ.get('FREE_CHUNK_S', '3600'))
ZERO = '0x0000000000000000000000000000000000000000'
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
reg = Registry(key_path=os.path.join(ROOT, 'deploy.txt'))
fund = reg.w3.eth.contract(address=FUND, abi=json.load(open(os.path.join(ROOT, 'contracts', 'out', 'LifeFund.sol', 'LifeFund.json')))['abi'])
log(f'life keeper {reg.address}: fund {FUND}, {fund.functions.stockSeconds().call():,} s of life in stock, topping up under {LOW_S} s')
while True:
    try:
        n = reg.c.functions.totalMinted().call()
        rows = reg.flies(list(range(1, n + 1))) if hasattr(reg, 'flies') else [reg.fly(i) for i in range(1, n + 1)]
        fed = 0
        for i, f in enumerate(rows, 1):
            if not f['alive'] or (f['body'] == ZERO and f['pendingBody'] == ZERO) or int(f['energy']) >= LOW_S: continue
            credit = fund.functions.credit(i).call()
            if credit > 0:
                s = min(credit, TOPUP_S)
                rc = reg.send(fund.functions.keep, i, s, gas=250_000); fed += 1
                log(f'fly #{i}: fed {s} s from its sponsored credit ({credit - s} s left) tx {rc["transactionHash"].hex()}')
                continue
            free = fund.functions.freeLeftToday(i).call()
            if free > 0:
                s = min(free, FREE_CHUNK_S)
                rc = reg.send(fund.functions.grant, i, s, gas=250_000); fed += 1
                log(f'fly #{i}: fed {s} s for free ({free - s} s of today\'s allowance left) tx {rc["transactionHash"].hex()}')
        if fed: log(f'{fed} flies fed; fund stock {fund.functions.stockSeconds().call():,} s')
    except Exception as e:
        log('keeper error:', repr(e)[:200])
    time.sleep(LOOP_S)
