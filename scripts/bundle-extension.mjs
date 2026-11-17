// One-time build helper: copies the compiled core (dist/src) into the
// VS Code extension as .mjs files so a CommonJS extension host can load
// it with dynamic import. Run from the hazma root:  node scripts\bundle-extension.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const srcDir = join(root, "dist", "src");
const outDir = join(root, "vscode-hazma", "core");

function walk(dir, rel = "") {
  const entries = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) entries.push(...walk(p, rel ? rel + "/" + e : e));
    else entries.push({ p, rel: rel ? rel + "/" + e : e });
  }
  return entries;
}

const files = walk(srcDir);
let count = 0;
for (const f of files) {
  if (!f.rel.endsWith(".js")) continue;
  const outRel = f.rel.replace(/\.js$/, ".mjs");
  const outPath = join(outDir, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  const text = readFileSync(f.p, "utf8");
  // rewrite relative "./x.js" imports to "./x.mjs"
  const rewritten = text.replace(
    /(from\s+)(["'])(\.[^"']*?)\.js\2/g,
    (m, from, q, spec) => `${from}${q}${spec}.mjs${q}`,
  );
  writeFileSync(outPath, rewritten);
  count++;
  // copy declaration files too for a nicer editor experience
  const dts = f.rel.replace(/\.js$/, ".d.ts");
  try {
    copyFileSync(join(srcDir, dts), join(outDir, dts));
  } catch {}
}
console.log(`bundled ${count} core files into vscode-hazma/core`);
