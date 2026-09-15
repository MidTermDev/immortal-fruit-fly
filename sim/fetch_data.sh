#!/usr/bin/env bash
# Downloads the public FlyWire v783 data needed to rebuild the on-chain circuit table.
set -euo pipefail
cd "$(dirname "$0")/../data"
curl -L -o Supplemental_file1_neuron_annotations.tsv \
  https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv
curl -L -o proofread_connections_783.feather \
  "https://zenodo.org/api/records/10676866/files/proofread_connections_783.feather/content"
sha256sum proofread_connections_783.feather
