import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("s.change selection", () => {
  it("runs the matching branch", () => {
    expectOut(
      'save : weapon = 1\ns.change : weapon {\n    sword = 1 {\n        log.out {\n            "Sword"\n        }\n    }\n\n    gun = 2 {\n        log.out {\n            "Gun"\n        }\n    }\n\n    default : {\n        log.out {\n            "Unknown weapon"\n        }\n    }\n}\n',
      ["Sword"],
    );
  });

  it("runs the first matching branch only", () => {
    expectOut(
      'save : x = 1\ns.change : x {\n    first = 1 {\n        log.out { "first" }\n    }\n    second = 1 {\n        log.out { "second" }\n    }\n    default : {\n        log.out { "none" }\n    }\n}\n',
      ["first"],
    );
  });

  it("falls back to default when nothing matches", () => {
    expectOut(
      'save : x = 9\ns.change : x {\n    a = 1 {\n        log.out { "a" }\n    }\n    default : {\n        log.out { "none" }\n    }\n}\n',
      ["none"],
    );
  });

  it("supports string subjects and nested selection", () => {
    expectOut(
      'save : kind = "magic"\ns.change : kind {\n    fire = "fire" {\n        log.out { "burn" }\n    }\n    ice = "cold" {\n        log.out { "freeze" }\n    }\n    default : {\n        s.change : kind {\n            other = "magic" {\n                log.out { "mystery" }\n            }\n            default : {\n                log.out { "plain" }\n            }\n        }\n    }\n}\n',
      ["mystery"],
    );
  });

  it("does nothing when nothing matches and there is no default", () => {
    expectOut(
      'save : x = 9\ns.change : x {\n    a = 1 {\n        log.out { "a" }\n    }\n}\nlog.out { "after" }\n',
      ["after"],
    );
  });

  it("requires branch values to be literals", () => {
    expectDiag(
      "save : x = 5\ns.change : x {\n    a = x {\n        log.out { 1 }\n    }\n}\n",
      "H3043",
    );
  });

  it("warns about subject and value type mismatches", () => {
    expectDiag(
      'save : x = 5\ns.change : x {\n    a = "five" {\n        log.out { 1 }\n    }\n}\n',
      "H3044",
    );
  });

  it("requires the subject to exist", () => {
    expectDiag(
      "s.change : nothing {\n    a = 1 {\n        log.out { 1 }\n    }\n}\n",
      "H3011",
    );
  });
});
