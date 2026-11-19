// HAZMA - copy the native runtime into dist so `hazma run`/`hazma build`
// can find it after `tsc` (tsc does not copy non-TS assets).
// Runs from the project root (npm run build).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename); // .../hazma/scripts
const root = dirname(__dirname); // .../hazma

const src = join(root, "src/backend/runtime/hazma_rt.c");
const out = join(root, "dist/src/backend/runtime/hazma_rt.c");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, readFileSync(src));
console.log(`copied ${src} -> ${out}`);
