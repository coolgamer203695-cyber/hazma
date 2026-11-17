import { describe, it } from "node:test";
import { expectOut, expectDiag } from "./support.js";

describe("structures", () => {
  it("creates instances with independent values", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n    strength = 0\n    speed = 2\n}\nalex = struct.c : npc_structure\nbob = struct.c : npc_structure\nchange : alex.health = 50\nlog.out {\n    alex.health\n}\nlog.out {\n    bob.health\n}\n",
      ["50", "100"],
    );
  });

  it("prints instances in a readable form", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n    strength = 0\n}\nalex = struct.c : npc_structure\nlog.out {\n    alex\n}\n",
      ["npc_structure{ health: 100, strength: 0 }"],
    );
  });

  it("changes one property and many properties", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n    strength = 0\n    speed = 2\n}\nalex = struct.c : npc_structure\nchange : alex.health = 50\nchange : alex {\n    strength = 20\n    speed = 5\n}\nlog.out {\n    alex\n}\n",
      ["npc_structure{ health: 50, strength: 20, speed: 5 }"],
    );
  });

  it("supports custom values during creation", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n    strength = 0\n}\nalex = struct.c : npc_structure {\n    health = 200\n}\nlog.out {\n    alex.health\n}\n",
      ["200"],
    );
  });

  it("locks const properties against instances", () => {
    expectDiag(
      "struct : npc_structure {\n    const.id = 1\n    health = 100\n}\nalex = struct.c : npc_structure\nchange : alex.id = 9\n",
      "H3013",
    );
  });

  it("rejects const values during creation", () => {
    expectDiag(
      "struct : npc_structure {\n    const.id = 1\n}\nalex = struct.c : npc_structure {\n    id = 9\n}\n",
      "H3013",
    );
  });

  it("rejects const. outside structures", () => {
    expectDiag(
      "save : x = 1\nchange : x {\n    const.y = 2\n}\n",
      "H2043",
    );
  });

  it("supports nested structures and property paths", () => {
    expectOut(
      "struct : inventory_structure {\n    slots = 20\n    coins = 0\n}\n\nstruct : npc_structure {\n    health = 100\n\n    inventory = struct.c : inventory_structure\n}\nalex = struct.c : npc_structure\nchange : alex.inventory.coins = 500\nlog.out {\n    alex.inventory.coins\n}\n",
      ["500"],
    );
  });

  it("keeps nested instances independent per instance", () => {
    expectOut(
      "struct : inventory_structure {\n    coins = 0\n}\nstruct : npc_structure {\n    inventory = struct.c : inventory_structure\n}\nalex = struct.c : npc_structure\nbob = struct.c : npc_structure\nchange : alex.inventory.coins = 5\nlog.out {\n    bob.inventory.coins\n}\n",
      ["0"],
    );
  });

  it("inherits with struct.base (single parent)", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n    strength = 0\n}\nstruct.base : npc_structure {\n    struct : boss_structure {\n        health = 500\n        damage = 50\n    }\n}\nbob = struct.c : boss_structure\nlog.out {\n    bob.health\n}\nlog.out {\n    bob.strength\n}\nlog.out {\n    bob.damage\n}\n",
      ["500", "0", "50"],
    );
  });

  it("inherits with multiple parents", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n}\nstruct : monster_structure {\n    damage = 100\n}\nstruct.base : npc_structure, monster_structure {\n    struct : boss_structure {\n        health = 500\n    }\n}\nbob = struct.c : boss_structure\nlog.out {\n    bob.health + bob.damage\n}\n",
      ["600"],
    );
  });

  it("rejects conflicting properties across parents", () => {
    expectDiag(
      "struct : a {\n    x = 1\n}\nstruct : b {\n    x = 2\n}\nstruct.base : a, b {\n    struct : c {\n        y = 3\n    }\n}\n",
      "H3037",
    );
  });

  it("lets children override inherited properties", () => {
    expectOut(
      "struct : npc_structure {\n    health = 100\n}\nstruct.base : npc_structure {\n    struct : boss_structure {\n        health = 500\n    }\n}\nbob = struct.c : boss_structure\nlog.out {\n    bob.health\n}\n",
      ["500"],
    );
  });

  it("rejects overriding inherited const properties", () => {
    expectDiag(
      "struct : npc_structure {\n    const.id = 1\n}\nstruct.base : npc_structure {\n    struct : boss_structure {\n        id = 9\n    }\n}\n",
      "H3038",
    );
  });

  it("rejects overrides with a different type", () => {
    expectDiag(
      "struct : npc_structure {\n    health = 100\n}\nstruct.base : npc_structure {\n    struct : boss_structure {\n        health = \"strong\"\n    }\n}\n",
      "H3040",
    );
  });

  it("rejects unknown parents", () => {
    expectDiag(
      "struct.base : ghost_structure {\n    struct : c {\n        y = 3\n    }\n}\n",
      "H3036",
    );
  });

  it("rejects duplicate structure and property names", () => {
    expectDiag(
      "struct : a {\n    x = 1\n}\nstruct : a {\n    y = 2\n}\n",
      "H3032",
    );
    expectDiag(
      "struct : a {\n    x = 1\n    x = 2\n}\n",
      "H3033",
    );
  });

  it("rejects const properties with non-literal defaults", () => {
    expectDiag(
      "save : n = 5\nstruct : a {\n    x = n\n}\n",
      "H3042",
    );
  });

  it("rejects the reserved property name r", () => {
    expectDiag(
      "struct : a {\n    r = 1\n}\n",
      "H3034",
    );
  });

  it("rejects unknown properties in creation blocks", () => {
    expectDiag(
      "struct : a {\n    x = 1\n}\nalex = struct.c : a {\n    y = 2\n}\n",
      "H3010",
    );
  });

  it("rejects struct instances inside a function from unknown structs", () => {
    expectDiag(
      "func : f {\n    save : ghost = struct.c : missing {\n    }\n}\n",
      "H3004",
    );
  });

  it("keeps property types checked on instances", () => {
    expectDiag(
      'struct : a {\n    x = 1\n}\nalex = struct.c : a\nchange : alex.x = "no"\n',
      "H3012",
    );
  });
});
