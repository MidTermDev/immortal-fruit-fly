"use client";

import dynamic from "next/dynamic";
import styles from "./WorldStage.module.css";

export type WorldPoint = { x: number; y: number };
export type WorldStageFrame = {
  x: number; y: number; heading: number; alive: boolean; generation: number; arena: number;
  food: { id: number | string; x: number; y: number; energy: number; energy0: number }[];
  predator?: { x: number; y: number; size: number } | null;
};
export type WorldStageProps = {
  frame: WorldStageFrame | null;
  spikes: Uint16Array | null;
  status: "connecting" | "live" | "offline" | "stale";
  arena: number;
  selectedFood?: WorldPoint | null;
  onSelectFood?: (point: WorldPoint) => void;
  disabled?: boolean;
};
const WholeBrainView = dynamic(() => import("./WholeBrainView"), {
  ssr: false,
  loading: () => <div className={styles.placeholder} role="status">Loading brain…</div>,
});

export default function WorldStage({ frame, spikes, status }: WorldStageProps) {
  return <div className={styles.stage}>
    <div className={styles.brainPane}>
      <WholeBrainView spikes={spikes} active={status === "live"} />
    </div>
    <div className={styles.caption}>
      <span>Whole brain</span>
      <span>{!frame ? "Waiting for data" : status === "live" ? "Live stream" : "Last received state"}</span>
    </div>
  </div>;
}
