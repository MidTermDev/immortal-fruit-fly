// Whole-brain point cloud (FlyWire, 139,248 neurons downsampled) with the 155 on-chain
// ring-attractor neurons drawn on top and lit by their spikes. Three.js r128 (global THREE).
(function (global) {
  const VERT = `
    attribute float aSize; attribute vec3 aColor; attribute float aGlow;
    varying vec3 vColor; varying float vGlow;
    void main() {
      vColor = aColor; vGlow = aGlow;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (6.5 / -mv.z) * (1.0 + vGlow * 1.2);
      gl_Position = projectionMatrix * mv;
    }`;
  const FRAG = `
    varying vec3 vColor; varying float vGlow;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.05, d);
      vec3 col = vColor * (1.0 + vGlow * 2.5);
      gl_FragColor = vec4(col, a * (0.45 + vGlow * 0.55));
    }`;

  function decodePoints(b64) {
    const bin = atob(b64); const buf = new ArrayBuffer(bin.length); const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    const mn = [dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
    const mx = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
    const pos = new Float32Array(n * 3); const cls = new Uint8Array(n);
    let o = 28;
    for (let i = 0; i < n; i++) {
      pos[3 * i] = mn[0] + dv.getUint16(o, true) / 65535 * (mx[0] - mn[0]);
      pos[3 * i + 1] = mn[1] + dv.getUint16(o + 2, true) / 65535 * (mx[1] - mn[1]);
      pos[3 * i + 2] = mn[2] + dv.getUint16(o + 4, true) / 65535 * (mx[2] - mn[2]);
      cls[i] = dv.getUint8(o + 6); o += 7;
    }
    return { n, pos, cls, mn, mx };
  }

  // class palette: 0 optic, 1 central, 2 visual projection, 3 sensory, 4 asc/desc, 5 motor/endocrine
  const CLASS_COLORS = [[0.35, 0.42, 0.62], [0.86, 0.72, 0.48], [0.55, 0.60, 0.80], [0.50, 0.66, 0.66], [0.78, 0.50, 0.42], [0.95, 0.45, 0.35]];
  const TYPE_COLORS = [[1.0, 0.72, 0.25], [1.0, 0.72, 0.25], [0.95, 0.55, 0.25], [1.0, 0.36, 0.2], [1.0, 0.36, 0.2], [0.31, 0.76, 0.97]];

  class Brain3D {
    constructor(canvas, pointsB64, ringNeurons) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
      this.group = new THREE.Group(); this.scene.add(this.group);
      this.rotY = 0.2; this.rotX = 0.35; this.targetRotY = 0.2; this.targetRotX = 0.35; this.auto = true;
      this.zoom = 1;

      const pts = decodePoints(pointsB64);
      const cx = (pts.mn[0] + pts.mx[0]) / 2, cy = (pts.mn[1] + pts.mx[1]) / 2, cz = (pts.mn[2] + pts.mx[2]) / 2;
      const scale = 1 / (pts.mx[0] - pts.mn[0]); // brain width -> 1 unit
      this.center = [cx, cy, cz]; this.scale = scale;
      const toLocal = (x, y, z) => [(x - cx) * scale, -(y - cy) * scale, (z - cz) * scale];

      // background brain
      const pos = new Float32Array(pts.n * 3), col = new Float32Array(pts.n * 3), size = new Float32Array(pts.n), glow = new Float32Array(pts.n);
      for (let i = 0; i < pts.n; i++) {
        const p = toLocal(pts.pos[3 * i], pts.pos[3 * i + 1], pts.pos[3 * i + 2]);
        pos.set(p, 3 * i);
        const c = CLASS_COLORS[pts.cls[i]] || CLASS_COLORS[1];
        const dim = pts.cls[i] === 0 ? 0.55 : 0.85;
        col[3 * i] = c[0] * dim; col[3 * i + 1] = c[1] * dim; col[3 * i + 2] = c[2] * dim;
        size[i] = pts.cls[i] === 0 ? 0.55 : 0.8;
      }
      this.bg = this._points(pos, col, size, glow, 0.0);
      this.group.add(this.bg);

      // ring neurons
      const n = ringNeurons.length;
      const rp = new Float32Array(n * 3), rc = new Float32Array(n * 3), rs = new Float32Array(n), rg = new Float32Array(n);
      ringNeurons.forEach((nr, i) => {
        const p = toLocal(nr.pos_nm[0], nr.pos_nm[1], nr.pos_nm[2]);
        rp.set(p, 3 * i);
        const c = TYPE_COLORS[nr.type]; rc.set(c, 3 * i); rs[i] = 2.6; rg[i] = 0.25;
      });
      this.ring = this._points(rp, rc, rs, rg, 0.0);
      this.group.add(this.ring);
      this.ringGlow = rg;

      this._bindPointer();
      this.resize();
      addEventListener('resize', () => this.resize());
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    _points(pos, col, size, glow, _) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
      const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      return new THREE.Points(g, m);
    }
    _bindPointer() {
      let drag = null;
      const c = this.canvas;
      c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ry: this.targetRotY, rx: this.targetRotX }; this.auto = false; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', e => { if (!drag) return; this.targetRotY = drag.ry + (e.clientX - drag.x) * 0.006; this.targetRotX = Math.max(-1.2, Math.min(1.2, drag.rx + (e.clientY - drag.y) * 0.006)); });
      c.addEventListener('pointerup', () => { drag = null; setTimeout(() => { this.auto = true; }, 4000); });
      c.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(0.6, Math.min(2.4, this.zoom * (e.deltaY > 0 ? 0.92 : 1.08))); }, { passive: false });
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    /** flash ring neurons; spikes = array of neuron indices */
    spike(spikes) { for (const i of spikes) this.ringGlow[i] = 1.0; }
    frame(dt) {
      if (this.auto && !this.reduced) this.targetRotY += dt * 0.08;
      this.rotY += (this.targetRotY - this.rotY) * 0.08; this.rotX += (this.targetRotX - this.rotX) * 0.08;
      this.group.rotation.set(this.rotX, this.rotY, 0);
      const dist = 1.25 / this.zoom;
      this.camera.position.set(0, -0.16, dist); this.camera.lookAt(0, -0.16, 0);
      this.group.position.set(0, 0.06, 0);
      const g = this.ringGlow; const decay = Math.exp(-dt * 4.5);
      for (let i = 0; i < g.length; i++) g[i] *= decay;
      this.ring.geometry.attributes.aGlow.needsUpdate = true;
      this.renderer.render(this.scene, this.camera);
    }
  }
  global.Brain3D = Brain3D;
})(window);
