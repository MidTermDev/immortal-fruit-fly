import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BLACK, BONE, DIM, MONO, RED, SERIF } from "./theme";
import { BottomScrim, Fade, Footage, Letterbox, Mono, Pebble, Words, crtOff, useSceneFade } from "./ui";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ---- timeline (frames at 30 fps)
const T = {
  open: [0, 210],
  brain: [210, 510],
  tab: [510, 750],
  quote: [750, 1020],
  layer: [1020, 1350],
  doom: [1350, 1620],
  colony: [1620, 1920],
  hand: [1920, 2055],
  v3: [2055, 2235],
  close: [2235, 2400],
} as const;
const len = (k: keyof typeof T) => T[k][1] - T[k][0];

const Pad: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ padding: "110px 120px", ...style }}>{children}</AbsoluteFill>
);

// 1. cold open: a fact, on black
const Open: React.FC = () => {
  const o = useSceneFade(len("open"), 1, 14);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Pad>
        <Mono text="Drosophila melanogaster · FlyWire · 2024" start={18} size={26} />
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          <Words text="A whole animal brain," start={45} size={132} />
          <Words text="mapped. Every neuron. Every synapse." start={80} size={132} color={DIM} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 2. the brain, firing
const Brain: React.FC = () => {
  const o = useSceneFade(len("brain"), 14, 12);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Footage src="clips/brain.mp4" trimBefore={7 * 30} from={1.12} to={1.34} over={300} origin="50% 50%" grade="contrast(1.15) brightness(1.05)" />
      <BottomScrim strength={0.7} />
      <Letterbox />
      <Pad>
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          <Words text="139,248 neurons." start={60} size={150} />
          <Mono text="spiking in real time · the state anchored to BNB Chain" start={120} size={28} style={{ marginTop: 18 }} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 3. people ran it in DOOM, then closed the tab
const Tab: React.FC = () => {
  const frame = useCurrentFrame();
  const OFF = 178;
  const o = useSceneFade(len("tab"), 8, 12);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <div style={{ position: "absolute", inset: 0, ...crtOff(frame - OFF) }}>
        <Footage src="clips/doom_game.mp4" trimBefore={12} from={1} to={1.06} over={200} grade="saturate(0.9) contrast(1.1) brightness(0.9)" />
        <BottomScrim strength={0.8} />
        <Letterbox />
      </div>
      <Pad>
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          <Words text="People ran it in DOOM." start={20} size={120} fadeOut={150} />
        </div>
        <div style={{ position: "absolute", left: 120, top: 440, width: 1700 }}>
          <Words text="Then they closed the tab." start={172} per={7} size={120} color={BONE} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 4. the ask, and the answer
const Quote: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("quote"), 6, 14);
  const built = spring({ frame: frame - 190, fps: 30, config: { damping: 16, stiffness: 110, mass: 0.8 } });
  const builtO = interpolate(frame, [190, 200], [0, 1], clamp);
  const quoteOut = interpolate(frame, [178, 190], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Pad>
        <div style={{ position: "absolute", left: 120, right: 120, top: 250, opacity: quoteOut }}>
          <Words
            text="“Would be cool to see someone make ‘immortal fruit flies’ on BNB Chain.”"
            start={14}
            per={5}
            size={104}
            italic
            width={1600}
          />
          <Mono text="— CZ" start={110} size={34} color={RED} style={{ marginTop: 44 }} />
        </div>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: builtO }}>
          <div
            style={{
              fontFamily: SERIF,
              fontSize: 220,
              color: BONE,
              letterSpacing: -2,
              transform: `scale(${0.92 + built * 0.08})`,
            }}
          >
            We built it.
          </div>
        </AbsoluteFill>
      </Pad>
    </AbsoluteFill>
  );
};

// 5. the permanent layer, then the loop: over the colony's neurology panel
const Row: React.FC<{ items: string[]; start: number; first: number }> = ({ items, start, first }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", gap: "0 40px" }}>
      {items.map((it, i) => {
        const f = frame - start - i * 14;
        const p = spring({ frame: f, fps: 30, config: { damping: 200, stiffness: 120 } });
        const op = interpolate(f, [0, 12], [0, 1], clamp);
        return (
          <div
            key={it}
            style={{
              fontFamily: SERIF,
              fontSize: 118,
              color: BONE,
              opacity: op,
              transform: `translateY(${(1 - p) * 40}px)`,
              display: "flex",
              alignItems: "baseline",
            }}
          >
            {(i > 0 || first > 0) && <span style={{ color: RED, marginRight: 40, fontSize: 60 }}>·</span>}
            {it}
          </div>
        );
      })}
    </div>
  );
};

const Layer: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("layer"), 14, 12);
  const phase1Out = interpolate(frame, [168, 182], [1, 0], clamp);
  const loop = ["It dies in a game.", "Its brain stays on the chain.", "It wakes up in the next body."];
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Footage src="clips/colony.mp4" trimBefore={150} from={1.0} to={1.1} over={330} origin="30% 50%" grade="saturate(1) contrast(1.1) brightness(0.9)" scrim={0.62} />
      <AbsoluteFill style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0) 70%)", opacity: phase1Out }} />
      <AbsoluteFill style={{ opacity: 1 - phase1Out }}>
        <BottomScrim strength={0.92} />
      </AbsoluteFill>
      <Letterbox />
      <Pad>
        <div style={{ position: "absolute", left: 120, top: 150, opacity: phase1Out }}>
          <Mono text="the chain holds" start={12} size={28} />
          <div style={{ marginTop: 20 }}>
            <Row items={["identity", "brain state", "memory"]} start={40} first={0} />
            <Row items={["lineage", "history"]} start={82} first={1} />
          </div>
          <Mono text="forever · BNB Smart Chain · FlyRegistry v3" start={122} size={28} style={{ marginTop: 26 }} />
        </div>
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          {loop.map((line, i) => (
            <Words key={line} text={line} start={186 + i * 40} per={5} size={108} color={i === 2 ? BONE : DIM} />
          ))}
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 6. it plays DOOM, on the record
const Doom: React.FC = () => {
  const o = useSceneFade(len("doom"), 10, 12);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Footage src="clips/doom_full.mp4" trimBefore={0} from={1.0} to={1.05} over={270} grade="saturate(1.05) contrast(1.08)" />
      <BottomScrim strength={0.75} />
      <Letterbox />
      <Pad>
        <div style={{ position: "absolute", left: 120, bottom: 175 }}>
          <Words text="It plays DOOM." start={24} size={140} />
          <Mono text="every decision hashed · committed to the chain as it plays" start={80} size={28} style={{ marginTop: 18 }} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 7. they live together in Minecraft
const Colony: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("colony"), 12, 12);
  const cut = 150;
  const a = interpolate(frame, [cut - 8, cut], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Sequence from={0} durationInFrames={cut} layout="none">
        <AbsoluteFill style={{ opacity: a }}>
          <Footage src="clips/nightcam.mp4" trimBefore={90} from={1.0} to={1.14} over={150} origin="45% 60%" />
        </AbsoluteFill>
      </Sequence>
      <Sequence from={cut} durationInFrames={len("colony") - cut} layout="none">
        <Footage src="clips/night.mp4" trimBefore={30} from={1.04} to={1.0} over={150} />
      </Sequence>
      <BottomScrim strength={0.75} />
      <Letterbox />
      <Pad>
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          <Words text="They live together." start={24} size={140} fadeOut={140} />
          <Mono text="the Colony · a Minecraft world · mc.immortalfly.app" start={70} size={28} style={{ marginTop: 18 }} fadeOut={140} />
        </div>
        <div style={{ position: "absolute", left: 120, bottom: 150 }}>
          <Words text="They die. They respawn. They remember." start={158} per={6} size={120} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 8. they live in your hand
const Hand: React.FC = () => {
  const o = useSceneFade(len("hand"), 8, 12);
  const files = ["screens/hatching.png", "screens/life_eating.png", "screens/neurons.png", "screens/life_caught.png"];
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <Pad>
        <div style={{ position: "absolute", left: 120, top: 130 }}>
          <Words text="They live in your hand." start={6} size={120} />
          <Mono text="M5Stack CoreS3 · its own wallet · signs its own transactions" start={40} size={28} style={{ marginTop: 14 }} />
        </div>
      </Pad>
      {files.map((f, i) => (
        <Pebble key={f} file={f} start={30 + i * 9} x={48 + i * 462} y={470} w={410} rotate={(i - 1.5) * 1.2} />
      ))}
    </AbsoluteFill>
  );
};

const Counter: React.FC<{ to: number; start: number; label: string; x: number }> = ({ to, start, label, x }) => {
  const frame = useCurrentFrame();
  const n = Math.round(interpolate(frame, [start, start + 50], [0, to], { ...clamp, easing: Easing.out(Easing.cubic) }));
  const o = interpolate(frame, [start, start + 8], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: x, top: 330, opacity: o }}>
      <div style={{ fontFamily: MONO, fontSize: 150, color: BONE, letterSpacing: -4, fontWeight: 500 }}>{n.toLocaleString("en-US")}</div>
      <div style={{ fontFamily: MONO, fontSize: 30, color: DIM, letterSpacing: 3, textTransform: "uppercase", marginTop: 6 }}>{label}</div>
    </div>
  );
};

// 9. two days, and v3
const V3: React.FC = () => {
  const frame = useCurrentFrame();
  const o = useSceneFade(len("v3"), 8, 12);
  const statsOut = interpolate(frame, [92, 104], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o }}>
      <div style={{ opacity: statsOut }}>
        <Mono text="the first 48 hours" start={6} size={28} style={{ position: "absolute", left: 120, top: 250 }} />
        <Counter to={3268} start={14} label="flies" x={120} />
        <Counter to={536} start={26} label="owners" x={800} />
        <Counter to={1} start={38} label="brain" x={1380} />
      </div>
      <Pad>
        <div style={{ position: "absolute", left: 120, top: 300 }}>
          <Mono text="FlyRegistry v3 · today" start={104} size={28} color={RED} />
          <Words text="Life now costs a little BNB." start={112} size={120} style={{ marginTop: 20 }} />
          <Words text="Nothing is burned." start={140} size={120} color={DIM} />
        </div>
      </Pad>
    </AbsoluteFill>
  );
};

// 10. the fly escaped the computer
const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = useSceneFade(len("close"), 10, 30);
  const p = spring({ frame: frame - 6, fps, config: { damping: 200, stiffness: 60 } });
  const logo = interpolate(frame, [6, 40], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: BLACK, opacity: o, justifyContent: "center", alignItems: "center" }}>
      <Img
        src={staticFile("fly.png")}
        style={{ width: 580, height: 580, opacity: logo, transform: `scale(${0.9 + p * 0.1})`, marginTop: -140 }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, top: 640, textAlign: "center" }}>
        <Words text="The fly escaped the computer." start={30} per={5} size={110} align="center" />
        <Fade start={95} style={{ marginTop: 26 }}>
          <div style={{ fontFamily: MONO, fontSize: 40, color: RED, letterSpacing: 4 }}>immortalfly.app</div>
          <div style={{ fontFamily: MONO, fontSize: 24, color: DIM, letterSpacing: 3, marginTop: 10, textTransform: "uppercase" }}>
            $FLY · BNB Smart Chain
          </div>
        </Fade>
      </div>
    </AbsoluteFill>
  );
};

export const Promo: React.FC = () => {
  const scenes: [keyof typeof T, React.FC][] = [
    ["open", Open],
    ["brain", Brain],
    ["tab", Tab],
    ["quote", Quote],
    ["layer", Layer],
    ["doom", Doom],
    ["colony", Colony],
    ["hand", Hand],
    ["v3", V3],
    ["close", Close],
  ];
  return (
    <AbsoluteFill style={{ background: BLACK }}>
      <Audio
        src={staticFile("music_ominous.mp3")}
        volume={(f) => interpolate(f, [0, 20, 2330, 2398], [0, 1, 1, 0], clamp)}
      />
      {scenes.map(([k, C]) => (
        <Sequence key={k} from={T[k][0]} durationInFrames={len(k)} name={k}>
          <C />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
