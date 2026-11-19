import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenize } from "../src/lexer/lexer.js";
import { HazmaError } from "../src/errors.js";
import { runSource } from "./support.js";

function kinds(src: string): string[] {
  return tokenize(src).map((t) => t.kind);
}

function texts(src: string): string[] {
  return tokenize(src).map((t) => t.text);
}

describe("lexer", () => {
  it("produces tokens with kinds and keeps newlines", () => {
    const t = tokenize("save : age = 18\n");
    assert.deepEqual(
      t.map((x) => x.kind),
      ["ident", "punct", "ident", "punct", "number", "newline", "eof"],
    );
  });

  it("lexes dotted commands and names as single tokens", () => {
    assert.deepEqual(texts("log.out { is.ready }"), ["log.out", "{", "is.ready", "}", "\n", "<end of file>"]);
  });

  it("ignores a leading UTF-8 BOM", () => {
    assert.deepEqual(texts("\uFEFFsave : x = 1"), ["save", ":", "x", "=", "1", "\n", "<end of file>"]);
    const t = tokenize("\uFEFFsave : x = 1");
    assert.equal(t[0].line, 1);
    assert.equal(t[0].col, 1);
  });

  it("tracks 1-based line and column", () => {
    const t = tokenize("save : x = 1\nlog.out { x }");
    const logTok = t.find((x) => x.text === "log.out")!;
    assert.equal(logTok.line, 2);
    assert.equal(logTok.col, 1);
  });

  it("decodes string escapes", () => {
    const t = tokenize('"a\\n\\"b"')[0];
    assert.equal(t.kind, "string");
    assert.equal(t.value, 'a\n"b');
  });

  it("splits 2.2.r into a number and a .r operator", () => {
    assert.deepEqual(texts("2.2.r"), ["2.2", ".r", "\n", "<end of file>"]);
  });

  it("allows .r after parentheses", () => {
    assert.deepEqual(texts("(1 + 2).r"), ["(", "1", "+", "2", ")", ".r", "\n", "<end of file>"]);
  });

  it("skips // comments", () => {
    const r = runSource('// this is a note\nsave : x = 2 // trailing\nlog.out { x }\n');
    assert.deepEqual(r.output, ["2"]);
  });

  it("reports unterminated strings", () => {
    assert.throws(() => tokenize('"oops'), (e: HazmaError) => e.code === "H1002");
  });

  it("reports unknown characters", () => {
    assert.throws(() => tokenize("save : x = 1 #"), (e: HazmaError) => e.code === "H1001");
  });

  it("reports unknown escapes", () => {
    assert.throws(() => tokenize('"\\q"'), (e: HazmaError) => e.code === "H1004");
  });
});
