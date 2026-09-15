import * as THREE from "three";

const VERT = `
  attribute float aSize; attribute vec3 aColor; attribute float aGlow; uniform float uPointScale;
  varying vec3 vColor; varying float vGlow;
  void main() { vColor = aColor; vGlow = aGlow; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.0, aSize * uPointScale * (6.5 / -mv.z) * (1.0 + vGlow * 0.55)); gl_Position = projectionMatrix * mv; }`;
const FRAG = `
  varying vec3 vColor; varying float vGlow; uniform float uOpacity;
  void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = smoothstep(0.5, 0.05, d);
    vec3 col = min(vColor * (1.0 + vGlow * 0.3), vec3(1.0)); gl_FragColor = vec4(col, a * uOpacity * (0.8 + vGlow * 0.2)); }`;
const CLASS_COLORS = [[0.35, 0.42, 0.62], [0.86, 0.72, 0.48], [0.55, 0.6, 0.8], [0.5, 0.66, 0.66], [0.78, 0.5, 0.42], [0.95, 0.45, 0.35]];
const TYPE_COLORS = [[1.0, 0.72, 0.25], [1.0, 0.72, 0.25], [0.95, 0.55, 0.25], [1.0, 0.36, 0.2], [1.0, 0.36, 0.2], [0.31, 0.76, 0.97]];
type BrainPoints = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
type RingNeuron = { type: number; pos_nm: number[] };

export function decodePoints(buf: ArrayBuffer) {
  if (buf.byteLength < 28) throw new Error("Invalid brain data");
  const dv = new DataView(buf), n = dv.getUint32(0, true);
  if (!n || buf.byteLength !== 28 + n * 7) throw new Error("Invalid brain data length");
  const mn = [dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
  const mx = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  const pos = new Float32Array(n * 3), cls = new Uint8Array(n);
  for (let i = 0, offset = 28; i < n; i++, offset += 7) {
    for (let axis = 0; axis < 3; axis++) pos[i * 3 + axis] = mn[axis] + (dv.getUint16(offset + axis * 2, true) / 65535) * (mx[axis] - mn[axis]);
    cls[i] = dv.getUint8(offset + 6);
  }
  if (!(mx[0] > mn[0])) throw new Error("Invalid brain bounds");
  return { n, pos, cls, mn, mx };
}

export class Brain3D {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  bg: BrainPoints;
  ring: BrainPoints;
  ringGlow: Float32Array;
  rotY = 0.22; rotX = 0.16; targetRotY = 0.22; targetRotX = 0.16;
  auto = true; zoom = 1; reduced = false; disposed = false;
  yOffset = 0.06; camY = -0.16; dist = 1.25; sway = false; t = 0;
  private cleanup: (() => void)[] = [];
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private potentialGlow: Float32Array;

  constructor(canvas: HTMLCanvasElement, points: ArrayBuffer, ringNeurons: RingNeuron[], opts: { camY?: number; yOffset?: number; dist?: number; sway?: boolean } = {}) {
    // Validate before allocating a WebGL context.
    const pts = decodePoints(points);
    this.canvas = canvas;
    this.camY = opts.camY ?? this.camY; this.yOffset = opts.yOffset ?? this.yOffset;
    this.dist = opts.dist ?? this.dist; this.sway = opts.sway ?? false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.group = new THREE.Group(); this.scene.add(this.group);
    const cx = (pts.mn[0] + pts.mx[0]) / 2, cy = (pts.mn[1] + pts.mx[1]) / 2, cz = (pts.mn[2] + pts.mx[2]) / 2;
    const scale = 1 / (pts.mx[0] - pts.mn[0]);
    const toLocal = (x: number, y: number, z: number) => [(x - cx) * scale, -(y - cy) * scale, (z - cz) * scale];
    const pos = new Float32Array(pts.n * 3), col = new Float32Array(pts.n * 3), size = new Float32Array(pts.n), glow = new Float32Array(pts.n);
    for (let i = 0; i < pts.n; i++) {
      pos.set(toLocal(pts.pos[3 * i], pts.pos[3 * i + 1], pts.pos[3 * i + 2]), 3 * i);
      const color = CLASS_COLORS[pts.cls[i]] || CLASS_COLORS[1], dim = pts.cls[i] === 0 ? 0.55 : 0.85;
      col.set(color.map(value => value * dim), 3 * i); size[i] = pts.cls[i] === 0 ? 0.55 : 0.8;
    }
    this.bg = this.makePoints(pos, col, size, glow, 0.28); this.group.add(this.bg);
    const n = ringNeurons.length, rp = new Float32Array(n * 3), rc = new Float32Array(n * 3), rs = new Float32Array(n), rg = new Float32Array(n);
    ringNeurons.forEach((neuron, i) => {
      rp.set(toLocal(neuron.pos_nm[0], neuron.pos_nm[1], neuron.pos_nm[2]), 3 * i);
      rc.set(TYPE_COLORS[neuron.type] ?? TYPE_COLORS[0], 3 * i); rs[i] = 1.6; rg[i] = 0.16;
    });
    this.ring = this.makePoints(rp, rc, rs, rg, 0.95); this.ring.renderOrder = 1; this.group.add(this.ring); this.ringGlow = rg;
    this.potentialGlow = new Float32Array(n).fill(0.16);
    this.bindPointer();
    const resizeObserver = new ResizeObserver(() => { this.resize(); this.frame(0); });
    resizeObserver.observe(canvas);
    this.cleanup.push(() => resizeObserver.disconnect());
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resize();
  }

  private makePoints(pos: Float32Array, col: Float32Array, size: Float32Array, glow: Float32Array, opacity: number): BrainPoints {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geometry.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1)); geometry.setAttribute("aGlow", new THREE.BufferAttribute(glow, 1));
    return new THREE.Points(geometry, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uOpacity: { value: opacity }, uPointScale: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.NormalBlending }));
  }

  private bindPointer() {
    let drag: { x: number; y: number; ry: number; rx: number; id: number } | null = null;
    const canvas = this.canvas;
    const pauseAuto = () => { this.auto = false; clearTimeout(this.resumeTimer); };
    const resumeLater = () => { this.resumeTimer = setTimeout(() => { this.auto = true; }, 4000); };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, ry: this.targetRotY, rx: this.targetRotX, id: event.pointerId };
      pauseAuto(); canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      this.targetRotY = drag.ry + (event.clientX - drag.x) * 0.006;
      this.targetRotX = Math.max(-1.2, Math.min(1.2, drag.rx + (event.clientY - drag.y) * 0.006));
      this.frame(0);
    };
    const up = () => { if (!drag) return; drag = null; resumeLater(); };
    const wheel = (event: WheelEvent) => {
      // Let ordinary scrolling continue through the dashboard.
      if (!event.ctrlKey) return;
      event.preventDefault(); this.zoom = Math.max(0.6, Math.min(2.4, this.zoom * (event.deltaY > 0 ? 0.92 : 1.08))); this.frame(0);
    };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Home"].includes(event.key)) return;
      event.preventDefault(); pauseAuto();
      if (event.key === "ArrowLeft") this.targetRotY -= .12;
      if (event.key === "ArrowRight") this.targetRotY += .12;
      if (event.key === "ArrowUp") this.targetRotX = Math.max(-1.2, this.targetRotX - .12);
      if (event.key === "ArrowDown") this.targetRotX = Math.min(1.2, this.targetRotX + .12);
      if (event.key === "+" || event.key === "=") this.zoom = Math.min(2.4, this.zoom * 1.12);
      if (event.key === "-") this.zoom = Math.max(.6, this.zoom / 1.12);
      if (event.key === "Home" || event.key === "0") this.resetView();
      this.frame(0); resumeLater();
    };
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
    canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    });
  }

  resize() {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect(), width = Math.max(1, Math.floor(rect.width)), height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    const pointScale = Math.min(1.5, Math.max(0.4, height * this.renderer.getPixelRatio() / 600));
    this.bg.material.uniforms.uPointScale.value = pointScale;
    this.ring.material.uniforms.uPointScale.value = pointScale;
  }

  resetView() { this.rotY = this.targetRotY = .22; this.rotX = this.targetRotX = .16; this.zoom = 1; this.t = 0; this.auto = true; }
  spike(spikes: number[]) { for (const i of spikes) if (i >= 0 && i < this.ringGlow.length) this.ringGlow[i] = 1; }
  setPotentials(values: number[]) {
    for (let i = 0; i < this.ringGlow.length; i++) {
      // A steady highlight of the latest membrane potential, not fabricated spikes.
      this.potentialGlow[i] = .12 + Math.max(0, Math.min(1, (values[i] ?? 0) / 1000)) * .65;
      this.ringGlow[i] = this.potentialGlow[i];
    }
  }

  frame(dt: number) {
    if (this.disposed) return;
    this.t += dt;
    if (dt > 0 && this.auto && !this.reduced) {
      if (this.sway) { this.targetRotY = .26 * Math.sin(this.t * .16); this.targetRotX = .15 + .07 * Math.sin(this.t * .11); }
      else this.targetRotY += dt * .08;
    }
    const smoothing = dt === 0 ? 1 : 1 - Math.exp(-dt * 5);
    this.rotY += (this.targetRotY - this.rotY) * smoothing; this.rotX += (this.targetRotX - this.rotX) * smoothing;
    this.group.rotation.set(this.rotX, this.rotY, 0); this.group.position.set(0, this.yOffset, 0);
    this.camera.position.set(0, this.camY, this.dist / this.zoom); this.camera.lookAt(0, this.camY, 0);
    const decay = Math.exp(-dt * 4.5);
    for (let i = 0; i < this.ringGlow.length; i++) this.ringGlow[i] = Math.max(this.potentialGlow[i], this.ringGlow[i] * decay);
    this.ring.geometry.attributes.aGlow.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.resumeTimer);
    for (const cleanup of this.cleanup) cleanup();
    this.cleanup = [];
    for (const points of [this.bg, this.ring]) { points.geometry.dispose(); points.material.dispose(); }
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}


export function decodePointsV2(buf: ArrayBuffer) {
  if (buf.byteLength < 28) throw new Error("Invalid whole-brain data");
  const dv = new DataView(buf), n = dv.getUint32(0, true);
  if (!n || buf.byteLength !== 28 + n * 11) throw new Error("Invalid whole-brain data length");
  const mn = [dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true)];
  const mx = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
  if (!(mx[0] > mn[0])) throw new Error("Invalid whole-brain bounds");
  const pos = new Float32Array(n * 3), cls = new Uint8Array(n), idx = new Uint32Array(n);
  for (let i = 0, offset = 28; i < n; i++, offset += 11) {
    for (let axis = 0; axis < 3; axis++) pos[i * 3 + axis] = mn[axis] + (dv.getUint16(offset + axis * 2, true) / 65535) * (mx[axis] - mn[axis]);
    cls[i] = dv.getUint8(offset + 6); idx[i] = dv.getUint32(offset + 7, true);
  }
  return { n, pos, cls, idx, mn, mx };
}

// Optic, sensory, central, CX, MB, descending, motor/endocrine, ascending.
const LIVE_COLORS = [[0.36, 0.44, 0.62], [0.42, 0.72, 0.62], [0.82, 0.70, 0.50], [0.96, 0.72, 0.28], [0.85, 0.45, 0.75], [1.0, 0.36, 0.20], [0.95, 0.5, 0.35], [0.6, 0.6, 0.85]];
const LIVE_FRAG = `
  varying vec3 vColor; varying float vGlow; uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.05, d);
    vec3 col = min(vColor * (1.0 + vGlow * 1.6), vec3(1.0));
    gl_FragColor = vec4(col, alpha * uOpacity * (0.15 + vGlow * 0.85));
  }`;

/** Rendered soma indices are lit only by spikes received from the simulator. */
export class BrainLive {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  pts: BrainPoints;
  glow: Float32Array;
  n: number;
  rotY = .22; rotX = .16; targetRotY = .22; targetRotX = .16;
  auto = true; zoom = 1; reduced = false; disposed = false; t = 0; dist = 1.5; yOffset = .02;
  private cleanup: (() => void)[] = [];
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(canvas: HTMLCanvasElement, buf: ArrayBuffer) {
    const points = decodePointsV2(buf);
    this.canvas = canvas; this.n = points.n;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(38, 1, .05, 100);
    this.group = new THREE.Group(); this.scene.add(this.group);
    const center = points.mn.map((value, axis) => (value + points.mx[axis]) / 2), scale = 1 / (points.mx[0] - points.mn[0]);
    const positions = new Float32Array(this.n * 3), colors = new Float32Array(this.n * 3), sizes = new Float32Array(this.n);
    this.glow = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      for (let axis = 0; axis < 3; axis++) positions[i * 3 + axis] = (points.pos[i * 3 + axis] - center[axis]) * scale * (axis === 1 ? -1 : 1);
      const color = LIVE_COLORS[points.cls[i]] ?? LIVE_COLORS[2], dim = points.cls[i] === 0 ? .5 : .76;
      colors.set(color.map(value => value * dim), i * 3); sizes[i] = points.cls[i] === 0 ? .55 : .8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aGlow", new THREE.BufferAttribute(this.glow, 1));
    this.pts = new THREE.Points(geometry, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: LIVE_FRAG, uniforms: { uOpacity: { value: .85 }, uPointScale: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.NormalBlending }));
    this.group.add(this.pts);
    this.bindControls();
    const observer = new ResizeObserver(() => { this.resize(); this.frame(0); });
    observer.observe(canvas); this.cleanup.push(() => observer.disconnect());
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resize();
  }

  private bindControls() {
    const canvas = this.canvas;
    let drag: { x: number; y: number; ry: number; rx: number; id: number } | null = null;
    const pause = () => { clearTimeout(this.resumeTimer); this.auto = false; };
    const resume = () => { clearTimeout(this.resumeTimer); this.resumeTimer = setTimeout(() => { this.auto = true; }, 4000); };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, rx: this.targetRotX, ry: this.targetRotY, id: event.pointerId };
      pause(); canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      this.targetRotY = drag.ry + (event.clientX - drag.x) * .006;
      this.targetRotX = Math.max(-1.2, Math.min(1.2, drag.rx + (event.clientY - drag.y) * .006));
      this.frame(0);
    };
    const up = () => { if (!drag) return; drag = null; resume(); };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); this.zoom = Math.max(.6, Math.min(2.4, this.zoom * (event.deltaY > 0 ? .92 : 1.08))); this.frame(0);
    };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Home"].includes(event.key)) return;
      event.preventDefault(); pause();
      if (event.key === "ArrowLeft") this.targetRotY -= .12;
      if (event.key === "ArrowRight") this.targetRotY += .12;
      if (event.key === "ArrowUp") this.targetRotX = Math.max(-1.2, this.targetRotX - .12);
      if (event.key === "ArrowDown") this.targetRotX = Math.min(1.2, this.targetRotX + .12);
      if (event.key === "+" || event.key === "=") this.zoom = Math.min(2.4, this.zoom * 1.12);
      if (event.key === "-") this.zoom = Math.max(.6, this.zoom / 1.12);
      if (event.key === "0" || event.key === "Home") this.resetView();
      this.frame(0); resume();
    };
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up); canvas.addEventListener("lostpointercapture", up);
    canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up); canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    });
  }

  resize() {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect(), width = Math.max(1, Math.floor(rect.width)), height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.pts.material.uniforms.uPointScale.value = Math.min(1.5, Math.max(.4, height * this.renderer.getPixelRatio() / 600));
  }
  resetView() { this.rotY = this.targetRotY = .22; this.rotX = this.targetRotX = .16; this.zoom = 1; this.t = 0; this.auto = true; }
  /** Indices into the rendered point list that spiked in the last frame. */
  spike(indices: Uint16Array | number[]) {
    for (const i of indices) if (i >= 0 && i < this.n) this.glow[i] = Math.min(1, this.glow[i] + .28);
  }
  frame(dt: number) {
    if (this.disposed) return;
    this.t += dt;
    if (dt > 0 && this.auto && !this.reduced) { this.targetRotY = .26 * Math.sin(this.t * .16); this.targetRotX = .15 + .07 * Math.sin(this.t * .11); }
    const smoothing = dt === 0 ? 1 : 1 - Math.exp(-dt * 5);
    this.rotY += (this.targetRotY - this.rotY) * smoothing; this.rotX += (this.targetRotX - this.rotX) * smoothing;
    this.group.rotation.set(this.rotX, this.rotY, 0); this.group.position.set(0, this.yOffset, 0);
    this.camera.position.set(0, 0, this.dist / this.zoom); this.camera.lookAt(0, 0, 0);
    const decay = Math.exp(-dt * 2.6);
    for (let i = 0; i < this.glow.length; i++) this.glow[i] *= decay;
    this.pts.geometry.attributes.aGlow.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.resumeTimer);
    for (const cleanup of this.cleanup) cleanup(); this.cleanup = [];
    this.pts.geometry.dispose(); this.pts.material.dispose(); this.scene.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
