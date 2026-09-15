// Immortal Fruit Fly — page logic. Ties the simulator, the 3D brain, the compass,
// the walk map and the chain together.
(function () {
  const CFG = window.FLY_CONFIG, CIRC = window.FLY_CIRCUIT, PARAMS = window.FLY_PARAMS;
  const { Circuit, FlySim, CH, COS16, SIN16, WEDGES, TYPE_NAMES } = window.FlySim;
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n).toLocaleString('en-US');
  const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const fmtTok = (wei, d = 0) => { try { return Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: d }); } catch { return '0'; } };

  // ---------------------------------------------------------------- state
  const circuit = new Circuit(CIRC.table);
  const sim = new FlySim(circuit, PARAMS);
  let mode = 'preview';           // 'chain' | 'preview'
  let chain = null, chainState = null, wallet = null, balance = 0n;
  const wedgeAct = new Array(WEDGES).fill(0);   // decaying EPG activity per wedge, for the dial
  let headAngle = 0, headMag = 0;               // smoothed compass reading
  const trail = [];                             // [x,y] in cells
  let brain3d = null;

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(msg, ms = 4200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }

  // ---------------------------------------------------------------- 3D
  try { brain3d = new Brain3D($('brain'), window.BRAIN_POINTS_B64, CIRC.neurons); }
  catch (e) { console.warn('WebGL unavailable', e); $('brain').style.display = 'none'; }

  sim.onStep = (spikes) => {
    if (brain3d) brain3d.spike(spikes);
    let hx = 0, hy = 0;
    for (const i of spikes) { const w = circuit.wedge[i]; if (circuit.type[i] <= 1 && w !== 255) { wedgeAct[w] = Math.min(3, wedgeAct[w] + 1); hx += COS16[w]; hy += SIN16[w]; } }
    if (hx || hy) { const a = Math.atan2(hy, hx); headAngle = a; headMag = Math.min(1, Math.hypot(hx, hy) / 400); }
  };

  // ---------------------------------------------------------------- compass dial
  const dial = $('compass'), dctx = dial.getContext('2d');
  function drawCompass() {
    const r = dial.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2);
    if (dial.width !== Math.round(r.width * dpr)) { dial.width = Math.round(r.width * dpr); dial.height = Math.round(r.width * dpr); }
    const S = dial.width, c = S / 2, R = S * 0.44, r0 = S * 0.27;
    dctx.clearRect(0, 0, S, S);
    for (let w = 0; w < WEDGES; w++) {
      const a0 = w * 2 * Math.PI / WEDGES, a1 = a0 + 2 * Math.PI / WEDGES - 0.02;
      const act = Math.min(1, wedgeAct[w] / 2);
      dctx.beginPath(); dctx.arc(c, c, R, -a1, -a0, false); dctx.arc(c, c, r0, -a0, -a1, true); dctx.closePath();
      dctx.fillStyle = `rgba(245,184,64,${0.06 + act * 0.9})`; dctx.fill();
      if (act > 0.6) { dctx.fillStyle = `rgba(255,77,46,${(act - 0.6) * 1.6})`; dctx.fill(); }
      // heading memory ring (outer, faint)
      const h = sim.hist[w] || 0, hm = Math.max(1, ...sim.hist);
      dctx.beginPath(); dctx.arc(c, c, R + S * 0.03, -a1, -a0, false); dctx.arc(c, c, R + S * 0.012, -a0, -a1, true); dctx.closePath();
      dctx.fillStyle = `rgba(79,195,247,${0.08 + 0.7 * (h / hm)})`; dctx.fill();
    }
    // needle
    dctx.save(); dctx.translate(c, c); dctx.rotate(-headAngle);
    dctx.beginPath(); dctx.moveTo(0, -S * 0.012); dctx.lineTo(r0 * (0.4 + 0.6 * headMag), 0); dctx.lineTo(0, S * 0.012); dctx.closePath();
    dctx.fillStyle = '#e8e4da'; dctx.fill(); dctx.restore();
    dctx.beginPath(); dctx.arc(c, c, S * 0.018, 0, 7); dctx.fillStyle = '#ff4d2e'; dctx.fill();
    // labels
    dctx.fillStyle = 'rgba(232,228,218,0.55)'; dctx.font = `${Math.round(S * 0.032)}px JetBrains Mono, monospace`; dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
    for (let w = 0; w < WEDGES; w += 4) { const a = (w + 0.5) * 2 * Math.PI / WEDGES; dctx.fillText(String(w), c + Math.cos(a) * S * 0.485, c - Math.sin(a) * S * 0.485); }
  }
  dial.addEventListener('click', e => {
    const r = dial.getBoundingClientRect(); const x = e.clientX - r.left - r.width / 2, y = -(e.clientY - r.top - r.height / 2);
    const w = ((Math.floor(Math.atan2(y, x) / (2 * Math.PI / WEDGES)) % WEDGES) + WEDGES) % WEDGES;
    $('cue-wedge').value = w; $('cue-wedge-out').textContent = w; toast(`Wedge ${w} selected. Press “Flash cue” to pin the compass there.`, 2500);
  });

  // ---------------------------------------------------------------- walk map
  const walk = $('walk'), wctx = walk.getContext('2d');
  function drawWalk() {
    const r = walk.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2);
    if (walk.width !== Math.round(r.width * dpr)) { walk.width = Math.round(r.width * dpr); walk.height = Math.round(r.height * dpr); }
    const W = walk.width, H = walk.height; wctx.clearRect(0, 0, W, H);
    const pts = trail.length ? trail : [[0, 0]];
    let minx = 0, maxx = 0, miny = 0, maxy = 0;
    for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    const span = Math.max(8, maxx - minx, maxy - miny) * 1.15; const sc = Math.min(W, H) / span;
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const P = ([x, y]) => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];
    // grid
    wctx.strokeStyle = 'rgba(232,228,218,0.07)'; wctx.lineWidth = 1;
    const g = Math.pow(10, Math.floor(Math.log10(span / 4)));
    for (let x = Math.floor((cx - span) / g) * g; x < cx + span; x += g) { const [px] = P([x, 0]); wctx.beginPath(); wctx.moveTo(px, 0); wctx.lineTo(px, H); wctx.stroke(); }
    for (let y = Math.floor((cy - span) / g) * g; y < cy + span; y += g) { const [, py] = P([0, y]); wctx.beginPath(); wctx.moveTo(0, py); wctx.lineTo(W, py); wctx.stroke(); }
    // trail
    wctx.strokeStyle = 'rgba(245,184,64,0.9)'; wctx.lineWidth = Math.max(1, W / 400);
    wctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? wctx.lineTo(x, y) : wctx.moveTo(x, y); }); wctx.stroke();
    const [ex, ey] = P(pts[pts.length - 1]);
    wctx.save(); wctx.translate(ex, ey); wctx.rotate(-headAngle);
    wctx.fillStyle = '#ff4d2e'; wctx.beginPath(); wctx.moveTo(W / 60, 0); wctx.lineTo(-W / 90, W / 120); wctx.lineTo(-W / 90, -W / 120); wctx.closePath(); wctx.fill(); wctx.restore();
    wctx.fillStyle = 'rgba(232,228,218,0.5)'; wctx.font = `${Math.round(W / 42)}px JetBrains Mono, monospace`; wctx.textAlign = 'left';
    wctx.fillText(`grid ${g} cell${g === 1 ? '' : 's'}`, 8 * dpr, H - 8 * dpr);
  }
  function pushTrail() { const x = sim.posX / 256, y = sim.posY / 256; const l = trail[trail.length - 1]; if (!l || l[0] !== x || l[1] !== y) { trail.push([x, y]); if (trail.length > 4000) trail.shift(); } }

  // ---------------------------------------------------------------- stats
  function render() {
    const alive = sim.alive;
    const st = $('status'); st.textContent = mode === 'chain' ? (alive ? 'alive · on-chain' : 'dead · on-chain') : (alive ? 'alive · preview' : 'dead · preview');
    st.className = 'status' + (alive ? '' : ' dead') + (mode === 'preview' ? ' preview' : '');
    const src = mode === 'chain' && chainState ? chainState : sim;   // the label reports what is on-chain; the animation runs ahead
    $('gen').textContent = src.generation;
    $('step').textContent = fmt(src.step) + (mode === 'chain' ? ` (+${fmt(sim.step - chainState.step)} preview)` : '');
    $('energy').textContent = fmt(src.energy);
    $('spikes').textContent = fmt(mode === 'chain' ? chainState.totalSpikes : sim.totalSpikes);
    $('pos').textContent = `${(src.posX / 256).toFixed(1)}, ${(src.posY / 256).toFixed(1)}`;
    $('heading').textContent = `${Math.round(((headAngle * 180 / Math.PI) + 360) % 360)}°`;
    const maxE = Math.max(1, Number($('energy').dataset.max || 1000000), sim.energy);
    $('energy-bar').style.width = Math.min(100, 100 * sim.energy / maxE) + '%';
    const stim = sim.stimChannel && sim.step < sim.stimUntil ? ['', 'cue', 'turn left', 'turn right', 'shock'][sim.stimChannel] + (sim.stimChannel === 1 ? ` @${sim.stimParam}` : '') + ` ×${sim.stimStrength}` : 'none';
    $('stim').textContent = stim;
    $('resurrect-card').hidden = alive;
    if (chainState) { $('burned').textContent = fmtTok(chainState.totalBurned); $('block').textContent = fmt(chainState.block); $('gen-count').textContent = chainState.lineageLength + 1; }
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now(), acc = 0;
  const SPS = CFG.previewStepsPerSecond || 10;
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    acc += dt * SPS;
    let n = 0;
    while (acc >= 1 && n < 4) { acc -= 1; n++; if (sim.alive) { sim.tick(1); pushTrail(); } }
    const dec = Math.exp(-dt * 3); for (let w = 0; w < WEDGES; w++) wedgeAct[w] *= dec;
    headMag *= Math.exp(-dt * 0.5);
    if (brain3d) brain3d.frame(dt);
    drawCompass(); drawWalk();
    if (n) render();
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- chain sync
  function applyChainState(s) {
    const spikesBefore = sim.totalSpikes;
    sim.loadState(s); sim.totalSpikes = 0; s._simSpikesAtLoad = 0; chainState = s;
    $('energy').dataset.max = Math.max(Number($('energy').dataset.max || 0), s.energy);
    trail.length = 0; pushTrail();
  }
  async function syncChain() {
    try {
      const s = await chain.readState();
      if (!chainState || s.step !== chainState.step || s.generation !== chainState.generation || s.alive !== chainState.alive || s.energy > chainState.energy) {
        if (chainState && s.step !== chainState.step) toast(`On-chain tick: step ${fmt(chainState.step)} → ${fmt(s.step)}`, 2500);
        applyChainState(s);
        loadEvents().catch(() => {});
      } else { chainState.block = s.block; chainState.totalBurned = s.totalBurned; }
      render();
    } catch (e) { console.warn('sync failed', e); }
  }
  async function loadEvents() {
    const evs = await chain.recentEvents(40000);
    const box = $('log'); box.innerHTML = '';
    const names = { Ticked: e => `tick +${e.steps} steps · ${e.spikes} spikes · by ${short(e.by)}`, Fed: e => `fed ${fmtTok(e.tokensBurned)} FLY (+${fmt(e.energyAdded)} steps) · by ${short(e.by)}`,
      Stimulated: e => `${['', 'cue', 'turn left', 'turn right', 'shock'][Number(e.channel)]}${Number(e.channel) === 1 ? ' @' + e.param : ''} ×${e.strength} · ${fmtTok(e.tokensBurned)} FLY · by ${short(e.by)}`,
      Died: e => `DIED · generation ${e.generation} · lived ${fmt(e.lifeSteps)} steps, ${fmt(e.lifeSpikes)} spikes`, Resurrected: e => `RESURRECTED · generation ${e.generation} · by ${short(e.by)}` };
    for (const ev of evs.slice(0, 40)) {
      const d = document.createElement('div'); const a = document.createElement('a'); a.href = `${CFG.explorer}/tx/${ev.tx}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '#' + ev.block;
      const b = document.createElement('b'); b.textContent = names[ev.name] ? names[ev.name](ev.args) : ev.name; d.append(a, b); box.appendChild(d);
    }
    if (!evs.length) box.innerHTML = '<div><span>—</span><b>no interactions in the last 40,000 blocks</b></div>';
    // walk trail from Ticked events (oldest first)
    const ticks = evs.filter(e => e.name === 'Ticked').reverse();
    if (ticks.length) { trail.length = 0; for (const t of ticks) trail.push([Number(t.args.posX) / 256, Number(t.args.posY) / 256]); pushTrail(); }
    // lineage
    if (chainState.lineageLength) {
      const lin = await chain.readLineage(chainState.lineageLength); const tb = $('lineage-body'); tb.innerHTML = '';
      for (const l of lin) { const tr = document.createElement('tr'); tr.innerHTML = `<td class="mono">${l.generation}</td><td class="mono">${fmt(l.bornBlock)}</td><td class="mono">${fmt(l.diedBlock)}</td><td class="mono">${fmt(l.steps)}</td><td class="mono">${fmt(l.spikes)}</td><td class="mono hash">${l.hash.slice(0, 18)}…</td>`; tb.appendChild(tr); }
      $('lineage-empty').hidden = true;
    }
  }

  // ---------------------------------------------------------------- actions
  function strength() { return Math.max(1, Math.min(255, Number($('strength').value) || 4)); }
  async function act(kind, fn, previewFn) {
    if (mode === 'preview') { previewFn(); toast(`Preview: ${kind} applied to the local copy of the brain. On-chain actions need a wallet once the site is connected to BNB Chain.`); render(); return; }
    if (!wallet) { toast('Connect a wallet first.'); return; }
    try { toast(`${kind}: confirm in your wallet…`, 60000); const rc = await fn(); toast(`${kind}: confirmed in block ${fmt(rc.blockNumber)}.`); await syncChain(); balance = await chain.balance(); $('wallet-bal').textContent = fmtTok(balance) + ' FLY'; }
    catch (e) { console.error(e); toast(`${kind} failed: ${e.shortMessage || e.reason || e.message}`, 7000); }
  }
  $('btn-feed').onclick = () => { const amt = Number($('feed-amount').value) || 0; if (amt <= 0) return toast('Enter an amount of FLY.'); act('Feed', () => chain.feed(ethers.parseEther(String(amt))), () => { sim.energy += Math.floor(amt); }); };
  $('btn-cue').onclick = () => { const w = Number($('cue-wedge').value) || 0; act(`Cue @${w}`, () => chain.stimulate(CH.CUE, w, strength(), 32), () => sim.stimulate(CH.CUE, w, strength())); };
  $('btn-left').onclick = () => act('Turn left', () => chain.stimulate(CH.TURN_LEFT, 0, strength(), 32), () => sim.stimulate(CH.TURN_LEFT, 0, strength()));
  $('btn-right').onclick = () => act('Turn right', () => chain.stimulate(CH.TURN_RIGHT, 0, strength(), 32), () => sim.stimulate(CH.TURN_RIGHT, 0, strength()));
  $('btn-shock').onclick = () => act('Shock', () => chain.stimulate(CH.SHOCK, 0, strength(), 32), () => sim.stimulate(CH.SHOCK, 0, strength()));
  $('btn-tick').onclick = () => act('Tick 32', () => chain.tick(32), () => { sim.tick(32); pushTrail(); });
  $('btn-resurrect').onclick = () => { const extra = Number($('resurrect-food').value) || 0; act('Resurrect', () => chain.resurrect(ethers.parseEther(String(extra))), () => { sim.alive = true; sim.generation++; sim.energy = extra; sim.posX = 0; sim.posY = 0; trail.length = 0; }); };
  $('cue-wedge').oninput = e => { $('cue-wedge-out').textContent = e.target.value; };
  $('strength').oninput = e => { $('strength-out').textContent = e.target.value; updateCosts(); };
  function updateCosts() {
    if (!chain || !chain.prices) return;
    $('cost-stim').textContent = `${fmtTok(chain.prices.stimPrice * BigInt(strength()))} FLY`;
    $('cost-feed').textContent = `${fmtTok(chain.prices.tokensPerStep)} FLY = 1 step`;
    $('cost-res').textContent = `${fmtTok(chain.prices.resurrectPrice)} FLY + food`;
  }
  $('btn-connect').onclick = async () => {
    if (mode !== 'chain') return toast('The site is not connected to BNB Chain right now (preview mode).');
    try { wallet = await chain.connectWallet(); balance = await chain.balance(); $('btn-connect').textContent = short(wallet); $('wallet-bal').textContent = fmtTok(balance) + ' FLY'; $('wallet-bal').hidden = false; toast(`Connected ${short(wallet)}`); }
    catch (e) { toast(e.shortMessage || e.message, 6000); }
  };

  // ---------------------------------------------------------------- provenance table
  function fillProvenance() {
    const tb = $('neuron-body'); const frag = document.createDocumentFragment();
    for (const n of CIRC.neurons) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${n.i}</td><td>${TYPE_NAMES[n.type]}</td><td>${n.side[0].toUpperCase()}</td><td>${n.wedge === null ? '—' : n.wedge}</td><td>${n.out_degree}</td><td><a href="${CFG.links.codex}${n.root_id}" target="_blank" rel="noopener">${n.root_id}</a></td>`;
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    $('meta-keccak').textContent = CIRC.meta.table_keccak256; $('meta-sha').textContent = CIRC.meta.connections_file_sha256; $('meta-geom').textContent = CIRC.meta.ring_geometry;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    fillProvenance();
    const ex = CFG.explorer;
    $('addr-token').innerHTML = CFG.token ? `<a href="${ex}/token/${CFG.token}" target="_blank" rel="noopener">${CFG.token}</a>` : 'not deployed yet';
    $('addr-brain').innerHTML = CFG.brain ? `<a href="${ex}/address/${CFG.brain}" target="_blank" rel="noopener">${CFG.brain}</a>` : 'not deployed yet';
    for (const a of document.querySelectorAll('[data-buy]')) a.href = CFG.token ? CFG.links.pancake + CFG.token : '#';
    for (const a of document.querySelectorAll('[data-chart]')) a.href = CFG.token ? CFG.links.dexscreener + CFG.token : '#';
    $('link-x').href = CFG.links.x; $('link-tg').href = CFG.links.telegram; $('link-gh').href = CFG.links.github; $('link-gh2').href = CFG.links.github;

    if (CFG.brain && typeof ethers !== 'undefined') {
      try {
        chain = await new FlyChain.Chain(CFG).connectRead();
        const s = await chain.readState(); mode = 'chain'; applyChainState(s); updateCosts();
        $('mode-banner').classList.remove('show');
        loadEvents().catch(e => console.warn(e));
        setInterval(syncChain, 5000);
      } catch (e) { console.warn('chain unavailable, preview mode', e); mode = 'preview'; }
    }
    if (mode === 'preview') {
      $('mode-banner').classList.add('show');
      $('mode-banner-text').textContent = CFG.brain ? 'This page cannot reach BNB Chain from here, so it is running the same circuit locally. Open the site directly for the live on-chain fly.' : 'Preview: the fly is not deployed yet. This is the same circuit running locally.';
      sim.energy = 10_000_000; $('energy').dataset.max = 10_000_000; sim.stimulate(CH.CUE, 4, 4);
      setInterval(() => { if (sim.alive && !(sim.stimChannel && sim.step < sim.stimUntil) && Math.random() < 0.5) sim.stimulate(Math.random() < 0.5 ? CH.TURN_LEFT : CH.TURN_RIGHT, 0, 3); }, 25000);
    }
    render();
    requestAnimationFrame(loop);
  }
  boot();
})();
