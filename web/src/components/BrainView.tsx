"use client";

import { useEffect, useRef, useState } from "react";
import { CFG } from "@/lib/config";
import neurons from "@/data/brain-neurons.json";
import type { Brain3D } from "@/lib/brain3d";
import type { StageSnapshot } from "./FlyStage";
import styles from "./FlyStage.module.css";

export default function BrainView({ snapshot, active, reducedMotion, resetKey }: {
  snapshot: StageSnapshot | null; active: boolean; reducedMotion: boolean; resetKey: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const brain = useRef<Brain3D | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    let model: Brain3D | null = null;
    const initialize = async () => {
      try {
        const [module, response] = await Promise.all([
          import("@/lib/brain3d"),
          fetch(`${CFG.basePath}/assets/brain_points.bin`, { signal: abort.signal }),
        ]);
        if (!response.ok) throw new Error("Brain data unavailable");
        const data = await response.arrayBuffer();
        if (disposed || !canvas.current) return;
        model = new module.Brain3D(canvas.current, data, neurons, { camY: 0, yOffset: 0.02, dist: 1.5, sway: true });
        brain.current = model;
        model.frame(0);
        setStatus("ready");
      } catch {
        if (!disposed) setStatus("error");
      }
    };
    void initialize();
    return () => {
      disposed = true;
      abort.abort();
      model?.dispose();
      if (brain.current === model) brain.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    const model = brain.current;
    if (!model || status !== "ready") return;
    model.reduced = reducedMotion;
    model.setPotentials(snapshot?.v ?? []);
    model.frame(0);
  }, [snapshot, reducedMotion, status]);

  useEffect(() => {
    const model = brain.current;
    if (!model || status !== "ready") return;
    model.resetView();
    model.frame(0);
  }, [resetKey, status]);

  useEffect(() => {
    if (status !== "ready" || !active || reducedMotion) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      if (now - last >= 1000 / 30) {
        brain.current?.frame(Math.min((now - last) / 1000, 0.1));
        last = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, reducedMotion, status]);

  return (
    <div className={styles.brain}>
      <canvas ref={canvas} tabIndex={status === "ready" ? 0 : -1} aria-label="Brain anatomy. Drag or use arrow keys to rotate. Plus and minus to zoom." style={{ visibility: status === "ready" ? "visible" : "hidden" }} />
      {status === "loading" && <div className={styles.placeholder} role="status">Loading brain…</div>}
      {status === "error" && <div className={styles.placeholder} role="status"><span>Brain view unavailable</span><button type="button" onClick={() => { setStatus("loading"); setAttempt(value => value + 1); }}>Try again</button></div>}
      {status === "ready" && <p className={styles.brainHint}>Drag to rotate</p>}
    </div>
  );
}
