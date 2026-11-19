# HAZMA Compiler Architecture

How the HAZMA toolchain is built. The implementation is TypeScript on
Node.js, ESM with `NodeNext` module resolution, and has **zero runtime
dependencies** — only `typescript` and `@types/node` as dev dependencies.

There are two execution paths from the same analyzed program:

```
source (.hz)
   │
   ▼
 tokenize()            src/lexer/lexer.ts        → Token[]
   │                                              src/lexer/tokens.ts
   ▼
 Parser                src/parser/parser.ts      → Stmt[] (AST)
   │                                              src/ast/nodes.ts
   ▼
 Analyzer              src/semantic/analyzer.ts  → AnalysisResult
   │               (pass 0 + quiet fixpoint + body walks + diagnostics)
   ▼
 ┌────────────────────────────┬───────────────────────────────┬─────────────────────────┐
 │ Native backend (default)   │ Interpreter (--interpret)     │ diagnostics (check/IDE) │
 │ src/backend/cgen.ts        │ src/runtime/interpreter.ts    │ src/errors.ts           │
 │   → generated C            │                               │                         │
 │ src/backend/runtime/       │                               │                         │
 │   hazma_rt.c               │                               │                         │
 │   → MSVC / clang / gcc     │                               │                         │
 │   → native executable      │                               │                         │
 └────────────────────────────┴───────────────────────────────┴─────────────────────────┘
```

Entry points:

- `src/index.ts` — public API used by tests and the VS Code extension:
  `runSource`, `analyze`, `parse`.
- `src/cli.ts` — `runCli(argv)`; `bin/hazma.js` is the shebang wrapper.
- `dist/` holds the compiled output; tests import from `dist/`.

---

## 1. Lexer (`src/lexer/`)

- Single pass, emits `number | string | ident | punct | newline | eof`.
- Newline tokens are **kept** — the grammar is newline-terminated.
- A run of `ident(.ident)*` lexes as **one** token, so dotted commands
  (`t.change`, `log.out`, `struct.c`, `func.p`) and dotted boolean names
  (`is.fight.over`) cannot be split.
- If the source does not end with a newline, one virtual newline token is
  pushed before `eof` (statements are always newline-terminated).
- Errors: H1001 (character), H1002 (string), H1004 (escape). They are
  thrown as `HazmaError` with exact 1-based line/col spans.

`RESERVED_WORDS` lives in `src/lexer/tokens.ts` and is the single source
of truth for the reserved list.

---

## 2. Parser (`src/parser/parser.ts`)

Recursive descent over the flat token list:

- `parseStatement` dispatches on the first token's text, splitting the
  dotted token on `.` when needed (`t.change` = ident token `t.change`).
- `varTarget` validates assignment targets: a plain name or an `is.*`
  name (returns the **whole dotted name as one part**, e.g.
  `["is.fight.over"]`); `pathTarget` validates property paths (split
  parts, e.g. `["alex","health"]`).
- Expression precedence chain: `parseExpression` → `or` → `and` → `not`
  → comparisons → additive → multiplicative → unary → primary; `.r` and
  `[ index ]` are postfix operators at primary level (`round` and `index`
  nodes).
- List syntax: `l.save` / `l.add` / `l.remove` / `l.change` statements use
  `parseListItems` (newline- or comma-separated expressions) and
  `parseListChanges` (`index = value` lines); `{ ... }` in value position
  is a `list.lit`.
- Named repeats: the parser pulls the leading `till` line out of the body
  into `RepeatNamed.cond` and rejects `func.p` after non-parameter
  statements.
- `else` / `else if` are looked up **past newlines** so both styles parse.
- Parser errors are H2xxx `HazmaError`s with precise spans.

---

## 3. AST (`src/ast/nodes.ts`)

Discriminated unions. Notable nodes: `RepeatNamed` carries `usedVars`
(variable names the body references — computed by the analyzer), 
`targetDecl` (the resolved `RepeatNamed` node) and `scopeKind`
(`"global" | "function"`), which the runtime needs for pause/resume and
`repeat.new` snapshots.

List nodes are first-class: expressions `ListLit`, `ListIndex`,
`ListCount`, `ListFind`, `ListFindIndex`; statements `ListSave`,
`ListAdd`, `ListRemove`, `ListChange` (with `ListChangeEntry`).

---

## 4. Semantic analyzer (`src/semantic/analyzer.ts`)

`Analyzer.analyze(program)` runs:

1. **pass 0** — `precollectGlobals` registers every top-level `save`
   (as `T_ANY` placeholders, refined as the walk assigns real types);
   `registerStruct` / `registerFunc` / named-repeat registration run
   next (duplicate names, reserved words, `r` properties, inheritance
   conflicts are all checked here).
2. **phase A (quiet)** — return-type inference to a fixpoint: for every
   function, evaluate the types of its `func.r` expressions repeatedly
   until `fn.returnType` stops changing. `this.quiet = true` suppresses
   diagnostics during inference so only the real walk reports problems.
3. **phase B** — full check of each function body with a `Ctx`
   (function, locals map, local loops, enclosing loop stack). Parameter
   vs global shadowing is checked here, then defaults, then the body.
4. **phase C** — full check of the top-level program.

Key helpers: `exprType` (expression typing), `pathType` (variable vs
property-path resolution — any dotted path starting with `is` is one
variable whose name is the joined parts), `checkAssign` (the H3012 /
H3013 machinery), `collectUsedVars` (the repeat-body variable census),
`checkIsNaming` (D3), and the recursion detector (H3057) over the
function call graph.

Lists add `{ k: "list"; of: Type }` to `Type` (with `typeEq`/`typeKey`
recursing into the element type), list-literal inference through
`listType`/`unifyTypes`, list checks in `exprType` (H3060/H3061/H3062)
and `l.change` index typing (H3063). List literals are valid structure
defaults, so `validateDefault`/`defaultType` accept them.

Diagnostics accumulate in `result.diagnostics` (a compile may report
**several** problems at once); parser/lexer errors throw and surface as
the first problem.

---

## 5. Runtime (`src/runtime/interpreter.ts`)

A **frame machine**, not a recursive tree-walker — because repeats can be
paused and resumed, plain recursion would not survive.

- `Frame { stmts, ip, kind, cond?, loop?, scope, owner }` — kinds:
  `block`, `do-until` (anonymous repeat), `named` (named repeat body),
  `func`. The machine loop pops finished frames; `do-until`/`named`
  frames re-check their condition when `ip` reaches the end and either
  loop (`ip = 0`) or finish.
- `Scope` chains for globals/functions/blocks. Each scope owns the
  named-repeat instances (`LoopInstance`) declared in it.
- `LoopInstance` states: `fresh → running → paused | frozen | finished`.
  A paused loop parks `savedFrames` (its own body frame and everything
  nested inside, including frozen inner repeats and function frames).
- `repeat.break` records the pause, splices frames, and throws
  `PauseHandled` which unwinds the machine loop cleanly.
- `repeat.continue` / `repeat.new` splice the parked frames back in and
  execution resumes from the topmost restored frame — i.e. at the
  statement after the break. `repeat.new` first resets the body's
  referenced variables (`usedVars`) to the snapshot taken at loop entry.
- `func.r` unwinds via a `ReturnSignal`; a stray one at top level is
  H4099.
- Values are plain JS `number | string | boolean`, `StructInstance
  { def, values }` where `def` is shared per structure, and
  `ListValue { items }`. Structure instances and lists are **reference
  values**: copying a variable shares the object, while `repeat.new`
  snapshots are deep copies (`deepCopy`).
- List operations live in `execStmt` (`l.save`/`l.add`/`l.remove`/
  `l.change`) and `eval` (`list.lit`, `index`, `list.count`, `list.find`,
  `list.find.index`). `listIndex` centralises 1-based validation
  (H4061/H4062); `requireListPath`/`evalList` centralise H4064.
- `log.out` output goes through an injectable `out` function
  (`RunOptions.out`), defaulting to stdout; the test harness and the
  VS Code extension capture it instead.

The interpreter assumes a **clean bill of health**: it is only run when
`result.diagnostics.length === 0`. That contract is why runtime errors
(H4xxx) are genuinely runtime conditions (division by zero, frozen-loop
state machines, identity surprises) and not compile-checkable ones.

---

## 6. Diagnostics (`src/errors.ts`)

`HazmaError` carries `code` (H1xxx–H4xxx), `message`, `span`, optional
`help`. `renderDiagnostics` prints RUST-style output:

```
error[H3012]: "age" holds a string and cannot be changed to a number
  --> app.hz:2:16
     |
2 | change : age = 5
     |                ^
  help: use t.change : age = ... to change the type of a variable
```

`suggest()` implements did-you-mean (edit distance against known names)
used by H3010/H3011 and friends.

---

## 7. CLI (`src/cli.ts`, `bin/hazma.js`)

| Command            | Behavior                                  |
| ------------------ | ----------------------------------------- |
| `hazma run f.hz`   | compile to C, link a native executable, run it; `log.out` to stdout, exit 1 on failure |
| `hazma run f.hz --interpret` | run with the tree-walking interpreter instead |
| `hazma run f.hz --emit-c` | print the generated C, do not compile |
| `hazma run f.hz --keep` | keep the temporary C/build files |
| `hazma run f.hz -o out.exe` | compile only (new in 0.3) |
| `hazma build f.hz -o out.exe` | compile only, write the executable |
| `hazma interpret f.hz` | explicit interpreter alias |
| `hazma check f.hz` | compile only; `no problems found in ...` on success |
| `hazma ast f.hz`   | print the parsed statements (debug dump, `[line N]` annotations) |
| `hazma new dir`    | scaffold `dir/app.hz` with a starter program |
| `hazma version`    | print version |

Note: `node dist/src/cli.js` does nothing by itself — `runCli` is only
invoked from `bin/hazma.js` (or import it yourself).

---

## 8. Tests (`tests/`, run with `npm test`)

`npm test` = `npm run build` then
`node --test "dist/tests/*.test.js"` (the quoted glob matters: this Node
does not accept a bare directory for `--test`). `npm run build` compiles
TypeScript and copies `hazma_rt.c` into `dist/`, because `tsc` does not
copy non-TS assets. `tests/support.ts` provides `expectOut` (run + exact
`log.out` lines) and `expectDiag` (expect a given H-code, optionally with
a message fragment). The example programs in `examples/` are themselves
tests: `tests/programs.test.ts` runs them through the interpreter and
`tests/native.test.ts` compiles and runs them natively, comparing exact
output. Native tests skip themselves when no C toolchain is present.

---

## 9. Native backend (`src/backend/`)

The default `hazma run` path is a real compile-and-link:

```
AnalysisResult
   │  cgen.ts
   ▼
program.c  ──#include "hazma_rt.c"──►  cl.exe /Feprogram.exe
```

- **`cgen.ts`** walks the typed IR and emits C. Globals live in one
  `static HzGlobals G`; every function becomes a C function taking
  `HzValue` arguments plus `int hasN` presence flags (for defaulted
  parameters), and a local activation struct reached through an `HzValue`
  pointer `a`. Struct factories `mkN()` start from the struct's literal
  defaults, then apply `struct.c` overrides.
- **`runtime/hazma_rt.c`** is included textually into each program, so
  every helper can stay `static` and the build is one translation unit.
  It provides tagged `HzValue`s (`HZ_NONE`, `HZ_NUM`, `HZ_STR`,
  `HZ_BOOL`, `HZ_STRUCT`, `HZ_LIST`), strings, growing lists, structure
  instances with a const-property table, arithmetic, equality, printing,
  deep copy, and the runtime diagnostics H4xxx.
- **Named repeats** compile to body functions `lbN(HzLoop *loop, void *ctx)`.
  Loops that can be paused (`repeat.break` reachable) run on a **Windows
  fiber**, so a paused loop keeps its entire C stack, including nested
  loops and function calls. `repeat.new` restores generated snapshot
  assignments (`gsnN[]` globals or `a->snN[]` activation arrays) before
  resuming. Loops never paused run inline without a fiber.
- **Rejected construct**: `func.r` inside any named repeat is reported as
  **H5001**, because the loop body is a separate function and a value
  cannot return through it. Everything else in the language compiles.
- **`native.ts`** finds the toolchain, writes `program.c` + a `build.bat`
  that calls `vcvars64.bat`, compiles, and either executes the binary
  (`run`) or leaves it at `-o` (`build`). `HAZMA_CC` overrides the
  compiler with `clang`/`gcc` (C11). Compiler diagnostics include the
  generated file path; front-end diagnostics use the normal rendered
  `file:line:col` format.
- **Optimization**: pass `HAZMA_OPT=/Od` (or `-O0`, `-O3`, ...) to
  override the default `/O2` / `-O2`; the choice is not hidden.

### It is not a speed claim

The generated C is ordinary C plus a dynamic-value runtime. Compile time,
startup, runtime and memory must be measured per workload. `npm run bench`
(`scripts/benchmark.mjs`) reports those four numbers separately for one
program and prints no cross-language claim. On Windows, a cold build is
dominated by `vcvars64.bat` (~9 s on the development machine); the code
generation plus `cl /O2` compile and link is under a second. There is no
benchmark in the repo asserting HAZMA beats C, C++ or Rust.

---

## 10. Future work **[planned — not implemented]**

The architecture leaves room for:

- **LLVM / direct object-code backend**: lower the typed IR to LLVM IR or
  Cranelift to remove the C round-trip and the MSVC dependency. The
  current C backend is the reference for semantics.
- **Memory reclamation**: the native runtime allocates for the lifetime of
  the process. A GC or arena scheme (and fiber cleanup) is future work.
- **Bytecode compiler + VM**: an execution path with no external C
  toolchain, useful on machines without MSVC. `Analyzer`'s typed IR is the
  natural input; the frame machine's `Frame`/`ip` model maps directly to a
  `code[] + pc` VM with explicit loop-state objects, so the pause/resume
  semantics (D6) survive.
- **Web layer**: the language's original goal — elements, styling and
  events as first-class HAZMA constructs replacing HTML/CSS/JS. This
  needs a new statement family and a host runtime (browser or Node
  preview server); nothing shipped so far hard-codes assumptions that
  would block it.
- **LSP / language server** for real IDE diagnostics beyond the basic
  VS Code extension shipped in phase 8.
