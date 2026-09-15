"""Export a downsampled whole-brain point cloud (all 139k FlyWire neurons) for the website hero.
Output: site/assets/brain_points.bin  — uint16 x,y,z (quantised 0..65535) + uint8 class per point.
"""
import csv, struct, random, os, json
random.seed(783)
SRC = os.path.join(os.path.dirname(__file__), '..', 'data', 'Supplemental_file1_neuron_annotations.tsv')
OUT = os.path.join(os.path.dirname(__file__), '..', 'site', 'assets', 'brain_points.bin')
CLASSES = {'optic':0,'central':1,'visual_projection':2,'visual_centrifugal':2,'sensory':3,'sensory_ascending':3,
           'ascending':4,'descending':4,'motor':5,'endocrine':5}
RING = ('EPG','EPGt','PEG','PEN_a(PEN1)','PEN_b(PEN2)','Delta7')
pts=[]; ring=[]
with open(SRC) as f:
    for row in csv.DictReader(f, delimiter='\t'):
        try:
            x=float(row['pos_x'])*4; y=float(row['pos_y'])*4; z=float(row['pos_z'])*40   # -> nm
        except ValueError: continue
        c = CLASSES.get(row['super_class'], 1)
        if row['cell_type'] in RING: ring.append((x,y,z,row['root_id'],row['cell_type'],row['side']))
        pts.append((x,y,z,c))
# keep every optic-lobe point with p=0.18, others with p=0.5 -> ~ 30k points, central brain emphasised
keep=[p for p in pts if random.random() < (0.18 if p[3]==0 else 0.5)]
xs=[p[0] for p in pts]; ys=[p[1] for p in pts]; zs=[p[2] for p in pts]
mn=(min(xs),min(ys),min(zs)); mx=(max(xs),max(ys),max(zs))
def q(v,lo,hi): return int((v-lo)/(hi-lo)*65535)
with open(OUT,'wb') as f:
    f.write(struct.pack('<I', len(keep)))
    f.write(struct.pack('<6f', *mn, *mx))
    for x,y,z,c in keep:
        f.write(struct.pack('<HHHB', q(x,mn[0],mx[0]), q(y,mn[1],mx[1]), q(z,mn[2],mx[2]), c))
print('total neurons', len(pts), 'kept', len(keep), 'bytes', os.path.getsize(OUT))
print('bounds nm', mn, mx)
print('ring neurons', len(ring))
json.dump([{'x':x,'y':y,'z':z,'root_id':r,'type':t,'side':s} for x,y,z,r,t,s in ring],
          open(os.path.join(os.path.dirname(__file__), '..', 'data', 'ring_positions.json'),'w'))
