// HAZMA - public API.
//
// The compiler pipeline in one place:
//   tokenize -> parse -> analyze -> interpret
//
// This module is what the CLI, the automated tests and the VS Code
// extension all share.

import { HazmaError, type Diagnostic } from "./errors.js";
import { tokenize } from "./lexer/lexer.js";
import type { Token } from "./lexer/tokens.js";
import type { Program, Stmt } from "./ast/nodes.js";
import { Parser } from "./parser/parser.js";
import { Analyzer, type AnalysisResult } from "./semantic/analyzer.js";
import { Interpreter } from "./runtime/interpreter.js";

export { HazmaError, toDiagnostic, renderDiagnostic, renderDiagnostics } from "./errors.js";
export type { Diagnostic, Span } from "./errors.js";
export { tokenize } from "./lexer/lexer.js";
export type { Token } from "./lexer/tokens.js";
export { Parser } from "./parser/parser.js";
export { Analyzer } from "./semantic/analyzer.js";
export type { AnalysisResult, StructIR, FuncIR, Type } from "./semantic/analyzer.js";
export { Interpreter, StructInstance, ListValue, format } from "./runtime/interpreter.js";

export const VERSION = "0.2.0";

export function parse(source: string): Stmt[] {
  return new Parser(tokenize(source)).parseProgram();
}

/** Lex + parse + semantic analysis. Throws HazmaError on syntax errors. */
export function analyze(source: string): AnalysisResult {
  const stmts = parse(source);
  return new Analyzer().analyze({ stmts });
}

export interface RunOutcome {
  ok: boolean;
  /** compiler diagnostics (empty when ok) */
  diagnostics: Diagnostic[];
  /** lines produced by log.out */
  output: string[];
}

/** One-shot helper used by tests: compile and run, capturing output. */
export function runSource(source: string): RunOutcome {
  const output: string[] = [];
  try {
    const result = analyze(source);
    if (result.diagnostics.length > 0) {
      return { ok: false, diagnostics: result.diagnostics, output };
    }
    new Interpreter(result, { out: (line) => output.push(line) }).run();
    return { ok: true, diagnostics: [], output };
  } catch (e) {
    if (e instanceof HazmaError) {
      return {
        ok: false,
        diagnostics: [{ code: e.code, message: e.message, span: e.span, help: e.help }],
        output,
      };
    }
    throw e;
  }
}

export type { Program };
