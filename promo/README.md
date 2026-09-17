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
