import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Video } from "@remotion/media";
import { BONE, DIM, MONO, RED, SERIF } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 over `dur` frames from `start`, eased out */
export const rise = (frame: number, start: number, dur = 18) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });

/** opacity of a scene of `len` frames: fades in over `fin`, out over `fout` */
export const useSceneFade = (len: number, fin = 12, fout = 12) => {
  const frame = useCurrentFrame();
  return Math.min(
    interpolate(frame, [0, fin], [0, 1], clamp),
    interpolate(frame, [len - fout, len], [1, 0], clamp),
  );
};

/** words rising in one after another */
export const Words: React.FC<{
  text: string;
  start?: number;
  per?: number;
  size?: number;
  italic?: boolean;
  color?: string;
  align?: "left" | "center";
  width?: number;
  fadeOut?: number;
  style?: React.CSSProperties;
}> = ({ text, start = 0, per = 5, size = 120, italic, color = BONE, align = "left", width, fadeOut, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  const out = fadeOut === undefined ? 1 : interpolate(frame, [fadeOut, fadeOut + 14], [1, 0], clamp);
  return (
    <div
      style={{
        fontFamily: SERIF,
        fontStyle: italic ? "italic" : "normal",
        fontSize: size,
        lineHeight: 1.06,
        letterSpacing: -0.5,
        color,
        textAlign: align,
        width,
        opacity: out,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const f = frame - start - i * per;
        const p = spring({ frame: f, fps, config: { damping: 200, stiffness: 120 } });
        const o = interpolate(f, [0, 14], [0, 1], clamp);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: o,
              transform: `translateY(${(1 - p) * 0.35 * size}px)`,
              marginRight: "0.27em",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** a monospace caption typed out */
export const Mono: React.FC<{
  text: string;
  start?: number;
  cps?: number;
  size?: number;
  color?: string;
  fadeOut?: number;
  style?: React.CSSProperties;
}> = ({ text, start = 0, cps = 1.6, size = 28, color = DIM, fadeOut, style }) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.floor((frame - start) * cps));
  const out = fadeOut === undefined ? 1 : interpolate(frame, [fadeOut, fadeOut + 12], [1, 0], clamp);
  const o = interpolate(frame, [start, start + 4], [0, 1], clamp) * out;
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: size,
        letterSpacing: 2,
        textTransform: "uppercase",
        color,
        opacity: o,
        whiteSpace: "pre",
        ...style,
      }}
    >
      {text.slice(0, n)}
      <span style={{ color: RED, opacity: n < text.length ? 1 : 0 }}>▍</span>
    </div>
  );
};

/** a plain fade-in block */
export const Fade: React.FC<{ start: number; dur?: number; fadeOut?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  start,
  dur = 16,
  fadeOut,
  style,
  children,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [start, start + dur], [0, 1], clamp);
  const out = fadeOut === undefined ? 1 : interpolate(frame, [fadeOut, fadeOut + 12], [1, 0], clamp);
  return <div style={{ opacity: o * out, ...style }}>{children}</div>;
};

/** graded footage filling the frame, with a slow push and a vignette; scale runs from→to over the given frames */
export const Footage: React.FC<{
  src: string;
  trimBefore?: number;
  from?: number;
  to?: number;
  over?: number;
  origin?: string;
  grade?: string;
  scrim?: number;
  playbackRate?: number;
}> = ({ src, trimBefore = 0, from = 1, to = 1.08, over = 300, origin = "50% 50%", grade = "saturate(0.8) contrast(1.12) brightness(0.82)", scrim = 0, playbackRate }) => {
  const frame = useCurrentFrame();
  const s = interpolate(frame, [0, over], [from, to], clamp);
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <Video
        src={staticFile(src)}
        muted
        trimBefore={trimBefore}
        playbackRate={playbackRate}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${s})`,
          transformOrigin: origin,
          filter: grade,
        }}
      />
      <AbsoluteFill style={{ background: `rgba(0,0,0,${scrim})` }} />
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.78) 100%)" }}
      />
    </AbsoluteFill>
  );
};

/** cinema bars */
export const Letterbox: React.FC<{ h?: number }> = ({ h = 110 }) => (
  <>
    <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: h, background: "#000" }} />
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: h, background: "#000" }} />
  </>
);

/** a dark gradient rising from the bottom so captions read over footage */
export const BottomScrim: React.FC<{ strength?: number }> = ({ strength = 0.85 }) => (
  <AbsoluteFill
    style={{ background: `linear-gradient(to top, rgba(0,0,0,${strength}) 0%, rgba(0,0,0,0.35) 40%, rgba(0,0,0,0) 70%)` }}
  />
);

/** a pebble screen in a dark bezel */
export const Pebble: React.FC<{ file: string; start: number; x: number; y: number; w?: number; rotate?: number }> = ({
  file,
  start,
  x,
  y,
  w = 400,
  rotate = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - start, fps, config: { damping: 18, stiffness: 90, mass: 0.9 } });
  const o = interpolate(frame - start, [0, 10], [0, 1], clamp);
  const h = (w * 3) / 4;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w + 28,
        height: h + 28,
        padding: 14,
        borderRadius: 22,
        background: "#111",
        boxShadow: "0 30px 80px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,255,255,0.08)",
        opacity: o,
        transform: `translateY(${(1 - p) * 90}px) rotate(${rotate}deg)`,
      }}
    >
      <Img src={staticFile(file)} style={{ width: w, height: h, borderRadius: 8, display: "block" }} />
    </div>
  );
};

/** the moment a tab is closed: the picture collapses like a CRT switching off */
export const crtOff = (t: number) => {
  const sy = interpolate(t, [0, 9], [1, 0.004], { ...clamp, easing: Easing.in(Easing.cubic) });
  const sx = interpolate(t, [9, 15], [1, 0], { ...clamp, easing: Easing.in(Easing.quad) });
  const bright = interpolate(t, [0, 9], [1, 2.6], clamp);
  return { transform: `scale(${sx}, ${sy})`, filter: `brightness(${bright})`, opacity: t >= 15 ? 0 : 1 };
};
