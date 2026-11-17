import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Parser } from "../src/parser/parser.js";
import { tokenize } from "../src/lexer/lexer.js";
import { HazmaError } from "../src/errors.js";
import { runSource } from "./support.js";

function parse(src: string) {
  return new Parser(tokenize(src)).parseProgram();
}

describe("parser", () => {
  it("parses variables, conditions and output", () => {
    const stmts = parse('save : age = 18\nif : age >= 18 {\n    log.out { "x" }\n}\n');
    assert.deepEqual(stmts.map((s) => s.kind), ["save", "if"]);
  });

  it("builds else-if chains", () => {
    const stmts = parse(
      "if : a > 1 {\n    log.out { 1 }\n}\nelse if : a > 2 {\n    log.out { 2 }\n}\nelse : {\n    log.out { 3 }\n}\n",
    );
    const iff = stmts[0];
    assert.equal(iff.kind, "if");
    if (iff.kind === "if") {
      assert.equal(iff.branches.length, 2);
      assert.ok(iff.elseBody);
    }
  });

  it("extracts the till clause of a named repeat", () => {
    const stmts = parse("repeat : main {\n    till n > 3\n    log.out { n }\n}\n");
    assert.equal(stmts[0].kind, "repeat.named");
    if (stmts[0].kind === "repeat.named") {
      assert.equal(stmts[0].name, "main");
      assert.ok(stmts[0].cond);
    }
  });

  it("parses struct.base inheritance", () => {
    const stmts = parse(
      "struct : a {\n    x = 1\n}\nstruct.base : a {\n    struct : b {\n        y = 2\n    }\n}\n",
    );
    const base = stmts[1];
    assert.equal(base.kind, "struct");
    if (base.kind === "struct") {
      assert.equal(base.name, "b");
      assert.deepEqual(base.parents, ["a"]);
    }
  });

  it("rejects an unclosed block", () => {
    assert.throws(() => parse("if : x {\n    log.out { 1 }\n"), (e: HazmaError) => e.code === "H2040");
  });

  it("rejects two commands on one line", () => {
    assert.throws(
      () => parse('save : a = 1 save : b = 2\n'),
      (e: HazmaError) => e.code === "H2011",
    );
  });

  it("rejects unknown commands with a helpful list", () => {
    assert.throws(() => parse("frobnicate : 1\n"), (e: HazmaError) => e.code === "H2010");
  });

  it("rejects else without if", () => {
    assert.throws(() => parse("else : {\n    log.out { 1 }\n}\n"), (e: HazmaError) => e.code === "H2023");
  });

  it("rejects func.p after other commands", () => {
    assert.throws(
      () => parse("func : f {\n    log.out { 1 }\n    func.p : x\n}\n"),
      (e: HazmaError) => e.code === "H2031",
    );
  });

  it("rejects default in the middle of s.change", () => {
    assert.throws(
      () => parse("s.change : w {\n    default : {\n        log.out { 1 }\n    }\n    a = 1 {\n        log.out { 2 }\n    }\n}\n"),
      (e: HazmaError) => e.code === "H2026",
    );
  });

  it("rejects struct.c as a statement", () => {
    assert.throws(
      () => parse("struct.c : npc\n"),
      (e: HazmaError) => e.code === "H2034",
    );
  });

  it("runs the spec example conditions program", () => {
    const r = runSource('save : age = 15\nif : age >= 18 {\n    log.out {\n        "Adult"\n    }\n}\nelse if : age > 12 {\n    log.out {\n        "Teenager"\n    }\n}\nelse : {\n    log.out {\n        "Child"\n    }\n}\n');
    assert.deepEqual(r.output, ["Teenager"]);
  });
});
