# HAZMA

One language for building websites and web applications — intended to
replace HTML, CSS and JavaScript with a single, readable syntax. No
semicolons, no ceremony: commands read like sentences.

```
// hello.hz
log.out {
    "Hello HAZMA!"
}

save : age = 18
save : is.ready = true

repeat : main {
    till age > 21
    log.out { "growing... " + age }
    change : age = age + 1
    repeat.break : main
}
```

**Status: phases 1–8 complete and tested (core language, compiler,
runtime, CLI, docs, examples, test suite, VS Code extension). The
bytecode compiler and the web/document layer are architected for a later
phase — nothing here fakes them.**

---

## What works today

- **Language core** — variables (`save` / `change` / `t.change`), output
  (`log.out`), conditions (`if` / `else if` / `else` with `and` / `or` /
  `not`), selection (`s.change` with labeled literal branches and
  `default`), loops (`repeat` / named `repeat` with `till`, plus the
  pause/resume/restart machine `repeat.break` / `repeat.continue` /
  `repeat.new`), functions (`func` / `func.p` / `func.c` / `func.r`,
  named + positional arguments, inferred return types), structures
  (`struct` with literal defaults, `const.` properties, `struct.base`
  inheritance, `struct.c` creation), rounding with `.r`, boolean naming
  with `is.*` (`is.ready`, `is.fight.over` — any depth), `//` comments.
- **Real diagnostics** — every problem has an `H` code, a precise
  span, a plain-English message and often a `help:` line
  (`error[H3012]: "age" holds a string and cannot be changed to a
  number ... help: use t.change : age = ...`). 111 distinct codes.
- **CLI** — `hazma run | check | ast | new | version | help`.
- **Docs** — language spec, design decisions (locked + open questions),
  compiler architecture: see [`docs/`](docs/).
- **Examples** — `examples/01_hello.hz` through `examples/06_rpg.hz`,
  each with exact-output tests.
- **Tests** — `npm test` runs the full suite (120 tests: lexer, parser,
  semantics, runtime, example programs).
- **VS Code extension** — syntax highlighting, snippets, diagnostics
  reusing the real compiler, and a run button: see
  [`vscode-hazma/`](vscode-hazma/).

## Not built yet (by design)

- **Bytecode compiler + VM** — the typed IR and the frame machine are
  designed to compile to this; see
  [`docs/COMPILER_ARCHITECTURE.md`](docs/COMPILER_ARCHITECTURE.md#9-phase-9-and-beyond-planned--not-implemented).
- **The web layer** — elements, styling and events as HAZMA constructs
  (the part that actually replaces HTML/CSS/JS). Next major phase.
- **Package manager, LSP, browser runtime.**

## Quick start

```powershell
cd hazma
npm install        # typescript + @types/node only
npm run build
node bin/hazma.js run examples/01_hello.hz
node bin/hazma.js check examples/06_rpg.hz
node bin/hazma.js new my-app
npm test
```

## Learn the language

- [`docs/LANGUAGE_SPEC.md`](docs/LANGUAGE_SPEC.md) — the full language,
  including the error-code tables.
- [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md) — what is locked
  (e.g. `repeat.break` pauses rather than discards; recursion is
  statically rejected) and what is still open.
- [`examples/`](examples/) — six runnable programs from hello-world to
  an RPG-style fight loop.

## Project layout

```
hazma/
├── bin/hazma.js            # CLI entry point
├── src/                    # compiler + runtime source (TypeScript)
│   ├── lexer/  parser/  ast/  semantic/  runtime/
│   ├── cli.ts  index.ts  errors.ts
├── tests/                  # node:test suite (120 tests)
├── examples/               # 01_hello.hz ... 06_rpg.hz
├── docs/                   # language spec, decisions, architecture
└── vscode-hazma/           # VS Code extension (highlighting, diagnostics, run)
```

## License

MIT — see [`LICENSE`](LICENSE).
