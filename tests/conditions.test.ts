import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("conditions", () => {
  it("uses the full if / else if / else chain", () => {
    const src = (age: string) =>
      `save : age = ${age}\nif : age >= 18 {\n    log.out {\n        "Adult"\n    }\n}\nelse if : age > 12 {\n    log.out {\n        "Teenager"\n    }\n}\nelse : {\n    log.out {\n        "Child"\n    }\n}\n`;
    expectOut(src("18"), ["Adult"]);
    expectOut(src("15"), ["Teenager"]);
    expectOut(src("7"), ["Child"]);
  });

  it("supports and, or, not and parentheses", () => {
    const wrap = (cond: string) =>
      `save : is.a = true\nsave : is.b = false\nif : ${cond} {\n    log.out {\n        "yes"\n    }\n}\nelse : {\n    log.out {\n        "no"\n    }\n}\n`;
    expectOut(wrap("is.a and not is.b"), ["yes"]);
    expectOut(wrap("is.a and is.b"), ["no"]);
    expectOut(wrap("is.b or is.a"), ["yes"]);
    expectOut(wrap("not (is.a and is.b)"), ["yes"]);
  });

  it("gives and a higher precedence than or", () => {
    const wrap = (cond: string) =>
      `if : ${cond} {\n    log.out {\n        "yes"\n    }\n}\nelse : {\n    log.out {\n        "no"\n    }\n}\n`;
    // or(false, and(true, false)) = or(false, false) = false
    expectOut(wrap("false or true and false"), ["no"]);
    // and(true, or(false, true)) = true
    expectOut(wrap("true and (false or true)"), ["yes"]);
  });

  it("not applies to the whole comparison", () => {
    expectOut(
      "save : age = 20\nif : not age >= 18 {\n    log.out { \"minor\" }\n}\nelse : {\n    log.out { \"adult\" }\n}\n",
      ["adult"],
    );
  });

  it("rejects non-boolean conditions at compile time", () => {
    expectDiag(
      "save : age = 5\nif : age {\n    log.out { 1 }\n}\n",
      "H3015",
    );
  });

  it("rejects and/or with non-boolean sides", () => {
    expectDiag(
      "save : age = 5\nif : age and true {\n    log.out { 1 }\n}\n",
      "H3005",
    );
  });

  it("rejects a runtime condition that is not boolean", () => {
    expectDiag(
      'func : f {\n    func.p : v\n    func.r : v\n}\nsave : x = 1\nif : func.c : f { x } {\n    log.out { 1 }\n}\n',
      "H4033",
    );
  });
});
