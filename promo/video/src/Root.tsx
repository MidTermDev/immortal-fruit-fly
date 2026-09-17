import { Composition } from "remotion";
import { Promo } from "./Promo";
import { DURATION, FPS, H, W } from "./theme";

export const RemotionRoot: React.FC = () => {
  return <Composition id="Promo" component={Promo} durationInFrames={DURATION} fps={FPS} width={W} height={H} />;
};
