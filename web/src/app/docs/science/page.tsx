import type { Metadata } from "next";
import DocsShell from "@/components/DocsShell";
export const metadata: Metadata = { title: "Science & sources" };

export default function Page() {
  return (
    <DocsShell current="/docs/science/">
      <h1>Science &amp; sources</h1>
      <p className="lede">The papers, datasets and tools behind the fly.</p>
      <h2>Datasets</h2>
      <ul>
        <li><strong>FlyWire v783</strong> (adult female brain, 139,255 neurons, ~50M synapses). Dorkenwald et al., <em>Neuronal wiring diagram of an adult brain</em>, Nature 2024. Schlegel et al., <em>Whole-brain annotation and multi-connectome cell typing of Drosophila</em>, Nature 2024. Connectivity data: <a href="https://doi.org/10.5281/zenodo.10676866">doi:10.5281/zenodo.10676866</a>. Annotations: <a href="https://github.com/flyconnectome/flywire_annotations">flyconnectome/flywire_annotations</a>. Explorer: <a href="https://codex.flywire.ai">codex.flywire.ai</a>.</li>
        <li><strong>MaleCNS v1.0</strong> (adult male brain + nerve cord, 166,700 neurons, 11,710 cell types). Berg et al., Cell 2026, doi:10.1016/j.cell.2026.08.015. Data: <a href="https://male-cns.janelia.org/">male-cns.janelia.org</a>.</li>
      </ul>
      <h2>The head-direction circuit</h2>
      <ul>
        <li>Seelig &amp; Jayaraman 2015, <em>Neural dynamics for landmark orientation and angular path integration</em>, Nature.</li>
        <li>Kim, Rouault, Druckmann, Jayaraman 2017, <em>Ring attractor dynamics in the Drosophila central brain</em>, Science.</li>
        <li>Turner-Evans et al. 2017, <em>Angular velocity integration in a fly heading circuit</em>, eLife.</li>
        <li>Green et al. 2017, <em>A neural circuit architecture for angular integration in Drosophila</em>, Nature.</li>
        <li>Hulse et al. 2021, <em>A connectome of the Drosophila central complex</em>, eLife.</li>
        <li>Pisokas, Heinze, Webb 2020, <em>The head direction circuit of two insect species</em>, eLife.</li>
      </ul>
      <h2>Whole-brain simulation</h2>
      <ul>
        <li>Shiu et al. 2024, <em>A Drosophila computational brain model reveals sensorimotor processing</em>, Nature. LIF: rest/reset −52 mV, threshold −45 mV, τm 20 ms, τsyn 5 ms, refractory 2.2 ms, delay 1.8 ms, 0.275 mV per synapse. <a href="https://github.com/philshiu/Drosophila_brain_model">code</a>.</li>
        <li>Lappalainen et al. 2024, <em>Connectome-constrained networks predict neural activity across the fly visual system</em>, Nature (flyvis).</li>
        <li>Wang-Chen et al. 2024, NeuroMechFly v2, Nature Methods.</li>
      </ul>
      <h2>Circuits on the roadmap</h2>
      <ul>
        <li>Escape: von Reyn et al. 2014 (Nat Neurosci), 2017 (Neuron); Ache et al. 2019 (Curr Biol); Dombrovski et al. 2023 (Nature); Phelan et al. 2008 (rectifying gap junctions).</li>
        <li>Steering and descending neurons: Rayshubskiy et al. 2025 (eLife, DNa02); Braun et al. 2024 (Nature, DN–DN networks); Bidaye et al. 2014 (MDN), 2020 (DNp09); Cheong et al. 2024 (MANC DN→MN).</li>
        <li>Learning: Aso et al. 2014 (eLife), Hige et al. 2015 (Neuron), Li et al. 2020 (eLife, hemibrain mushroom body).</li>
      </ul>
      <h2>Tools used to build the fly</h2>
      <ul><li>pandas, pyarrow, numpy for the 852 MB connections table and 9.5 GB synapse table.</li><li>Foundry (forge 1.4) for contracts and the mainnet replay test.</li><li>three.js for the 44,716-point brain; ethers v6 for the chain; Next.js for this site.</li></ul>
    </DocsShell>
  );
}
