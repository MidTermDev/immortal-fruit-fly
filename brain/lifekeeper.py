"""The life keeper (v3): every LOOP_S it looks at every alive fly that is running somewhere (body or pending body set)
and, when its energy at the last checkpoint is under LOW_S, feeds it for free through the registry's keeper role
(the operator pays only gas), up to FREE_PER_DAY seconds per fly per day. Anyone can add more life to any fly with
BNB on the site; a fly that is not running does not age. State (today's grants) in state/lifekeeper.json.
   ../.venv/bin/python lifekeeper.py"""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..'); STATE = os.path.join(HERE, 'state', 'lifekeeper.json')
LOOP_S = int(os.environ.get('LOOP_S', '120')); LOW_S = int(os.environ.get('LOW_S', '1800')); CHUNK_S = int(os.environ.get('CHUNK_S', '3600')); FREE_PER_DAY = int(os.environ.get('FREE_PER_DAY', '7200'))
ZERO = '0x0000000000000000000000000000000000000000'
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
reg = Registry(key_path=os.path.join(ROOT, 'deploy.txt'))
st = json.load(open(STATE)) if os.path.exists(STATE) else {}
log(f'life keeper {reg.address} on {reg.c.address}: keeper role {"yes" if reg.is_keeper() else "NO"}; free {FREE_PER_DAY} s per fly per day, topping up under {LOW_S} s')
while True:
    try:
        day = time.strftime('%Y-%m-%d'); used = st.setdefault(day, {})
        n = reg.c.functions.totalMinted().call()
        rows = reg.flies(list(range(1, n + 1))) if hasattr(reg, 'flies') else [reg.fly(i) for i in range(1, n + 1)]
        fed = 0
        for i, f in enumerate(rows, 1):
            if not f['alive'] or (f['body'] == ZERO and f['pendingBody'] == ZERO) or int(f['energy']) >= LOW_S: continue
            left = FREE_PER_DAY - used.get(str(i), 0)
            if left <= 0: continue
            s = min(left, CHUNK_S)
            rc = reg.feed(i, s); used[str(i)] = used.get(str(i), 0) + s; fed += 1
            log(f'fly #{i}: fed {s} s for free ({left - s} s of today\'s allowance left) tx {rc["transactionHash"].hex()}')
        for k in list(st):   # keep only today and yesterday
            if k not in (day, time.strftime('%Y-%m-%d', time.localtime(time.time() - 86400))): del st[k]
        os.makedirs(os.path.dirname(STATE), exist_ok=True); json.dump(st, open(STATE, 'w'))
        if fed: log(f'{fed} flies fed')
    except Exception as e:
        log('keeper error:', repr(e)[:200])
    time.sleep(LOOP_S)
