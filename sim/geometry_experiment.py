import json, numpy as np
c = json.load(open('data/circuit.json'))
neu = c['neurons']; N = len(neu)
t = np.array([n['type'] for n in neu]); side = np.array([1 if n['side']=='right' else 0 for n in neu])
W = np.zeros((N,N))
for pre,post,w in c['synapses']: W[pre,post] = w
EPG = np.where(t<=1)[0]; PEG=np.where(t==2)[0]; PEN=np.where((t==3)|(t==4))[0]; D7=np.where(t==5)[0]
others = np.concatenate([PEG,PEN,D7])

def metrics(ang, name):
    dphi = np.abs(np.angle(np.exp(1j*(ang[:,None]-ang[None,:]))))
    I2 = W[np.ix_(EPG,D7)] @ W[np.ix_(D7,EPG)]
    strong = I2 > np.percentile(I2, 90)
    peg = (W[np.ix_(EPG,PEG)] @ W[np.ix_(PEG,EPG)]); pegm = peg > np.percentile(peg[peg>0], 50)
    off = ~np.eye(len(EPG),dtype=bool)
    # bump test: cosine kernel fit of EPG->Delta7->EPG inhibition vs angle distance
    corr = np.corrcoef(dphi[off], I2[off])[0,1]
    print(f'{name:28s} Δ7 far={np.degrees(dphi[strong].mean()):6.1f}°  PEG near={np.degrees(dphi[pegm&off].mean()):6.1f}°  corr(dist,inh)={corr:5.2f}')

def eigmap(A, k=2):
    A = A.copy(); np.fill_diagonal(A,0); A = np.maximum(A,0)
    d = A.sum(1); Dm = np.diag(1/np.sqrt(np.maximum(d,1e-9)))
    L = np.eye(len(A)) - Dm@A@Dm
    vals, vecs = np.linalg.eigh(L)
    u = vecs[:,1:3]; ang = np.arctan2(u[:,1],u[:,0]); rad=np.hypot(u[:,0],u[:,1])
    return ang, vals[1:4], rad.std()/rad.mean()

# 1 original two-hop
A1 = W[np.ix_(EPG,PEG)]@W[np.ix_(PEG,EPG)] + W[np.ix_(EPG,PEN)]@W[np.ix_(PEN,EPG)] + 10*W[np.ix_(EPG,EPG)]
a,v,cv = eigmap(A1+A1.T); print('eig',np.round(v,3),'cv',round(cv,2)); metrics(a,'two-hop exc')

# 2 connectivity-profile cosine similarity (in+out to all partners)
F = np.hstack([W[np.ix_(EPG, np.arange(N))], W[np.ix_(np.arange(N), EPG)].T])
F = F / np.maximum(np.linalg.norm(F,axis=1,keepdims=True),1e-9)
C = F@F.T
for k in (4,6,8,10):
    A = np.zeros_like(C)
    for i in range(len(EPG)):
        nn = np.argsort(-C[i])[1:k+1]; A[i,nn] = C[i,nn]
    A = np.maximum(A, A.T)
    a,v,cv = eigmap(A); print('eig',np.round(v,3),'cv',round(cv,2)); metrics(a,f'profile cosine kNN k={k}')
a,v,cv = eigmap(C); print('eig',np.round(v,3),'cv',round(cv,2)); metrics(a,'profile cosine dense')

# 3 inhibition-based: similarity = -(EPG->Δ7->EPG) + max  (far neurons inhibit each other)
I2 = W[np.ix_(EPG,D7)] @ W[np.ix_(D7,EPG)]; I2 = (I2+I2.T)/2
Asim = I2.max() - I2
a,v,cv = eigmap(Asim); print('eig',np.round(v,3),'cv',round(cv,2)); metrics(a,'anti-inhibition dense')

# 4 classical MDS on inhibition as distance
D = I2 / I2.max()
n=len(EPG); J = np.eye(n)-np.ones((n,n))/n; B = -0.5*J@(D**2)@J
vals,vecs = np.linalg.eigh(B); u = vecs[:,-2:]*np.sqrt(np.maximum(vals[-2:],0))
a = np.arctan2(u[:,1],u[:,0]); metrics(a,'MDS inhibition')

# 5 profile cosine with only Δ7 and PEN/PEG partners, dense, then circular refinement by 1D circular embedding (angular synchronization)
def circ_refine(ang, S, iters=200):
    z = np.exp(1j*ang)
    for _ in range(iters):
        z = S@z; z = z/np.abs(z)
    return np.angle(z)
S = C.copy(); np.fill_diagonal(S,0)
for k in (6,8):
    A = np.zeros_like(C)
    for i in range(len(EPG)):
        nn = np.argsort(-C[i])[1:k+1]; A[i,nn] = C[i,nn]
    A = np.maximum(A,A.T)
    a0,_,_ = eigmap(A); a = circ_refine(a0, A); metrics(a, f'kNN k={k} + sync refine')
