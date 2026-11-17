import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSource } from "../src/index.js";

export { assert, runSource };

/** The program must compile, run and log.out exactly these lines. */
export function expectOut(src: string, lines: string[]): void {
  const r = runSource(src);
  assert.equal(
    r.ok,
    true,
    "expected success, got: " + JSON.stringify(r.diagnostics, null, 2),
  );
  assert.deepEqual(r.output, lines);
}

/** The program must fail with the given error code (and message fragment). */
export function expectDiag(src: string, code: string, messagePart?: string): void {
  const r = runSource(src);
  assert.equal(r.ok, false, "expected a problem but the program ran: " + JSON.stringify(r.output));
  const hit = r.diagnostics.find(
    (d) => d.code === code && (messagePart === undefined || d.message.includes(messagePart)),
  );
  assert.ok(
    hit,
    `expected ${code}${messagePart ? ` with "${messagePart}"` : ""}, got: ` +
      JSON.stringify(r.diagnostics.map((d) => `[${d.code}] ${d.message}`)),
  );
}

/** Read an example program relative to the project root. */
export function example(name: string): string {
  return readFileSync(new URL(`../../examples/${name}`, import.meta.url), "utf8");
}
