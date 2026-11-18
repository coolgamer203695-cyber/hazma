import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSource, example } from "./support.js";

describe("example programs", () => {
  it("01_hello.hz", () => {
    const r = runSource(example("01_hello.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, ["Hello HAZMA!", "Alex is 18", "ready: true"]);
  });

  it("02_conditions.hz", () => {
    const r = runSource(example("02_conditions.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, ["Teenager", "Teen member", "Not an adult yet"]);
  });

  it("03_loops.hz", () => {
    const r = runSource(example("03_loops.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, [
      "tick 0",
      "tick 1",
      "tick 2",
      "tick 3",
      "power level 3",
      "paused with battery 2",
      "power level 2",
      "resumed with battery 1",
    ]);
  });

  it("04_functions.hz", () => {
    const r = runSource(example("04_functions.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, ["Welcome Alex", "Welcome Guest", "2 + 3 = 5"]);
  });

  it("05_structs.hz", () => {
    const r = runSource(example("05_structs.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, [
      "npc_structure{ id: 1, health: 50, strength: 10 }",
      "npc_structure{ id: 1, health: 100, strength: 5 }",
      "500 hp and 900 coins",
    ]);
  });

  it("06_rpg.hz", () => {
    const r = runSource(example("06_rpg.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, [
      "Alex hits for 12 (target at 18)",
      "Goblin hits for 8 (target at 92)",
      "Alex hits for 12 (target at 6)",
      "Goblin hits for 8 (target at 84)",
      "Alex hits for 12 (target at -6)",
      "The goblin falls!",
      "Alex survived with 84 hp",
    ]);
  });

  it("07_lists.hz", () => {
    const r = runSource(example("07_lists.hz"));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.output, [
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
    ]);
  });
});
