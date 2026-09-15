"use client";

import { useEffect, useRef, useState } from "react";
import { CFG } from "@/lib/config";
import type { BrainLive } from "@/lib/brain3d";
import styles from "./WorldStage.module.css";

export default function WholeBrainView({ spikes, active, resetKey = 0 }: {
  spikes: Uint16Array | null; active: boolean; resetKey?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const model = useRef<BrainLive | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const previousSpikes = useRef<Uint16Array | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduced(media.matches);
    let intersecting = true;
    const updateVisibility = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; updateVisibility(); });
    if (root.current) observer.observe(root.current);
    media.addEventListener("change", updateMotion); document.addEventListener("visibilitychange", updateVisibility);
    updateMotion(); updateVisibility();
    return () => { observer.disconnect(); media.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); };
  }, []);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let brain: BrainLive | null = null;
    void (async () => {
      try {
        const [module, response] = await Promise.all([import("@/lib/brain3d"), fetch(`${CFG.basePath}/assets/brain_points_v2.bin`, { signal: controller.signal })]);
        if (!response.ok) throw new Error("Brain data unavailable");
        const data = await response.arrayBuffer();
        if (disposed || !canvas.current) return;
        brain = new module.BrainLive(canvas.current, data); model.current = brain;
        brain.frame(0); setStatus("ready");
      } catch { if (!disposed) setStatus("error"); }
    })();
    return () => { disposed = true; controller.abort(); brain?.dispose(); if (model.current === brain) model.current = null; };
  }, [attempt]);

  useEffect(() => {
    const brain = model.current;
    if (!brain || status !== "ready") return;
    brain.reduced = reduced;
    if (spikes && spikes !== previousSpikes.current && active && visible) brain.spike(spikes);
    previousSpikes.current = spikes;
    if (active && visible && reduced) brain.frame(.1);
  }, [spikes, active, visible, reduced, status]);

  useEffect(() => { if (status === "ready") { model.current?.resetView(); model.current?.frame(0); } }, [resetKey, status]);

  useEffect(() => {
    if (status !== "ready" || !active || !visible || reduced) return;
    let raf = 0, last = performance.now();
    const render = (now: number) => {
      if (now - last >= 1000 / 30) { model.current?.frame(Math.min(.1, (now - last) / 1000)); last = now; }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [status, active, visible, reduced]);

  return <div ref={root} className={styles.wholeBrain}>
    <canvas ref={canvas} tabIndex={status === "ready" ? 0 : -1} aria-label="Whole brain. Drag or use arrow keys to rotate. Plus and minus to zoom." style={{ visibility: status === "ready" ? "visible" : "hidden" }} />
    {status === "loading" && <div className={styles.placeholder} role="status">Loading brain…</div>}
    {status === "error" && <div className={styles.placeholder} role="status"><span>Brain view unavailable</span><button type="button" onClick={() => { setStatus("loading"); setAttempt(value => value + 1); }}>Try again</button></div>}
  </div>;
}
