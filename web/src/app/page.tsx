import Fly from "@/components/Fly";
import { CircuitSection, TokenSection, ProvenanceSection, VisionTeaser } from "@/components/Static";

export default function Home() {
  return (
    <main>
      <Fly />
      <CircuitSection />
      <VisionTeaser />
      <TokenSection />
      <ProvenanceSection />
    </main>
  );
}
