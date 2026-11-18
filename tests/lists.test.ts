import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("lists", () => {
  // ---------------------------------------------------------------- creation

  it("creates an empty list", () => {
    expectOut(
      "l.save : items = { }\nlog.out { items }\nlog.out { l.count : items }\n",
      ["[]", "0"],
    );
  });

  it("creates a list with text values in insertion order", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Bow"\n}\nlog.out { weapons }\n',
      ["[Sword, Gun, Bow]"],
    );
  });

  it("creates a list with numbers", () => {
    expectOut(
      "l.save : scores = {\n    30\n    10\n    20\n}\nlog.out { scores }\nlog.out { scores[2] }\n",
      ["[30, 10, 20]", "10"],
    );
  });

  it("creates a list with Boolean values", () => {
    expectOut(
      "l.save : flags = {\n    true\n    false\n    true\n}\nlog.out { flags }\nlog.out { flags[2] }\n",
      ["[true, false, true]", "false"],
    );
  });

  it("accepts commas as element separators too", () => {
    expectOut(
      'l.save : mixed = { "a", 2, true }\nlog.out { mixed }\n',
      ["[a, 2, true]"],
    );
  });

  // --------------------------------------------------------------- l.add

  it("adds one element", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n}\nl.add : weapons {\n    "Shield"\n}\nlog.out { weapons }\n',
      ["[Sword, Shield]"],
    );
  });

  it("adds multiple elements and allows duplicates", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n}\nl.add : weapons {\n    "Shield"\n    "Dagger"\n    "Sword"\n}\nlog.out { weapons }\nlog.out { l.count : weapons }\n',
      ["[Sword, Shield, Dagger, Sword]", "4"],
    );
  });

  // -------------------------------------------------------------- l.remove

  it("removes an existing element by value", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Bow"\n}\nl.remove : weapons {\n    "Gun"\n}\nlog.out { weapons }\n',
      ["[Sword, Bow]"],
    );
  });

  it("removes a numeric value as a value, not an index", () => {
    expectOut(
      "l.save : numbers = {\n    10\n    20\n    30\n}\nl.remove : numbers {\n    20\n}\nlog.out { numbers }\n",
      ["[10, 30]"],
    );
  });

  it("removes only the first matching occurrence", () => {
    expectOut(
      'l.save : items = {\n    "Apple"\n    "Apple"\n    "Banana"\n}\nl.remove : items {\n    "Apple"\n}\nlog.out { items }\n',
      ["[Apple, Banana]"],
    );
  });

  it("fails clearly when the value to remove is missing", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nl.remove : weapons {\n    "Boomerang"\n}\n',
      "H4063",
      "cannot be removed",
    );
  });

  // -------------------------------------------------------------- l.change

  it("changes an element by 1-based index and keeps its position", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Bow"\n}\nl.change : weapons {\n    2 = "Rifle"\n}\nlog.out { weapons }\n',
      ["[Sword, Rifle, Bow]"],
    );
  });

  it("changes several elements in one block", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Bow"\n}\nl.change : weapons {\n    1 = "Axe"\n    3 = "Staff"\n}\nlog.out { weapons }\n',
      ["[Axe, Gun, Staff]"],
    );
  });

  it("rejects index 0 in l.change with a runtime error", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nl.change : weapons {\n    0 = "Axe"\n}\n',
      "H4061",
      "starting at 1",
    );
  });

  it("rejects an out-of-range index in l.change", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nl.change : weapons {\n    5 = "Axe"\n}\n',
      "H4062",
      "out of range",
    );
  });

  it("rejects adding a value of the wrong element type", () => {
    expectDiag(
      'l.save : names = { "Sword" }\nl.add : names { 2 }\n',
      "H3064",
      "holds text",
    );
  });

  it("rejects changing an element to the wrong type", () => {
    expectDiag(
      'l.save : names = { "Sword" }\nl.change : names { 1 = 2 }\n',
      "H3064",
      "cannot be stored",
    );
  });

  it("accepts any value when the list was created with mixed values", () => {
    expectOut(
      'l.save : mixed = { "a", 2 }\nl.add : mixed { true }\nlog.out { l.count : mixed }\n',
      ["3"],
    );
  });

  // -------------------------------------------------------------- indexing

  it("accesses elements with 1-based indexes", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Bow"\n}\nlog.out { weapons[1] }\nlog.out { weapons[2] }\nlog.out { weapons[3] }\n',
      ["Sword", "Gun", "Bow"],
    );
  });

  it("rejects index 0 when reading", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nlog.out { weapons[0] }\n',
      "H4061",
      "starting at 1",
    );
  });

  it("rejects an out-of-range read index", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nlog.out { weapons[2] }\n',
      "H4062",
      "out of range",
    );
  });

  it("rejects a non-numeric index at compile time", () => {
    expectDiag(
      'l.save : weapons = {\n    "Sword"\n}\nlog.out { weapons["x"] }\n',
      "H3061",
      "whole numbers",
    );
  });

  it("rejects indexing something that is not a list", () => {
    expectDiag("save : x = 1\nlog.out { x[1] }\n", "H3060", "cannot be indexed");
  });

  // --------------------------------------------------------------- counting

  it("counts the elements of a list", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n}\nlog.out { l.count : weapons }\n',
      ["2"],
    );
  });

  // --------------------------------------------------------------- searching

  it("finds an existing element (true)", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n}\nlog.out { l.find : weapons { "Sword" } }\n',
      ["true"],
    );
  });

  it("reports false for a missing element and 0 for its index", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n}\nlog.out { l.find : weapons { "Shield" } }\nlog.out { l.find.index : weapons { "Shield" } }\n',
      ["false", "0"],
    );
  });

  it("returns the first matching index among duplicates", () => {
    expectOut(
      'l.save : weapons = {\n    "Sword"\n    "Gun"\n    "Sword"\n}\nlog.out { l.find : weapons { "Sword" } }\nlog.out { l.find.index : weapons { "Sword" } }\n',
      ["true", "1"],
    );
  });

  it("finds the later duplicate when the first values differ", () => {
    expectOut(
      'l.save : items = {\n    "Apple"\n    "Apple"\n    "Banana"\n}\nlog.out { l.find.index : items { "Banana" } }\n',
      ["3"],
    );
  });

  it("does not match values of a different type", () => {
    expectOut(
      'l.save : items = {\n    1\n    2\n}\nlog.out { l.find : items { "1" } }\nlog.out { l.find.index : items { "1" } }\n',
      ["false", "0"],
    );
  });

  // ------------------------------------------------------- invalid references

  it("rejects l.add on a non-list", () => {
    expectDiag("save : x = 1\nl.add : x { 2 }\n", "H3062", "needs a list");
  });

  it("rejects l.count on a non-list", () => {
    expectDiag("save : x = 1\nlog.out { l.count : x }\n", "H3062", "needs a list");
  });

  it("rejects list commands on an unknown variable", () => {
    expectDiag('l.add : ghost { "x" }\n', "H3011", "unknown variable");
  });

  it("rejects a value-only list command used as a statement", () => {
    expectDiag(
      "l.save : weapons = { 1 }\nl.count : weapons\n",
      "H2060",
      "is a value, not a command",
    );
  });

  it("rejects a statement-only list command used as a value", () => {
    expectDiag(
      'l.save : weapons = { 1 }\nsave : x = l.add : weapons { 2 }\n',
      "H2060",
      "is a command, not a value",
    );
  });

  it("rejects l.save with something other than a list literal", () => {
    expectDiag(
      "l.save : x = 5\n",
      "H2067",
      "needs a list written with { }",
    );
  });

  // --------------------------------------------------------------- functions

  it("passes lists into functions and mutates the same list", () => {
    expectOut(
      "func : push {\n    func.p : xs\n    l.add : xs { 4 }\n}\nl.save : items = { 1, 2, 3 }\nfunc.c : push { items }\nlog.out { items }\nlog.out { l.count : items }\n",
      ["[1, 2, 3, 4]", "4"],
    );
  });

  it("returns a list from a function", () => {
    expectOut(
      "func : make {\n    func.r : { 7, 8 }\n}\nsave : made = func.c : make {\n}\nlog.out { made }\nlog.out { made[2] }\n",
      ["[7, 8]", "8"],
    );
  });

  it("supports local lists inside functions", () => {
    expectOut(
      'func : show {\n    l.save : local = { "only", "here" }\n    log.out { local }\n}\nfunc.c : show {\n}\n',
      ["[only, here]"],
    );
  });

  // --------------------------------------------------------------- structures

  it("uses list literals as structure defaults", () => {
    expectOut(
      'struct : bag_structure {\n    items = { "map" }\n}\nbag = struct.c : bag_structure\nl.add : bag.items { "torch" }\nlog.out { bag.items }\nlog.out { bag.items[2] }\n',
      ["[map, torch]", "torch"],
    );
  });

  it("gives each structure instance its own list", () => {
    expectOut(
      'struct : bag_structure {\n    items = { "map" }\n}\nfirst = struct.c : bag_structure\nsecond = struct.c : bag_structure\nl.add : first.items { "torch" }\nlog.out { first.items }\nlog.out { second.items }\n',
      ["[map, torch]", "[map]"],
    );
  });

  // ----------------------------------------------------------- list of lists

  it("supports lists of lists", () => {
    expectOut(
      "l.save : grid = { { 1, 2 }, { 3, 4 } }\nlog.out { grid }\nlog.out { grid[2][1] }\n",
      ["[[1, 2], [3, 4]]", "3"],
    );
  });
});
