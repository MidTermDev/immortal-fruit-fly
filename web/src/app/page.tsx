import Fly from "@/components/Fly";
import { CircuitSection, ImmortalitySection, VisionSection, TokenSection, ProvenanceSection } from "@/components/Static";

export default function Home() {
  return (
    <main>
      <Fly />
      <CircuitSection />
      <ImmortalitySection />
      <VisionSection />
      <TokenSection />
      <ProvenanceSection />
    </main>
  );
}
