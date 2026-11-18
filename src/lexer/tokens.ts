// HAZMA - token definitions.

export type TokKind = "number" | "string" | "ident" | "punct" | "newline" | "eof";

export interface Token {
  kind: TokKind;
  /** Raw text as it appeared in the source (for idents: the dotted name). */
  text: string;
  /** 1-based position of the first character. */
  line: number;
  col: number;
  /** 1-based position just after the last character. */
  endLine: number;
  endCol: number;
  /** Decoded value for numbers and strings. */
  value?: number | string;
}

export function tokSpan(t: Token) {
  return { start: { line: t.line, col: t.col }, end: { line: t.endLine, col: t.endCol } };
}

/** Words reserved by the language. They can never be variable or property names. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "save",
  "change",
  "t.change",
  "log",
  "if",
  "else",
  "s",
  "repeat",
  "func",
  "struct",
  "till",
  "default",
  "and",
  "or",
  "not",
  "true",
  "false",
  "const",
  "is",
]);

export const PUNCT_SYMBOLS = [":", "=", "==", "!=", ">=", "<=", ">", "<", "+", "-", "*", "/", ",", "(", ")", "{", "}", "[", "]"] as const;
