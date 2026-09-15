"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState } from "react";
import styles from "./FlyStage.module.css";

export type StageSnapshot = {
  posX: number; posY: number; headX: number; headY: number;
  alive: boolean; generation: number; step: number; v: number[];
};
export type StageFeedback = { id: string; kind: "feed" | "stimulate" | "tick" | "resurrect" };

const BrainView = dynamic(() => import("./BrainView"), {
  ssr: false,
  loading: () => <div className={styles.placeholder} role="status">Loading brain…</div>,
});

export function FlyBody({ prefix }: { prefix: string }) {
  return (
    <g className={styles.body}>
      <defs>
        <linearGradient id={`${prefix}-body`} x1="0" y1="0" x2="1" y2="0">
          <stop stopColor="#665044" /><stop offset=".45" stopColor="#c2a279" /><stop offset="1" stopColor="#695141" />
        </linearGradient>
        <linearGradient id={`${prefix}-wing`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#e4ede5" stopOpacity=".36" /><stop offset="1" stopColor="#ccdbd1" stopOpacity=".08" />
        </linearGradient>
        <radialGradient id={`${prefix}-eye`} cx=".35" cy=".25" r=".8">
          <stop stopColor="#f28d63" /><stop offset=".5" stopColor="#c65336" /><stop offset="1" stopColor="#742f26" />
        </radialGradient>
      </defs>
      <ellipse cy="21" rx="72" ry="54" fill="#000" opacity=".15" />
      <g fill="none" stroke="#b6a58a" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M-13-22 -39-42 -46-70 -61-78 M13-22 39-42 46-70 61-78" />
        <path d="M-17-7 -48 1 -64-16 -81-14 M17-7 48 1 64-16 81-14" />
        <path d="M-15 13 -41 36 -40 68 -55 84 M15 13 41 36 40 68 55 84" />
      </g>
      <path d="M-19 4 C-31 30 -21 66 0 76 C21 66 31 30 19 4Z" fill={`url(#${prefix}-body)`} stroke="#ddc397" strokeOpacity=".4" />
      <g fill="none" stroke="#332d28" strokeWidth="5" opacity=".75">
        <path d="M-23 27 Q0 36 23 27 M-20 43 Q0 52 20 43 M-12 59 Q0 65 12 59" />
      </g>
      <g className={styles.wings} fill={`url(#${prefix}-wing)`} stroke="#d8e5dc" strokeOpacity=".45" strokeWidth="1">
        <path d="M-10-20 C-43-15 -103 24 -108 65 C-111 91 -85 83 -62 66 C-38 48 -19 14 -10-20Z" />
        <path d="M10-20 C43-15 103 24 108 65 C111 91 85 83 62 66 C38 48 19 14 10-20Z" />
        <g fill="none" strokeOpacity=".23" strokeWidth=".8">
          <path d="M-12-17 -94 68 M-37 4 -61 56 M-55 18 -80 32 -88 62 M12-17 94 68 M37 4 61 56 M55 18 80 32 88 62" />
          <path d="M-17-10 -79 70 M17-10 79 70" />
        </g>
      </g>
      <ellipse cy="-13" rx="21" ry="29" fill={`url(#${prefix}-body)`} stroke="#d0b487" strokeOpacity=".6" />
      <path d="M-7-35 -8 9 M7-35 8 9" stroke="#4a3b32" strokeWidth="3" opacity=".8" />
      <ellipse cy="-47" rx="22" ry="17" fill="#9e8160" />
      <ellipse cx="-17" cy="-47" rx="11" ry="16" transform="rotate(-15 -17 -47)" fill={`url(#${prefix}-eye)`} />
      <ellipse cx="17" cy="-47" rx="11" ry="16" transform="rotate(15 17 -47)" fill={`url(#${prefix}-eye)`} />
      <g stroke="#ceb58e" fill="none" strokeWidth="1.8" strokeLinecap="round">
        <path d="M-6-59 -11-73 -21-78 M6-59 11-73 21-78" />
        <path d="M-14-73 -20-68 M14-73 20-68" strokeWidth="1" />
      </g>
      <path d="M0-51 0-65" stroke="#594a3a" strokeWidth="3" strokeLinecap="round" />
      <g fill="#f5d4a0" opacity=".5"><circle cx="-6" cy="-18" r="1" /><circle cx="6" cy="-18" r="1" /></g>
    </g>
  );
}

export default function FlyStage({ snapshot, connection, feedback }: {
  snapshot: StageSnapshot | null;
  connection: "loading" | "live" | "stale" | "offline";
  feedback: StageFeedback | null;
}) {
  const [view, setView] = useState<"fly" | "brain">("fly");
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const fly = useRef<SVGGElement>(null);
  const trail = useRef<SVGPolylineElement>(null);
  const acknowledgment = useRef<SVGCircleElement>(null);
  const playedFeedback = useRef<string | null>(null);
  const history = useRef<{ generation: number; points: [number, number][] }>({ generation: -1, points: [] });
  const displayed = useRef({ x: 400, y: 260, a: -28 });
  const prefix = useId().replace(/:/g, "");
  const active = visible && !paused;

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

  useEffect(() => {
    if (!snapshot || !active || view !== "fly" || !fly.current) return;
    const { posX, posY, generation, headX, headY } = snapshot;
    if (history.current.generation !== generation) history.current = { generation, points: [] };
    const points = history.current.points;
    const previous = points[points.length - 1];
    if (!previous || previous[0] !== posX || previous[1] !== posY) {
      points.push([posX, posY]);
      if (points.length > 32) points.shift();
    }
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    const scale = Math.min(0.18, 300 / Math.max(1, maxX - minX), 150 / Math.max(1, maxY - minY));
    const project = ([x, y]: [number, number]) => [400 + (x - centerX) * scale, 260 - (y - centerY) * scale];
    trail.current?.setAttribute("points", points.map(p => project(p).join(",")).join(" "));
    const [x, y] = project([posX, posY]);
    const a = headX || headY ? Math.atan2(-headY, headX) * 180 / Math.PI + 90 : displayed.current.a;
    const from = { ...displayed.current };
    const angleDelta = ((a - from.a + 540) % 360 + 360) % 360 - 180;
    let raf = 0;
    const start = performance.now();
    const animate = (now: number) => {
      const t = reducedMotion ? 1 : Math.min(1, (now - start) / 650);
      const eased = 1 - Math.pow(1 - t, 3);
      displayed.current = { x: from.x + (x - from.x) * eased, y: from.y + (y - from.y) * eased, a: from.a + angleDelta * eased };
      const current = displayed.current;
      fly.current?.setAttribute("transform", `translate(${current.x} ${current.y}) rotate(${current.a})`);
      if (t < 1) raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [snapshot, active, view, reducedMotion, resetKey]);

  useEffect(() => {
    if (!feedback || playedFeedback.current === feedback.id) return;
    playedFeedback.current = feedback.id;
    if (!acknowledgment.current || !active || reducedMotion) return;
    const animation = acknowledgment.current.animate([
      { opacity: .8, transform: "scale(.6)" },
      { opacity: 0, transform: "scale(1.7)" },
    ], { duration: 1600, easing: "ease-out" });
    return () => animation.cancel();
  }, [feedback, active, reducedMotion, view]);

  const reset = () => {
    history.current = { generation: -1, points: [] };
    displayed.current = { ...displayed.current, x: 400, y: 260 };
    fly.current?.setAttribute("transform", `translate(400 260) rotate(${displayed.current.a})`);
    trail.current?.setAttribute("points", "");
    setResetKey(value => value + 1);
  };
  const stateLabel = view === "brain" ? "state" : "position";
  const status = paused ? "Motion paused" : !snapshot ? "Waiting for data" : connection === "live" ? `Latest ${stateLabel}` : `Last known ${stateLabel}`;

  return (
    <div ref={stage} className={styles.stage} data-running={active && !reducedMotion && snapshot?.alive && connection === "live"}>
      <div className={styles.toolbar}>
        <div className={styles.views} role="group" aria-label="Visual view">
          <button type="button" aria-pressed={view === "fly"} onClick={() => setView("fly")}>Fly</button>
          <button type="button" aria-pressed={view === "brain"} onClick={() => setView("brain")}>Brain</button>
        </div>
        <div className={styles.tools}>
          <button type="button" onClick={() => setPaused(value => !value)} aria-label={paused ? "Resume motion" : "Pause motion"} aria-pressed={paused}>{paused ? "Resume" : "Pause"}</button>
          <button type="button" onClick={reset} aria-label="Reset view">Reset</button>
        </div>
      </div>
      {view === "fly" ? (
        <svg className={styles.arena} viewBox="0 0 800 520" role="img" aria-label={snapshot ? (snapshot.alive ? "Fly at its latest recorded position and heading" : "Fly resting at its last recorded position") : "Fly illustration. Waiting for the latest position."}>
          <defs>
            <pattern id={`${prefix}-grid`} width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#82948c" opacity=".2" /></pattern>
            <radialGradient id={`${prefix}-arena`}><stop stopColor="#2f3931" stopOpacity=".6" /><stop offset="1" stopColor="#17221c" stopOpacity="0" /></radialGradient>
          </defs>
          <path d="M0 0H800V520H0Z" fill={`url(#${prefix}-grid)`} />
          <ellipse cx="400" cy="260" rx="370" ry="230" fill={`url(#${prefix}-arena)`} />
          <ellipse className={styles.arenaRing} cx="400" cy="260" rx="288" ry="184" />
          <path d="M400 67v9M400 444v9M103 260h9M688 260h9" stroke="#8e9b87" strokeOpacity=".4" />
          <polyline ref={trail} fill="none" stroke="#c0cfa4" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 8" opacity=".45" />
          <g ref={fly} transform="translate(400 260) rotate(-28)" opacity={snapshot && !snapshot.alive ? ".5" : "1"}>
            <circle ref={acknowledgment} className={styles.acknowledgment} r="90" fill="none" stroke={feedback?.kind === "feed" || feedback?.kind === "resurrect" ? "#c9dfaa" : "#d2b995"} strokeWidth="1.5" />
            <path d="m-3-115 3-5 3 5" fill="none" stroke="#c8d5b6" strokeWidth="1.2" opacity=".65" />
            <FlyBody prefix={prefix} />
          </g>
        </svg>
      ) : <BrainView snapshot={snapshot} active={active} reducedMotion={reducedMotion} resetKey={resetKey} />}
      <div className={styles.caption}>
        <span>{view === "brain" ? "Brain view" : "Drosophila melanogaster"}</span>
        <span>{status}</span>
      </div>
    </div>
  );
}
