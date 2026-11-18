# HAZMA Compiler Architecture

How the HAZMA toolchain is built (phases 1–8) and where it is going
(phase 9). The implementation is TypeScript on Node.js, ESM with
`NodeNext` module resolution, and has **zero runtime dependencies** —
only `typescript` and `@types/node` as dev dependencies.

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
 ┌────────────────────────────┬───────────────────────────────┐
 │ Interpreter (run)          │ diagnostics (check/CLI/IDE)   │
 │ src/runtime/interpreter.ts │ src/errors.ts                 │
 └────────────────────────────┴───────────────────────────────┘
```

Entry points:

- `src/index.ts` — public API used by tests and (later) the VS Code
  extension: `runSource`, `analyze`, `parse`.
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
| `hazma run f.hz`   | compile then execute; diagnostics to stderr, `log.out` to stdout, exit 1 on failure |
| `hazma check f.hz` | compile only; `no problems found in ...` on success |
| `hazma ast f.hz`   | print the parsed statements (debug dump, `[line N]` annotations) |
| `hazma new dir`    | scaffold `dir/app.hz` with a starter program |
| `hazma version`    | print version |

Note: `node dist/src/cli.js` does nothing by itself — `runCli` is only
invoked from `bin/hazma.js` (or import it yourself).

---

## 8. Tests (`tests/`, run with `npm test`)

`npm test` = `tsc -p tsconfig.json` then
`node --test "dist/tests/*.test.js"` (the quoted glob matters: this Node
does not accept a bare directory for `--test`). `tests/support.ts`
provides `expectOut` (run + exact `log.out` lines) and `expectDiag`
(expect a given H-code, optionally with a message fragment). The example
programs in `examples/` are themselves tests: `tests/programs.test.ts`
runs them and compares exact output.

---

## 9. Phase 9 and beyond **[planned — not implemented]**

The architecture leaves room for:

- **Bytecode compiler + VM**: `Analyzer`'s typed IR is the natural input;
  the frame machine's `Frame`/`ip` model maps directly to a
  `code[] + pc` VM with explicit loop-state objects, so the pause/resume
  semantics (D6) survive compilation.
- **Native machine-code backend**: a genuinely compiled HAZMA would lower
  the typed IR (including the `list` type) to a lower-level IR, emit
  object code through LLVM (or Cranelift), and link a native executable
  per platform. This has **not been started** — `hazma run` still
  executes the AST with the interpreter. No native executable is produced
  today, and no performance comparison against C/C++/Rust is claimed.
- **Web layer**: the language's original goal — elements, styling and
  events as first-class HAZMA constructs replacing HTML/CSS/JS. This
  needs a new statement family and a host runtime (browser or Node
  preview server); nothing in phases 1–8 hard-codes assumptions that
  would block it.
- **LSP / language server** for real IDE diagnostics beyond the basic
  VS Code extension shipped in phase 8.
