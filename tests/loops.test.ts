import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("loops", () => {
  it("runs the body before checking the condition (do-until)", () => {
    expectOut(
      "save : is.done = true\nrepeat till is.done {\n    log.out { \"ran\" }\n}\n",
      ["ran"],
    );
  });

  it("counts from 0 to 10 like the spec example", () => {
    expectOut(
      "save : number = 0\nrepeat till number > 4 {\n    log.out {\n        number\n    }\n\n    change : number = number + 1\n}\n",
      ["0", "1", "2", "3", "4"],
    );
  });

  it("supports named repeats with till inside the block", () => {
    expectOut(
      "save : number = 0\nrepeat : main {\n    till number > 3\n    log.out {\n        number\n    }\n\n    change : number = number + 1\n}\n",
      ["0", "1", "2", "3"],
    );
  });

  it("pauses with repeat.break and continues after the loop", () => {
    expectOut(
      'save : i = 0\nrepeat : main {\n    till i > 5\n    log.out { "pass " + i }\n    change : i = i + 1\n    repeat.break : main\n}\nlog.out { "after" }\n',
      ["pass 0", "after"],
    );
  });

  it("resumes a paused repeat from where it stopped", () => {
    expectOut(
      'save : i = 0\nrepeat : main {\n    till i > 3\n    log.out { "pass " + i }\n    change : i = i + 1\n    repeat.break : main\n}\nlog.out { "paused" }\nrepeat.continue : main\nlog.out { "end" }\n',
      ["pass 0", "paused", "pass 1", "end"],
    );
  });

  it("restarts with repeat.new and resets referenced variables", () => {
    expectOut(
      'save : score = 0\nrepeat : game {\n    till score > 1\n    log.out { "round " + score }\n    change : score = score + 1\n    repeat.break : game\n}\nrepeat.new : game\nlog.out { "first restart at " + score }\nrepeat.new : game\nlog.out { "second restart at " + score }\n',
      ["round 0", "round 0", "first restart at 1", "round 0", "second restart at 1"],
    );
  });

  it("freezes nested repeats when the outer repeat pauses, and resumes them", () => {
    expectOut(
      'save : outer = 0\nsave : inner = 0\nrepeat : main {\n    till outer > 1\n    log.out { "outer " + outer }\n    change : outer = outer + 1\n    repeat till inner > 2 {\n        log.out { "inner " + inner }\n        change : inner = inner + 1\n        repeat.break : main\n    }\n}\nlog.out { "paused" }\nrepeat.continue : main\nlog.out { "outer now " + outer + " inner now " + inner }\n',
      ["outer 0", "inner 0", "paused", "inner 1", "outer now 1 inner now 2"],
    );
  });

  it("pauses named repeats nested inside another named repeat", () => {
    expectOut(
      'save : a = 0\nrepeat : main {\n    till a > 1\n    log.out { "main " + a }\n    change : a = a + 1\n    repeat : sub {\n        till a > 0\n        log.out { "sub " + a }\n        change : a = a + 1\n        repeat.break : main\n    }\n}\nlog.out { "paused with a = " + a }\nrepeat.continue : main\nlog.out { "done with a = " + a }\n',
      ["main 0", "sub 1", "paused with a = 2", "done with a = 2"],
    );
  });

  it("resumes a global repeat from inside a function", () => {
    expectOut(
      'save : i = 0\nrepeat : main {\n    till i > 2\n    log.out { "step " + i }\n    change : i = i + 1\n    repeat.break : main\n}\nfunc : drive {\n    repeat till is.stop {\n        repeat.continue : main\n        change : is.stop = true\n    }\n}\nsave : is.stop = false\nfunc.c : drive {\n}\nlog.out { "final " + i }\n',
      ["step 0", "step 1", "final 2"],
    );
  });

  it("rejects repeat.break without an enclosing repeat", () => {
    expectDiag("repeat.break : main\n", "H3050");
  });

  it("rejects continue/new from inside the repeat itself", () => {
    expectDiag(
      "repeat : main {\n    till false\n    repeat.continue : main\n}\n",
      "H3051",
    );
    expectDiag(
      "repeat : main {\n    till false\n    repeat.new : main\n}\n",
      "H3051",
    );
  });

  it("rejects unknown continue targets", () => {
    expectDiag("repeat.continue : ghost\n", "H3052");
  });

  it("rejects two repeats with the same name", () => {
    expectDiag(
      "repeat : main {\n    till false\n}\nrepeat : main {\n    till false\n}\n",
      "H3021",
    );
  });

  it("rejects continuing a finished repeat", () => {
    expectDiag(
      "save : i = 0\nrepeat : main {\n    till i > 0\n    change : i = i + 1\n}\nrepeat.continue : main\n",
      "H4024",
    );
  });

  it("rejects restarting a running repeat from inside it", () => {
    // repeat.new inside the loop body is caught at compile time; check the code
    expectDiag(
      "repeat : main {\n    till false\n    repeat.new : main\n}\n",
      "H3051",
    );
  });
});
