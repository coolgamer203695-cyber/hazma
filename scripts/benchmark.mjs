#!/usr/bin/env node
// HAZMA benchmark harness.
//
// Reports four separate numbers for one program, because they answer
// different questions:
//   1. compile time  - end to end `hazma build` including the C compiler
//   2. startup time  - a trivial program, i.e. process + runtime start
//   3. runtime       - the benchmark program itself, best of N runs
//   4. peak memory   - Windows only, via .NET Process.PeakWorkingSet64
//
// It deliberately does NOT compare against C/C++/Rust. Use the same harness
// shape and the same machine if you want that comparison, and report the four
// numbers separately.
//
//   node scripts/benchmark.mjs [file.hz] [--runs N] [--keep]
//
// Requires `npm run build` first (imports nothing, but the CLI needs dist/).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "bin", "hazma.js");

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 3) : 3;
const keep = args.includes("--keep");
const file = resolve(
  args.find((a, i) => !a.startsWith("--") && !(runsAt >= 0 && i === runsAt + 1)) ??
    join(root, "examples", "benchmark.hz"),
);

const dir = mkdtempSync(join(tmpdir(), "hazma-bench-"));
const exe = join(dir, "bench.exe");
const startupSrc = join(dir, "startup.hz");
const startupExe = join(dir, "startup.exe");
writeFileSync(startupSrc, 'log.out { "ok" }\n');

function ms(ns) {
  return Number(ns) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function build(source, out) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [cli, "build", source, "-o", out], {
    cwd: root,
    encoding: "utf8",
  });
  const elapsed = ms(process.hrtime.bigint() - t0);
  if (r.status !== 0) {
    console.error(`build failed for ${source}:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    process.exit(1);
  }
  return elapsed;
}

function runOnce(path) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(path, [], { encoding: "utf8" });
  const elapsed = ms(process.hrtime.bigint() - t0);
  if (r.status !== 0) {
    console.error(`run failed for ${path} (exit ${r.status}):\n${r.stderr ?? ""}`);
    process.exit(1);
  }
  return elapsed;
}

function peakMemoryMb(path) {
  if (process.platform !== "win32") return null;
  const escaped = path.replace(/'/g, "''");
  // PeakWorkingSet64 is only readable while the process object is live, so the
  // run is sampled every 50 ms and the highest observed peak is kept. This is a
  // sampled peak, not an exact high-water mark.
  const script = [
    `$p = Start-Process -FilePath '${escaped}' -NoNewWindow -PassThru`,
    "$max = 0",
    "while (-not $p.HasExited) {",
    "  try { $p.Refresh(); if ($p.PeakWorkingSet64 -gt $max) { $max = $p.PeakWorkingSet64 } } catch { }",
    "  Start-Sleep -Milliseconds 50",
    "}",
    '[Console]::WriteLine("peak=" + $max)',
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  // The program's own stdout is inherited, so the marker is the last line.
  const lines = (r.stdout ?? "").trim().split(/\r?\n/);
  const line = lines[lines.length - 1] ?? "";
  const match = /^peak=(\d+)$/.exec(line.trim());
  if (!match) return null;
  const bytes = Number(match[1]);
  return bytes > 0 ? bytes / (1024 * 1024) : null;
}

console.log(`HAZMA benchmark: ${file}`);
console.log(`machine: ${process.platform} ${process.arch}, node ${process.version}`);
console.log("");

const compileMs = build(file, exe);
const startupCompileMs = build(startupSrc, startupExe);

const startupRuns = [];
for (let i = 0; i < runs; i++) startupRuns.push(runOnce(startupExe));

const runtimeRuns = [];
for (let i = 0; i < runs; i++) runtimeRuns.push(runOnce(exe));

const memory = peakMemoryMb(exe);

console.log(`compile time      ${compileMs.toFixed(1)} ms   (build + C compile + link)`);
console.log(
  `startup time      ${Math.min(...startupRuns).toFixed(1)} ms   (best of ${runs}, trivial program)`,
);
console.log(
  `runtime           ${Math.min(...runtimeRuns).toFixed(1)} ms   (best of ${runs}, median ${median(runtimeRuns).toFixed(1)} ms)`,
);
console.log(
  `peak memory       ${memory === null ? "n/a (Windows only)" : memory.toFixed(1) + " MB   (sampled every 50 ms)"}`,
);
console.log("");
console.log("These are measurements of this program on this machine, not a claim");
console.log("that HAZMA is faster or slower than any other language.");

if (!keep) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
} else {
  console.log(`kept ${dir}`);
}
