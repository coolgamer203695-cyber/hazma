import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("variables and output", () => {
  it("saves, changes and logs values", () => {
    expectOut(
      'save : age = 18\nchange : age = 20\nlog.out {\n    age\n}\n',
      ["20"],
    );
  });

  it("logs strings without quotes and booleans as true/false", () => {
    expectOut(
      'save : username = "Alex"\nsave : is.ready = true\nlog.out {\n    "Hello " + username\n}\nlog.out {\n    is.ready\n}\n',
      ["Hello Alex", "true"],
    );
  });

  it("keeps the type on change (string into number fails)", () => {
    expectDiag(
      'save : age = "18"\nchange : age = 20\n',
      "H3012",
    );
  });

  it("keeps the type on change (number into string fails)", () => {
    expectDiag(
      'save : age = 18\nchange : age = "20"\n',
      "H3012",
    );
  });

  it("t.change retypes a variable", () => {
    expectOut(
      'save : age = "18"\nt.change : age = 18\nlog.out {\n    age + 2\n}\n',
      ["20"],
    );
  });

  it("rounds with .r", () => {
    expectOut(
      "save : price = 2.2\nchange : price = price.r\nlog.out {\n    price\n}\n",
      ["2"],
    );
    expectOut(
      "log.out { 2.5.r }\nlog.out { 2.4.r }\nlog.out { (1.5 + 1.5).r }\n",
      ["3", "2", "3"],
    );
  });

  it("rounds negative halves toward positive infinity (Math.round)", () => {
    expectOut("log.out { (0 - 2.5).r }\n", ["-2"]);
  });

  it("rejects booleans without the is. naming", () => {
    expectDiag(
      "save : ready = true\n",
      "H3020",
      "is.",
    );
  });

  it("rejects is. names holding non-booleans", () => {
    expectDiag(
      'save : is.count = 5\n',
      "H3020",
    );
  });

  it("rejects .r on non-numbers", () => {
    expectDiag('save : name = "x"\nchange : name = name.r\n', "H3001");
  });

  it("re-executed save re-initializes the variable", () => {
    expectOut(
      "save : x = 0\nrepeat till x > 2 {\n    save : x = 5\n    log.out { x }\n}\n",
      ["5"],
    );
  });

  it("supports parentheses and arithmetic", () => {
    expectOut("log.out { (2 + 3) * 4 }\nlog.out { 10 - 3 - 2 }\nlog.out { 10 / 4 }\n", ["20", "5", "2.5"]);
  });

  it("rejects division by zero", () => {
    expectDiag("log.out { 1 / 0 }\n", "H4031");
  });

  it("rejects comparing strings with > at compile time", () => {
    expectDiag('if : "a" > "b" {\n    log.out { 1 }\n}\n', "H3006");
  });

  it("compares strings with == at runtime", () => {
    expectOut(
      'save : name = "Alex"\nif : name == "Alex" {\n    log.out { "same" }\n}\nelse : {\n    log.out { "different" }\n}\n',
      ["same"],
    );
  });
});
