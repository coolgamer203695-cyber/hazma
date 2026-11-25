// HAZMA - lexer / tokenizer.
//
// Turns HAZMA source text into a flat token stream. Newline tokens are kept
// because HAZMA statements are newline-separated (there are no semicolons).

import { HazmaError } from "../errors.js";
import type { Token } from "./tokens.js";

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentChar = (c: string) => isIdentStart(c) || isDigit(c);

/** Postfix math names that may follow a `.` directly after a value. */
const MATH_POSTFIX_NAMES = new Set(["abs", "sqrt", "floor", "ceil", "round", "pow"]);

/**
 * Turns the literal text between a `file.write`/`file.add` opening `{` and the
 * closing `}` line into the bytes written to disk.
 *
 * The rules (see DESIGN_DECISIONS D34): one leading and one trailing blank line
 * are dropped, the common indentation of the non-blank lines is removed, and
 * the result ends with exactly one newline. An empty block yields "".
 */
export function dedentRawBlock(text: string): string {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  let indent = Infinity;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const lead = /^[ \t]*/.exec(l)?.[0].length ?? 0;
    if (lead < indent) indent = lead;
  }
  if (!Number.isFinite(indent)) indent = 0;

  const out = lines.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
  if (out.length === 0) return "";
  return out.join("\n") + "\n";
}

export function tokenize(source: string): Token[] {
  // A UTF-8 BOM is common from Windows editors; it is not part of the source.
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  // Set when the last identifier was file.write / file.add; the next `{` on the
  // same line opens a raw text block instead of normal tokens.
  let rawMode: "file.write" | "file.add" | null = null;

  const err = (code: string, msg: string, eline = line, ecol = col, help?: string): never => {
    throw new HazmaError(
      code,
      msg,
      { start: { line, col }, end: { line: eline, col: ecol } },
      help,
    );
  };

  const push = (
    kind: Token["kind"],
    text: string,
    sl: number,
    sc: number,
    value?: number | string,
  ): void => {
    tokens.push({ kind, text, line: sl, col: sc, endLine: line, endCol: col, value });
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "\n") {
      push("newline", "\n", line, col);
      i++;
      line++;
      col = 1;
      rawMode = null;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      i++;
      col++;
      continue;
    }

    // line comment: // ... to end of line
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
        col++;
      }
      continue;
    }

    const sl = line;
    const sc = col;

    // number
    if (isDigit(c)) {
      let j = i;
      while (j < source.length && isDigit(source[j])) j++;
      if (source[j] === "." && isDigit(source[j + 1])) {
        j++;
        while (j < source.length && isDigit(source[j])) j++;
      }
      const text = source.slice(i, j);
      push("number", text, sl, sc, Number(text));
      col += j - i;
      i = j;
      continue;
    }

    // string
    if (c === '"') {
      i++;
      col++;
      let text = "";
      while (true) {
        if (i >= source.length || source[i] === "\n") {
          err("H1002", "unterminated string - missing closing \"", sl, sc, "close the string with a \" character");
        }
        const ch = source[i];
        if (ch === '"') {
          i++;
          col++;
          break;
        }
        if (ch === "\\") {
          const esc = source[i + 1];
          if (esc === "n") text += "\n";
          else if (esc === "t") text += "\t";
          else if (esc === '"') text += '"';
          else if (esc === "\\") text += "\\";
          else {
            err("H1004", `unknown escape sequence \\${esc ?? ""}`, line, col, "supported escapes are \\n \\t \\\" \\\\");
          }
          i += 2;
          col += 2;
          continue;
        }
        text += ch;
        i++;
        col++;
      }
      push("string", '"' + text + '"', sl, sc, text);
      continue;
    }

    // identifier (may contain dots: log.out, is.ready, alex.health)
    if (isIdentStart(c)) {
      let j = i;
      while (j < source.length) {
        if (isIdentChar(source[j])) {
          j++;
          continue;
        }
        if (source[j] === "." && isIdentStart(source[j + 1])) {
          j += 2;
          continue;
        }
        break;
      }
      const text = source.slice(i, j);
      push("ident", text, sl, sc);
      col += j - i;
      i = j;
      if (text === "file.write" || text === "file.add") rawMode = text;
      continue;
    }

    // postfix math directly after a number, a closing parenthesis or a closing
    // bracket:  2.2.r   (price + tax).r   2.pow(3)   25.sqrt   xs[1].abs
    const prev = tokens[tokens.length - 1];
    const afterValue =
      prev !== undefined &&
      (prev.kind === "number" ||
        prev.kind === "string" ||
        (prev.kind === "punct" &&
          (prev.text === ")" ||
            prev.text === "]" ||
            prev.text === "}" ||
            prev.text.startsWith("."))));
    if (c === "." && afterValue && isIdentStart(source[i + 1] ?? "")) {
      let j = i + 1;
      while (j < source.length && isIdentChar(source[j])) j++;
      const name = source.slice(i + 1, j);
      if (name === "r" && !isIdentChar(source[i + 2] ?? "")) {
        push("punct", ".r", sl, sc);
        i += 2;
        col += 2;
        continue;
      }
      if (MATH_POSTFIX_NAMES.has(name)) {
        push("punct", "." + name, sl, sc);
        col += j - i;
        i = j;
        continue;
      }
    }

    // Raw text block for file.write / file.add: `{` opens literal text that
    // runs until a line containing only `}`. Handled here because the text is
    // not tokenized (it may contain spaces, quotes, punctuation, anything).
    if (c === "{" && rawMode !== null) {
      push("punct", "{", sl, sc);
      i++;
      col++;
      const contentStart = i;
      const rawSL = line;
      const rawSC = col;

      // Locate the start of the line whose only non-space character is `}`.
      let j = i;
      let termStart = -1;
      while (j <= source.length) {
        let k = j;
        while (k < source.length && (source[k] === " " || source[k] === "\t" || source[k] === "\r")) k++;
        if (k < source.length && source[k] === "}") {
          let m = k + 1;
          while (m < source.length && (source[m] === " " || source[m] === "\t" || source[m] === "\r")) m++;
          if (m >= source.length || source[m] === "\n") {
            termStart = j;
            break;
          }
        }
        while (j < source.length && source[j] !== "\n") j++;
        if (j >= source.length) break;
        j++;
      }

      if (termStart < 0) {
        err(
          "H2040",
          "raw text block is not closed - missing a line with only }",
          sl,
          sc,
          "end the block with a line containing only }",
        );
      }

      const rawText = dedentRawBlock(source.slice(contentStart, termStart));
      // Advance line/col across the captured text; termStart begins a line.
      for (let p = contentStart; p < termStart; p++) {
        if (source[p] === "\n") {
          line++;
          col = 1;
        } else {
          col++;
        }
      }
      push("raw", rawText, rawSL, rawSC, rawText);
      i = termStart;
      rawMode = null;
      continue;
    }

    // punctuation (longest match first)
    const three = source.slice(i, i + 2);
    if (three === "==" || three === "!=" || three === ">=" || three === "<=") {
      push("punct", three, sl, sc);
      i += 2;
      col += 2;
      continue;
    }
    if (":=><+-*/,(){}[]".includes(c)) {
      push("punct", c, sl, sc);
      i++;
      col++;
      continue;
    }

    err("H1001", `unexpected character "${c}"`, line, col + 1, "remove this character");
  }

  // HAZMA statements are newline-terminated, so a source that does not end
  // with a newline still gets one virtual newline before the end of file.
  const last = tokens[tokens.length - 1];
  if (!last || last.kind !== "newline") {
    tokens.push({
      kind: "newline",
      text: "\n",
      line,
      col,
      endLine: line,
      endCol: col,
    });
  }

  tokens.push({
    kind: "eof",
    text: "<end of file>",
    line,
    col,
    endLine: line,
    endCol: col,
  });
  return tokens;
}
