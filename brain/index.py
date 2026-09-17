"""The registry index: a read model of FlyRegistry v3 for the site.

Every INDEX_EVERY seconds it reads every fly's record, owner and name in one pass (Multicall3, a few hundred calls per
request, public RPCs first) and serves them as JSON on :8127 (nginx: https://mc.immortalfly.app/registry/). The site's
"Your flies" (3,268 ownerOf calls in a browser were never going to work), the browse grid with its filters, and the
leaderboards read from here. It is never the source of truth: the registry is, and the fly pages still read the chain.

    GET /registry/flies.json          every fly (compact), and the block it was read at
    GET /registry/leaders.json        totals and the hall of the species (top lists)
    GET /registry/owner/<addr>.json   one wallet's flies
    GET /registry/fly/<id>.json       one fly
    GET /registry/portrait/<id>.png   a 320 px copy of the curator's portrait (brain/state/portrait_<id>.png)
    GET /registry/health

Runs forever: ../.venv/bin/python index.py (run_index.sh). Environment: INDEX_PORT, INDEX_EVERY, INDEX_RPCS (comma list)."""
import asyncio, json, os, time, gzip, hashlib, traceback
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from aiohttp import web
from web3 import Web3
from eth_abi import decode
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = Web3.to_checksum_address(os.environ.get('FLYREGISTRY', '0x69DA3239B69c0B7C9C063F105c4DDf008FFb8F53'))
MULTICALL = Web3.to_checksum_address('0xcA11bde05977b3631167028862bE2a173976CA11')   # Multicall3, same address on BSC
PORT = int(os.environ.get('INDEX_PORT', '8127'))
EVERY = float(os.environ.get('INDEX_EVERY', '60'))
BATCH = 120                                   # calls per multicall: 3 per fly, so 40 flies per request
PARALLEL = int(os.environ.get('INDEX_PARALLEL', '4'))   # multicalls in flight at once
# the reads are plain eth_call: the public dataseeds serve them without a key; the private RPC (rpc.txt) is the last resort
_rpc_file = os.path.join(HERE, 'rpc.txt')
RPCS = [u for u in os.environ.get('INDEX_RPCS', '').split(',') if u] or ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-rpc.publicnode.com'] + ([open(_rpc_file).read().strip()] if os.path.exists(_rpc_file) else [])
BODIES = {}
for n in ('arena', 'colony', 'doom', 'host'):
    p = os.path.join(HERE, f'body_{n}.address')
    if os.path.exists(p): BODIES[open(p).read().strip().lower()] = n
ZERO = '0x0000000000000000000000000000000000000000'
ABI = json.load(open(os.path.join(HERE, 'FlyRegistry.abi.json')))
MC_ABI = json.loads('[{"name":"aggregate3","type":"function","stateMutability":"payable","inputs":[{"name":"calls","type":"tuple[]","components":[{"name":"target","type":"address"},{"name":"allowFailure","type":"bool"},{"name":"callData","type":"bytes"}]}],"outputs":[{"name":"returnData","type":"tuple[]","components":[{"name":"success","type":"bool"},{"name":"returnData","type":"bytes"}]}]}]')
FLY_TYPES = ['(bytes32,uint32,uint32,uint32,uint256,uint256,bytes32,bytes32,string,uint64,uint64,uint64,uint64,address,address,bool)']
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}
THUMBS = os.path.join(HERE, 'state', 'thumbs'); os.makedirs(THUMBS, exist_ok=True)

state = {'at': 0.0, 'block': 0, 'total': 0, 'flies': [], 'by_id': {}, 'by_owner': {}, 'leaders': None, 'error': None, 'took': 0.0, 'rpc': '', 'reads': 0}
blobs = {}   # path -> (etag, gzip bytes, plain bytes), rebuilt after every read


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


class Reader:
    """One RPC at a time; moves to the next on failure."""
    def __init__(self):
        self.i = 0; self.w3 = None; self.reg = None; self.mc = None
        self._use(0)

    def _use(self, i):
        self.i = i % len(RPCS); url = RPCS[self.i]
        self.w3 = Web3(Web3.HTTPProvider(url, request_kwargs={'timeout': 40}))
        self.reg = self.w3.eth.contract(address=REGISTRY, abi=ABI); self.mc = self.w3.eth.contract(address=MULTICALL, abi=MC_ABI)
        state['rpc'] = url.split('/v1/')[0].split('/')[2] if '://' in url else url

    def rotate(self):
        self._use(self.i + 1); log('rpc ->', state['rpc'])

    def read_all(self):
        """Every fly at one block (a few multicalls in flight at once). Returns (block, total, records)."""
        block = self.w3.eth.block_number - 2   # a couple of blocks back: the dataseeds behind a balancer disagree about the very latest
        total = self.reg.functions.totalMinted().call(block_identifier=block)
        per = BATCH // 3
        starts = list(range(1, total + 1, per))

        def batch(start):
            ids = list(range(start, min(total + 1, start + per)))
            calls = []
            for i in ids:
                calls += [(REGISTRY, True, self.reg.encode_abi('fly', [i])), (REGISTRY, True, self.reg.encode_abi('ownerOf', [i])), (REGISTRY, True, self.reg.encode_abi('flyName', [i]))]
            out = self.mc.functions.aggregate3(calls).call(block_identifier=block)
            recs = []
            for k, i in enumerate(ids):
                ok_f, d_f = out[3 * k]; ok_o, d_o = out[3 * k + 1]; ok_n, d_n = out[3 * k + 2]
                if not ok_f or not ok_o: continue   # burned or unminted: not in the collection
                f = decode(FLY_TYPES, d_f)[0]; owner = decode(['address'], d_o)[0]; name = decode(['string'], d_n)[0] if ok_n else ''
                recs.append({'id': i, 'name': name, 'owner': owner.lower(), 'gen': f[2], 'deaths': f[3], 'pa': f[4], 'pb': f[5], 'step': f[9], 'energy': f[10],
                             'born': f[11], 'commit': f[12], 'body': f[13].lower() if f[13] != ZERO else '', 'pending': f[14].lower() if f[14] != ZERO else '', 'alive': bool(f[15]),
                             'state': '0x' + f[6].hex()})
            state['reads'] += 1
            return recs

        with ThreadPoolExecutor(PARALLEL) as ex: parts = list(ex.map(batch, starts))
        return block, total, [r for part in parts for r in part]


def leaders_of(recs, block):
    """Totals and the hall of the species, from one read. Each list: the top ten by one number, ties by lower id."""
    by_id = {r['id']: r for r in recs}
    alive = [r for r in recs if r['alive']]
    running = [r for r in alive if r['body']]
    owners = Counter(r['owner'] for r in recs)
    brood = Counter()
    for r in recs:
        if r['pa']: brood[r['pa']] += 1
        if r['pb']: brood[r['pb']] += 1
    where = Counter(BODIES.get(r['body'], 'pebble') for r in running)
    def top(rows, key, n=10, reverse=True, value=None):
        rows = sorted(rows, key=lambda r: (-key(r) if reverse else key(r), r['id']))[:n]
        return [{'id': r['id'], 'name': r['name'], 'alive': r['alive'], 'value': (value or key)(r)} for r in rows if key(r) > 0 or not reverse]
    keepers = [{'owner': a, 'flies': n, 'alive': sum(1 for r in recs if r['owner'] == a and r['alive'])} for a, n in owners.most_common(10)]
    return {
        'block': block, 'at': time.time(),
        'totals': {'flies': len(recs), 'alive': len(alive), 'dead': len(recs) - len(alive), 'running': len(running), 'dormant': len(alive) - len(running),
                   'owners': len(owners), 'bred': sum(1 for r in recs if r['pa']), 'deaths': sum(r['deaths'] for r in recs), 'steps': sum(r['step'] for r in recs),
                   'where': dict(where), 'life_banked': sum(r['energy'] for r in alive)},
        'oldest_alive': top(alive, lambda r: r['born'], reverse=False),
        'longest_lived': top(recs, lambda r: r['step']),
        'most_lives': top(recs, lambda r: r['deaths']),
        'highest_generation': top(recs, lambda r: r['gen']),
        'biggest_brood': [{'id': i, 'name': by_id[i]['name'] if i in by_id else '', 'alive': by_id.get(i, {}).get('alive', False), 'value': n} for i, n in brood.most_common(10)],
        'most_life': top(alive, lambda r: r['energy']),
        'newest': [{'id': r['id'], 'name': r['name'], 'alive': r['alive'], 'value': r['born']} for r in sorted(recs, key=lambda r: -r['id'])[:10]],
        'top_keepers': keepers,
    }


def pack(obj):
    plain = json.dumps(obj, separators=(',', ':')).encode()
    return (f'"{hashlib.blake2b(plain, digest_size=6).hexdigest()}"', gzip.compress(plain, 6), plain)


def rebuild(block, total, recs):
    by_id = {r['id']: r for r in recs}
    by_owner = defaultdict(list)
    for r in recs: by_owner[r['owner']].append(r['id'])
    leaders = leaders_of(recs, block)
    state.update(block=block, total=total, flies=recs, by_id=by_id, by_owner=dict(by_owner), leaders=leaders, at=time.time(), error=None)
    blobs['flies'] = pack({'block': block, 'at': state['at'], 'total': total, 'bodies': {a: n for a, n in BODIES.items()}, 'flies': recs})
    blobs['leaders'] = pack(leaders)


async def refresh_forever(app):
    reader = Reader(); fails = 0
    while True:
        t0 = time.time()
        try:
            block, total, recs = await asyncio.get_running_loop().run_in_executor(None, reader.read_all)
            rebuild(block, total, recs); state['took'] = time.time() - t0; fails = 0
            log(f"read {len(recs)} flies at block {block} in {state['took']:.1f} s via {state['rpc']}")
        except Exception as e:
            fails += 1; state['error'] = str(e)[:200]; log('read failed:', str(e)[:200]); reader.rotate()
            if fails > 3: traceback.print_exc()
        await asyncio.sleep(max(5.0, EVERY - (time.time() - t0)) if fails == 0 else min(60.0, 5.0 * fails))


def send(request, key):
    if key not in blobs: return web.json_response({'ok': False, 'error': 'not read yet'}, status=503, headers=CORS)
    etag, gz, plain = blobs[key]
    if request.headers.get('If-None-Match') == etag: return web.Response(status=304, headers={**CORS, 'ETag': etag})
    h = {**CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20', 'ETag': etag}
    if 'gzip' in request.headers.get('Accept-Encoding', ''): return web.Response(body=gz, headers={**h, 'Content-Encoding': 'gzip'})
    return web.Response(body=plain, headers=h)


async def flies(request): return send(request, 'flies')
async def leaders(request): return send(request, 'leaders')


async def owner(request):
    a = request.match_info['addr'].lower().replace('.json', '')
    if not (a.startswith('0x') and len(a) == 42): return web.json_response({'ok': False, 'error': 'not an address'}, status=400, headers=CORS)
    if not state['flies']: return web.json_response({'ok': False, 'error': 'not read yet'}, status=503, headers=CORS)
    ids = state['by_owner'].get(a, [])
    return web.json_response({'block': state['block'], 'at': state['at'], 'owner': a, 'flies': [state['by_id'][i] for i in ids]}, headers={**CORS, 'Cache-Control': 'public, max-age=10'})


async def one(request):
    i = int(request.match_info['id'])
    if not state['flies']: return web.json_response({'ok': False, 'error': 'not read yet'}, status=503, headers=CORS)
    r = state['by_id'].get(i)
    if not r: return web.json_response({'ok': False, 'error': 'no such fly'}, status=404, headers=CORS)
    kids = [k['id'] for k in state['flies'] if k['pa'] == i or k['pb'] == i]
    return web.json_response({'block': state['block'], 'at': state['at'], 'fly': r, 'children': kids}, headers={**CORS, 'Cache-Control': 'public, max-age=10'})


async def portrait(request):
    i = int(request.match_info['id']); src = os.path.join(HERE, 'state', f'portrait_{i}.png'); dst = os.path.join(THUMBS, f'{i}.png')
    if not os.path.exists(src): return web.json_response({'ok': False, 'error': 'no portrait yet'}, status=404, headers=CORS)
    if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
        def make():
            im = Image.open(src).convert('RGB'); im.thumbnail((320, 320)); im.save(dst + '.tmp', 'PNG', optimize=True); os.replace(dst + '.tmp', dst)
        await asyncio.get_running_loop().run_in_executor(None, make)
    return web.FileResponse(dst, headers={**CORS, 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'image/png'})


async def health(request):
    return web.json_response({'ok': bool(state['flies']), 'block': state['block'], 'total': state['total'], 'at': state['at'], 'took': state['took'], 'rpc': state['rpc'], 'error': state['error'], 'every': EVERY}, headers=CORS)


async def options(request): return web.Response(status=204, headers=CORS)


async def on_startup(app): app['loop'] = asyncio.create_task(refresh_forever(app))
async def on_shutdown(app): app['loop'].cancel()


def main():
    app = web.Application(); app.on_startup.append(on_startup); app.on_shutdown.append(on_shutdown)
    r = app.router
    for prefix in ('', '/registry'):
        r.add_get(prefix + '/flies.json', flies); r.add_get(prefix + '/leaders.json', leaders); r.add_get(prefix + '/health', health)
        r.add_get(prefix + '/owner/{addr}', owner); r.add_get(prefix + '/fly/{id:\\d+}.json', one); r.add_get(prefix + '/fly/{id:\\d+}', one); r.add_get(prefix + '/portrait/{id:\\d+}.png', portrait)
    r.add_route('OPTIONS', '/{tail:.*}', options)
    log(f'registry index on :{PORT}, every {EVERY:.0f} s, rpcs {len(RPCS)}, bodies {BODIES}')
    web.run_app(app, host='127.0.0.1', port=PORT, print=None, access_log=None)


if __name__ == '__main__':
    main()
