import { Composition } from "remotion";
import { Promo } from "./Promo";
import { Tour, TOUR_DURATION } from "./Tour";
import { DURATION, FPS, H, W } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="Promo" component={Promo} durationInFrames={DURATION} fps={FPS} width={W} height={H} />
      <Composition id="Tour" component={Tour} durationInFrames={TOUR_DURATION} fps={FPS} width={W} height={H} />
    </>
  );
};
