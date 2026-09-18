# The v3 announcement video

An 80 s, 1920×1080, no-voice cut: flies playing DOOM and Minecraft, the brain firing, the pebbles, the CZ quote and the v3
economics, over an ominous score. The rendered file is `out/immortal_fly_v3.mp4` (not in git).

## Remake it

1. **Score** (inference.sh, ElevenLabs music, ~$0.15/min): `infsh app run elevenlabs/music@3bxnvf05 --input music_input.json`
   and save the mp3 as `music_ominous.mp3`.
2. **Footage** (headless Chromium with software WebGL, the Colony's RCON scripting the scene):
   `node shoot.mjs all` writes `rec/{day,night,nightcam,brain,colony}/*.webm`; `rec.mjs` records a single URL.
   DOOM comes from a session folder (`brain/doom_sessions/<id>/doom_fly.mp4`).
3. **Clips**: crop and cut with ffmpeg into `clips/` (`brain.mp4` 1920×722 panel crop, `colony.mp4` 1920×1026 panel crop,
   `day/night/nightcam.mp4` 1280×720, `doom_full.mp4` 1280×720, `doom_game*.mp4` 1920×1248 game crops).
4. **Composition** (Remotion, `video/`): `cd video && npm install`, copy the assets into `public/`
   (`clips/*.mp4` → `public/clips/`, `music_ominous.mp3` → `public/`, `brand/pebble_screens/*.png` → `public/screens/`,
   `brand/fly_transparent.png` → `public/fly.png`), preview with `npx remotion studio`, render with
   `npx remotion render Promo ../out/immortal_fly_v3.mp4 --codec h264 --crf 18` (about 2.5 min on 12 threads;
   the score is mixed in by Remotion).

The timeline lives in `video/src/Promo.tsx` (one `Sequence` per scene, frames at 30 fps); the typography, footage grading,
letterbox and the "closed tab" effect are in `video/src/ui.tsx`; colours and fonts in `video/src/theme.ts`.

## The feature tour (`Tour` composition, 97 s)

A second cut that walks the site: the brain live on the home page, minting, a fly's page (record, keep alive, hand to a body,
breed, watch it live, the on-chain core), the bodies (Colony, DOOM, pebbles), v3 economics, the hall of the species and the
browse grid, the link cards, the docs. Footage: `node tour.mjs all` records the real pages headlessly at 1920×1080 with a
drawn cursor, smooth scrolls and scripted clicks into `rec/tour_<name>/` (the pages take a few seconds to load, so read the
timestamps off a contact sheet before trimming); convert with ffmpeg into `video/public/tour/<name>.mp4`, copy the DOOM clip
and the link cards (`/api/og/<id>/`) there too, and the score (`music_tour_input.json` → `music_tour.mp3`) into `video/public/`.
The timeline is `video/src/Tour.tsx`, cut to the score's bars (118 bpm; drop at 20.4 s, break at 53, second drop at 61).
Render: `npx remotion render Tour ../out/immortal_fly_tour.mp4 --codec h264 --crf 18`.
