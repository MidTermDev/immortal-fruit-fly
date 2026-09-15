"""Hand fly #id to a body (owner or current body may do this): handoff.py <id> <arena|doom|0xaddress>"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from registry import Registry
HERE = os.path.dirname(os.path.abspath(__file__))
fid = int(sys.argv[1]); who = sys.argv[2]
addr = open(os.path.join(HERE, f'body_{who}.address')).read().strip() if not who.startswith('0x') else who
op = Registry(key='0x' + open(os.path.join(HERE, '..', 'deploy.txt')).read().strip())
rc = op.assign(fid, addr); print(f'fly #{fid} assigned to {who} ({addr}) tx {rc["transactionHash"].hex()}')
