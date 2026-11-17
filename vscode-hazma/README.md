# HAZMA for Visual Studio Code

![HAZMA](assets/wordmark.png)

The official VS Code extension for the **HAZMA** language (`.hz` files) —
one language for building websites and web applications, designed to
replace HTML, CSS and JavaScript.

![icon](assets/icon.png)

## Features

- **Syntax highlighting** — full TextMate grammar for the language:
  dotted commands (`save :`, `t.change :`, `log.out { ... }`,
  `s.change`, `repeat`, `func.p/c/r`, `struct.c/base`, `const.`),
  boolean names (`is.ready`, `is.fight.over`), the `.r` round operator,
  strings with escapes, numbers and comments (`//`).
- **Real compiler diagnostics** — as you type, the bundled HAZMA
  compiler (the exact code the CLI runs, dependency-free) parses and
  fully analyzes your program and reports problems in the Problems
  panel with precise spans and H-codes, e.g.
  `error[H3012]: "age" holds a string and cannot be changed to a number`.
- **Run Program** — `Ctrl+F5`, the `$(play)` button in the editor title
  bar, the "Run HAZMA" code lens at the top of the file, or the command
  palette (`HAZMA: Run Program`). Output goes to the **HAZMA** output
  channel.
- **Check Program** — compile without executing.
- **Snippets** — `save`, `change`, `t.change`, `log`, `if`, `ifelse`,
  `elseif`, `s.change`, `repeat`, `repeatnamed`, `repeat.break`,
  `repeat.continue`, `repeat.new`, `func`, `func.p`, `func.c`,
  `func.r`, `struct`, `struct.base`, `struct.c`, `const.`.

## Requirements

- VS Code 1.75 or newer. No other dependencies — the compiler ships
  inside the extension.

## Extension Settings

None yet — diagnostics run automatically on open/change/save of `.hz`
files.

## Building from source

The compiler core is bundled at build time from the HAZMA repository:

```powershell
# from the hazma repository root
npm run build
node scripts/bundle-extension.mjs   # copies dist/src -> vscode-hazma/core as .mjs
cd vscode-hazma
npx @vscode/vsce package            # produces hazma-0.1.0.vsix
```

## Known Issues

The extension reports exactly what the compiler reports. There is no
language server yet (no hovers, no completions beyond snippets) — that
is planned alongside the bytecode compiler phase.

## License

MIT — see [LICENSE](LICENSE).
