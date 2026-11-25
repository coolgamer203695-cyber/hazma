// Math: postfix operators on numbers and the math.* helpers.
import { describe, it } from "node:test";
import { expectDiag, expectOut } from "./support.js";

describe("postfix math", () => {
  it("takes the absolute value, including a leading minus", () => {
    expectOut("log.out { -15.abs }", ["15"]);
    expectOut("save : x = -7\nlog.out { x.abs }", ["7"]);
  });

  it("takes square roots", () => {
    expectOut("log.out { 25.sqrt }", ["5"]);
    expectOut("log.out { 0.sqrt }", ["0"]);
  });

  it("floors, ceils and rounds", () => {
    expectOut("log.out { 2.9.floor }", ["2"]);
    expectOut("log.out { -2.1.floor }", ["-3"]);
    expectOut("log.out { 2.1.ceil }", ["3"]);
    expectOut("log.out { -2.1.ceil }", ["-2"]);
    expectOut("log.out { 2.5.round }", ["3"]);
    expectOut("log.out { 2.4.round }", ["2"]);
  });

  it("raises to a power with .pow(...)", () => {
    expectOut("log.out { 2.pow(3) }", ["8"]);
    expectOut("log.out { 2.pow(0) }", ["1"]);
    expectOut("save : n = 3\nlog.out { n.pow(2) }", ["9"]);
    expectOut("log.out { (1 + 1).pow(3) }", ["8"]);
  });

  it("chains postfix operators left to right", () => {
    expectOut("log.out { 2.pow(3).abs }", ["8"]);
    expectOut("log.out { 25.sqrt.floor }", ["5"]);
  });

  it("binds postfix math looser than a leading minus", () => {
    // The minus belongs to the value, so this is round(-2.5) = -2.
    expectOut("log.out { -2.5.r }", ["-2"]);
    expectOut("save : p = 2.5\nlog.out { -p.r }", ["-2"]);
    // (-2)^2 is 4, not -(2^2).
    expectOut("log.out { -2.pow(2) }", ["4"]);
    expectOut("save : x = 2\nlog.out { -x.pow(2) }", ["4"]);
    expectOut("log.out { -2.pow(3) }", ["-8"]);
    expectOut("log.out { -(-15).abs }", ["15"]);
  });

  it("works on list elements and parenthesised values", () => {
    expectOut("save : xs = {-3, 4}\nlog.out { xs[1].abs }", ["3"]);
    expectOut("save : a = 2.2\nsave : b = 0.9\nlog.out { (a + b).floor }", ["3"]);
  });

  it("keeps ordinary arithmetic and unary minus intact", () => {
    expectOut("log.out { 2 * -3 }", ["-6"]);
    expectOut("log.out { -2 * 3 }", ["-6"]);
    expectOut("log.out { 2 - 3 }", ["-1"]);
    expectOut("log.out { -(2 + 3) }", ["-5"]);
    expectOut("log.out { --2 }", ["2"]);
  });
});

describe("math helpers", () => {
  it("returns the smaller and larger of two or more numbers", () => {
    expectOut("log.out { math.min(3, 5) }", ["3"]);
    expectOut("log.out { math.max(3, 5) }", ["5"]);
    expectOut("log.out { math.min(4, 2, 9) }", ["2"]);
    expectOut("log.out { math.max(4, 2, 9) }", ["9"]);
  });

  it("clamps a number into a range", () => {
    expectOut("log.out { math.clamp(150, 0, 100) }", ["100"]);
    expectOut("log.out { math.clamp(-5, 0, 100) }", ["0"]);
    expectOut("log.out { math.clamp(50, 0, 100) }", ["50"]);
  });

  it("measures angles in degrees", () => {
    expectOut("log.out { math.sin(0) }", ["0"]);
    expectOut("log.out { math.sin(90) }", ["1"]);
    expectOut("log.out { math.cos(0) }", ["1"]);
    expectOut("log.out { math.cos(180) }", ["-1"]);
    expectOut("log.out { math.tan(0) }", ["0"]);
    // 30 and 45 degrees are not exact in binary floating point, so check a window.
    expectOut(
      [
        "save : sinv = math.sin(30)",
        "save : cosv = math.cos(60)",
        "save : tanv = math.tan(45)",
        "if : sinv > 0.49 and sinv < 0.51 and cosv > 0.49 and cosv < 0.51 and tanv > 0.99 and tanv < 1.01 {",
        '    log.out { "trig" }',
        "}",
      ].join("\n"),
      ["trig"],
    );
  });

  it("exposes pi and e", () => {
    expectOut("log.out { math.pi }", ["3.141592653589793"]);
    expectOut("log.out { math.e }", ["2.718281828459045"]);
  });

  it("picks a whole number inside the random range", () => {
    expectOut("log.out { math.random(1, 1) }", ["1"]);
    expectOut("log.out { math.random(4, 4) }", ["4"]);
    // Several draws must be whole numbers in 1..6.
    expectOut(
      [
        "save : a = math.random(1, 6)",
        "save : b = math.random(1, 6)",
        "save : c = math.random(1, 6)",
        "if : a >= 1 and a <= 6 and b >= 1 and b <= 6 and c >= 1 and c <= 6 and a == a.round and b == b.round and c == c.round {",
        '    log.out { "in range" }',
        "}",
      ].join("\n"),
      ["in range"],
    );
  });

  it("rejects a random range where the first number is larger", () => {
    expectDiag("log.out { math.random(6, 1) }", "H4066");
  });
});

describe("math errors", () => {
  it("rejects postfix math on non-numbers", () => {
    expectDiag('log.out { "hi".abs }', "H3067", "abs");
    expectDiag("save : is.ready = true\nlog.out { is.ready.floor }", "H3067", "floor");
    expectDiag("save : xs = {1, 2}\nlog.out { xs.sqrt }", "H3067", "sqrt");
  });

  it("rejects non-number helper arguments", () => {
    expectDiag('log.out { math.min("a", 1) }', "H3067", "math.min");
    expectDiag("log.out { math.clamp(1, true, 3) }", "H3067", "math.clamp");
  });

  it("checks argument counts", () => {
    expectDiag("log.out { math.random(1) }", "H3046", "math.random");
    expectDiag("log.out { math.min(1) }", "H3046", "math.min");
    expectDiag("log.out { math.sin(1, 2) }", "H3046", "math.sin");
    expectDiag("log.out { math.clamp(1, 2) }", "H3046", "math.clamp");
    expectDiag("log.out { 2.pow(1, 2) }", "H3046", "math.pow");
  });

  it("reports unknown math helpers", () => {
    expectDiag("log.out { math.bogus(1) }", "H2010", "math.bogus");
  });

  it("needs parentheses around .pow arguments", () => {
    expectDiag("log.out { 2.pow }", "H2002", "pow");
  });

  it("fails at runtime when the value turns out not to be a number", () => {
    expectDiag(
      'func : weird {\n    func.p : flag\n    if : flag {\n        func.r : 5\n    }\n    func.r : "text"\n}\nlog.out { func.c : weird {\n    false\n}.abs }',
      "H4065",
      ".abs",
    );
  });
});
