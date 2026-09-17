import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";

// the site's palette: bone text on black, one red
export const BLACK = "#050505";
export const BONE = "#efe9dc";
export const DIM = "rgba(239,233,220,0.55)";
export const RED = "#e8452c";

const serifNormal = loadSerif("normal", { weights: ["400"], subsets: ["latin"] });
loadSerif("italic", { weights: ["400"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

export const SERIF = serifNormal.fontFamily;
export const MONO = mono.fontFamily;

export const FPS = 30;
export const W = 1920;
export const H = 1080;
export const DURATION = 80 * FPS; // the score is 80.07 s
