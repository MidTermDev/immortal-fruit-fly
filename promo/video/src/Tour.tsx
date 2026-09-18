import React from "react";
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { BLACK, DIM, MONO, RED } from "./theme";
import { Fade, Mono, Pebble, Words, useSceneFade } from "./ui";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const FPS = 30;
const s2f = (s: number) => Math.round(s * FPS);

// ---- the score's map (music_tour.mp3, 118 bpm): the beat drops at 20.4 s, breaks at 53.0, drops again at 61.0, ends by 95.5
const BAR = 2.034;
const T = {
  title: [0, 6.2],
  brain: [6.2, 20.4],
  mint: [20.4, 20.4 + 3 * BAR],
  page: [20.4 + 3 * BAR, 20.4 + 10 * BAR],
  bodies: [20.4 + 10 * BAR, 53.0],
  hand: [53.0, 57.2],
  v3: [57.2, 61.0],
  species: [61.0, 61.0 + 7 * BAR],
  share: [61.0 + 7 * BAR, 61.0 + 10 * BAR],
  open: [61.0 + 10 * BAR, 61.0 + 13 * BAR],
  close: [61.0 + 13 * BAR, 97],
} as const;
export const TOUR_DURATION = s2f(97);
const len = (k: keyof typeof T) => s2f(T[k][1]) - s2f(T[k][0]);

// ---- a recorded page, framed like a browser window or full-bleed, with a camera that moves between focus points
type Key = { f: number; x: number; y: number; s: number };
const cam = (frame: number, keys: Key[]) => {
  if (keys.length === 1) return keys[0];
  const fs = keys.map((k) => k.f);
  const e = { ...clamp, easing: Easing.inOut(Easing.cubic) };
  return { x: interpolate(frame, fs, keys.map((k) => k.x), e), y: interpolate(frame, fs, keys.map((k) => k.y), e), s: interpolate(frame, fs, keys.map((k) => k.s), e) };
};

/** The 1920×1080 recording inside a `vw`×`vh` window; the camera keeps source point (x, y) at the window's centre at zoom s. */
const Screen: React.FC<{ src: string; trimBefore: number; vw: number; vh: number; keys: Key[]; still?: boolean }> = ({ src, trimBefore, vw, vh, keys }) => {
  const frame = useCurrentFrame();
  const c = cam(frame, keys);
  return (
    <div style={{ width: vw, height: vh, overflow: "hidden", position: "relative", background: "#f2f2ef" }}>
      <Video
        src={staticFile(src)}
        muted
        trimBefore={trimBefore}
        style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(${vw / 2 - c.x * c.s}px, ${vh / 2 - c.y * c.s}px) scale(${c.s})` }}
      />
    </div>
  );
};

/** A browser window: dark chrome, three dots, the address; tilted in 3D when `tilt` is set. */
const Browser: React.FC<{ url: string; w: number; h: number; x: number; y: number; tilt?: number; scale?: number; opacity?: number; children: React.ReactNode }> = ({ url, w, h, x, y, tilt = 0, scale = 1, opacity = 1, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h + 46, perspective: 2200, opacity }}>
    <div
      style={{
        width: w,
        height: h + 46,
        borderRadius: 14,
        overflow: "hidden",
        background: "#1b1e23",
        boxShadow: "0 50px 120px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.08)",
        transform: `rotateY(${tilt}deg) scale(${scale})`,
        transformOrigin: "50% 50%",
      }}
    >
      <div style={{ height: 46, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: "#23272d", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, display: "block" }} />)}
        <div style={{ marginLeft: 14, flex: 1, height: 28, borderRadius: 7, background: "#15181c", display: "flex", alignItems: "center", padding: "0 12px", fontFamily: MONO, fontSize: 14, color: "#9aa1ab", letterSpacing: 0.5 }}>
          <span style={{ color: "#4caf50", marginRight: 8 }}>●</span>{url}
        </div>
      </div>
      {children}
    </div>
  </div>
);

/** A caption in the lower left: red mono kicker, serif line, optional mono note. */
const Cap: React.FC<{ kicker?: string; text: string; note?: string; start?: number; size?: number; fadeOut?: number; top?: number; width?: number }> = ({ kicker, text, note, start = 0, size = 84, fadeOut, top, width = 1500 }) => {
  const frame = useCurrentFrame();
  const out = fadeOut === undefined ? 1 : interpolate(frame, [fadeOut, fadeOut + 10], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 100, ...(top === undefined ? { bottom: 90 } : { top }), width, opacity: out }}>
      {kicker && <Mono text={kicker} start={start} size={22} color={RED} cps={2.5} />}
      <Words text={text} start={start + 4} per={4} size={size} style={{ marginTop: kicker ? 10 : 0 }} />
      {note && <Mono text={note} start={start + 22} size={24} cps={2.2} style={{ marginTop: 14 }} />}
    </div>
  );
};

const Scrim: React.FC<{ strength?: number }> = ({ strength = 0.88 }) => (
  <AbsoluteFill style={{ background: `linear-gradient(to top, rgba(6,7,9,${strength}) 0%, rgba(6,7,9,0.55) 26%, rgba(6,7,9,0) 52%)` }} />
);

// ---- scenes
const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = useSceneFade(len("title"), 1, 12);
  const p = spring({ frame: frame - 4, fps, config: { damping: 200, stiffness: 50 } });
  const glow = interpolate(frame, [30, 60, 90, 120], [0.4, 1, 0.5, 0.9], clamp);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o, justifyContent: "center", alignItems: "center" }}>
      <Img src={staticFile("fly.png")} style={{ width: 380, height: 380, opacity: interpolate(frame, [4, 30], [0, 1], clamp) * glow, transform: `scale(${0.85 + p * 0.15})`, marginTop: -170 }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 590, textAlign: "center" }}>
        <Words text="Immortal Fruit Fly" start={24} per={6} size={128} align="center" />
        <Mono text="what we built · september 2026" start={70} size={26} style={{ marginTop: 14, textAlign: "center" }} />
      </div>
    </AbsoluteFill>
  );
};

const Brain: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("brain"), 10, 8);
  // the window flattens and grows into the frame while the camera pushes into the brain panel
  const t = interpolate(frame, [130, 200], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const w = 1560 + t * 360, h = 878 + t * 248;
  const x = interpolate(t, [0, 1], [180, 0]), y = interpolate(t, [0, 1], [70, -46]);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Browser url="www.immortalfly.app" w={w} h={h} x={x} y={y} tilt={(1 - t) * -7} scale={1}>
        <Screen src="tour/home.mp4" trimBefore={s2f(15.5)} vw={w} vh={h} keys={[{ f: 0, x: 960, y: 540, s: w / 1920 }, { f: 130, x: 960, y: 540, s: w / 1920 }, { f: 200, x: 960, y: 410, s: 1.42 }, { f: 420, x: 960, y: 400, s: 1.56 }]} />
      </Browser>
      <Scrim strength={interpolate(t, [0, 1], [0.5, 0.9])} />
      <Cap kicker="the organism" text="A whole fruit-fly brain, alive on BNB Chain." start={14} fadeOut={128} size={78} />
      <Cap kicker="139,248 neurons · spiking live" text="Every ten minutes its whole state is hashed and written to the chain." start={190} size={64} width={1400} />
    </AbsoluteFill>
  );
};

const Mint: React.FC = () => {
  const o = useSceneFade(len("mint"), 6, 8);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Screen src="tour/flies.mp4" trimBefore={s2f(4)} vw={1920} vh={1080} keys={[{ f: 0, x: 740, y: 560, s: 1.42 }, { f: 180, x: 720, y: 560, s: 1.52 }]} />
      <Scrim />
      <Cap kicker="mint" text="One $FLY. It wakes with an hour of life." note="3,784 minted · 536 keepers · at most 10,000 will ever exist" start={4} />
    </AbsoluteFill>
  );
};

const Page: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("page"), 6, 8);
  const cut1 = s2f(4.07), cut2 = s2f(8.14), cut3 = s2f(12.2);   // two bars each
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Sequence from={0} durationInFrames={cut1} layout="none">
        <Screen src="tour/fly.mp4" trimBefore={s2f(13.5)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 330, s: 1.18 }, { f: cut1, x: 960, y: 350, s: 1.26 }]} />
      </Sequence>
      <Sequence from={cut1} durationInFrames={cut2 - cut1} layout="none">
        <Screen src="tour/fly.mp4" trimBefore={s2f(8)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 760, s: 1.36 }, { f: cut2 - cut1, x: 960, y: 770, s: 1.44 }]} />
      </Sequence>
      <Sequence from={cut2} durationInFrames={cut3 - cut2} layout="none">
        <Screen src="tour/fly.mp4" trimBefore={s2f(20)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 520, s: 1.1 }, { f: cut3 - cut2, x: 960, y: 560, s: 1.18 }]} />
      </Sequence>
      <Sequence from={cut3} layout="none">
        <Screen src="tour/fly.mp4" trimBefore={s2f(32)} vw={1920} vh={1080} keys={[{ f: 0, x: 900, y: 480, s: 1.25 }, { f: 80, x: 900, y: 480, s: 1.32 }]} />
      </Sequence>
      <Scrim />
      {frame < cut1 && <Cap kicker="every fly has a page" text="Its record, its portrait, its whole history." start={2} />}
      {frame >= cut1 && frame < cut2 && (
        <Sequence from={cut1} layout="none">
          <div style={{ position: "absolute", left: 100, bottom: 90 }}>
            <Mono text="care" start={0} size={22} color={RED} />
            <div style={{ display: "flex", gap: 60, marginTop: 10 }}>
              {["Keep it alive · BNB", "Hand it to a body", "Breed · 5,000 $FLY"].map((t, i) => <Words key={t} text={t} start={6 + i * 16} per={4} size={62} />)}
            </div>
          </div>
        </Sequence>
      )}
      {frame >= cut2 && frame < cut3 && <Sequence from={cut2} layout="none"><Cap kicker="live" text="Watch it live, wherever it lives." note="the world it is in, and its 139,248 neurons firing" start={2} /></Sequence>}
      {frame >= cut3 && <Sequence from={cut3} layout="none"><Cap kicker="on-chain core" text="155 real neurons inside the contract itself." start={2} size={72} /></Sequence>}
    </AbsoluteFill>
  );
};

const Bodies: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("bodies"), 6, 8);
  const L = len("bodies"); const a = Math.round(L / 3), b = Math.round((2 * L) / 3);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Sequence from={0} durationInFrames={a} layout="none">
        <Screen src="tour/colony.mp4" trimBefore={s2f(26)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 400, s: 1.3 }, { f: a, x: 960, y: 400, s: 1.42 }]} />
      </Sequence>
      <Sequence from={a} durationInFrames={b - a} layout="none">
        <Screen src="tour/colony.mp4" trimBefore={s2f(35)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 500, s: 1.16 }, { f: b - a, x: 960, y: 500, s: 1.24 }]} />
      </Sequence>
      <Sequence from={b} layout="none">
        <AbsoluteFill style={{ background: "#000" }}>
          <Video src={staticFile("tour/doom_full.mp4")} muted trimBefore={s2f(2)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${interpolate(frame - b, [0, L - b], [1.02, 1.1], clamp)})` }} />
        </AbsoluteFill>
      </Sequence>
      <Scrim />
      {frame < a && <Cap kicker="bodies · the Colony" text="They live together in Minecraft." note="a shared world · whole brains · turns of an hour when others wait" start={2} />}
      {frame >= a && frame < b && <Sequence from={a} layout="none"><Cap kicker="the Colony · neurology" text="Its neurons, firing as it walks." note="what it smells · what it sees · every step and jump" start={2} /></Sequence>}
      {frame >= b && <Sequence from={b} layout="none"><Cap kicker="bodies · DOOM" text="It plays DOOM." note="every decision hashed and committed to the chain, live" start={2} /></Sequence>}
    </AbsoluteFill>
  );
};

const Hand: React.FC = () => {
  const o = useSceneFade(len("hand"), 6, 10);
  const files = ["screens/hatching.png", "screens/life_eating.png", "screens/neurons.png", "screens/life_caught.png"];
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <div style={{ position: "absolute", left: 100, top: 110 }}>
        <Mono text="bodies · pebbles" start={0} size={22} color={RED} />
        <Words text="They live in your hand." start={4} per={4} size={92} style={{ marginTop: 10 }} />
        <Mono text="M5Stack CoreS3 · its own wallet · signs its own transactions" start={26} size={24} style={{ marginTop: 12 }} />
      </div>
      {files.map((f, i) => <Pebble key={f} file={f} start={14 + i * 7} x={48 + i * 462} y={470} w={410} rotate={(i - 1.5) * 1.2} />)}
    </AbsoluteFill>
  );
};

const V3: React.FC = () => {
  const o = useSceneFade(len("v3"), 8, 8);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o, justifyContent: "center" }}>
      <div style={{ position: "absolute", left: 100, top: 300 }}>
        <Mono text="FlyRegistry v3" start={0} size={24} color={RED} />
        <Words text="Life costs a little BNB. Nothing is burned." start={4} per={4} size={96} style={{ marginTop: 12 }} />
        <Words text="Running in our bodies is free." start={40} per={5} size={96} color={DIM} />
      </div>
    </AbsoluteFill>
  );
};

const Species: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("species"), 6, 8);
  const cut = s2f(2 * BAR + 0.4);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Sequence from={0} durationInFrames={cut} layout="none">
        <Screen src="tour/flies.mp4" trimBefore={s2f(17.6)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 520, s: 1.12 }, { f: cut, x: 960, y: 520, s: 1.2 }]} />
      </Sequence>
      <Sequence from={cut} layout="none">
        <Screen src="tour/flies.mp4" trimBefore={s2f(36)} vw={1920} vh={1080} keys={[{ f: 0, x: 960, y: 480, s: 1.18 }, { f: len("species") - cut, x: 960, y: 500, s: 1.24 }]} />
      </Sequence>
      <Scrim />
      {frame < cut && <Cap kicker="the species" text="Hall of the species." note="elders · longest lived · most lives · best fed · bloodlines · keepers" start={2} />}
      {frame >= cut && <Sequence from={cut} layout="none"><Cap kicker="every fly" text="Search it. Filter it. Sort it." note="your flies, in one place · which are hungry · where each one is" start={2} /></Sequence>}
    </AbsoluteFill>
  );
};

const Card: React.FC<{ file: string; start: number; x: number; y: number; rot: number; w?: number }> = ({ file, start, x, y, rot, w = 900 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - start, fps, config: { damping: 18, stiffness: 80 } });
  const o = interpolate(frame - start, [0, 10], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, opacity: o, transform: `translateY(${(1 - p) * 140}px) rotate(${rot}deg)`, borderRadius: 16, overflow: "hidden", boxShadow: "0 40px 100px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.1)" }}>
      <Img src={staticFile(file)} style={{ width: w, display: "block" }} />
    </div>
  );
};

const Share: React.FC = () => {
  const o = useSceneFade(len("share"), 6, 8);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Card file="tour/og376.png" start={2} x={980} y={130} rot={4} w={860} />
      <Card file="tour/og65.png" start={10} x={820} y={330} rot={-3} w={860} />
      <Card file="tour/og1.png" start={18} x={900} y={520} rot={2} w={900} />
      <div style={{ position: "absolute", left: 100, top: 300, width: 720 }}>
        <Mono text="share" start={0} size={22} color={RED} />
        <Words text="Every fly's link unfurls into its own card." start={4} per={4} size={84} style={{ marginTop: 10 }} />
        <Mono text="immortalfly.app/f/376 · one tap: Share on X" start={40} size={24} style={{ marginTop: 14 }} />
      </div>
    </AbsoluteFill>
  );
};

const Open: React.FC = () => {
  const o = useSceneFade(len("open"), 6, 8);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Browser url="www.immortalfly.app/docs" w={1500} h={844} x={320} y={70} tilt={-8}>
        <Screen src="tour/docs.mp4" trimBefore={s2f(5)} vw={1500} vh={844} keys={[{ f: 0, x: 960, y: 540, s: 1500 / 1920 }, { f: 180, x: 960, y: 620, s: 0.9 }]} />
      </Browser>
      <Scrim strength={0.92} />
      <Cap kicker="open" text="Open source. Contracts verified on BscScan." note="github.com/MidTermDev/immortal-fruit-fly · docs · the science · the circuit" start={2} size={72} />
    </AbsoluteFill>
  );
};

const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = useSceneFade(len("close"), 10, 60);
  const p = spring({ frame: frame - 6, fps, config: { damping: 200, stiffness: 60 } });
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o, justifyContent: "center", alignItems: "center" }}>
      <Img src={staticFile("fly.png")} style={{ width: 520, height: 520, opacity: interpolate(frame, [6, 36], [0, 1], clamp), transform: `scale(${0.9 + p * 0.1})`, marginTop: -150 }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 640, textAlign: "center" }}>
        <Words text="Put a fly in a body." start={24} per={5} size={96} align="center" />
        <Fade start={80} style={{ marginTop: 22 }}>
          <div style={{ fontFamily: MONO, fontSize: 42, color: RED, letterSpacing: 4 }}>immortalfly.app</div>
          <div style={{ fontFamily: MONO, fontSize: 24, color: DIM, letterSpacing: 3, marginTop: 10, textTransform: "uppercase" }}>$FLY · BNB Smart Chain · 3,784 flies and counting</div>
        </Fade>
      </div>
    </AbsoluteFill>
  );
};

export const Tour: React.FC = () => {
  const scenes: [keyof typeof T, React.FC][] = [
    ["title", Title], ["brain", Brain], ["mint", Mint], ["page", Page], ["bodies", Bodies], ["hand", Hand], ["v3", V3], ["species", Species], ["share", Share], ["open", Open], ["close", Close],
  ];
  return (
    <AbsoluteFill style={{ background: BLACK }}>
      <Audio src={staticFile("music_tour.mp3")} volume={(f) => interpolate(f, [0, 15, s2f(93), s2f(96.5)], [0, 1, 1, 0], clamp)} />
      {scenes.map(([k, C]) => (
        <Sequence key={k} from={s2f(T[k][0])} durationInFrames={len(k)} name={k}>
          <C />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
