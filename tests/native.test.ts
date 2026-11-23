// Native backend tests. These compile real executables with MSVC (or the
// compiler named by HAZMA_CC) and run them, so they exercise code generation,
// the C runtime, fibers, lists and structures end to end.
//
// When no C toolchain is available the suite reports a skip instead of failing,
// because the interpreter suites still cover language semantics everywhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeAvailable, runNative } from "../src/backend/native.js";

const available = nativeAvailable();
const skip = available ? false : "no C toolchain (install MSVC Build Tools or set HAZMA_CC)";

let dir = "";
function tempDir(): string {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "hazma-test-"));
  return dir;
}

function write(name: string, source: string): string {
  const file = join(tempDir(), name);
  writeFileSync(file, source);
  return file;
}

function run(source: string, name = "test.hz") {
  return runNative({ file: write(name, source) });
}

describe("native backend", { skip }, () => {
  it("compiles and runs every example", () => {
    const expected: Record<string, string[]> = {
      "01_hello.hz": ["Hello HAZMA!", "Alex is 18", "ready: true"],
      "02_conditions.hz": ["Teenager", "Teen member", "Not an adult yet"],
      "03_loops.hz": [
        "tick 0",
        "tick 1",
        "tick 2",
        "tick 3",
        "power level 3",
        "paused with battery 2",
        "power level 2",
        "resumed with battery 1",
      ],
      "04_functions.hz": ["Welcome Alex", "Welcome Guest", "2 + 3 = 5"],
      "05_structs.hz": [
        "npc_structure{ id: 1, health: 50, strength: 10 }",
        "npc_structure{ id: 1, health: 100, strength: 5 }",
        "500 hp and 900 coins",
      ],
      "06_rpg.hz": [
        "Alex hits for 12 (target at 18)",
        "Goblin hits for 8 (target at 92)",
        "Alex hits for 12 (target at 6)",
        "Goblin hits for 8 (target at 84)",
        "Alex hits for 12 (target at -6)",
        "The goblin falls!",
        "Alex survived with 84 hp",
      ],
      "07_lists.hz": [
        "[Sword, Gun, Bow]",
        "3",
        "Sword",
        "true",
        "2",
        "false",
        "0",
        "[Sword, Gun, Bow, Shield, Dagger]",
        "[Sword, Rifle, Bow, Shield, Dagger]",
        "[Sword, Rifle, Shield, Dagger]",
        "[10, 30]",
        "1",
        "[Apple, Banana]",
        "0",
      ],
    };

    for (const [name, lines] of Object.entries(expected)) {
      const source = readFileSync(
        new URL(`../../examples/${name}`, import.meta.url),
        "utf8",
      );
      const r = run(source, name);
      assert.equal(r.ok, true, `${name}: ${r.stderr ?? ""}`);
      assert.deepEqual(r.output, lines, name);
    }
  });

  it("prints numbers like the interpreter", () => {
    const r = run(
      [
        'log.out { 1 }',
        'log.out { 1.5 }',
        'log.out { 0.1 + 0.2 }',
        'log.out { 1000000000000000000000 }',
        'log.out { 1 / 3 }',
        'log.out { -0.5 }',
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, [
      "1",
      "1.5",
      "0.30000000000000004",
      "1e+21",
      "0.3333333333333333",
      "-0.5",
    ]);
  });

  it("preserves empty output lines", () => {
    const r = run('log.out { "" }\nlog.out { "x" }\n');
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["", "x"]);
  });

  it("implements list commands natively", () => {
    const r = run(
      [
        "l.save : xs = {",
        "  1",
        "  2",
        "  3",
        "}",
        "l.add : xs { 4 }",
        "log.out { xs }",
        "log.out { l.count : xs }",
        "log.out { xs[1] }",
        "log.out { l.find : xs { 3 } }",
        "log.out { l.find.index : xs { 3 } }",
        "l.remove : xs { 2 }",
        "log.out { xs }",
        "l.change : xs {",
        "  1 = 9",
        "}",
        "log.out { xs }",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, [
      "[1, 2, 3, 4]",
      "4",
      "1",
      "true",
      "3",
      "[1, 3, 4]",
      "[9, 3, 4]",
    ]);
  });

  it("runs default and custom till conditions", () => {
    const r = run(
      [
        "save : n = 0",
        "repeat : once {",
        "  till true",
        "  log.out { n }",
        "  change : n = n + 1",
        "  repeat.break : once",
        "}",
        "repeat till n > 2 {",
        "  change : n = n + 1",
        "}",
        "log.out { n }",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["0", "3"]);
  });

  it("restarts a named repeat with repeat.new snapshots", () => {
    const r = run(
      [
        "save : hp = 10",
        "repeat : battle {",
        "  till hp < 1",
        "  log.out { \"hit \" + hp }",
        "  change : hp = hp - 3",
        "  repeat.break : battle",
        "}",
        "log.out { \"paused \" + hp }",
        "repeat.new : battle",
        "log.out { \"restored \" + hp }",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["hit 10", "paused 7", "hit 10", "restored 7"]);
  });

  it("snapshots a named repeat inside a function", () => {
    const r = run(
      [
        "func : f {",
        "  save : c = 0",
        "  repeat : inner {",
        "    till c > 1",
        '    log.out { "c " + c }',
        "    change : c = c + 1",
        "    repeat.break : inner",
        "  }",
        '  log.out { "paused " + c }',
        "  repeat.new : inner",
        '  log.out { "resumed " + c }',
        "}",
        "func.c : f {",
        "}",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["c 0", "paused 1", "c 0", "resumed 1"]);
  });

  it("supports nested named repeats", () => {
    const r = run(
      [
        "save : outer = 0",
        "repeat : a {",
        "  till outer > 0",
        "  change : outer = outer + 1",
        "  save : inner = 0",
        "  repeat : b {",
        "    till inner > 1",
        "    log.out { outer + \":\" + inner }",
        "    change : inner = inner + 1",
        "  }",
        "  repeat.break : a",
        "}",
        "log.out { \"done\" }",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["1:0", "1:1", "done"]);
  });

  it("supports the rest of the language natively", () => {
    const r = run(
      [
        'save : name = "Alex"',
        "save : is.ready = true",
        "save : age = 15",
        "",
        "if : age > 12 and is.ready {",
        '  log.out { name + " ok" }',
        "}",
        "else : {",
        '  log.out { "bad" }',
        "}",
        "",
        "t.change : name = 42",
        "log.out { name }",
        "log.out { 2.6.r }",
        "log.out { -2.5.r }",
        "",
        "s.change : age {",
        '  teen = 15 { log.out { "teen" } }',
        '  default : { log.out { "other" } }',
        "}",
        "",
        'log.out { "a\\tb" }',
        "log.out { not is.ready }",
        "log.out { (1 + 2) * 3 }",
        "",
        "l.save : grid = { { 1, 2 }, { 3, 4 } }",
        "log.out { grid }",
        "log.out { grid[2][1] }",
        "",
        "struct : bag_structure {",
        '  items = { "map" }',
        "}",
        "first = struct.c : bag_structure",
        "second = struct.c : bag_structure",
        "func : push {",
        "  func.p : xs",
        '  l.add : xs { "torch" }',
        "}",
        "func.c : push { first.items }",
        "log.out { first.items }",
        "log.out { second.items }",
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, [
      "Alex ok",
      "42",
      "3",
      "-3",
      "teen",
      "a\tb",
      "false",
      "9",
      "[[1, 2], [3, 4]]",
      "3",
      "[map, torch]",
      "[map]",
    ]);
  });

  it("resumes a global repeat from inside a function", () => {
    const r = run(
      [
        "save : i = 0",
        "repeat : g {",
        "  till i > 2",
        '  log.out { "tick " + i }',
        "  change : i = i + 1",
        "  repeat.break : g",
        "}",
        "func : again {",
        "  repeat.continue : g",
        "}",
        "func.c : again {",
        "}",
        'log.out { "after " + i }',
      ].join("\n"),
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["tick 0", "tick 1", "after 2"]);
  });

  it("exits non-zero on a runtime error", () => {
    const r = run("log.out { 1 / 0 }");
    assert.equal(r.ok, false);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr ?? "", /H4031/);
  });

  it("reports list removal of a missing value from the native runtime", () => {
    const r = run(
      [
        "l.save : xs = { 1, 2 }",
        "save : missing = 9",
        "l.remove : xs { missing }",
      ].join("\n"),
    );
    assert.equal(r.ok, false);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr ?? "", /runtime error\[H4063\]/);
    assert.match(r.stderr ?? "", /cannot be removed/);
  });

  it("rejects func.r inside a named repeat with H5001", () => {
    const r = run(
      [
        "func : f {",
        "  repeat : loop {",
        "    till true",
        "    func.r : 1",
        "  }",
        "}",
        "save : x = func.c : f {",
        "}",
      ].join("\n"),
    );
    assert.equal(r.ok, false);
    assert.match(r.stderr ?? "", /H5001/);
    assert.match(r.stderr ?? "", /func\.r inside repeat/);
  });

  it("implements file commands and check.error natively", () => {
    const dir = tempDir().replace(/\\/g, "/") + "/native-files";
    const r = run(
      [
        `folder.create : "${dir}"`,
        `file.create : "${dir}/a.txt"`,
        `file.write : "${dir}/a.txt" {`,
        "    Hello from HAZMA!",
        "}",
        `file.add : "${dir}/a.txt" {`,
        "    Another line!",
        "}",
        `save : content = file.read : "${dir}/a.txt"`,
        "log.out { content }",
        `log.out { file.exists : "${dir}/a.txt" }`,
        `save : missing = file.read : "${dir}/missing.txt"`,
        "check.error {",
        '    log.out { "caught" }',
        "}",
        "func : safe_read {",
        "    func.p : path",
        "    save : text = file.read : path",
        "    check.error {",
        '        func.r : "fallback"',
        "    }",
        "    func.r : text",
        "}",
        `log.out { func.c : safe_read { "${dir}/missing.txt" } }`,
        `folder.delete : "${dir}"`,
      ].join("\n"),
      "files.hz",
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, [
      "Hello from HAZMA!",
      "Another line!",
      "",
      "true",
      "caught",
      "fallback",
    ]);
  });

  it("check.error catches a runtime error natively", () => {
    const r = run(
      [
        "log.out { 1 / 0 }",
        "check.error {",
        '  log.out { "caught div" }',
        "}",
        'log.out { "after" }',
      ].join("\n"),
      "check-error.hz",
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["caught div", "after"]);
  });

  it("check.error leaves a successful command alone natively", () => {
    const r = run(
      [
        'save : note = "none"',
        "log.out { 1 }",
        "check.error {",
        '  change : note = "ran"',
        "}",
        "log.out { note }",
      ].join("\n"),
      "check-ok.hz",
    );
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, ["1", "none"]);
  });

  it("compile-only writes an executable and does not run it", () => {
    const out = join(tempDir(), "compiled-only.exe");
    const r = runNative({
      file: write("compile-only.hz", 'log.out { "should not print" }'),
      out,
      compileOnly: true,
    });
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual(r.output, []);
    assert.ok(readFileSync(out).length > 0);
  });
});

// Keep temp artifacts until the process ends; Windows locks running exes briefly.
process.on("exit", () => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
