// HAZMA - native compilation backend.
//
// Translates analyzed HAZMA source to C (via src/backend/cgen.ts), then
// compiles and links it with the native runtime (hazma_rt.c) using the host
// toolchain into a real native executable. MSVC on Windows is the first
// supported target; clang/gcc can be used through HAZMA_CC.
//
//   hazma build app.hz -o app.exe   compile only
//   hazma run app.hz                compile and execute natively
//   hazma run app.hz --emit-c       print the generated C instead of running
//
// Windows named-repeat semantics (pause/resume/restart) are implemented on
// top of Windows fibers, which preserve the whole C stack.

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HazmaError, renderDiagnostics, toDiagnostic } from "../errors.js";
import { tokenize } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { Analyzer } from "../semantic/analyzer.js";
import { generateC } from "./cgen.js";

/** Candidate vcvars64.bat locations, newest Visual Studio first. */
const MSVC_VCVARS = [
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\VC\\Auxiliary\\Build\\vcvars64.bat",
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat",
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat",
];

export interface NativeOptions {
  /** path of the source file being compiled */
  file: string;
  /** where to write the .exe (build) */
  out?: string;
  /** print generated C instead of compiling/running */
  emitC?: boolean;
  /** keep the temp C files after compiling */
  keep?: boolean;
  /** compile to `out` but do not execute it */
  compileOnly?: boolean;
}

interface Tool {
  kind: "msvc" | "cc";
  /** the compiler driver to invoke */
  exe: string;
  /** arguments to prepend before the output flag and source list */
  flags: string[];
  /** how to name the output: "/Fe:<out>" for msvc, ["-o", out] for cc */
  outputFlag(out: string): string[];
  /** MSVC only: the vcvars64.bat that puts cl.exe on PATH */
  vcvars?: string;
}

let detected: Tool | null = null;

const RUNTIME_C = join(fileURLToPath(dirname(import.meta.url)), "runtime/hazma_rt.c");

/** Optimization flags are configurable: HAZMA_OPT overrides the /O2 || -O2
 * default, for example HAZMA_OPT=/Od or HAZMA_OPT="-O0 -g". */
function optimizationFlags(msvc: boolean): string[] {
  const raw = process.env.HAZMA_OPT?.trim();
  if (raw) return raw.split(/\s+/).filter(Boolean);
  return [msvc ? "/O2" : "-O2"];
}

function detectTool(): Tool | null {
  if (detected) return detected;

  const envCC = process.env.HAZMA_CC;
  if (envCC) {
    // HAZMA_CC=<clang|gcc|cc> or a full path to a compiler driver.
    detected = {
      kind: "cc",
      exe: envCC,
      flags: ["-std=c11", ...optimizationFlags(false)],
      outputFlag: (out) => ["-o", out],
    };
    return detected;
  }

  // MSVC: cl must be run through vcvars64.bat (sets INCLUDE/LIB/PATH).
  const vcvars = MSVC_VCVARS.find((p) => existsSync(p));
  if (vcvars) {
    detected = {
      kind: "msvc",
      exe: "cl",
      flags: optimizationFlags(true),
      outputFlag: (out) => [`/Fe:${out}`],
      vcvars,
    };
    return detected;
  }

  detected = null;
  return null;
}

/** True when a usable C toolchain is present, so callers can skip gracefully. */
export function nativeAvailable(): boolean {
  return detectTool() !== null;
}

/** Compile `source.c` next to the copied `hazma_rt.c` into `out`. Throws a
 * HazmaError carrying the compiler output when the build fails. */
function compileC(
  sourceC: string,
  out: string,
  opts: { keep?: boolean; tool: Tool; tmpDir: string; file: string },
): void {
  const tool = opts.tool;
  const rtC = RUNTIME_C;
  if (!existsSync(rtC)) {
    throw new HazmaError(
      "H5000",
      `native runtime not found at ${rtC} (did you run the build step?)`,
    );
  }
  const rtCopy = join(opts.tmpDir, "hazma_rt.c");
  copyFileSync(rtC, rtCopy);

  const bat = join(opts.tmpDir, "build.bat");
  let lines: string[] = [];
  if (tool.kind === "msvc") {
    lines.push(`call "${tool.vcvars}" >nul`);
    const args = [
      tool.exe,
      "/nologo",
      ...tool.flags,
      ...tool.outputFlag(out),
      sourceC,
    ];
    lines.push(args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
  } else {
    const args = [tool.exe, ...tool.flags, ...tool.outputFlag(out), sourceC];
    lines.push(args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
  }
  writeFileSync(bat, lines.join("\r\n") + "\r\n");

  const result = spawnSync("cmd", ["/c", bat], {
    cwd: opts.tmpDir,
    encoding: "utf8",
    windowsHide: false,
  });
  if (result.status !== 0 || result.error) {
    const detail = [result.stdout, result.stderr]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join("\n")
      .trim();
    const why = result.error?.message ?? `compiler exited with code ${result.status}`;
    throw new HazmaError(
      "H5000",
      `native compilation failed while building "${opts.file}" (${why}):\n` +
        `${detail || "(the compiler produced no output)"}\n` +
        `generated C: ${sourceC}`,
      undefined,
      "install MSVC Build Tools, or set HAZMA_CC to a working C compiler; " +
        "hazma run --interpret needs no compiler",
    );
  }
}

/** Compile and run a native program, capturing its stdout. */
export function runNative(opts: NativeOptions): {
  ok: boolean;
  output: string[];
  diagnostics: never[];
  exitCode: number;
  stderr?: string;
} {
  const { source, file } = readSource(opts.file);
  let result;
  try {
    result = new Analyzer().analyze({
      stmts: new Parser(tokenize(source)).parseProgram(),
    });
  } catch (e) {
    if (e instanceof HazmaError) {
      return {
        ok: false,
        output: [],
        diagnostics: [],
        exitCode: 1,
        stderr: renderDiagnostics(source, file, [toDiagnostic(e)]),
      };
    }
    throw e;
  }
  if (result.diagnostics.length > 0) {
    return {
      ok: false,
      output: [],
      diagnostics: [],
      exitCode: 1,
      stderr: renderDiagnostics(source, file, result.diagnostics),
    };
  }

  const c = generateC(result, file);
  if (c.diagnostics.length > 0) {
    return {
      ok: false,
      output: [],
      diagnostics: [],
      exitCode: 1,
      stderr: renderDiagnostics(source, file, c.diagnostics),
    };
  }

  if (opts.emitC) {
    process.stdout.write(c.code);
    return { ok: true, output: [], diagnostics: [], exitCode: 0 };
  }

  const tool = detectTool();
  if (!tool) {
    return {
      ok: false,
      output: [],
      diagnostics: [],
      exitCode: 1,
      stderr:
        "error[H5000]: no native C compiler found - install MSVC Build Tools " +
        "or set HAZMA_CC (hazma run --interpret needs no compiler)",
    };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "hazma-"));
  const sourceC = join(tmpDir, "program.c");
  writeFileSync(sourceC, c.code);
  const dest = opts.out ? resolve(opts.out) : join(tmpDir, "program.exe");

  try {
    compileC(sourceC, dest, { keep: opts.keep, tool, tmpDir, file });
  } catch (e) {
    // Leave the generated C in the temp dir so the H5000 message can point at
    // a file the user can open and report.
    if (e instanceof HazmaError) {
      return {
        ok: false,
        output: [],
        diagnostics: [],
        exitCode: 1,
        stderr: renderDiagnostics(source, file, [toDiagnostic(e)]),
      };
    }
    throw e;
  }

  // `-o` / build: compile only, never execute the produced binary.
  if (opts.compileOnly) {
    if (!opts.keep) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, output: [], diagnostics: [], exitCode: 0 };
  }

  const run = spawnSync(dest, [], { encoding: "utf8", windowsHide: false });
  const output = splitOutput(run.stdout ?? "");

  if (!opts.keep) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    ok: run.status === 0 && !run.error,
    output,
    diagnostics: [],
    exitCode: run.status ?? 1,
    stderr: run.stderr ?? undefined,
  };
}

/** Compile only (hazma build). Produces `out` and returns diagnostics. */
export function buildNative(opts: NativeOptions): {
  ok: boolean;
  diagnostics: never[];
  exitCode: number;
  stderr?: string;
} {
  const run = runNative({ ...opts, compileOnly: true });
  return {
    ok: run.ok,
    diagnostics: [],
    exitCode: run.exitCode,
    stderr: run.stderr,
  };
}

/** Split process stdout into lines, keeping meaningful empty lines but
 * dropping the empty element after a trailing newline. */
function splitOutput(stdout: string): string[] {
  if (stdout === "") return [];
  const lines = stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readSource(file: string): { source: string; file: string } {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    throw new HazmaError("H2000", `cannot read "${file}"`);
  }
  return { source, file };
}
