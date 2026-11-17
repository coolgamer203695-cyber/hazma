// HAZMA - errors and diagnostics.
// Every compiler/runtime problem becomes a Diagnostic with a code, message,
// source span and an optional help line.

export interface SourcePos {
  /** 1-based line number */
  line: number;
  /** 1-based column number (in UTF-16 code units, matching most editors) */
  col: number;
}

export interface Span {
  start: SourcePos;
  end: SourcePos;
}

export interface Diagnostic {
  code: string;
  message: string;
  span?: Span;
  help?: string;
}

/** Thrown by the lexer/parser for fail-fast problems, and by the runtime. */
export class HazmaError extends Error {
  code: string;
  span?: Span;
  help?: string;

  constructor(code: string, message: string, span?: Span, help?: string) {
    super(message);
    this.name = "HazmaError";
    this.code = code;
    this.span = span;
    this.help = help;
  }
}

export function toDiagnostic(e: HazmaError): Diagnostic {
  return { code: e.code, message: e.message, span: e.span, help: e.help };
}

/** Levenshtein distance used for "did you mean" hints. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Find the closest known name, for "did you mean" help lines. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // only suggest when the name is reasonably close
  if (best !== undefined && bestScore <= Math.max(2, Math.floor(name.length / 3))) return best;
  return undefined;
}

function pad(n: number, width: number): string {
  let s = String(n);
  while (s.length < width) s = " " + s;
  return s;
}

/** Render one diagnostic as a friendly compiler-style message with a source excerpt. */
export function renderDiagnostic(source: string, file: string, d: Diagnostic): string {
  const lines = source.split(/\r\n|\n|\r/);
  const out: string[] = [];
  const severity = d.code.startsWith("H4") ? "runtime error" : "error";
  out.push(`${severity}[${d.code}]: ${d.message}`);
  if (d.span) {
    const { line, col } = d.span.start;
    const endCol = d.span.end.col;
    out.push(`  --> ${file}:${line}:${col}`);
    const lineText = lines[line - 1] ?? "";
    const gutter = String(line).length;
    out.push("   " + " ".repeat(gutter) + " |");
    out.push(`${pad(line, gutter)} | ${lineText}`);
    const caretLen = Math.max(1, Math.min(endCol - col, Math.max(1, lineText.length - col + 1)));
    out.push(
      "   " + " ".repeat(gutter) + " | " + " ".repeat(Math.max(0, col - 1)) + "^".repeat(caretLen),
    );
  }
  if (d.help) out.push(`  help: ${d.help}`);
  return out.join("\n");
}

export function renderDiagnostics(source: string, file: string, diags: Diagnostic[]): string {
  return diags.map((d) => renderDiagnostic(source, file, d)).join("\n\n");
}
