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

export function tokenize(source: string): Token[] {
  // A UTF-8 BOM is common from Windows editors; it is not part of the source.
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

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
      continue;
    }

    // postfix round ".r" directly after a number or a closing parenthesis:
    //   2.2.r    (price + tax).r
    const prev = tokens[tokens.length - 1];
    if (
      c === "." &&
      source[i + 1] === "r" &&
      !isIdentChar(source[i + 2] ?? "") &&
      prev &&
      (prev.kind === "number" || (prev.kind === "punct" && prev.text === ")"))
    ) {
      push("punct", ".r", sl, sc);
      i += 2;
      col += 2;
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
