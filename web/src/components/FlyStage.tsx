"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import styles from "./FlyStage.module.css";

export type StageSnapshot = {
  posX: number; posY: number; headX: number; headY: number;
  alive: boolean; generation: number; step: number; v: number[];
};

const BrainView = dynamic(() => import("./BrainView"), {
  ssr: false,
  loading: () => <div className={styles.placeholder} role="status">Loading brain…</div>,
});

export default function FlyStage({ snapshot, connection }: {
  snapshot: StageSnapshot | null;
  connection: "loading" | "live" | "stale" | "offline";
}) {
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    let intersecting = true;
    const updateVisibility = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      updateVisibility();
    }, { threshold: 0.01 });
    if (stage.current) observer.observe(stage.current);
    updateMotion();
    updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const status = !snapshot ? "Waiting for data" : connection === "live" ? "Latest state" : "Last known state";

  return (
    <div ref={stage} className={styles.stage}>
      <BrainView snapshot={snapshot} active={visible} reducedMotion={reducedMotion} resetKey={0} />
      <div className={styles.caption}><span>Brain</span><span>{status}</span></div>
    </div>
  );
}
