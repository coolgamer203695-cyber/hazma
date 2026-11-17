import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDiagnostic } from "../src/errors.js";
import { runSource } from "./support.js";

describe("diagnostics", () => {
  it("suggests close variable names", () => {
    const r = runSource('save : name = "x"\nlog.out {\n    nmae\n}\n');
    assert.equal(r.ok, false);
    const d = r.diagnostics.find((x) => x.code === "H3011");
    assert.ok(d, JSON.stringify(r.diagnostics));
    assert.ok(d.help!.includes('did you mean "name"'), d.help);
  });

  it("renders file, line, column and a caret", () => {
    const source = 'save : age = 18\nlog.out {\n    agge\n}\n';
    const r = runSource(source);
    const d = r.diagnostics.find((x) => x.code === "H3011")!;
    const text = renderDiagnostic(source, "demo.hz", d);
    assert.ok(text.includes("demo.hz:3:5"), text);
    assert.ok(text.includes("unknown variable \"agge\""), text);
    assert.ok(text.includes("did you mean \"age\""), text);
  });

  it("points at runtime errors too", () => {
    const source = "log.out { 1 / 0 }\n";
    const r = runSource(source);
    assert.equal(r.ok, false);
    const d = r.diagnostics[0];
    assert.equal(d.code, "H4031");
    assert.ok(d.span, "runtime errors carry a span");
    const text = renderDiagnostic(source, "demo.hz", d);
    assert.ok(text.includes("runtime error[H4031]"), text);
  });

  it("reports multiple compiler problems at once", () => {
    const r = runSource("log.out {\n    ghost1\n}\nlog.out {\n    ghost2\n}\n");
    const codes = r.diagnostics.map((d) => d.code);
    assert.ok(codes.filter((c) => c === "H3011").length === 2, JSON.stringify(codes));
  });
});
