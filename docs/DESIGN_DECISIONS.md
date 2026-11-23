# HAZMA Design Decisions

This file records decisions that are **locked** (implemented, tested, and
load-bearing for the language's identity) and questions that are still
**open**. When a decision is locked here, the compiler enforces it; when a
question is open, the compiler either documents the current choice or
rejects the construct rather than inventing silent rules.

---

## 1. Locked decisions

### D1 — No semicolons; newlines separate statements

Statements end at a newline. A source file that does not end with a newline
behaves as if it did (the lexer emits one virtual newline before EOF).
Locked: the parser reports two commands on one line as an error.

### D2 — `//` line comments

Only line comments exist. Block comments are not designed yet (open Q3).

### D3 — Boolean variables are named `is.*`

Any variable holding `true`/`false` must be named with the `is.` prefix,
and may go multiple levels deep: `is.ready`, `is.fight.over`,
`is.game.has.won`. The whole dotted name is **one variable**, not a path.
Enforced by H3020 (compile) and H4010 (runtime). `is` alone is reserved.

### D4 — `change` keeps the type, `t.change` retypes

`change : x = ...` is a compile-time type error (H3012) when the type
differs; `t.change : x = ...` allows a new type. Shorthand `x = ...`
behaves like `change` (type-stable). This keeps accidental string→number
mistakes from compiling.

### D5 — Both repeat forms are do-until

The body runs before the condition is first checked. For the named form,
`till` must be the first statement of the body syntactically, but it is
checked at the end of each pass (so a named repeat always runs its first
pass). Anonymous `repeat till cond { }` checks `cond` after each pass too.

### D6 — `repeat.break` pauses, it does not discard

`repeat.break : name` freezes the loop: its frame and every frame nested
inside it (inner repeats, calls made from inside it) are parked. Execution
continues after the repeat statement. `repeat.continue : name` parks the
frames back and the machine resumes inside the loop at the statement after
the break; statements after the `repeat.continue` run when the loop pauses
or finishes again. `repeat.new : name` additionally restores body-referenced
variables to the snapshot taken when the loop began.

Locked sub-rules:

- break targets must lexically enclose the break in the same activation
  (H3050).
- continue/new work from the same scope, or from any function for global
  repeats; a repeat frozen inside a paused repeat cannot be targeted
  (H4021); a running repeat cannot be restarted from inside itself
  (H3051/H4025).

### D7 — Locals/parameters never shadow globals

A `save` inside a function, or a `func.p` parameter, may not reuse a
global's name (H3007). This keeps "did I mean the global or the local?"
errors out of the language entirely.

### D8 — Recursion is statically banned

The call graph is checked; cycles are reported with the full cycle
(H3057). Rationale: with no stacks growing per call, the pause/resume
machine stays simple and predictable. This may be revisited once a future
backend can bound call depth explicitly.

### D9 — Functions and structures live at top level

Nested declarations are rejected (H3053, H3055). `func.p` lines must be
the first statements of a body (H2031).

### D10 — Structure defaults are literals

`struct` property defaults and `const.` defaults must be literals or
nested `struct.c : name { ... }` values (H3042). Instance-creation
overrides may be arbitrary expressions.

### D11 — `const.` is permanent

`const.` properties cannot be set at creation (H3041), cannot be changed
later (H3013/H4011), and children cannot override them (H3038). A child
also cannot redeclare an inherited property as `const.` (H3039).

### D12 — Property named `r` is forbidden

`.r` is the round suffix, so a structure property called `r` would make
`thing.r` ambiguous. Forbidden with a dedicated message (H3034).

### D13 — `.r` uses round-half-toward-positive-infinity

Same behavior as JavaScript `Math.round` (`2.5.r` → `3`, `-2.5.r` → `-2`).
Documented rather than hidden.

### D14 — `save` re-initialization is allowed

Re-running a `save` re-initializes the variable with the same-type rule
(useful inside repeats where each pass should reset state).

### D15 — Globals are pre-collected

Functions and top-level code may reference globals declared later in the
file. The analyzer registers all top-level `save`s before checking bodies.

### D16 — Return types are inferred

Function return types come from `func.r` expressions, computed to a
fixpoint in a quiet pass before bodies are checked, so calls that appear
before the return is written still type-check.

### D17 — Identity comparison for structures

`==` on two structure instances compares identity, not fields. Strings,
numbers and booleans compare by value.

### D18 — `+` joins text with anything

`"a" + 1` is `"a1"`; `string + boolean` is allowed; `boolean + boolean`
and `boolean + number` are compile errors (H3005). Numbers `+` numbers add.

### D19 — Strings compare with `==`/`!=`; ordering is numbers-only

`>` `<` `>=` `<=` are rejected at compile time for strings (H3006) rather
than inventing an ordering for text.

### D20 — `l.remove` removes the first matching occurrence only

Removing by value when duplicates exist is ambiguous. The locked rule is:
remove exactly one element — the first match, the same occurrence
`l.find.index` reports. Later duplicates stay. Removing a missing value is
a runtime error (H4063), not a silent no-op.

### D21 — `l.change` uses a 1-based numeric index

The left side of `l.change` is a position, never a value: `2 = "Rifle"`.
This keeps `l.change` (position) distinct from `l.remove`/`l.find`
(value). The original sketch's `"Gun" = "Rifle"` example was a
documentation error; the written rule wins.

### D22 — `l.find` is a boolean; `l.find.index` is the position

`l.find` returns `true`/`false` only. The first matching position is
available separately as `l.find.index`. This keeps both usable inside
`if :` conditions and avoids a value that means two things.

`l.find.index` returns **0** when the value is absent. Indexes start at 1,
so 0 is an unambiguous "not found" marker.

### D23 — Lists are reference values

A list variable holds a reference, like a structure instance. Assigning a
list or passing it to a function shares the same list; `l.add` inside a
function is visible to the caller. `repeat.new` restores deep copies of
snapshotted variables, so restarted loops get fresh lists. `==` compares
lists by identity. This mirrors the existing structure rules rather than
introducing a second value model.

### D24 — Struct defaults may hold list literals

`items = { "map" }` is a valid structure default. Each instance
const-evaluates its own defaults, so every instance receives its own list.
`l.add`/`l.remove`/`l.change` accept property paths (`bag.items`), not
just bare variables.

### D25 — `l.save :` requires a list literal

`l.save : name = { ... }` creates a list from a literal. Storing a list
returned by a function uses ordinary `save : name = func.c : ...`, which
already infers the list type. Mixing the two forms would make `l.save`
sometimes a declaration and sometimes an assignment; H2067 explains the
distinction.

### D26 — Lists keep one element type

`l.add` and `l.change` accept only values matching the list's inferred
element type (H3064). A literal that mixes value types is a list of
anything, and so is an empty list, so those accept every value.
`l.find` and `l.remove` stay permissive on purpose: a value of another
type simply never matches, and removing it reports the same missing-value
error (H4063).

### D27 — The native backend emits C, not machine code directly

HAZMA compiles the analyzed AST to C, then invokes MSVC (`cl.exe`) or a
C11 compiler named by `HAZMA_CC`. This keeps the backend small,
inspectable (`--emit-c`) and portable across C toolchains, at the cost of
a C compile step and a dependency on a host compiler. A future LLVM or
Cranelift backend can replace the emitter without changing semantics.

### D28 — `hazma run` is native; `--interpret` is the explicit escape hatch

Compilation is the default so "compiled language" is not merely a label.
The interpreter stays available because it is portable, needs no C
toolchain, and covers the one construct the native backend rejects
(`func.r` inside a named repeat). `hazma check` and the VS Code extension
continue to use the analyzer only.

### D29 — Named repeats compile to functions; pause/resume uses Windows fibers

Every named repeat becomes `lbN(HzLoop*, void*)`. A loop that can pause
runs on a Windows fiber, so its entire C stack — including nested loops
and function calls — is preserved across `repeat.break`. Loops that can
never pause run inline with no fiber. This is the only faithful way to
keep D6's "pause, do not discard" semantics once control flow is
compiled. Consequence: pause/resume is Windows-only for now.

### D30 — `func.r` inside a named repeat is rejected with H5001

A named repeat's body is a separate C function, so a `func.r` inside it
would have to return through the loop body to the outer function. Rather
than miscompile or silently change semantics, the generator rejects it
with H5001 and a help line. Programs that need it use `--interpret`.

### D31 — Native runtime allocates for the process lifetime (no GC yet)

Strings, lists, structures and fibers are not reclaimed in 0.3. This is
explicitly documented and tested for correctness, not presented as a
memory story. Reclamation is future work and will not change observable
language semantics.

### D32 — Structure properties are looked up by name at runtime

Generated C uses `hz_prop_get` / `hz_prop_slot` with the property name, so
`any`-typed paths, inheritance and diagnostics stay consistent with the
interpreter. `const` enforcement uses a per-structure `consts[]` table.
This trades a small runtime lookup cost for simpler, safer code
generation.

### D33 — Native number printing approximates JavaScript `Number#toString`

Integers below 1e21 print without a decimal point, other numbers use the
shortest round-trip form, and exponents are normalized (`1e+21`). This
keeps native `log.out` output byte-identical to the interpreter, which is
what the example tests assert.

### D34 — `file.write` / `file.add` use a raw text block, not an expression

File contents are not HAZMA values, so parsing them as expressions would
force quoting and escaping on every line. Instead the lexer switches to a
raw mode after `file.write : path {` / `file.add : path {` and emits one
`raw` token. The block ends at the first line that is only `}`, so a `}`
inside the text is safe as long as it shares the line with other text.
The token's text is dedented by the common indent and given exactly one
trailing newline, which makes the common case (write a small config or
notes file) read like a here-document.

Rejected alternatives: backtick strings (borrowed syntax), a `{{ }}`
delimiter (collides with block syntax), and requiring one command per line
(`file.write.line`). The raw block keeps `file.write` a single statement.

### D35 — `check.error` guards the single preceding statement

`check.error { ... }` is written **after** the command it protects, which
reads as "do this, and if it fails, do that". The parser moves the previous
statement into the `CheckError` node, so the AST has no new grouping
syntax and a handler can never drift away from its guard. Semantics:

- the guarded statement runs in a nested frame; a thrown runtime error
  switches to the handler, a `func.r` or a pause propagates normally;
- handled errors are silent (they are handled, not logged);
- errors raised *inside* the handler are not caught again;
- `check.error` with nothing before it is H2048, and guarding a pause
  (`repeat.break` etc.) is rejected at compile time with H3066 so the
  interpreter and the native backend agree; H4098 remains only as an
  internal backstop.

In the native backend each guard pushes an error handler (`setjmp`) onto a
runtime stack; `hz_rt_error` longjmps to the top handler. The stack pointer
is saved and restored with the fiber, and `func.r` restores it before
returning so a guard cannot leak across frames. A named-repeat body is a
separate fiber, so a guard outside the loop cannot catch errors raised
inside it — documented in the spec as a native limit rather than papered
over.

---

## 2. Open questions

These are documented **as currently chosen**, and revisiting them is safe
because the current choice is at least deterministic. None of them are
silent fudge factors.

### Q1 — `log.out` with several values

Currently `log.out { a b }` is a parse error (H2022 family): the block
holds exactly one expression, and a second bare token inside is rejected.
Options for later: (a) keep one-value-per-`log.out`; (b) allow
`log.out { a b }` to join with a space; (c) require explicit `a + " " + b`.
Choice pending; the parser currently points at the problem instead of
guessing.

### Q2 — `struct.c` override syntax

Creation overrides use `name = expr` lines inside the braces
(`struct.c : npc { health = 70 }`). An alternative syntax
(`health : 70`, or a `with` block) was considered; the current choice
mirrors `change : x { prop = value }` so one mental model covers both.
Locked for 0.1, revisit if real programs feel wrong.

### Q3 — `else` on the same line as `}`

`else : { }` and `} else : { }` (same line) both parse today because the
parser skips newlines when looking for `else`. Whether to *require* the
one-line style (as in the original sketch) is an open style question; the
parser is permissive either way and the test suite locks the permissive
behavior.

### Q4 — Wording of the snapshot rule for `repeat.new`

The implemented rule: `repeat.new` restores the variables the body
*referenced* to the values from the loop's first entry, then resumes the
machine where the break left it. An alternative reading ("snapshot at
pause time") was rejected because it makes "new" mean "continue". The
spec wording above is the contract; a clearer phrasing for beginners is
welcome, the behavior is not.

### Q5 — Block comments

`//` only, today. A block-comment form (e.g. `/+ ... +/`) may be added
without breaking anything; not designed yet.

### Q6 — Number literals beyond decimals

No hex, exponents, separators, or negative zero handling yet. A future
bytecode or direct-object backend will need a decision before
serialization matters.

---

## 3. Rejected ideas (kept so we do not re-litigate)

- **Semicolon option** — rejected; newline-termination is the identity of
  the language.
- **Implicit boolean truthiness** (`if : name` where name is a number) —
  rejected; conditions must be booleans, and booleans must be `is.` named.
- **Dynamic shadowing of globals by locals** — rejected (D7).
- **`null`** — rejected for now; structure properties always have values.
- **Allowing recursion with a depth limit** — rejected for now (D8);
  revisiting requires the phase-9 call frame design.
