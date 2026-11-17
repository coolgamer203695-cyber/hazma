// HAZMA - command line interface.
//
//   hazma run app.hz      compile and execute a program
//   hazma check app.hz    compile only, report problems
//   hazma ast app.hz      print the parsed syntax tree (debugging)
//   hazma new my-app      create a starter project
//   hazma version         print the version

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HazmaError, renderDiagnostic, renderDiagnostics } from "./errors.js";
import { tokenize } from "./lexer/lexer.js";
import { Parser } from "./parser/parser.js";
import { Analyzer } from "./semantic/analyzer.js";
import { Interpreter } from "./runtime/interpreter.js";

export const VERSION = "0.1.0";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readProgram(fileArg: string | undefined, cmd: string): { source: string; file: string } {
  if (!fileArg) fail(`hazma ${cmd}: provide a file, e.g. hazma ${cmd} app.hz`);
  const file = resolve(fileArg);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    fail(`hazma ${cmd}: cannot read "${fileArg}"`);
  }
  return { source, file };
}

/** Compile a source file to an executable analysis result. Throws HazmaError on syntax errors. */
export function compile(source: string, file: string) {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const stmts = parser.parseProgram();
  const analyzer = new Analyzer();
  return analyzer.analyze({ stmts });
}

export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help": {
      console.log(`HAZMA ${VERSION} - one language for the web

  hazma run app.hz      compile and execute a program
  hazma check app.hz    compile only, report problems
  hazma ast app.hz      print the parsed syntax tree
  hazma new my-app      create a starter project
  hazma version         print the version`);
      break;
    }

    case "version":
    case "--version": {
      console.log(`HAZMA ${VERSION}`);
      break;
    }

    case "run": {
      const { source, file } = readProgram(rest[0], "run");
      let result;
      try {
        result = compile(source, file);
      } catch (e) {
        if (e instanceof HazmaError) {
          console.error(renderDiagnostic(source, file, { code: e.code, message: e.message, span: e.span, help: e.help }));
          process.exit(1);
        }
        throw e;
      }
      if (result.diagnostics.length > 0) {
        console.error(renderDiagnostics(source, file, result.diagnostics));
        process.exit(1);
      }
      try {
        new Interpreter(result).run();
      } catch (e) {
        if (e instanceof HazmaError) {
          console.error(renderDiagnostic(source, file, { code: e.code, message: e.message, span: e.span, help: e.help }));
          process.exit(1);
        }
        throw e;
      }
      break;
    }

    case "check": {
      const { source, file } = readProgram(rest[0], "check");
      let result;
      try {
        result = compile(source, file);
      } catch (e) {
        if (e instanceof HazmaError) {
          console.error(renderDiagnostic(source, file, { code: e.code, message: e.message, span: e.span, help: e.help }));
          process.exit(1);
        }
        throw e;
      }
      if (result.diagnostics.length > 0) {
        console.error(renderDiagnostics(source, file, result.diagnostics));
        process.exit(1);
      }
      console.log(`no problems found in ${file}`);
      break;
    }

    case "ast": {
      const { source, file } = readProgram(rest[0], "ast");
      let stmts;
      try {
        stmts = new Parser(tokenize(source)).parseProgram();
      } catch (e) {
        if (e instanceof HazmaError) {
          console.error(renderDiagnostic(source, file, { code: e.code, message: e.message, span: e.span, help: e.help }));
          process.exit(1);
        }
        throw e;
      }
      console.log(stmts.map((s) => dump(s, 0)).join("\n"));
      break;
    }

    case "new": {
      const dir = rest[0];
      if (!dir) fail("hazma new: provide a project name, e.g. hazma new my-app");
      const target = resolve(dir);
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "app.hz"),
        `// ${dir} - a HAZMA program
save : is.running = true
save : visits = 0

repeat till visits > 2 {
    log.out {
        "visit number " + visits
    }

    change : visits = visits + 1
}

log.out {
    "done!"
}
`,
      );
      console.log(`created ${join(target, "app.hz")}`);
      console.log(`run it with: hazma run ${join(target, "app.hz")}`);
      break;
    }

    default:
      fail(`unknown command "${cmd}" - try hazma help`);
  }
}

// ---------------------------------------------------------------------------
// AST dump (hazma ast)
// ---------------------------------------------------------------------------

function dump(node: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(node)) {
    return node.map((n) => dump(n, indent)).join("\n");
  }
  if (node === null || typeof node !== "object") {
    return pad + String(node);
  }
  const obj = node as Record<string, unknown>;
  const span = obj.span as { start: { line: number }; end: { line: number } } | undefined;
  const at = span ? `  [line ${span.start.line}]` : "";
  if (typeof obj.kind === "string") {
    const simpleKeys: string[] = [];
    const childKeys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === "span") continue;
      const isSimple =
        v === null ||
        ["string", "number", "boolean"].includes(typeof v) ||
        (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));
      if (isSimple) simpleKeys.push(`${k}=${JSON.stringify(v)}`);
      else childKeys.push(k);
    }
    let out = pad + obj.kind + (simpleKeys.length ? ` ${simpleKeys.join(" ")}` : "") + at;
    for (const k of childKeys) {
      const v = obj[k];
      if (Array.isArray(v)) {
        out += `\n${pad}  ${k}:`;
        out += "\n" + dump(v, indent + 2);
      } else if (v && typeof v === "object") {
        out += `\n${pad}  ${k}:`;
        out += "\n" + dump(v, indent + 2);
      }
    }
    return out;
  }
  return pad + JSON.stringify(obj);
}

// keep node imports used
void dirname;
