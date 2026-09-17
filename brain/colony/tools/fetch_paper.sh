#!/usr/bin/env bash
# Downloads the Paper build the Colony runs into server/paper.jar (gitignored) using the fill v3 API,
# and verifies its sha256. Minecraft 1.21.4: the newest 1.21.x that both mineflayer 4.39 (tested) and
# prismarine-viewer 1.33 (textures + block states shipped) support.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(dirname "$HERE")/server"
MC_VERSION="${MC_VERSION:-1.21.4}"
UA="flybrain-colony/0.1 (https://www.immortalfly.app)"
mkdir -p "$SERVER"
builds="$(curl -fsSL -H "User-Agent: $UA" "https://fill.papermc.io/v3/projects/paper/versions/$MC_VERSION/builds")"
url="$(printf '%s' "$builds" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s)[0];const d=b.downloads["server:default"];console.log(d.url, d.checksums.sha256, b.id)})')"
set -- $url
echo "Paper $MC_VERSION build $3"
if [ -f "$SERVER/paper.jar" ] && [ "$(sha256sum "$SERVER/paper.jar" | cut -d' ' -f1)" = "$2" ]; then
  echo "server/paper.jar is already build $3"; exit 0
fi
curl -fsSL -H "User-Agent: $UA" -o "$SERVER/paper.jar.part" "$1"
echo "$2  $SERVER/paper.jar.part" | sha256sum -c -
mv "$SERVER/paper.jar.part" "$SERVER/paper.jar"
echo "wrote server/paper.jar"
