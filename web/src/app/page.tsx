import LiveFly from "@/components/LiveFly";
import Fly from "@/components/Fly";
import { CircuitSection, MethodsSection, ContinuitySection, VisionSection, TokenSection, DataSection } from "@/components/Static";

export default function Home() {
  return (
    <main>
      <LiveFly />
      <Fly />
      <CircuitSection />
      <MethodsSection />
      <ContinuitySection />
      <VisionSection />
      <TokenSection />
      <DataSection />
    </main>
  );
}
