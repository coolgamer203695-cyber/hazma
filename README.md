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

**Status: phases 1–8 complete and tested, plus a real native backend.
`hazma run` now compiles HAZMA to C and links a native executable through
MSVC (or `clang`/`gcc` via `HAZMA_CC`) instead of interpreting the tree.
Lists are a native, fully integrated type. The web/document layer is
architected for a later phase — nothing here fakes it.**

---

## Native compilation

`hazma run app.hz` is a real compile-and-run:

```
HAZMA source  ->  lexer  ->  parser  ->  analyzer (typed IR)
              ->  C code generator  ->  C compiler  ->  native .exe
```

- **No interpretation in the default path.** `hazma run` writes C, compiles
  it with the host toolchain and executes the resulting binary.
  `hazma run app.hz --interpret` keeps the tree-walking interpreter for
  debugging and for the one construct the native backend still rejects.
- **Commands**: `hazma run app.hz`, `hazma build app.hz -o app.exe`,
  `hazma run app.hz --emit-c` (print generated C), `hazma run app.hz
  --keep` (keep temporary C files), `hazma run app.hz -o app.exe`
  (compile only). The generated program begins with
  `#include "hazma_rt.c"`, so put
  `src/backend/runtime/hazma_rt.c` beside emitted C before compiling it
  yourself.
- **Toolchain**: Windows x64 with MSVC Build Tools is the tested target.
  Set `HAZMA_CC` to `clang` or `gcc` to use another C11 compiler; named
  repeat pause/resume needs Windows fibers, so those programs are
  Windows-only today. `HAZMA_OPT` overrides the optimization flags
  (default `/O2` on MSVC, `-O2` elsewhere), e.g. `HAZMA_OPT=/Od`.
- **Honest limitations**:
  - `func.r` inside a *named* repeat is rejected with **H5001** (the loop
    body is a separate C function, so a value cannot return through it).
    Move the return outside the repeat or use `--interpret`.
  - The runtime does not reclaim memory yet; long-running allocation
    programs grow until exit.
  - Runtime errors print `file:line` and the H code, without the source
    caret excerpt the analyzer shows.
  - Abandoned paused loops whose owning function returned leak their fiber.
- **No speed claim.** Compile time, startup, runtime and memory should be
  measured on your machine before comparing HAZMA with C, C++ or Rust.
  `hazma run examples/benchmark.hz` is a starting point, not evidence.

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
- **Lists** — native, mutable and ordered: `l.save`, `l.add`, `l.remove`,
  `l.change`, `l.count`, `l.find`, `l.find.index`, and 1-based indexing
  (`weapons[1]`). Lists hold any supported value, allow duplicates, work
  in functions and structures, and report precise compile-time and
  runtime errors:

  ```
  l.save : weapons = {
      "Sword"
      "Gun"
  }
  l.add : weapons { "Bow" }
  l.change : weapons { 2 = "Rifle" }
  l.remove : weapons { "Bow" }
  log.out { weapons[2] }              // Rifle
  log.out { l.count : weapons }       // 2
  log.out { l.find.index : weapons { "Gun" } }   // 0
  ```
- **Real diagnostics** — every problem has an `H` code, a precise
  span, a plain-English message and often a `help:` line
  (`error[H3012]: "age" holds a string and cannot be changed to a
  number ... help: use t.change : age = ...`). 131 distinct codes.
- **Real native executables** — `run`, `build`, `--emit-c`, `--keep`,
  `-o`, and `--interpret`, backed by a C runtime that implements values,
  strings, lists, structures, arithmetic, diagnostics and the named-repeat
  pause/resume machine. See [Native compilation](#native-compilation).
- **CLI** — `hazma run | build | interpret | check | ast | new | version | help`.
- **Docs** — language spec, design decisions (locked + open questions),
  compiler architecture: see [`docs/`](docs/).
- **Examples** — `examples/01_hello.hz` through `examples/07_lists.hz`,
  each with exact-output tests (run natively and compared against the
  interpreter).
- **Tests** — `npm test` runs the full suite (177 tests: lexer, parser,
  semantics, runtime, lists, example programs, and native compile/run
  tests that skip when no C toolchain is present).
- **VS Code extension** — syntax highlighting, snippets, diagnostics
  reusing the real compiler, and a run button: see
  [`vscode-hazma/`](vscode-hazma/).

## Not built yet (by design)

- **LLVM / direct object-code backend** — the shipped backend emits C and
  uses the host C compiler. A direct LLVM or Cranelift backend would cut
  the C round-trip and remove the MSVC dependency; not started.
- **Bytecode compiler + VM** — an alternative execution path that would
  keep the current interpreter's portability without a C toolchain.
- **Memory reclamation** — the native runtime currently allocates for the
  life of the process.
- **The web layer** — elements, styling and events as HAZMA constructs
  (the part that actually replaces HTML/CSS/JS). Next major phase.
- **Package manager, LSP, browser runtime.**

## Quick start

```powershell
cd hazma
npm install        # typescript + @types/node only
npm run build
node bin/hazma.js run examples/01_hello.hz          # compiles, then runs
node bin/hazma.js run examples/03_loops.hz          # pause/resume via fibers
node bin/hazma.js build examples/07_lists.hz -o lists.exe
node bin/hazma.js run examples/06_rpg.hz --interpret  # old interpreter
node bin/hazma.js check examples/06_rpg.hz
node bin/hazma.js new my-app
npm test
```

Native compilation needs a C toolchain. On Windows, install **MSVC Build
Tools** (the driver looks for Visual Studio 2022 Build Tools). On other
platforms set `HAZMA_CC=clang` (or `gcc`) and avoid named repeats, which
need Windows fibers.

## Benchmarks

There is a small loop benchmark in `examples/benchmark.hz`. To compare
honestly, measure the same algorithm in each language on the same machine
and report compile time, startup, runtime and peak memory separately. The
project makes **no claim** that HAZMA is faster than C, C++ or Rust; the
generated C is ordinary C and the runtime adds dynamic-value overhead.

```powershell
npm run bench                 # compile time, startup, runtime, peak memory
npm run bench -- examples/07_lists.hz --runs 5
```

`scripts/benchmark.mjs` reports the four numbers separately and prints no
cross-language claim. Peak memory on Windows is sampled every 50 ms while
the process runs.

Measured on the development machine (Windows 11 x64, Node 26, MSVC 2022
Build Tools, `HAZMA_OPT=/O2`), `examples/benchmark.hz` (1,000,000,000
increments):

| Metric        | Value                                        |
| ------------- | -------------------------------------------- |
| compile time  | 9,641 ms (cold)                              |
| startup       | 36.2 ms (best of 3, trivial program)         |
| runtime       | 8,992 ms (best of 3, median 9,018 ms)        |
| peak memory   | 3.4 MB (sampled)                             |

Almost all of that compile time is MSVC environment activation:
`vcvars64.bat` alone takes ~9,120 ms on this machine, so the HAZMA→C
generation plus `cl /O2` compile and link is under a second. These are
single-machine numbers, not a comparison.

## Learn the language

- [`docs/LANGUAGE_SPEC.md`](docs/LANGUAGE_SPEC.md) — the full language,
  including the error-code tables.
- [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md) — what is locked
  (e.g. `repeat.break` pauses rather than discards; recursion is
  statically rejected) and what is still open.
- [`examples/`](examples/) — seven runnable programs from hello-world to
  an RPG-style fight loop, including a complete List tour, plus a
  benchmark loop.

## Project layout

```
hazma/
├── bin/hazma.js            # CLI entry point
├── src/                    # compiler + runtime source (TypeScript)
│   ├── lexer/  parser/  ast/  semantic/  runtime/
│   ├── backend/            # native backend
│   │   ├── cgen.ts         # AST -> C code generator
│   │   ├── native.ts       # toolchain detection, compile, execute
│   │   └── runtime/hazma_rt.c   # native C runtime
│   ├── cli.ts  index.ts  errors.ts
├── scripts/copy-runtime.mjs
├── tests/                  # node:test suite (177 tests)
├── examples/               # 01_hello.hz ... 07_lists.hz, benchmark.hz
├── docs/                   # language spec, decisions, architecture
└── vscode-hazma/           # VS Code extension (highlighting, diagnostics, run)
```

## License

MIT — see [`LICENSE`](LICENSE).
