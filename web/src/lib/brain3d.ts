// @ts-nocheck
import * as THREE from "three";

const VERT = `
  attribute float aSize; attribute vec3 aColor; attribute float aGlow;
  varying vec3 vColor; varying float vGlow;
  void main() { vColor = aColor; vGlow = aGlow; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (6.5 / -mv.z) * (1.0 + vGlow * 1.2); gl_Position = projectionMatrix * mv; }`;
const FRAG = `
  varying vec3 vColor; varying float vGlow;
  void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = smoothstep(0.5, 0.05, d);
    vec3 col = vColor * (1.0 + vGlow * 2.5); gl_FragColor = vec4(col, a * (0.45 + vGlow * 0.55)); }`;

const CLASS_COLORS = [[0.35, 0.42, 0.62], [0.86, 0.72, 0.48], [0.55, 0.6, 0.8], [0.5, 0.66, 0.66], [0.78, 0.5, 0.42], [0.95, 0.45, 0.35]];
const TYPE_COLORS = [[1.0, 0.72, 0.25], [1.0, 0.72, 0.25], [0.95, 0.55, 0.25], [1.0, 0.36, 0.2], [1.0, 0.36, 0.2], [0.31, 0.76, 0.97]];

export function decodePoints(buf: ArrayBuffer) {
  const dv = new DataView(buf); const n = dv.getUint32(0, true);
  const mn = [dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)], mx = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  const pos = new Float32Array(n * 3), cls = new Uint8Array(n); let o = 28;
  for (let i = 0; i < n; i++) { pos[3 * i] = mn[0] + (dv.getUint16(o, true) / 65535) * (mx[0] - mn[0]); pos[3 * i + 1] = mn[1] + (dv.getUint16(o + 2, true) / 65535) * (mx[1] - mn[1]); pos[3 * i + 2] = mn[2] + (dv.getUint16(o + 4, true) / 65535) * (mx[2] - mn[2]); cls[i] = dv.getUint8(o + 6); o += 7; }
  return { n, pos, cls, mn, mx };
}

export class Brain3D {
  canvas; renderer; scene; camera; group; bg; ring; ringGlow; rotY = 0.22; rotX = 0.16; targetRotY = 0.22; targetRotX = 0.16; auto = true; zoom = 1; reduced = false; onResize; disposed = false; yOffset = 0.06; camY = -0.16; dist = 1.25; sway = false; t = 0;
  constructor(canvas: HTMLCanvasElement, points: ArrayBuffer, ringNeurons: any[], opts: { camY?: number; yOffset?: number; dist?: number; sway?: boolean } = {}) {
    this.canvas = canvas; if (opts.camY !== undefined) this.camY = opts.camY; if (opts.yOffset !== undefined) this.yOffset = opts.yOffset;
    if (opts.dist !== undefined) this.dist = opts.dist; if (opts.sway) this.sway = true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.group = new THREE.Group(); this.scene.add(this.group);
    const pts = decodePoints(points);
    const cx = (pts.mn[0] + pts.mx[0]) / 2, cy = (pts.mn[1] + pts.mx[1]) / 2, cz = (pts.mn[2] + pts.mx[2]) / 2, scale = 1 / (pts.mx[0] - pts.mn[0]);
    const toLocal = (x, y, z) => [(x - cx) * scale, -(y - cy) * scale, (z - cz) * scale];
    const pos = new Float32Array(pts.n * 3), col = new Float32Array(pts.n * 3), size = new Float32Array(pts.n), glow = new Float32Array(pts.n);
    for (let i = 0; i < pts.n; i++) { pos.set(toLocal(pts.pos[3 * i], pts.pos[3 * i + 1], pts.pos[3 * i + 2]), 3 * i); const c = CLASS_COLORS[pts.cls[i]] || CLASS_COLORS[1]; const dim = pts.cls[i] === 0 ? 0.55 : 0.85; col[3 * i] = c[0] * dim; col[3 * i + 1] = c[1] * dim; col[3 * i + 2] = c[2] * dim; size[i] = pts.cls[i] === 0 ? 0.55 : 0.8; }
    this.bg = this._points(pos, col, size, glow); this.group.add(this.bg);
    const n = ringNeurons.length, rp = new Float32Array(n * 3), rc = new Float32Array(n * 3), rs = new Float32Array(n), rg = new Float32Array(n);
    ringNeurons.forEach((nr, i) => { rp.set(toLocal(nr.pos_nm[0], nr.pos_nm[1], nr.pos_nm[2]), 3 * i); rc.set(TYPE_COLORS[nr.type], 3 * i); rs[i] = 2.6; rg[i] = 0.25; });
    this.ring = this._points(rp, rc, rs, rg); this.group.add(this.ring); this.ringGlow = rg;
    this._bindPointer(); this.resize(); this.onResize = () => this.resize(); window.addEventListener("resize", this.onResize);
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  _points(pos, col, size, glow) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("aColor", new THREE.BufferAttribute(col, 3)); g.setAttribute("aSize", new THREE.BufferAttribute(size, 1)); g.setAttribute("aGlow", new THREE.BufferAttribute(glow, 1));
    return new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  }
  _bindPointer() {
    let drag = null; const c = this.canvas;
    c.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, ry: this.targetRotY, rx: this.targetRotX }; this.auto = false; c.setPointerCapture(e.pointerId); });
    c.addEventListener("pointermove", (e) => { if (!drag) return; this.targetRotY = drag.ry + (e.clientX - drag.x) * 0.006; this.targetRotX = Math.max(-1.2, Math.min(1.2, drag.rx + (e.clientY - drag.y) * 0.006)); });
    c.addEventListener("pointerup", () => { drag = null; setTimeout(() => { this.auto = true; }, 4000); });
    c.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom = Math.max(0.6, Math.min(2.4, this.zoom * (e.deltaY > 0 ? 0.92 : 1.08))); }, { passive: false });
  }
  resize() { const r = this.canvas.getBoundingClientRect(); const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height)); this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  spike(spikes: number[]) { for (const i of spikes) this.ringGlow[i] = 1.0; }
  frame(dt: number) {
    if (this.disposed) return;
    this.t += dt;
    // a slow sway keeps the brain frontal and recognisable instead of spinning edge-on
    if (this.auto && !this.reduced) { if (this.sway) { this.targetRotY = 0.26 * Math.sin(this.t * 0.16); this.targetRotX = 0.15 + 0.07 * Math.sin(this.t * 0.11); } else this.targetRotY += dt * 0.08; }
    this.rotY += (this.targetRotY - this.rotY) * 0.08; this.rotX += (this.targetRotX - this.rotX) * 0.08;
    this.group.rotation.set(this.rotX, this.rotY, 0); this.group.position.set(0, this.yOffset, 0);
    const dist = this.dist / this.zoom; this.camera.position.set(0, this.camY, dist); this.camera.lookAt(0, this.camY, 0);
    const g = this.ringGlow, decay = Math.exp(-dt * 4.5); for (let i = 0; i < g.length; i++) g[i] *= decay;
    this.ring.geometry.attributes.aGlow.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }
  dispose() { this.disposed = true; window.removeEventListener("resize", this.onResize); this.renderer.dispose(); }
}
