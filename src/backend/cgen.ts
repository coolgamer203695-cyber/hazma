// HAZMA - native code generator.
//
// Translates the analyzed AST to C. The C is then compiled and linked by the
// host toolchain (MSVC on Windows today) into a real native executable.
//
// The generated program uses the HAZMA runtime (src/backend/runtime/hazma_rt.c)
// for tagged values, lists, structures, printing and the named-repeat machine.
//
// Code shape:
//   - every global variable is a field of `G` (zero-initialized)
//   - every function has a stack activation struct reached through `a`
//   - every named repeat has a body function; repeats that are paused by
//     repeat.break run that body on a Windows fiber so the C stack survives
//   - every expression is materialized in source order, so side effects match
//     the tree-walking interpreter

import type { Diagnostic, Span } from "../errors.js";
import type {
  Expr,
  FuncCall,
  PropAssign,
  RepeatNamed,
  Stmt,
} from "../ast/nodes.js";
import type { AnalysisResult, FuncIR } from "../semantic/analyzer.js";

export interface CGenResult {
  /** generated C (without the shared runtime header) */
  code: string;
  diagnostics: Diagnostic[];
}

type Field = { name: string; field: string };

interface Scope {
  kind: "global" | "func";
  fn: FuncIR | null;
  act: string | null;
  /** HAZMA name -> activation/global field name */
  vars: Map<string, Field>;
  /** locals of this activation (function scope only) */
  locals: Map<string, Field>;
  loops: Map<RepeatNamed, LoopInfo>;
}

interface LoopInfo {
  decl: RepeatNamed;
  id: number;
  owner: Scope;
  field: string;
  pausable: boolean;
  used: { name: string; local: Field | null }[];
}

const HZ_NONE = "HZ_NONE";
const HZ_FRESH = "HZ_LOOP_FRESH";
const HZ_PAUSED = "HZ_LOOP_PAUSED";
const HZ_FINISHED = "HZ_LOOP_FINISHED";

// ---------------------------------------------------------------------------
// C literal helpers
// ---------------------------------------------------------------------------

/** Escape a JavaScript string as a C string literal (UTF-8, octal escapes). */
function cString(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = '"';
  for (const byte of bytes) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += "\\" + byte.toString(8).padStart(3, "0");
  }
  return out + '"';
}

/** A C double literal that parses back to the same IEEE-754 value. */
function cNumber(n: number): string {
  if (Number.isNaN(n)) return "(0.0 / 0.0)";
  if (!Number.isFinite(n)) return n > 0 ? "(1.0 / 0.0)" : "(-1.0 / 0.0)";
  if (Object.is(n, -0)) return "(-0.0)";
  const text = String(n);
  if (!/[.eE]/.test(text)) return text + ".0";
  return text;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

// ---------------------------------------------------------------------------
// generator
// ---------------------------------------------------------------------------

class Generator {
  private readonly F: string;
  private readonly diags: Diagnostic[] = [];

  private globalVars = new Map<string, Field>();
  private globalVarList: Field[] = [];
  private globalLoopList: LoopInfo[] = [];

  private structs: {
    name: string;
    props: { name: string; isConst: boolean }[];
  }[] = [];
  private structIndex = new Map<string, number>();

  private fns: {
    fn: FuncIR;
    id: number;
    act: string;
    locals: Map<string, Field>;
    localList: Field[];
    scope: Scope;
    loops: LoopInfo[];
  }[] = [];
  private fnIndex = new Map<string, number>();

  private loopInfos = new Map<RepeatNamed, LoopInfo>();
  private loopCounter = 0;
  private tmpCounter = 0;

  private out: string[] = [];

  constructor(
    private readonly result: AnalysisResult,
    private readonly file: string,
  ) {
    this.F = cString(file);
  }

  // ---------------------------------------------------------------- layout

  generate(): CGenResult {
    this.collectGlobals(this.result.stmts);
    this.collectStructs();
    this.collectFunctions();
    this.collectLoops(this.result.stmts, this.globalScope());
    for (const info of this.fns) this.collectLoops(info.fn.body, info.scope);
    this.collectPausable();
    this.rejectUnsupportedReturns();

    if (this.diags.length > 0) return { code: "", diagnostics: this.diags };

    this.emitHeader();
    this.emitStructTables();
    this.emitGlobalStorage();
    this.emitActivations();
    this.emitPrototypes();
    this.emitStructFactories();
    for (const info of this.fns) {
      for (const loop of info.loops) this.emitLoopBody(loop);
    }
    for (const loop of this.globalLoopList) this.emitLoopBody(loop);
    for (const info of this.fns) this.emitFunction(info);
    this.emitMain();

    return { code: this.out.join("\n") + "\n", diagnostics: [] };
  }

  private globalScopeInstance: Scope | null = null;

  private globalScope(): Scope {
    if (!this.globalScopeInstance) {
      this.globalScopeInstance = {
        kind: "global",
        fn: null,
        act: null,
        vars: this.globalVars,
        locals: new Map(),
        loops: new Map(),
      };
    }
    return this.globalScopeInstance;
  }

  private collectGlobals(stmts: Stmt[]): void {
    for (const stmt of stmts) {
      if (stmt.kind === "save" || stmt.kind === "assign") {
        if (stmt.target.length > 0) this.addGlobal(stmt.target[0]);
        continue;
      }
      if (stmt.kind === "l.save") {
        if (stmt.target.length > 0) this.addGlobal(stmt.target[0]);
        continue;
      }
      if (stmt.kind === "if") {
        for (const b of stmt.branches) this.collectGlobals(b.body);
        if (stmt.elseBody) this.collectGlobals(stmt.elseBody);
      } else if (stmt.kind === "s.change") {
        for (const b of stmt.branches) this.collectGlobals(b.body);
        if (stmt.defaultBody) this.collectGlobals(stmt.defaultBody);
      } else if (stmt.kind === "repeat" || stmt.kind === "repeat.named") {
        this.collectGlobals(stmt.body);
      }
    }
  }

  private addGlobal(name: string): void {
    if (this.globalVars.has(name)) return;
    const field: Field = { name, field: `v${this.globalVarList.length}` };
    this.globalVars.set(name, field);
    this.globalVarList.push(field);
  }

  private collectStructs(): void {
    for (const ir of this.result.structs.values()) {
      this.structIndex.set(ir.name, this.structs.length);
      this.structs.push({
        name: ir.name,
        props: ir.props.map((p) => ({ name: p.name, isConst: p.isConst })),
      });
    }
  }

  private collectFunctions(): void {
    for (const fn of this.result.funcs.values()) {
      const locals = new Map<string, Field>();
      const localList: Field[] = [];
      const add = (name: string) => {
        if (locals.has(name)) return;
        const field: Field = { name, field: `f${localList.length}` };
        locals.set(name, field);
        localList.push(field);
      };
      for (const p of fn.params) add(p.name);
      this.collectLocals(fn.body, add);

      const id = this.fns.length;
      const act = `Act${id}`;
      const scope: Scope = {
        kind: "func",
        fn,
        act,
        vars: locals,
        locals,
        loops: new Map(),
      };
      this.fnIndex.set(fn.name, id);
      this.fns.push({ fn, id, act, locals, localList, scope, loops: [] });
    }
  }

  private collectLocals(stmts: Stmt[], add: (name: string) => void): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "save":
        case "assign":
        case "l.save":
          if (stmt.target.length > 0) add(stmt.target[0]);
          break;
        case "if":
          for (const b of stmt.branches) this.collectLocals(b.body, add);
          if (stmt.elseBody) this.collectLocals(stmt.elseBody, add);
          break;
        case "s.change":
          for (const b of stmt.branches) this.collectLocals(b.body, add);
          if (stmt.defaultBody) this.collectLocals(stmt.defaultBody, add);
          break;
        case "repeat":
        case "repeat.named":
          this.collectLocals(stmt.body, add);
          break;
        default:
          break;
      }
    }
  }

  private collectLoops(stmts: Stmt[], scope: Scope): void {
    for (const stmt of stmts) {
      if (stmt.kind === "repeat.named") {
        const id = this.loopCounter++;
        const info: LoopInfo = {
          decl: stmt,
          id,
          owner: scope,
          field: scope.kind === "func" ? `lp${id}` : `glp${id}`,
          pausable: false,
          used: [],
        };
        this.loopInfos.set(stmt, info);
        scope.loops.set(stmt, info);
        if (scope.kind === "func") {
          const info2 = this.fns.find((f) => f.scope === scope);
          if (info2) info2.loops.push(info);
        } else {
          this.globalLoopList.push(info);
        }
        this.collectLoops(stmt.body, scope);
      } else if (stmt.kind === "if") {
        for (const b of stmt.branches) this.collectLoops(b.body, scope);
        if (stmt.elseBody) this.collectLoops(stmt.elseBody, scope);
      } else if (stmt.kind === "s.change") {
        for (const b of stmt.branches) this.collectLoops(b.body, scope);
        if (stmt.defaultBody) this.collectLoops(stmt.defaultBody, scope);
      } else if (stmt.kind === "repeat") {
        this.collectLoops(stmt.body, scope);
      }
    }
  }

  private collectPausable(): void {
    const visit = (stmts: Stmt[]) => {
      for (const stmt of stmts) {
        switch (stmt.kind) {
          case "repeat.break": {
            const target = stmt.targetDecl;
            if (target) {
              const info = this.loopInfos.get(target);
              if (info) info.pausable = true;
            }
            break;
          }
          case "if":
            for (const b of stmt.branches) visit(b.body);
            if (stmt.elseBody) visit(stmt.elseBody);
            break;
          case "s.change":
            for (const b of stmt.branches) visit(b.body);
            if (stmt.defaultBody) visit(stmt.defaultBody);
            break;
          case "repeat":
          case "repeat.named":
            visit(stmt.body);
            break;
          default:
            break;
        }
      }
    };
    visit(this.result.stmts);
    for (const info of this.fns) visit(info.fn.body);

    // Resolve the variables a repeat restart must snapshot.
    for (const info of this.loopInfos.values()) {
      const seen = new Set<string>();
      for (const name of info.decl.usedVars ?? []) {
        if (seen.has(name)) continue;
        seen.add(name);
        const local = info.owner.kind === "func" ? info.owner.vars.get(name) : undefined;
        if (!local && !this.globalVars.has(name)) continue;
        info.used.push({
          name,
          local: local ?? null,
        });
      }
    }
  }

  private rejectUnsupportedReturns(): void {
    const findReturns = (stmts: Stmt[]): Stmt[] => {
      let found: Stmt[] = [];
      for (const stmt of stmts) {
        if (stmt.kind === "func.r") {
          found.push(stmt);
        } else if (stmt.kind === "if") {
          for (const b of stmt.branches) found = found.concat(findReturns(b.body));
          if (stmt.elseBody) found = found.concat(findReturns(stmt.elseBody));
        } else if (stmt.kind === "s.change") {
          for (const b of stmt.branches) found = found.concat(findReturns(b.body));
          if (stmt.defaultBody) found = found.concat(findReturns(stmt.defaultBody));
        } else if (stmt.kind === "repeat" || stmt.kind === "repeat.named") {
          found = found.concat(findReturns(stmt.body));
        }
      }
      return found;
    };

    const seenReturns = new Set<Stmt>();
    for (const info of this.loopInfos.values()) {
      for (const ret of findReturns(info.decl.body)) {
        if (seenReturns.has(ret)) continue;
        seenReturns.add(ret);
        this.diags.push({
          code: "H5001",
          message: `func.r inside repeat "${info.decl.name}" cannot be compiled natively yet`,
          span: ret.span,
          help:
            "a named repeat compiles to its own body function, so a value cannot return " +
            "through it - move func.r outside the repeat, or use hazma run --interpret",
        });
      }
    }
  }

  // ------------------------------------------------------------ C assembly

  private emitHeader(): void {
    this.out.push("/* Generated by HAZMA from " + this.file.replace(/\*\//g, "* /") + " */");
    // The runtime is included textually so every helper stays `static` and the
    // whole program is a single translation unit. hazma_rt.c is copied next to
    // this file by the native build driver.
    this.out.push('#include "hazma_rt.c"');
    this.out.push("");
  }

  private emitStructTables(): void {
    if (this.structs.length === 0) return;
    for (let i = 0; i < this.structs.length; i++) {
      const st = this.structs[i];
      const names = st.props.map((p) => cString(p.name)).join(", ") || "0";
      const consts = st.props.map((p) => (p.isConst ? "1" : "0")).join(", ") || "0";
      this.out.push(`static const char *const props_${i}[] = { ${names} };`);
      this.out.push(`static const unsigned char consts_${i}[] = { ${consts} };`);
      this.out.push(
        `static const HzStructDef sdef_${i} = { ${cString(st.name)}, ${st.props.length}, props_${i}, consts_${i} };`,
      );
    }
    this.out.push("");
  }

  private emitGlobalStorage(): void {
    this.out.push("typedef struct {");
    for (const v of this.globalVarList) this.out.push(`  HzValue ${v.field};`);
    for (const loop of this.globalLoopList) this.out.push(`  HzLoop ${loop.field};`);
    this.out.push("  int _pad;");
    this.out.push("} HzGlobals;");
    this.out.push("static HzGlobals G;");
    for (const loop of this.globalLoopList) {
      if (loop.used.length > 0) {
        this.out.push(`static HzValue gsn${loop.id}[${loop.used.length}];`);
      }
    }
    this.out.push("");
  }

  private emitActivations(): void {
    for (const info of this.fns) {
      this.out.push("typedef struct {");
      for (const v of info.localList) this.out.push(`  HzValue ${v.field};`);
      for (const loop of info.loops) this.out.push(`  HzLoop ${loop.field};`);
      for (const loop of info.loops) {
        if (loop.used.length > 0) {
          this.out.push(`  HzValue sn${loop.id}[${loop.used.length}];`);
        }
      }
      this.out.push("  HzValue ret;");
      this.out.push("  int _pad;");
      this.out.push(`} ${info.act};`);
    }
    this.out.push("");
  }

  private emitPrototypes(): void {
    for (let i = 0; i < this.structs.length; i++) {
      this.out.push(`static HzValue mk${i}(void);`);
    }
    for (const info of this.fns) {
      for (const loop of info.loops) {
        this.out.push(`static void lb${loop.id}(HzLoop *loop, void *ctx);`);
      }
      this.out.push(`static HzValue ${this.fnName(info.id)}(${this.paramSignature(info.fn)});`);
    }
    for (const loop of this.globalLoopList) {
      this.out.push(`static void lb${loop.id}(HzLoop *loop, void *ctx);`);
    }
    this.out.push("");
  }

  private fnName(id: number): string {
    return `fn${id}`;
  }

  private paramSignature(fn: FuncIR): string {
    if (fn.params.length === 0) return "void";
    return fn.params
      .map((_, i) => `HzValue arg${i}, int has${i}`)
      .join(", ");
  }

  private emitStructFactories(): void {
    for (let i = 0; i < this.structs.length; i++) {
      const ir = [...this.result.structs.values()][i];
      this.out.push(`static HzValue mk${i}(void) {`);
      this.out.push(`  HzValue s = hz_struct_make(&sdef_${i});`);
      ir.props.forEach((p, at) => {
        const pre: string[] = [];
        const value = this.constExpr(p.defaultExpr, pre);
        for (const line of pre) this.out.push("  " + line);
        this.out.push(`  hz_struct_put(s, ${at}, ${value});`);
      });
      this.out.push("  return s;");
      this.out.push("}");
      this.out.push("");
    }
  }

  // ---------------------------------------------------------------- bodies

  private emitLoopBody(info: LoopInfo): void {
    const scope = info.owner;
    this.tmpCounter = 0;
    this.out.push(`static void lb${info.id}(HzLoop *loop, void *ctx) {`);
    this.out.push("  (void)loop;");
    if (scope.kind === "func") {
      this.out.push(`  ${scope.act} *a = (${scope.act} *)ctx;`);
      this.out.push("  (void)a;");
    } else {
      this.out.push("  (void)ctx;");
    }

    const body: string[] = [];
    this.emitStmts(info.decl.body, scope, body, 1);
    this.out.push("  for (;;) {");
    this.out.push(...body);
    if (info.decl.cond) {
      const cond = this.expr(info.decl.cond, scope);
      this.out.push(...cond.pre.map((l) => "    " + l));
      this.out.push(
        `    if (hz_truth(${cond.code}, "the till condition", ${this.F}, ${this.line(info.decl.cond.span)})) break;`,
      );
    }
    this.out.push("  }");
    this.out.push("}");
    this.out.push("");
  }

  private emitFunction(info: {
    fn: FuncIR;
    id: number;
    act: string;
    locals: Map<string, Field>;
    localList: Field[];
    scope: Scope;
    loops: LoopInfo[];
  }): void {
    const fn = info.fn;
    this.tmpCounter = 0;
    this.out.push(`static HzValue ${this.fnName(info.id)}(${this.paramSignature(fn)}) {`);
    this.out.push(`  ${info.act} act;`);
    this.out.push(`  ${info.act} *a = &act;`);
    this.out.push("  memset(a, 0, sizeof(*a));");

    fn.params.forEach((p, i) => {
      const field = info.locals.get(p.name)!.field;
      this.out.push(`  if (has${i}) {`);
      this.out.push(`    a->${field} = arg${i};`);
      if (p.name.startsWith("is.")) {
        this.out.push(
          `    hz_check_param(a->${field}, ${cString(p.name)}, ${this.F}, ${this.line(p.span)});`,
        );
      }
      this.out.push("  } else {");
      if (p.hasDefault && p.defaultExpr) {
        const value = this.expr(p.defaultExpr, info.scope);
        this.out.push(...value.pre.map((l) => "    " + l));
        this.out.push(`    a->${field} = ${value.code};`);
      } else {
        this.out.push(
          `    hz_rt_error("H4026", ${this.F}, ${this.line(p.span)}, "the argument \\"%s\\" is missing in the call to \\"%s\\"", ${cString(p.name)}, ${cString(fn.name)});`,
        );
        this.out.push(`    a->${field} = hz_none();`);
      }
      this.out.push("  }");
    });

    const body: string[] = [];
    this.emitStmts(fn.body, info.scope, body, 1);
    this.out.push(...body);
    this.out.push("  return hz_none();");
    this.out.push("}");
    this.out.push("");
  }

  private emitMain(): void {
    this.tmpCounter = 0;
    this.out.push("int main(void) {");
    this.out.push("  hz_rt_init();");
    const body: string[] = [];
    this.emitStmts(this.result.stmts, this.globalScope(), body, 1);
    this.out.push(...body);
    this.out.push("  return 0;");
    this.out.push("}");
  }

  // ------------------------------------------------------------- statements

  private emitStmts(stmts: Stmt[], scope: Scope, out: string[], depth: number): void {
    for (const stmt of stmts) this.emitStmt(stmt, scope, out, depth);
  }

  private emitStmt(stmt: Stmt, scope: Scope, out: string[], depth: number): void {
    const pad = indent(depth);
    switch (stmt.kind) {
      case "func":
      case "struct":
      case "func.p":
        return;

      case "save":
      case "assign":
      case "t.change": {
        const value = this.expr(stmt.expr, scope);
        out.push(...value.pre.map((l) => pad + l));
        const tmp = this.tmp(out, pad, value.code);
        const target = this.varTarget(stmt.target, scope);
        const slot = this.ptrTmp(out, pad, target.slot);
        const retype = stmt.kind === "t.change" ? 1 : 0;
        out.push(
          `${pad}hz_set_var(${slot}, ${tmp}, ${cString(target.display)}, ${target.isIs ? 1 : 0}, ${this.F}, ${this.line(stmt.span)}, ${retype});`,
        );
        return;
      }

      case "change": {
        if (stmt.expr) {
          const value = this.expr(stmt.expr, scope);
          out.push(...value.pre.map((l) => pad + l));
          const tmp = this.tmp(out, pad, value.code);
          const target = this.propTarget(stmt.target, scope, stmt.span);
          if (target.kind === "var") {
            const slot = this.ptrTmp(out, pad, target.slot);
            out.push(
              `${pad}hz_set_var(${slot}, ${tmp}, ${cString(target.display)}, ${target.isIs ? 1 : 0}, ${this.F}, ${this.line(stmt.span)}, 0);`,
            );
          } else {
            const slot = this.ptrTmp(out, pad, target.slot);
            out.push(
              `${pad}hz_set_var(${slot}, ${tmp}, ${cString(target.display)}, 0, ${this.F}, ${this.line(stmt.span)}, 0);`,
            );
          }
        } else if (stmt.props) {
          this.emitMultiChange(stmt.target, stmt.props, scope, out, depth, stmt.span);
        }
        return;
      }

      case "l.save": {
        const value = this.listLiteral(stmt.items, scope);
        out.push(...value.pre.map((l) => pad + l));
        const tmp = this.tmp(out, pad, value.code);
        const target = this.varTarget(stmt.target, scope);
        const slot = this.ptrTmp(out, pad, target.slot);
        out.push(
          `${pad}hz_set_var(${slot}, ${tmp}, ${cString(target.display)}, ${target.isIs ? 1 : 0}, ${this.F}, ${this.line(stmt.span)}, 0);`,
        );
        return;
      }

      case "l.add": {
        const read = this.pathExpr(stmt.target, scope, stmt.span);
        const list = this.tmp(out, pad, read);
        const targetName = cString(stmt.target.join("."));
        out.push(`${pad}hz_list_assert(${list}, "l.add", ${targetName}, ${this.F}, ${this.line(stmt.span)});`);
        for (const item of stmt.items) {
          const value = this.expr(item, scope);
          out.push(...value.pre.map((l) => pad + l));
          const tmp = this.tmp(out, pad, value.code);
          out.push(
            `${pad}hz_list_add(${list}, ${tmp}, ${targetName}, ${this.F}, ${this.line(item.span)});`,
          );
        }
        return;
      }

      case "l.remove": {
        const read = this.pathExpr(stmt.target, scope, stmt.span);
        const list = this.tmp(out, pad, read);
        const targetName = cString(stmt.target.join("."));
        out.push(
          `${pad}hz_list_assert(${list}, "l.remove", ${targetName}, ${this.F}, ${this.line(stmt.span)});`,
        );
        for (const value of stmt.values) {
          const v = this.expr(value, scope);
          out.push(...v.pre.map((l) => pad + l));
          const tmp = this.tmp(out, pad, v.code);
          out.push(
            `${pad}hz_list_remove(${list}, ${tmp}, ${targetName}, ${this.F}, ${this.line(value.span)});`,
          );
        }
        return;
      }

      case "l.change": {
        const read = this.pathExpr(stmt.target, scope, stmt.span);
        const list = this.tmp(out, pad, read);
        const targetName = cString(stmt.target.join("."));
        out.push(
          `${pad}hz_list_assert(${list}, "l.change", ${targetName}, ${this.F}, ${this.line(stmt.span)});`,
        );
        for (const change of stmt.changes) {
          const index = this.expr(change.index, scope);
          out.push(...index.pre.map((l) => pad + l));
          const idx = this.tmp(out, pad, index.code);
          const at = this.intTmp(
            out,
            pad,
            `hz_list_index_checked(${list}, ${idx}, ${targetName}, ${this.F}, ${this.line(change.span)})`,
          );
          const value = this.expr(change.value, scope);
          out.push(...value.pre.map((l) => pad + l));
          const tmp = this.tmp(out, pad, value.code);
          out.push(`${pad}hz_list_set_at(${list}, ${at}, ${tmp});`);
        }
        return;
      }

      case "log": {
        const value = this.expr(stmt.expr, scope);
        out.push(...value.pre.map((l) => pad + l));
        out.push(`${pad}hz_print(${value.code});`);
        return;
      }

      case "if": {
        out.push(`${pad}do {`);
        for (const branch of stmt.branches) {
          const cond = this.expr(branch.cond, scope);
          out.push(...cond.pre.map((l) => pad + "  " + l));
          out.push(
            `  if (hz_truth(${cond.code}, "the if condition", ${this.F}, ${this.line(branch.cond.span)})) {`,
          );
          this.emitStmts(branch.body, scope, out, depth + 2);
          out.push("    break;");
          out.push("  }");
        }
        if (stmt.elseBody) {
          this.emitStmts(stmt.elseBody, scope, out, depth + 1);
        }
        out.push(`${pad}} while (0);`);
        return;
      }

      case "s.change": {
        const subject = this.expr(stmt.subject, scope);
        out.push(...subject.pre.map((l) => pad + l));
        const tmp = this.tmp(out, pad, subject.code);
        out.push(`${pad}do {`);
        for (const branch of stmt.branches) {
          const value = this.expr(branch.value, scope);
          out.push(...value.pre.map((l) => pad + "  " + l));
          out.push(`  if (hz_eq(${tmp}, ${value.code})) {`);
          this.emitStmts(branch.body, scope, out, depth + 2);
          out.push("    break;");
          out.push("  }");
        }
        if (stmt.defaultBody) {
          this.emitStmts(stmt.defaultBody, scope, out, depth + 1);
        }
        out.push(`${pad}} while (0);`);
        return;
      }

      case "repeat": {
        out.push(`${pad}for (;;) {`);
        this.emitStmts(stmt.body, scope, out, depth + 1);
        const cond = this.expr(stmt.cond, scope);
        out.push(...cond.pre.map((l) => pad + "  " + l));
        out.push(
          `  if (hz_truth(${cond.code}, "the repeat condition", ${this.F}, ${this.line(stmt.cond.span)})) break;`,
        );
        out.push(`${pad}}`);
        return;
      }

      case "repeat.named": {
        const info = this.loopInfos.get(stmt);
        if (!info) return;
        const sym = this.loopSym(info);
        this.emitCapture(info, scope, out, pad);
        out.push(
          `${pad}hz_loop_enter(&${sym}, lb${info.id}, ${this.loopCtx(info)}, ${info.pausable ? 1 : 0}, ${cString(stmt.name)}, ${this.F}, ${this.line(stmt.span)});`,
        );
        return;
      }

      case "repeat.break": {
        const info = stmt.targetDecl ? this.loopInfos.get(stmt.targetDecl) : undefined;
        if (!info) return;
        out.push(
          `${pad}hz_loop_pause(&${this.loopSym(info)}, ${this.F}, ${this.line(stmt.span)});`,
        );
        return;
      }

      case "repeat.continue": {
        const info = stmt.targetDecl ? this.loopInfos.get(stmt.targetDecl) : undefined;
        if (!info) return;
        const sym = this.loopSym(info);
        this.emitCapture(info, scope, out, pad);
        out.push(
          `${pad}hz_loop_continue(&${sym}, lb${info.id}, ${this.loopCtx(info)}, ${info.pausable ? 1 : 0}, ${cString(stmt.name)}, ${this.F}, ${this.line(stmt.span)});`,
        );
        return;
      }

      case "repeat.new": {
        const info = stmt.targetDecl ? this.loopInfos.get(stmt.targetDecl) : undefined;
        if (!info) return;
        const sym = this.loopSym(info);
        out.push(`${pad}if (${sym}.state == ${HZ_FRESH}) {`);
        this.emitCapture(info, scope, out, pad + "  ", true);
        out.push(`${pad}} else if (${sym}.state == ${HZ_PAUSED} || ${sym}.state == ${HZ_FINISHED}) {`);
        this.emitRestore(info, out, pad + "  ");
        out.push(`${pad}}`);
        out.push(
          `${pad}hz_loop_new(&${sym}, lb${info.id}, ${this.loopCtx(info)}, ${info.pausable ? 1 : 0}, ${cString(stmt.name)}, ${this.F}, ${this.line(stmt.span)});`,
        );
        return;
      }

      case "func.c.stmt": {
        const call = this.call(stmt.call, scope);
        out.push(...call.pre.map((l) => pad + l));
        out.push(`${pad}${call.code};`);
        return;
      }

      case "func.r": {
        const value = this.expr(stmt.expr, scope);
        out.push(...value.pre.map((l) => pad + l));
        out.push(`${pad}a->ret = ${value.code};`);
        out.push(`${pad}return a->ret;`);
        return;
      }
    }
  }

  private emitMultiChange(
    target: string[],
    props: PropAssign[],
    scope: Scope,
    out: string[],
    depth: number,
    span: Span,
  ): void {
    const pad = indent(depth);
    const read = this.pathExpr(target, scope, span);
    const obj = this.tmp(
      out,
      pad,
      `hz_as_struct(${read}, ${cString(target.join("."))}, ${this.F}, ${this.line(span)})`,
    );
    for (const prop of props) {
      const name = cString(prop.name);
      const prefix = cString(target.join("."));
      const slot = this.ptrTmp(
        out,
        pad,
        `hz_prop_slot(${obj}, ${name}, ${prefix}, 1, ${this.F}, ${this.line(prop.span)})`,
      );
      const value = this.expr(prop.expr, scope);
      out.push(...value.pre.map((l) => pad + l));
      const tmp = this.tmp(out, pad, value.code);
      const display = cString(`${target.join(".")}.${prop.name}`);
      out.push(
        `${pad}hz_set_var(${slot}, ${tmp}, ${display}, ${prop.name.startsWith("is.") ? 1 : 0}, ${this.F}, ${this.line(prop.span)}, 0);`,
      );
    }
  }

  private emitCapture(
    info: LoopInfo,
    scope: Scope,
    out: string[],
    pad: string,
    bodyOnly = false,
  ): void {
    if (info.used.length === 0) return;
    const storage = this.snapStorage(info);
    if (!bodyOnly) out.push(`${pad}if (${this.loopSym(info)}.state == ${HZ_FRESH}) {`);
    info.used.forEach((used, i) => {
      out.push(`${pad}${storage}[${i}] = hz_copy(${this.usedLValue(info, used)});`);
    });
    if (!bodyOnly) out.push(`${pad}}`);
  }

  private emitRestore(info: LoopInfo, out: string[], pad: string): void {
    if (info.used.length === 0) return;
    const storage = this.snapStorage(info);
    info.used.forEach((used, i) => {
      out.push(`${pad}${this.usedLValue(info, used)} = hz_copy(${storage}[${i}]);`);
    });
  }

  private snapStorage(info: LoopInfo): string {
    return info.owner.kind === "func" ? `a->sn${info.id}` : `gsn${info.id}`;
  }

  private usedLValue(info: LoopInfo, used: { name: string; local: Field | null }): string {
    if (used.local) return `a->${used.local.field}`;
    const global = this.globalVars.get(used.name);
    if (!global) return `G.v0 /* missing ${used.name.replace(/\*\//g, "* /")} */`;
    return `G.${global.field}`;
  }

  private loopSym(info: LoopInfo): string {
    return info.owner.kind === "func" ? `a->${info.field}` : `G.${info.field}`;
  }

  private loopCtx(info: LoopInfo): string {
    return info.owner.kind === "func" ? "(void *)a" : "(void *)0";
  }

  // ------------------------------------------------------------- assignment

  private varTarget(target: string[], scope: Scope): { slot: string; display: string; isIs: boolean } {
    const name = target.length === 1 ? target[0] : target.join(".");
    const field = scope.kind === "func" ? scope.vars.get(name) : this.globalVars.get(name);
    if (field) {
      const lvalue = scope.kind === "func" ? `a->${field.field}` : `G.${field.field}`;
      return { slot: `&${lvalue}`, display: name, isIs: name.startsWith("is.") };
    }
    return { slot: `hz_missing_slot(${cString(name)}, ${this.F}, 1)`, display: name, isIs: name.startsWith("is.") };
  }

  private propTarget(
    target: string[],
    scope: Scope,
    span: Span,
  ):
    | { kind: "var"; slot: string; display: string; isIs: boolean }
    | { kind: "prop"; slot: string; display: string } {
    if (target.length === 1 || target[0] === "is") {
      return { kind: "var", ...this.varTarget(target, scope) };
    }
    let cur = this.varLValue(target[0], scope);
    for (let i = 1; i < target.length - 1; i++) {
      cur = `hz_prop_get(${cur}, ${cString(target[i])}, ${cString(target.slice(0, i).join("."))}, ${this.F}, ${this.line(span)})`;
    }
    const last = target[target.length - 1];
    const prefix = target.slice(0, target.length - 1).join(".");
    return {
      kind: "prop",
      slot: `hz_prop_slot(${cur}, ${cString(last)}, ${cString(prefix)}, 1, ${this.F}, ${this.line(span)})`,
      display: target.join("."),
    };
  }

  private varLValue(name: string, scope: Scope): string {
    if (scope.kind === "func") {
      const field = scope.vars.get(name);
      if (field) return `a->${field.field}`;
    }
    const global = this.globalVars.get(name);
    if (global) return `G.${global.field}`;
    return `hz_unknown_var(${cString(name)}, ${this.F}, 1)`;
  }

  // ------------------------------------------------------------ expressions

  private tmp(out: string[], pad: string, code: string): string {
    const name = this.nextTmp();
    out.push(`${pad}HzValue ${name} = ${code};`);
    return name;
  }

  private ptrTmp(out: string[], pad: string, code: string): string {
    const name = `p${this.tmpCounter++}`;
    out.push(`${pad}HzValue *${name} = ${code};`);
    return name;
  }

  private intTmp(out: string[], pad: string, code: string): string {
    const name = `n${this.tmpCounter++}`;
    out.push(`${pad}int ${name} = ${code};`);
    return name;
  }

  private nextTmp(): string {
    return `t${this.tmpCounter++}`;
  }

  private expr(e: Expr, scope: Scope): { pre: string[]; code: string } {
    switch (e.kind) {
      case "number":
        return { pre: [], code: `hz_num(${cNumber(e.value)})` };
      case "string":
        return { pre: [], code: `hz_str(${cString(e.value)})` };
      case "boolean":
        return { pre: [], code: `hz_bool(${e.value ? 1 : 0})` };
      case "path":
        return { pre: [], code: this.pathExpr(e.parts, scope, e.span) };

      case "round": {
        const inner = this.expr(e.inner, scope);
        return {
          pre: inner.pre,
          code: `hz_round(${inner.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "neg": {
        const inner = this.expr(e.operand, scope);
        return {
          pre: inner.pre,
          code: `hz_neg(${inner.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "not": {
        const inner = this.expr(e.operand, scope);
        return {
          pre: inner.pre,
          code: `hz_not(${inner.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "binary":
        return this.binaryExpr(e, scope);
      case "struct.c":
        return this.structCreate(e, (x) => this.expr(x, scope));
      case "func.c": {
        const call = this.call(e, scope);
        return { pre: call.pre, code: call.code };
      }
      case "list.lit":
        return this.listLiteral(e.items, scope);
      case "index": {
        const target = this.expr(e.target, scope);
        const index = this.expr(e.index, scope);
        const pre = [...target.pre, ...index.pre];
        return {
          pre,
          code: `hz_index(${target.code}, ${index.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "list.count": {
        const list = this.expr(e.list, scope);
        return {
          pre: list.pre,
          code: `hz_list_count(${list.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "list.find": {
        const list = this.expr(e.list, scope);
        const value = this.expr(e.value, scope);
        return {
          pre: [...list.pre, ...value.pre],
          code: `hz_list_find(${list.code}, ${value.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
      case "list.find.index": {
        const list = this.expr(e.list, scope);
        const value = this.expr(e.value, scope);
        return {
          pre: [...list.pre, ...value.pre],
          code: `hz_list_find_index(${list.code}, ${value.code}, ${this.F}, ${this.line(e.span)})`,
        };
      }
    }
  }

  private binaryExpr(e: Extract<Expr, { kind: "binary" }>, scope: Scope): { pre: string[]; code: string } {
    const op = e.op;
    if (op === "and" || op === "or") return this.logicalExpr(e, scope);

    const left = this.expr(e.left, scope);
    const right = this.expr(e.right, scope);
    const pre = [...left.pre, ...right.pre];
    const l = this.tmp(pre, "", left.code);
    const r = this.tmp(pre, "", right.code);

    switch (op) {
      case "+":
        return { pre, code: `hz_add(${l}, ${r}, ${this.F}, ${this.line(e.span)})` };
      case "-":
        return { pre, code: `hz_sub(${l}, ${r}, ${this.F}, ${this.line(e.span)})` };
      case "*":
        return { pre, code: `hz_mul(${l}, ${r}, ${this.F}, ${this.line(e.span)})` };
      case "/":
        return { pre, code: `hz_div(${l}, ${r}, ${this.F}, ${this.line(e.span)})` };
      case "==":
        return { pre, code: `hz_bool(hz_eq(${l}, ${r}))` };
      case "!=":
        return { pre, code: `hz_bool(!hz_eq(${l}, ${r}))` };
      case ">":
      case "<":
      case ">=":
      case "<=": {
        const compare = op === ">" ? "> 0" : op === "<" ? "< 0" : op === ">=" ? ">= 0" : "<= 0";
        return {
          pre,
          code: `hz_bool(hz_cmp(${l}, ${r}, ${cString(op)}, ${this.F}, ${this.line(e.span)}) ${compare})`,
        };
      }
      default:
        return { pre, code: "hz_bool(0)" };
    }
  }

  private logicalExpr(
    e: Extract<Expr, { kind: "binary" }>,
    scope: Scope,
  ): { pre: string[]; code: string } {
    const op = e.op === "and" ? "and" : "or";
    const left = this.expr(e.left, scope);
    const pre = [...left.pre];
    const l = this.tmp(pre, "", left.code);
    const cond = this.nextTmp();
    pre.push(`int ${cond} = hz_truth(${l}, ${cString(`"${op}"`)}, ${this.F}, ${this.line(e.span)});`);
    const result = this.nextTmp();
    pre.push(`HzValue ${result} = hz_bool(${op === "and" ? 0 : 1});`);
    pre.push(`if (${cond}) {`);
    if (op === "and") {
      const right = this.expr(e.right, scope);
      pre.push(...right.pre);
      const r = this.tmp(pre, "", right.code);
      pre.push(`hz_truth(${r}, ${cString(`"${op}"`)}, ${this.F}, ${this.line(e.span)});`);
      pre.push(`${result} = ${r};`);
    } else {
      pre.push(`${result} = hz_bool(1);`);
    }
    pre.push("} else {");
    if (op === "or") {
      const right = this.expr(e.right, scope);
      pre.push(...right.pre);
      const r = this.tmp(pre, "", right.code);
      pre.push(`hz_truth(${r}, ${cString(`"${op}"`)}, ${this.F}, ${this.line(e.span)});`);
      pre.push(`${result} = ${r};`);
    }
    pre.push("}");
    return { pre, code: result };
  }

  private listLiteral(items: Expr[], scope: Scope): { pre: string[]; code: string } {
    const pre: string[] = [];
    const values = items.map((item) => {
      const value = this.expr(item, scope);
      pre.push(...value.pre);
      return this.tmp(pre, "", value.code);
    });
    return {
      pre,
      code: `hz_list_lit(${values.length}${values.length ? ", " + values.join(", ") : ""})`,
    };
  }

  private structCreate(
    e: Extract<Expr, { kind: "struct.c" }>,
    emit: (expr: Expr) => { pre: string[]; code: string },
  ): { pre: string[]; code: string } {
    const index = this.structIndex.get(e.structName);
    if (index === undefined) {
      return { pre: [], code: "hz_none()" };
    }
    const ir = [...this.result.structs.values()][index];
    const pre: string[] = [];
    let code = `mk${index}()`;
    for (const override of e.overrides) {
      const at = ir.index.get(override.name);
      if (at === undefined) continue;
      const value = emit(override.expr);
      pre.push(...value.pre);
      const tmp = this.tmp(pre, "", value.code);
      code = `hz_struct_put(${code}, ${at}, ${tmp})`;
    }
    return { pre, code };
  }

  private constExpr(e: Expr, pre: string[] = []): string {
    switch (e.kind) {
      case "number":
        return `hz_num(${cNumber(e.value)})`;
      case "string":
        return `hz_str(${cString(e.value)})`;
      case "boolean":
        return `hz_bool(${e.value ? 1 : 0})`;
      case "neg": {
        const inner = this.constExpr(e.operand, pre);
        return `hz_neg(${inner}, ${this.F}, ${this.line(e.span)})`;
      }
      case "struct.c": {
        const created = this.structCreate(e, (x) => ({
          pre: [],
          code: this.constExpr(x, pre),
        }));
        pre.push(...created.pre);
        return created.code;
      }
      case "list.lit": {
        const values = e.items.map((x) => {
          const value = this.constExpr(x, pre);
          return this.tmp(pre, "", value);
        });
        return `hz_list_lit(${e.items.length}${values.length ? ", " + values.join(", ") : ""})`;
      }
      default:
        return "hz_none()";
    }
  }

  private call(call: FuncCall, scope: Scope): { pre: string[]; code: string } {
    const id = this.fnIndex.get(call.funcName);
    const fn = this.result.funcs.get(call.funcName);
    if (id === undefined || !fn) {
      return { pre: [], code: `hz_unknown_func(${cString(call.funcName)}, ${this.F}, ${this.line(call.span)})` };
    }

    // Evaluate every argument in the order written.
    const provided = new Map<string, string>();
    const positional: string[] = [];
    const pre: string[] = [];
    for (const arg of call.args) {
      const value = this.expr(arg.expr, scope);
      pre.push(...value.pre);
      const tmp = this.tmp(pre, "", value.code);
      positional.push(tmp);
      if (arg.name) provided.set(arg.name, tmp);
    }

    const named = call.args.some((a) => a.name !== undefined);
    const args = fn.params.map((param, i) => {
      const tmp = named ? provided.get(param.name) : positional[i];
      if (tmp === undefined) return "hz_none(), 0";
      return `${tmp}, 1`;
    });

    return {
      pre,
      code: `${this.fnName(id)}(${args.join(", ")})`,
    };
  }

  private pathExpr(parts: string[], scope: Scope, span: Span): string {
    if (parts[0] === "is" || parts.length === 1) {
      return this.varLValue(parts[0] === "is" ? parts.join(".") : parts[0], scope);
    }
    let cur = this.varLValue(parts[0], scope);
    for (let i = 1; i < parts.length; i++) {
      cur = `hz_prop_get(${cur}, ${cString(parts[i])}, ${cString(parts.slice(0, i).join("."))}, ${this.F}, ${this.line(span)})`;
    }
    return cur;
  }

  private line(span: Span): number {
    return span.start.line;
  }
}

export function generateC(result: AnalysisResult, file: string): CGenResult {
  return new Generator(result, file).generate();
}
