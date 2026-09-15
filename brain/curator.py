"""Curator: gives every newly minted fly a portrait and IPFS metadata (presentation only).
Watches Minted events; for each fly whose tokenURI is still the base fallback, pins a portrait
and metadata JSON and calls setMetadata. Runs forever.   ../.venv/bin/python curator.py"""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry, portrait, REGISTRY
HERE = os.path.dirname(os.path.abspath(__file__)); STATE = os.path.join(HERE, 'state', 'curator.json')
DEPLOY_BLOCK = int(os.environ.get('REGISTRY_DEPLOY_BLOCK', '122001000'))
reg = Registry(key='0x' + open(os.path.join(HERE, '..', 'deploy.txt')).read().strip())
st = json.load(open(STATE)) if os.path.exists(STATE) else {'done': [], 'block': DEPLOY_BLOCK}
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
log('curator', reg.address, 'registry', REGISTRY)
while True:
    try:
        head = reg.w3.eth.block_number
        for ev in reg.events('Minted', st['block'], head):
            fid = ev['id']
            if fid in st['done']: continue
            uri = reg.c.functions.tokenURI(fid).call()
            if not uri.startswith('ipfs://'):
                png = os.path.join(HERE, 'state', f'portrait_{fid}.png'); portrait(fid, ev['name'], png)
                img_cid = reg.pinata.pin(png, f'fly-{fid}.png'); meta = reg.metadata(fid, f'ipfs://{img_cid}'); mcid = reg.pinata.pin_json(meta, f'fly-{fid}.json')
                f = reg.fly(fid)
                if f['body'] == '0x0000000000000000000000000000000000000000':
                    reg.set_metadata(fid, f'ipfs://{mcid}'); log(f'fly #{fid} "{ev["name"]}": portrait ipfs://{img_cid} metadata ipfs://{mcid}')
                    reg.market_refresh(fid)   # Element cached the pre-portrait fallback; ask it to look again
                else: log(f'fly #{fid} already has a body; its body will set metadata')
            st['done'].append(fid)
        st['block'] = head + 1; json.dump(st, open(STATE, 'w'))
    except Exception as e:
        log('curator error:', str(e)[:200])
    time.sleep(30)
