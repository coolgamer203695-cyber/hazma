import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("functions", () => {
  it("declares, calls and prints", () => {
    expectOut(
      'func : welcome {\n    func.p : name\n\n    log.out {\n        "Welcome " + name\n    }\n}\nfunc.c : welcome {\n    "Alex"\n}\n',
      ["Welcome Alex"],
    );
  });

  it("passes arguments positionally and by name", () => {
    expectOut(
      'func : show {\n    func.p : a\n    func.p : b\n    log.out {\n        a + "-" + b\n    }\n}\nfunc.c : show {\n    "1"\n    "2"\n}\nfunc.c : show {\n    b = "9"\n    a = "8"\n}\n',
      ["1-2", "8-9"],
    );
  });

  it("supports default parameter values", () => {
    expectOut(
      'func : welcome {\n    func.p : name = "Guest"\n\n    log.out {\n        "Welcome " + name\n    }\n}\nfunc.c : welcome {\n    "Alex"\n}\nfunc.c : welcome {\n}\n',
      ["Welcome Alex", "Welcome Guest"],
    );
  });

  it("returns values and infers the return type", () => {
    expectOut(
      "func : add {\n    func.p : num1\n    func.p : num2\n\n    func.r : num1 + num2\n}\nsave : total = func.c : add {\n    2\n    3\n}\nlog.out {\n    total\n}\n",
      ["5"],
    );
  });

  it("feeds inferred return types into later checks", () => {
    // greet returns a string, so changing the variable to a number is an error
    expectDiag(
      'func : greet {\n    func.r : "hi"\n}\nsave : x = func.c : greet {\n}\nchange : x = 5\n',
      "H3012",
    );
  });

  it("returns strings and concatenates", () => {
    expectOut(
      'func : greet {\n    func.p : name\n    func.r : "hey " + name\n}\nlog.out {\n    func.c : greet {\n        "Sam"\n    }\n}\n',
      ["hey Sam"],
    );
  });

  it("lets functions modify globals", () => {
    expectOut(
      "save : counter = 0\nfunc : bump {\n    change : counter = counter + 1\n}\nfunc.c : bump {\n}\nfunc.c : bump {\n}\nlog.out {\n    counter\n}\n",
      ["2"],
    );
  });

  it("keeps local variables local", () => {
    expectOut(
      'save : shared = "global"\nfunc : f {\n    save : local = "local"\n    log.out {\n        shared + " and " + local\n    }\n}\nfunc.c : f {\n}\n',
      ["global and local"],
    );
  });

  it("rejects recursive calls", () => {
    expectDiag(
      "func : loop {\n    func.c : loop {\n    }\n}\n",
      "H3057",
    );
    expectDiag(
      "func : a {\n    func.c : b {\n    }\n}\nfunc : b {\n    func.c : a {\n    }\n}\n",
      "H3057",
    );
  });

  it("rejects locals with the same name as globals", () => {
    expectDiag(
      'save : name = "global"\nfunc : f {\n    save : name = "local"\n}\n',
      "H3007",
    );
  });

  it("rejects parameters with the same name as globals", () => {
    expectDiag(
      'save : name = "global"\nfunc : f {\n    func.p : name\n}\n',
      "H3007",
    );
  });

  it("rejects mixed positional and named arguments", () => {
    expectDiag(
      'func : f {\n    func.p : a\n    func.p : b\n}\nfunc.c : f {\n    1\n    b = 2\n}\n',
      "H3045",
    );
  });

  it("rejects missing arguments", () => {
    expectDiag(
      "func : f {\n    func.p : a\n}\nfunc.c : f {\n}\n",
      "H3047",
    );
  });

  it("rejects unknown named arguments", () => {
    expectDiag(
      "func : f {\n    func.p : a\n}\nfunc.c : f {\n    wrong = 1\n}\n",
      "H3049",
    );
  });

  it("rejects too many positional arguments", () => {
    expectDiag(
      "func : f {\n    func.p : a\n}\nfunc.c : f {\n    1\n    2\n}\n",
      "H3046",
    );
  });

  it("rejects unknown functions", () => {
    expectDiag(
      'func.c : ghost {\n    1\n}\n',
      "H3030",
    );
  });

  it("rejects void calls used as values", () => {
    expectDiag(
      "func : f {\n    log.out { 1 }\n}\nsave : x = func.c : f {\n}\n",
      "H3031",
    );
  });

  it("rejects nested function declarations", () => {
    expectDiag(
      "if : true {\n    func : f {\n        func.r : 1\n    }\n}\n",
      "H3053",
    );
  });

  it("rejects func.r outside a function", () => {
    expectDiag("func.r : 5\n", "H3054");
  });

  it("rejects func.p outside a function", () => {
    expectDiag("func.p : x\n", "H3056");
  });

  it("rejects calls with unknown variables in arguments", () => {
    expectDiag(
      "func : f {\n    func.p : a\n}\nfunc.c : f {\n    nope\n}\n",
      "H3011",
    );
  });
});
