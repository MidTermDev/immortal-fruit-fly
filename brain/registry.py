"""Client for FlyRegistry on BNB Smart Chain, plus IPFS pinning and fly portraits.

Used by every body (arena, DOOM, …) and by the curator. All sends from one machine go
through a file lock so bodies sharing a host never race for nonces.
"""
import os, json, time, fcntl, hashlib, subprocess, math, warnings
warnings.filterwarnings('ignore', message='.*MismatchedABI.*')
from web3 import Web3

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
REGISTRY = os.environ.get('FLYREGISTRY', '0x0eeB0A675720306Ef6f426Bd8560c1288848f813')
TOKEN = '0x23791aa3b031659b593cf141a2bc76b0ad657777'
RPC = os.environ.get('RPC_URL') or (open(os.path.join(HERE, 'rpc.txt')).read().strip() if os.path.exists(os.path.join(HERE, 'rpc.txt')) else 'https://bsc-dataseed.bnbchain.org')
SITE = 'https://midtermdev.github.io/immortal-fruit-fly'
ABI = json.load(open(os.path.join(HERE, 'FlyRegistry.abi.json')))
ERC20_ABI = json.loads('[{"name":"approve","type":"function","inputs":[{"name":"s","type":"address"},{"name":"a","type":"uint256"}],"outputs":[{"type":"bool"}]},{"name":"allowance","type":"function","stateMutability":"view","inputs":[{"name":"o","type":"address"},{"name":"s","type":"address"}],"outputs":[{"type":"uint256"}]}]')
SENDLOCK = os.path.join(HERE, '.sendlock')
IDENTITY = json.load(open(os.path.join(HERE, 'identity.json')))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for c in iter(lambda: f.read(1 << 24), b''): h.update(c)
    return h.hexdigest()


class Pinata:
    def __init__(self):
        p = os.path.join(HERE, 'pinata.env'); self.jwt = os.environ.get('PINATA_JWT') or (open(p).read().split('=', 1)[1].strip() if os.path.exists(p) else None)

    def pin(self, path, name):
        if not self.jwt: raise RuntimeError('no PINATA_JWT')
        out = subprocess.run(['curl', '-s', '-m', '300', '-H', f'Authorization: Bearer {self.jwt}', '-F', f'file=@{path}', '-F', f'pinataMetadata={{"name":"{name}"}}', 'https://api.pinata.cloud/pinning/pinFileToIPFS'], capture_output=True, text=True).stdout
        return json.loads(out)['IpfsHash']

    def pin_json(self, obj, name):
        p = os.path.join('/tmp', f'pin_{int(time.time()*1000)}.json'); json.dump(obj, open(p, 'w'), indent=1)
        try: return self.pin(p, name)
        finally: os.remove(p)


class Registry:
    def __init__(self, key_path=None, key=None):
        self.w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={'timeout': 60}))
        self.c = self.w3.eth.contract(address=Web3.to_checksum_address(REGISTRY), abi=ABI)
        self.token = self.w3.eth.contract(address=Web3.to_checksum_address(TOKEN), abi=ERC20_ABI)
        k = key or (open(key_path).read().strip() if key_path else None)
        self.acct = self.w3.eth.account.from_key(k) if k else None
        self.address = self.acct.address if self.acct else None
        self.pinata = Pinata()

    # ---------------------------------------------------------------- reads
    FLY_KEYS = ['connectome', 'model', 'generation', 'deaths', 'parentA', 'parentB', 'stateRoot', 'memoryRoot', 'stateURI', 'brainStep', 'energy', 'bornBlock', 'lastCommitBlock', 'body', 'pendingBody', 'alive']

    def _fly_dict(self, fid, row):
        d = dict(zip(self.FLY_KEYS, row)); d['connectome'] = d['connectome'].hex(); d['stateRoot'] = d['stateRoot'].hex(); d['memoryRoot'] = d['memoryRoot'].hex(); d['id'] = fid
        return d

    def fly(self, fid):
        d = self._fly_dict(fid, self.c.functions.fly(fid).call())
        d['name'] = self.c.functions.flyName(fid).call(); d['owner'] = self.c.functions.ownerOf(fid).call()
        return d

    def flies(self, ids):
        """The records of many flies (without name/owner), batched 50 per round trip; one call each where the provider refuses batches."""
        ids = list(ids); out = []
        for k in range(0, len(ids), 50):
            chunk = ids[k:k + 50]
            try:
                with self.w3.batch_requests() as batch:
                    for i in chunk: batch.add(self.c.functions.fly(i))
                    rows = batch.execute()
            except Exception:
                rows = [self.c.functions.fly(i).call() for i in chunk]
            out += [self._fly_dict(i, r) for i, r in zip(chunk, rows)]
        return out

    def body(self, addr):
        """The registered body record: {name, uri, registeredBlock, flies} ('' name when never registered)."""
        b = self.c.functions.bodies(Web3.to_checksum_address(addr)).call(); return {'name': b[0], 'uri': b[1], 'registeredBlock': b[2], 'flies': b[3]}

    def total(self): return self.c.functions.totalMinted().call()

    def events(self, name, from_block, to_block='latest', **filters):
        ev = getattr(self.c.events, name)
        out = []
        frm = from_block; head = self.w3.eth.block_number if to_block == 'latest' else to_block
        while frm <= head:
            to = min(head, frm + 9999)
            for l in ev.get_logs(from_block=frm, to_block=to, argument_filters=filters or None): out.append({'block': l['blockNumber'], 'tx': l['transactionHash'].hex(), **{k: (v.hex() if isinstance(v, bytes) else v) for k, v in dict(l['args']).items()}})
            frm = to + 1
        return out

    # ---------------------------------------------------------------- sends
    def send(self, fn, *args, gas=None, value=0):
        if not self.acct: raise RuntimeError('no key')
        with open(SENDLOCK, 'w') as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            tx = fn(*args).build_transaction({'from': self.address, 'nonce': self.w3.eth.get_transaction_count(self.address, 'pending'), 'gas': gas or 600_000, 'gasPrice': max(self.w3.eth.gas_price, 50_000_000), 'value': value, 'chainId': 56})
            signed = self.acct.sign_transaction(tx); h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            rc = self.w3.eth.wait_for_transaction_receipt(h, timeout=180)
        if rc['status'] != 1: raise RuntimeError('reverted ' + h.hex())
        return rc

    def ensure_allowance(self, amount):
        if self.token.functions.allowance(self.address, self.c.address).call() < amount:
            self.send(self.token.functions.approve, self.c.address, 2 ** 256 - 1, gas=80_000)

    def register_body(self, name, uri): return self.send(self.c.functions.registerBody, name, uri)
    def assign(self, fid, body): return self.send(self.c.functions.assign, fid, Web3.to_checksum_address(body))
    def accept(self, fid): return self.send(self.c.functions.accept, fid)
    def release(self, fid): return self.send(self.c.functions.release, fid)
    def mint(self, name): self.ensure_allowance(10 ** 18); rc = self.send(self.c.functions.mint, name, gas=400_000); return self.c.events.Minted().process_receipt(rc)[0]['args']['id']
    def feed(self, fid, seconds): self.ensure_allowance(seconds * 10 ** 18); return self.send(self.c.functions.feed, fid, seconds)
    def resurrect(self, fid, seconds): self.ensure_allowance((1000 + seconds) * 10 ** 18); return self.send(self.c.functions.resurrect, fid, seconds)
    def commit(self, fid, state_root, memory_root, state_uri, metadata_uri, step, energy, history_root):
        return self.send(self.c.functions.commit, fid, bytes.fromhex(state_root), bytes.fromhex(memory_root), state_uri, metadata_uri, int(step), int(energy), bytes.fromhex(history_root))
    def interaction(self, fid, kind, data): return self.send(self.c.functions.interaction, fid, kind.encode().ljust(32, b'\0')[:32], data[:512], gas=120_000)
    def died(self, fid, state_root, memory_root, state_uri, metadata_uri, step, cause):
        return self.send(self.c.functions.died, fid, bytes.fromhex(state_root), bytes.fromhex(memory_root), state_uri, metadata_uri, int(step), cause)
    def set_metadata(self, fid, uri): return self.send(self.c.functions.setMetadata, fid, uri)

    # ---------------------------------------------------------------- IPFS
    def pin_snapshot(self, path):
        """Pins a snapshot; returns (sha256, ipfs URI). The registry's stateRoot is the sha256 of the brain, not of the file."""
        cid = self.pinata.pin(path, os.path.basename(path)); return cid, f'ipfs://{cid}'

    def metadata(self, fid, image_uri, extra=None, body_name=None, state=None):
        """ERC-721 token metadata (the OpenSea metadata standard, which Element and every BNB Chain marketplace read). `state` overrides the chain record with the values being committed right now
        (stateRoot, stateURI, brainStep, energy, alive, body), so metadata never lags a commit behind."""
        f = dict(self.fly(fid)); f.update(state or {}); alive = f['alive']
        body = body_name or ('none' if f['body'] in ('0x0000000000000000000000000000000000000000', '', None) else f['body'])
        attrs = [{'trait_type': 'Generation', 'value': int(f['generation'])}, {'trait_type': 'Deaths', 'value': int(f['deaths'])}, {'trait_type': 'Status', 'value': 'alive' if alive else 'dead (brain preserved)'},
                 {'trait_type': 'Energy (s)', 'value': int(f['energy'])}, {'trait_type': 'Brain step', 'value': int(f['brainStep'])}, {'trait_type': 'Body', 'value': body},
                 {'trait_type': 'Neurons', 'value': IDENTITY['neurons']}, {'trait_type': 'Connectome', 'value': 'FlyWire 783'}, {'trait_type': 'Lineage', 'value': 'genesis' if f['parentA'] == 0 else f'child of #{f["parentA"]} and #{f["parentB"]}'}]
        for k, v in (extra or {}).items(): attrs.append({'trait_type': k, 'value': v})
        fate = 'It dies when it starves and can be woken by anyone.' if alive else 'It is dead: its brain is frozen at exactly this state, and it cannot be sold until someone resurrects it, at which point the same brain continues.'
        return {'name': f'{f["name"]} · Fly #{fid}', 'description': f'A living fruit-fly brain on BNB Smart Chain: 139,248 neurons of the FlyWire connectome running the published whole-brain model. Brain state {str(f["stateRoot"])[:12]}… is committed on-chain; the bytes are at {f["stateURI"] or "(genesis)"}. {fate} Everything it has lived through, in every body, is in its interaction history.',
                'image': image_uri, 'external_url': f'{SITE}/fly/?id={fid}', 'attributes': attrs}

    def portrait_uri(self, fid):
        """The image of the token's current metadata (set by the curator at mint), or '' if none yet."""
        try:
            u = self.c.functions.tokenURI(fid).call()
            if not u.startswith('ipfs://'): return ''
            import urllib.request
            req = urllib.request.Request(f'https://gateway.pinata.cloud/ipfs/{u[7:]}', headers={'User-Agent': 'curl/8'})   # the gateway 403s urllib's default agent
            with urllib.request.urlopen(req, timeout=30) as r: return json.load(r).get('image', '')
        except Exception: return ''

    def market_refresh(self, *fids):
        """Ask the marketplace (Element) to re-read these tokens' metadata. Best effort, detached, never raises."""
        try:
            subprocess.Popen(['node', os.path.join(HERE, 'market_refresh.mjs'), *[str(f) for f in fids]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception: pass

    def pin_metadata(self, fid, image_uri, extra=None, body_name=None, state=None):
        meta = self.metadata(fid, image_uri, extra, body_name, state)
        return f"ipfs://{self.pinata.pin_json(meta, f'fly-{fid}.json')}", meta


def portrait(fid, name, out_path):
    """A fly portrait from the ASCII fly, colored by id."""
    from PIL import Image, ImageDraw, ImageFont
    import random
    rng = random.Random(fid * 7919 + 13)
    art = open(os.path.join(ROOT, 'brand', 'fly.txt')).read().rstrip('\n').split('\n'); cols = max(len(l) for l in art)
    h = rng.random(); import colorsys
    eye = tuple(int(255 * c) for c in colorsys.hsv_to_rgb(h, 0.85, 1.0)); body_c = tuple(int(255 * c) for c in colorsys.hsv_to_rgb((h + 0.5) % 1, 0.15 + 0.25 * rng.random(), 0.9)); bg = tuple(int(255 * c) for c in colorsys.hsv_to_rgb((h + 0.62) % 1, 0.5, 0.06 + 0.06 * rng.random()))
    size = 1024; fs = 38; lh = 45
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', fs); cw = font.getlength('M')
    img = Image.new('RGB', (size, size), bg); d = ImageDraw.Draw(img)
    x0 = (size - cols * cw) / 2; y0 = (size - len(art) * lh) / 2 - 40
    for i, l in enumerate(art):
        for j, ch in enumerate(l):
            if ch == ' ': continue
            d.text((x0 + j * cw, y0 + i * lh), ch, font=font, fill=eye if ch == '@' else body_c)
    f2 = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 40); t = f'{name}'.upper()[:22]; d.text(((size - f2.getlength(t)) / 2, y0 + len(art) * lh + 50), t, font=f2, fill=body_c)
    f3 = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 26); t2 = f'FLY #{fid} · 139,248 NEURONS · BNB CHAIN'; d.text(((size - f3.getlength(t2)) / 2, y0 + len(art) * lh + 110), t2, font=f3, fill=eye)
    img.save(out_path); return out_path
