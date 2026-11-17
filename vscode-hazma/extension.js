// HAZMA - VS Code extension.
//
// Reuses the real HAZMA compiler (bundled in ./core) for:
//   - live diagnostics for .hz files (parse + full semantic analysis)
//   - the "HAZMA: Run Program" command (Ctrl+F5 or the editor title play button)
//   - the "HAZMA: Check Program" command
//
// The core is the compiled, dependency-free compiler pipeline:
//   core/index.mjs exports analyze, runSource, Interpreter, HazmaError, ...

const vscode = require("vscode");
const path = require("path");
const { pathToFileURL } = require("url");

let corePromise = null;

/** Load the bundled compiler once (absolute URL so it resolves regardless of CWD). */
function loadCore() {
  if (!corePromise) {
    const coreUrl = pathToFileURL(path.join(__dirname, "core", "index.mjs")).href;
    corePromise = import(coreUrl);
  }
  return corePromise;
}

const diagnostics = vscode.languages.createDiagnosticCollection("hazma");
let outputChannel = null;
let changeTimer = null;

function channel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("HAZMA");
  }
  return outputChannel;
}

/** 1-based HAZMA span -> 0-based VS Code range. */
function toRange(span) {
  if (!span || !span.start) {
    return new vscode.Range(0, 0, 0, 1);
  }
  const start = new vscode.Position(
    Math.max(0, span.start.line - 1),
    Math.max(0, span.start.col - 1),
  );
  const end =
    span.end && span.end.line
      ? new vscode.Position(Math.max(0, span.end.line - 1), Math.max(0, span.end.col - 1))
      : new vscode.Position(start.line, start.character + 1);
  return new vscode.Range(start, end);
}

function toVsDiagnostic(d) {
  // Every H-code is a hard error (no warnings in the spec); H4 = runtime error.
  const severity = vscode.DiagnosticSeverity.Error;
  const v = new vscode.Diagnostic(toRange(d.span), `${d.message} (${d.code})`, severity);
  v.source = "hazma";
  if (d.help) {
    v.relatedInformation = undefined;
    v.message += ` — ${d.help}`;
  }
  return v;
}

/** Compile a document and publish its problems. */
async function updateDiagnostics(document) {
  if (document.languageId !== "hazma") return;
  const core = await loadCore();
  const file = document.fileName || "program.hz";
  const source = document.getText();
  try {
    const result = core.analyze(source);
    diagnostics.set(document.uri, result.diagnostics.map(toVsDiagnostic));
  } catch (e) {
    if (e && e.code) {
      diagnostics.set(document.uri, [toVsDiagnostic(core.toDiagnostic(e))]);
    } else {
      diagnostics.set(document.uri, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), String(e && e.message ? e.message : e), "error"),
      ]);
    }
  }
  void file;
}

/** Clear diagnostics for a closed document. */
function clearDiagnostics(document) {
  if (document && document.uri) diagnostics.delete(document.uri);
}

function isHazmaEditor(editor) {
  return !!editor && editor.document && editor.document.languageId === "hazma";
}

/** HAZMA: Run Program — compile then execute, output in the HAZMA channel. */
async function runProgram(checkOnly) {
  const editor = vscode.window.activeTextEditor;
  if (!isHazmaEditor(editor)) {
    vscode.window.showInformationMessage("Open a .hz file to run HAZMA.");
    return;
  }
  try {
    await Promise.resolve(editor.document.save());
  } catch {
    // saving is best-effort; run on the in-memory text either way
  }
  const core = await loadCore();
  const source = editor.document.getText();
  const file = editor.document.fileName;
  const out = channel();
  out.clear();
  out.show(true);

  const result = core.runSource(source);
  if (!result.ok) {
    out.appendLine(`HAZMA - ${result.diagnostics.length} problem(s) in ${file}`);
    out.appendLine("");
    out.appendLine(core.renderDiagnostics(source, file, result.diagnostics));
    diagnostics.set(editor.document.uri, result.diagnostics.map(toVsDiagnostic));
    void vscode.window.showErrorMessage(`HAZMA: ${result.diagnostics.length} problem(s) - see the HAZMA output`);
    return;
  }
  diagnostics.delete(editor.document.uri);
  if (checkOnly) {
    out.appendLine(`HAZMA: no problems found in ${file}`);
    return;
  }
  out.appendLine(`HAZMA - running ${file}`);
  out.appendLine("----------------------------------------");
  // stream output in chunks so very large programs (100k+ lines) print
  // completely without choking the output channel on per-line calls
  const output = result.output;
  const CHUNK = 2000;
  for (let i = 0; i < output.length; i += CHUNK) {
    out.append(output.slice(i, i + CHUNK).join("\n"));
    out.append("\n");
  }
  out.appendLine("----------------------------------------");
  out.appendLine(`finished with ${output.length} line(s) of output`);
}

function activate(context) {
  const subscriptions = context.subscriptions;

  subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "hazma" }, {
      provideCodeLenses(document) {
        const top = new vscode.Range(0, 0, 0, 0);
        return [
          new vscode.CodeLens(top, {
            title: "$(play) Run HAZMA",
            command: "hazma.run",
            tooltip: "Compile and execute this program (Ctrl+F5)",
          }),
        ];
      },
    }),
  );

  subscriptions.push(
    vscode.commands.registerCommand("hazma.run", () => runProgram(false)),
    vscode.commands.registerCommand("hazma.check", () => runProgram(true)),
  );

  // diagnostics on open / change (debounced) / save / close
  subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => {
      void updateDiagnostics(d);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.document || e.document.languageId !== "hazma") return;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        void updateDiagnostics(e.document);
      }, 250);
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      void updateDiagnostics(d);
    }),
    vscode.workspace.onDidCloseTextDocument(clearDiagnostics),
  );

  // already-open documents when the extension activates late
  for (const d of vscode.workspace.textDocuments) {
    if (d.languageId === "hazma") {
      void updateDiagnostics(d);
    }
  }
}

function deactivate() {
  if (changeTimer) clearTimeout(changeTimer);
}

module.exports = { activate, deactivate };
