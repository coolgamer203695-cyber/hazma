// HAZMA - semantic analysis.
//
// One pass registers top-level declarations (structures in source order,
// functions, global repeats). A second pass walks every statement with a
// context (global vs function scope, enclosing named repeats) and reports
// diagnostics. It also produces the IR the runtime executes:
//   - structs: merged inheritance with property order
//   - funcs:   parameters, bodies, inferred return types, call graph
//   - repeat control nodes get their target declaration attached

import { suggest, type Diagnostic, type Span } from "../errors.js";
import type {
  CallArg,
  Expr,
  FuncCall,
  FuncDecl,
  FuncParamStmt,
  Program,
  RepeatNamed,
  Stmt,
  StructDecl,
} from "../ast/nodes.js";
import { RESERVED_WORDS } from "../lexer/tokens.js";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type Type =
  | { k: "number" }
  | { k: "string" }
  | { k: "boolean" }
  | { k: "void" }
  | { k: "any" }
  | { k: "struct"; name: string }
  | { k: "list"; of: Type };

export const T_NUMBER: Type = { k: "number" };
export const T_STRING: Type = { k: "string" };
export const T_BOOLEAN: Type = { k: "boolean" };
export const T_VOID: Type = { k: "void" };
export const T_ANY: Type = { k: "any" };

export function typeEq(a: Type, b: Type): boolean {
  if (a.k === "any" || b.k === "any") return true;
  if (a.k !== b.k) return false;
  if (a.k === "struct") return b.k === "struct" && a.name === b.name;
  if (a.k === "list") return b.k === "list" && typeEq(a.of, b.of);
  return true;
}

export function typeName(t: Type): string {
  switch (t.k) {
    case "number": return "a number";
    case "string": return "a string";
    case "boolean": return "true or false";
    case "void": return "nothing";
    case "any": return "a value";
    case "struct": return `a ${t.name} instance`;
    case "list": return "a list";
  }
}

/** Plural element description used in list diagnostics. */
function elementName(t: Type): string {
  switch (t.k) {
    case "number": return "numbers";
    case "string": return "text";
    case "boolean": return "true/false values";
    case "struct": return `${t.name} instances`;
    case "list": return "lists";
    case "void": return "no values";
    case "any": return "any values";
  }
}

// ---------------------------------------------------------------------------
// IR shapes
// ---------------------------------------------------------------------------

export interface StructPropIR {
  name: string;
  isConst: boolean;
  defaultExpr: Expr;
  type: Type;
  span: Span;
}

export interface StructIR {
  name: string;
  parents: string[];
  props: StructPropIR[];
  index: Map<string, number>;
}

export interface FuncIR {
  name: string;
  params: { name: string; hasDefault: boolean; defaultExpr?: Expr; span: Span }[];
  body: Stmt[];
  span: Span;
  returnTypes: Type[];
  returnType: Type;
  calls: Set<string>;
}

export interface AnalysisResult {
  stmts: Stmt[];
  structs: Map<string, StructIR>;
  funcs: Map<string, FuncIR>;
  globalLoops: Map<string, RepeatNamed>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// analyzer
// ---------------------------------------------------------------------------

interface VarInfo {
  type: Type;
  isParam: boolean;
}

interface Ctx {
  func: FuncIR | null;
  locals: Map<string, VarInfo> | null;
  localLoops: Map<string, RepeatNamed>;
  enclosing: RepeatNamed[];
  atTop: boolean;
}

export class Analyzer {
  private diags: Diagnostic[] = [];
  private globals = new Map<string, VarInfo>();
  private structs = new Map<string, StructIR>();
  private funcs = new Map<string, FuncIR>();
  private globalLoops = new Map<string, RepeatNamed>();
  private registeredStructs = new Set<StructDecl>();
  /** When true (return-type fixpoint phase) diagnostics are suppressed. */
  private quiet = false;

  analyze(program: Program): AnalysisResult {
    // ---- pass 0: register top-level declarations ----
    this.precollectGlobals(program.stmts);
    for (const stmt of program.stmts) {
      if (stmt.kind === "struct") this.registerStruct(stmt);
      else if (stmt.kind === "func") this.registerFunc(stmt);
      else if (stmt.kind === "repeat.named") {
        stmt.scopeKind = "global";
        if (this.globalLoops.has(stmt.name)) {
          this.error(
            "H3021",
            `two repeats are named "${stmt.name}"`,
            stmt.span,
            "repeat names are unique inside their scope - rename one of them",
          );
        } else {
          this.globalLoops.set(stmt.name, stmt);
        }
      }
    }

    // ---- per function: pre-collect named repeats declared inside ----
    const funcLoops = new Map<FuncIR, Map<string, RepeatNamed>>();
    for (const fn of this.funcs.values()) {
      funcLoops.set(fn, this.collectFunctionLoops(fn));
    }

    // ---- phase A: infer return types to a fixpoint (quiet) ----
    // Functions can be called before their func.r lines are analyzed, so the
    // inference runs repeatedly until every return type stops changing.
    this.quiet = true;
    const returnExprs = new Map<FuncIR, Expr[]>();
    for (const fn of this.funcs.values()) {
      returnExprs.set(fn, collectFuncReturns(fn.body));
    }
    for (let iter = 0; iter <= this.funcs.size + 1; iter++) {
      let changed = false;
      for (const fn of this.funcs.values()) {
        const ctx: Ctx = {
          func: fn,
          locals: this.paramsFor(fn),
          localLoops: funcLoops.get(fn) ?? new Map(),
          enclosing: [],
          atTop: false,
        };
        const types = (returnExprs.get(fn) ?? []).map((e) => this.exprType(e, ctx));
        const t = this.unifyTypes(types);
        if (typeKey(t) !== typeKey(fn.returnType)) {
          fn.returnType = t;
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.quiet = false;

    // ---- phase B: full check of every function body ----
    for (const fn of this.funcs.values()) {
      // parameters must not shadow global variables (same rule as locals)
      for (const p of fn.params) {
        if (this.globals.has(p.name)) {
          this.error(
            "H3007",
            `the parameter "${p.name}" has the same name as a global variable`,
            p.span,
            "rename the parameter, or drop it and read the global one",
          );
        }
      }
      const ctx: Ctx = {
        func: fn,
        locals: this.paramsFor(fn),
        localLoops: funcLoops.get(fn) ?? new Map(),
        enclosing: [],
        atTop: false,
      };
      for (const p of fn.params) {
        if (p.defaultExpr) this.exprType(p.defaultExpr, ctx);
      }
      this.walkStmts(fn.body, ctx);
    }

    // ---- phase C: walk the top-level program ----
    const ctx: Ctx = {
      func: null,
      locals: null,
      localLoops: new Map(),
      enclosing: [],
      atTop: true,
    };
    this.walkStmts(program.stmts, ctx);

    // ---- post: recursion detection ----
    this.detectRecursion();

    return {
      stmts: program.stmts,
      structs: this.structs,
      funcs: this.funcs,
      globalLoops: this.globalLoops,
      diagnostics: this.diags,
    };
  }

  private paramsFor(fn: FuncIR): Map<string, VarInfo> {
    const locals = new Map<string, VarInfo>();
    for (const p of fn.params) locals.set(p.name, { type: T_ANY, isParam: true });
    return locals;
  }

  private error(code: string, message: string, span?: Span, help?: string): void {
    if (this.quiet) return;
    this.diags.push({ code, message, span, help });
  }

  /**
   * Collect every global variable name before anything is checked, so
   * functions may reference globals declared textually later. Types stay
   * "any" until the real walk assigns them in source order.
   */
  private precollectGlobals(stmts: Stmt[]): void {
    for (const stmt of stmts) {
      if (stmt.kind === "save" || stmt.kind === "assign" || stmt.kind === "l.save") {
        if (!this.globals.has(stmt.target[0])) {
          this.globals.set(stmt.target[0], { type: T_ANY, isParam: false });
        }
        continue;
      }
      if (stmt.kind === "if") {
        for (const b of stmt.branches) this.precollectGlobals(b.body);
        if (stmt.elseBody) this.precollectGlobals(stmt.elseBody);
      } else if (stmt.kind === "s.change") {
        for (const b of stmt.branches) this.precollectGlobals(b.body);
        if (stmt.defaultBody) this.precollectGlobals(stmt.defaultBody);
      } else if (stmt.kind === "repeat") {
        this.precollectGlobals(stmt.body);
      } else if (stmt.kind === "repeat.named") {
        this.precollectGlobals(stmt.body);
      } else if (stmt.kind === "check.error") {
        this.precollectGlobals([stmt.protectedStmt]);
        this.precollectGlobals(stmt.handler);
      }
      // func bodies hold locals, struct bodies hold properties - skip both
    }
  }

  // ------------------------------------------------------------- pass 0

  private registerFunc(stmt: FuncDecl): void {
    if (this.funcs.has(stmt.name)) {
      this.error("H3030", `a function named "${stmt.name}" already exists`, stmt.span);
      return;
    }
    const seen = new Set<string>();
    for (const p of stmt.params) {
      if (seen.has(p.name)) {
        this.error("H3031", `the parameter "${p.name}" is declared twice in "${stmt.name}"`, p.span);
      }
      seen.add(p.name);
      if (RESERVED_WORDS.has(p.name)) {
        this.error("H2016", `"${p.name}" is a reserved word and cannot be a parameter`, p.span);
      }
    }
    const fn: FuncIR = {
      name: stmt.name,
      params: stmt.params.map((p) => ({
        name: p.name,
        hasDefault: p.hasDefault,
        defaultExpr: p.defaultExpr,
        span: p.span,
      })),
      body: stmt.body,
      span: stmt.span,
      returnTypes: [],
      returnType: T_VOID,
      calls: new Set(),
    };
    this.funcs.set(stmt.name, fn);
  }

  private collectFunctionLoops(fn: FuncIR): Map<string, RepeatNamed> {
    const loops = new Map<string, RepeatNamed>();
    const visit = (stmts: Stmt[]) => {
      for (const s of stmts) {
        if (s.kind === "repeat.named") {
          s.scopeKind = "function";
          if (loops.has(s.name)) {
            this.error(
              "H3021",
              `two repeats are named "${s.name}" inside the function "${fn.name}"`,
              s.span,
            );
          } else {
            loops.set(s.name, s);
          }
          visit(s.body);
        } else if (s.kind === "if") {
          for (const b of s.branches) visit(b.body);
          if (s.elseBody) visit(s.elseBody);
        } else if (s.kind === "s.change") {
          for (const b of s.branches) visit(b.body);
          if (s.defaultBody) visit(s.defaultBody);
        } else if (s.kind === "repeat") {
          visit(s.body);
        } else if (s.kind === "check.error") {
          visit([s.protectedStmt]);
          visit(s.handler);
        }
      }
    };
    visit(fn.body);
    return loops;
  }

  private registerStruct(stmt: StructDecl): void {
    this.registeredStructs.add(stmt);
    if (this.structs.has(stmt.name)) {
      this.error("H3032", `a structure named "${stmt.name}" already exists`, stmt.span);
      return;
    }

    // own properties
    const ownByName = new Map<string, StructPropIR>();
    for (const p of stmt.props) {
      if (ownByName.has(p.name)) {
        this.error(
          "H3033",
          `the property "${p.name}" is declared twice in "${stmt.name}"`,
          p.span,
        );
        continue;
      }
      if (p.name === "r") {
        this.error(
          "H3034",
          `"r" is reserved for the round suffix (price.r) and cannot be a property name`,
          p.span,
        );
        continue;
      }
      if (!this.validateDefault(p.defaultExpr, true)) continue;
      const type = this.defaultType(p.defaultExpr);
      this.checkIsNaming(p.name, type, p.span, `the property "${p.name}"`);
      ownByName.set(p.name, { name: p.name, isConst: p.isConst, defaultExpr: p.defaultExpr, type, span: p.span });
    }

    // parents
    const seenParents = new Set<string>();
    const parentIRs: StructIR[] = [];
    for (const pname of stmt.parents) {
      if (seenParents.has(pname)) {
        this.error("H3035", `"${pname}" is listed twice as a parent of "${stmt.name}"`, stmt.span);
        continue;
      }
      seenParents.add(pname);
      const ir = this.structs.get(pname);
      if (!ir) {
        this.error(
          "H3036",
          `unknown structure "${pname}"`,
          stmt.span,
          `structures must be declared before "${stmt.name}" inherits from them`,
        );
        continue;
      }
      parentIRs.push(ir);
    }

    // conflict across parents
    const parentPropOwners = new Map<string, string[]>();
    for (const ir of parentIRs) {
      for (const p of ir.props) {
        const owners = parentPropOwners.get(p.name) ?? [];
        owners.push(ir.name);
        parentPropOwners.set(p.name, owners);
      }
    }
    for (const [prop, owners] of parentPropOwners) {
      if (owners.length > 1) {
        this.error(
          "H3037",
          `the property "${prop}" is inherited from both ${owners.map((o) => `"${o}"`).join(" and ")}`,
          stmt.span,
          "rename the property in one of the parent structures",
        );
      }
    }

    // merge: parents first (in order), child overrides / extends
    const props: StructPropIR[] = [];
    const index = new Map<string, number>();
    for (const ir of parentIRs) {
      for (const p of ir.props) {
        if (index.has(p.name)) continue; // conflict already reported
        index.set(p.name, props.length);
        props.push(p);
      }
    }
    for (const own of ownByName.values()) {
      const at = index.get(own.name);
      if (at !== undefined) {
        const inherited = props[at];
        if (inherited.isConst) {
          this.error(
            "H3038",
            `"${own.name}" is a const property inherited from a parent and cannot be overridden`,
            own.span,
            "const. properties stay exactly as the parent declared them",
          );
          continue;
        }
        if (own.isConst) {
          this.error(
            "H3039",
            `"${own.name}" is inherited from a parent and cannot be redeclared as const`,
            own.span,
          );
          continue;
        }
        if (!typeEq(inherited.type, own.type)) {
          this.error(
            "H3040",
            `the property "${own.name}" is inherited as ${typeName(inherited.type)} and cannot be overridden as ${typeName(own.type)}`,
            own.span,
          );
          continue;
        }
        props[at] = own;
        continue;
      }
      index.set(own.name, props.length);
      props.push(own);
    }

    this.structs.set(stmt.name, { name: stmt.name, parents: stmt.parents, props, index });
  }

  /** Structure defaults must be constant values (or nested struct.c). */
  private validateDefault(e: Expr, top: boolean): boolean {
    switch (e.kind) {
      case "number":
      case "string":
      case "boolean":
        return true;
      case "neg":
        return this.validateDefault(e.operand, false);
      case "struct.c": {
        const target = this.structs.get(e.structName);
        if (!target) {
          const near = suggest(e.structName, this.structs.keys());
          this.error(
            "H3036",
            `unknown structure "${e.structName}"`,
            e.span,
            near ? `did you mean "${near}"?` : "structures must be declared before they are used",
          );
          return false;
        }
        for (const o of e.overrides) {
          if (o.isConst) {
            this.error(
              "H3041",
              "const. cannot be used when creating an instance",
              o.span,
              "const. properties are set once inside the structure declaration",
            );
            return false;
          }
          if (!target.index.has(o.name)) {
            this.error(
              "H3010",
              `the structure "${target.name}" has no property "${o.name}"`,
              o.span,
            );
            return false;
          }
          if (!this.validateDefault(o.expr, false)) return false;
        }
        return true;
      }
      case "list.lit": {
        for (const item of e.items) {
          if (!this.validateDefault(item, false)) return false;
        }
        return true;
      }
      default:
        this.error(
          "H3042",
          "structure defaults must be literal values",
          e.span,
          "a number, text, true or false, or struct.c : another_structure",
        );
        return false;
    }
  }

  private defaultType(e: Expr): Type {
    switch (e.kind) {
      case "number": return T_NUMBER;
      case "string": return T_STRING;
      case "boolean": return T_BOOLEAN;
      case "neg": return T_NUMBER;
      case "struct.c": return { k: "struct", name: e.structName };
      case "list.lit": {
        if (e.items.length === 0) return { k: "list", of: T_ANY };
        let of = this.defaultType(e.items[0]);
        for (const item of e.items.slice(1)) {
          const t = this.defaultType(item);
          if (!typeEq(of, t)) {
            of = T_ANY;
            break;
          }
        }
        return { k: "list", of };
      }
      default: return T_ANY;
    }
  }

  // ------------------------------------------------------------- pass 1

  private walkStmts(stmts: Stmt[], ctx: Ctx): void {
    for (const stmt of stmts) this.walkStmt(stmt, ctx);
  }

  private walkStmt(stmt: Stmt, ctx: Ctx): void {
    switch (stmt.kind) {
      case "save":
      case "assign": {
        const name = stmt.target[0];
        const type = this.exprType(stmt.expr, ctx);
        this.checkIsNaming(name, type, stmt.span, `the variable "${name}"`);
        if (ctx.func && ctx.locals) {
          if (this.globals.has(name)) {
            this.error(
              "H3007",
              `the local variable "${name}" has the same name as a global variable`,
              stmt.span,
              "rename the local variable, or use change : to update the global one",
            );
            break;
          }
          const existing = ctx.locals.get(name);
          if (existing?.isParam) {
            this.error(
              "H3008",
              `"${name}" is already a parameter of "${ctx.func.name}"`,
              stmt.span,
              "use change : to update a parameter",
            );
            break;
          }
          ctx.locals.set(name, { type, isParam: false });
        } else {
          this.globals.set(name, { type, isParam: false });
        }
        break;
      }

      case "change": {
        if (stmt.expr !== undefined) {
          this.checkAssign(stmt.target, stmt.expr, ctx, { allowRetype: false });
        } else if (stmt.props !== undefined) {
          this.checkMultiChange(stmt, ctx);
        }
        break;
      }

      case "t.change": {
        this.checkAssign(stmt.target, stmt.expr, ctx, { allowRetype: true });
        break;
      }

      case "l.save": {
        const name = stmt.target[0];
        const type = this.listType(stmt.items, ctx);
        this.checkIsNaming(name, type, stmt.span, `the list "${name}"`);
        if (ctx.func && ctx.locals) {
          if (this.globals.has(name)) {
            this.error(
              "H3007",
              `the local list "${name}" has the same name as a global variable`,
              stmt.span,
              "rename the local list, or use change : to update the global one",
            );
            break;
          }
          const existing = ctx.locals.get(name);
          if (existing?.isParam) {
            this.error(
              "H3008",
              `"${name}" is already a parameter of "${ctx.func.name}"`,
              stmt.span,
              "use change : to update a parameter",
            );
            break;
          }
          ctx.locals.set(name, { type, isParam: false });
        } else {
          this.globals.set(name, { type, isParam: false });
        }
        break;
      }

      case "l.add": {
        const t = this.requireListTarget(stmt.target, stmt.span, ctx, "l.add");
        for (const item of stmt.items) {
          this.requireElementType(t, item, ctx, stmt.target, "added");
        }
        break;
      }

      case "l.remove": {
        this.requireListTarget(stmt.target, stmt.span, ctx, "l.remove");
        for (const value of stmt.values) this.exprType(value, ctx);
        break;
      }

      case "l.change": {
        const t = this.requireListTarget(stmt.target, stmt.span, ctx, "l.change");
        for (const c of stmt.changes) {
          const it = this.exprType(c.index, ctx);
          if (it.k !== "number" && it.k !== "any") {
            this.error(
              "H3063",
              `l.change indexes by position - the left side must be a whole number starting at 1, but this is ${typeName(it)}`,
              c.index.span,
              'example: l.change : weapons { 2 = "Rifle" }',
            );
          }
          this.requireElementType(t, c.value, ctx, stmt.target, "stored");
        }
        break;
      }

      case "check.error": {
        const guarded = stmt.protectedStmt.kind;
        if (guarded === "repeat.break" || guarded === "repeat.continue" || guarded === "repeat.new") {
          this.error(
            "H3066",
            "check.error cannot watch a command that pauses a repeat",
            stmt.protectedStmt.span,
            "move repeat.break : outside the command guarded by check.error",
          );
        }
        this.walkStmt(stmt.protectedStmt, ctx);
        this.walkStmts(stmt.handler, { ...ctx, atTop: false });
        break;
      }

      case "file.create":
      case "file.delete":
      case "folder.create":
      case "folder.delete":
      case "file.write":
      case "file.add": {
        this.requireTextPath(stmt.path, ctx, stmt.kind);
        break;
      }

      case "log": {
        this.exprType(stmt.expr, ctx);
        break;
      }

      case "if": {
        for (const b of stmt.branches) {
          this.requireCondition(b.cond, ctx, "if");
          this.walkStmts(b.body, { ...ctx, atTop: false });
        }
        if (stmt.elseBody) this.walkStmts(stmt.elseBody, { ...ctx, atTop: false });
        break;
      }

      case "s.change": {
        const subjectType = this.exprType(stmt.subject, ctx);
        for (const b of stmt.branches) {
          const vt = this.literalType(b.value);
          if (vt === null) {
            this.error(
              "H3043",
              `the branch "${b.label}" must compare against a literal value`,
              b.value.span,
              "branch values are literal numbers, text, or true/false",
            );
          } else if (subjectType.k !== "any" && vt.k !== "any" && !typeEq(subjectType, vt)) {
            this.error(
              "H3044",
              `the branch "${b.label}" compares ${typeName(vt)} against a subject of ${typeName(subjectType)}`,
              b.value.span,
            );
          }
          this.walkStmts(b.body, { ...ctx, atTop: false });
        }
        if (stmt.defaultBody) this.walkStmts(stmt.defaultBody, { ...ctx, atTop: false });
        break;
      }

      case "repeat": {
        this.requireCondition(stmt.cond, ctx, "repeat till");
        this.walkStmts(stmt.body, { ...ctx, atTop: false });
        break;
      }

      case "repeat.named": {
        if (stmt.cond) this.requireCondition(stmt.cond, ctx, "till");
        stmt.usedVars = this.collectUsedVars(stmt.body);
        this.walkStmts(stmt.body, { ...ctx, enclosing: [...ctx.enclosing, stmt], atTop: false });
        break;
      }

      case "repeat.break": {
        const target = [...ctx.enclosing].reverse().find((l) => l.name === stmt.name);
        if (!target) {
          this.error(
            "H3050",
            `there is no enclosing repeat named "${stmt.name}"`,
            stmt.span,
            "repeat.break pauses a repeat that surrounds this command",
          );
          break;
        }
        stmt.targetDecl = target;
        break;
      }

      case "repeat.continue":
      case "repeat.new": {
        const inside = ctx.enclosing.find((l) => l.name === stmt.name);
        if (inside) {
          this.error(
            "H3051",
            `repeat "${stmt.name}" cannot use ${stmt.kind === "repeat.continue" ? "repeat.continue" : "repeat.new"} from inside itself`,
            stmt.span,
            "a running repeat cannot resume or restart itself - use repeat.break : to pause it",
          );
          break;
        }
        let target: RepeatNamed | undefined;
        if (ctx.func) {
          target = ctx.localLoops.get(stmt.name);
          if (!target) target = this.globalLoops.get(stmt.name);
        } else {
          target = this.globalLoops.get(stmt.name);
        }
        if (!target) {
          this.error(
            "H3052",
            `there is no repeat named "${stmt.name}" visible from here`,
            stmt.span,
            ctx.func
              ? "repeat.continue and repeat.new reach repeats declared in the same function, or global repeats"
              : "repeat.continue and repeat.new reach global repeats",
          );
          break;
        }
        stmt.targetDecl = target;
        break;
      }

      case "func": {
        if (!ctx.atTop) {
          this.error(
            "H3053",
            `the function "${stmt.name}" must be declared at the top level`,
            stmt.span,
            "functions cannot be nested inside other commands",
          );
        }
        // bodies are walked once per registered function below
        break;
      }

      case "func.c.stmt": {
        this.analyzeCall(stmt.call, ctx, false);
        break;
      }

      case "func.r": {
        if (!ctx.func) {
          this.error("H3054", "func.r can only be used inside a function", stmt.span);
          break;
        }
        ctx.func.returnTypes.push(this.exprType(stmt.expr, ctx));
        break;
      }

      case "struct": {
        if (!this.registeredStructs.has(stmt)) {
          this.error(
            "H3055",
            `the structure "${stmt.name}" must be declared at the top level`,
            stmt.span,
            "structures cannot be nested inside other commands",
          );
        }
        break;
      }

      case "func.p": {
        this.error(
          "H3056",
          "func.p can only be used inside a function",
          stmt.span,
          "parameters are declared as the first lines of a func body",
        );
        break;
      }
    }
  }

  // ---------------------------------------------------------- expressions

  private exprType(expr: Expr, ctx: Ctx): Type {
    switch (expr.kind) {
      case "number": return T_NUMBER;
      case "string": return T_STRING;
      case "boolean": return T_BOOLEAN;

      case "path": return this.pathType(expr.parts, expr.span, ctx);

      case "round": {
        const t = this.exprType(expr.inner, ctx);
        if (t.k === "number" || t.k === "any") return T_NUMBER;
        this.error(
          "H3001",
          `price.r rounds numbers, but this is ${typeName(t)}`,
          expr.span,
        );
        return T_NUMBER;
      }

      case "neg": {
        const t = this.exprType(expr.operand, ctx);
        if (t.k !== "number" && t.k !== "any") {
          this.error("H3002", `a minus sign works on numbers, but this is ${typeName(t)}`, expr.span);
        }
        return T_NUMBER;
      }

      case "not": {
        const t = this.exprType(expr.operand, ctx);
        if (t.k !== "boolean" && t.k !== "any") {
          this.error("H3003", `not works on true or false, but this is ${typeName(t)}`, expr.span);
        }
        return T_BOOLEAN;
      }

      case "binary": return this.binaryType(expr, ctx);

      case "struct.c": {
        const ir = this.structs.get(expr.structName);
        if (!ir) {
          this.error(
            "H3004",
            `unknown structure "${expr.structName}"`,
            expr.span,
            suggest(expr.structName, this.structs.keys())
              ? `did you mean "${suggest(expr.structName, this.structs.keys())}"?`
              : "structures are declared with: struct : name { ... }",
          );
          return T_ANY;
        }
        for (const o of expr.overrides) {
          this.checkOverride(ir, o, ctx);
        }
        return { k: "struct", name: expr.structName };
      }

      case "func.c": {
        return this.analyzeCall(expr, ctx, true);
      }

      case "list.lit": {
        return this.listType(expr.items, ctx);
      }

      case "index": {
        const targetType = this.exprType(expr.target, ctx);
        const indexType = this.exprType(expr.index, ctx);
        if (indexType.k !== "number" && indexType.k !== "any") {
          this.error(
            "H3061",
            `list indexes are whole numbers starting at 1, but this is ${typeName(indexType)}`,
            expr.index.span,
            "index the list by position: weapons[1]",
          );
        }
        if (targetType.k === "list") return targetType.of;
        if (targetType.k === "any") return T_ANY;
        this.error(
          "H3060",
          `${typeName(targetType)} cannot be indexed - only lists are indexed, like weapons[1]`,
          expr.span,
        );
        return T_ANY;
      }

      case "list.count": {
        this.requireListType(expr.list, ctx, "l.count");
        return T_NUMBER;
      }

      case "list.find": {
        this.requireListType(expr.list, ctx, "l.find");
        this.exprType(expr.value, ctx);
        return T_BOOLEAN;
      }

      case "list.find.index": {
        this.requireListType(expr.list, ctx, "l.find.index");
        this.exprType(expr.value, ctx);
        return T_NUMBER;
      }

      case "file.read": {
        this.requireTextPath(expr.path, ctx, "file.read");
        return T_STRING;
      }

      case "file.exists": {
        this.requireTextPath(expr.path, ctx, "file.exists");
        return T_BOOLEAN;
      }

      case "math.prop":
        return T_NUMBER; // math.pi, math.e

      case "math.call": {
        const arity: Record<string, number> = {
          min: 2,
          max: 2,
          random: 2,
          clamp: 3,
          sin: 1,
          cos: 1,
          tan: 1,
        };
        const want = arity[expr.fn];
        const atLeast = expr.fn === "min" || expr.fn === "max";
        if (atLeast ? expr.args.length < want : expr.args.length !== want) {
          this.error(
            "H3046",
            `math.${expr.fn} takes ${atLeast ? "at least " : ""}${want} argument${want === 1 ? "" : "s"} but received ${expr.args.length}`,
            expr.span,
          );
        }
        for (const a of expr.args) {
          const t = this.exprType(a, ctx);
          if (t.k !== "number" && t.k !== "any") {
            this.error(
              "H3067",
              `math.${expr.fn} works on numbers, but this is ${typeName(t)}`,
              a.span,
            );
          }
        }
        return T_NUMBER;
      }

      case "math.postfix": {
        const t = this.exprType(expr.inner, ctx);
        if (t.k !== "number" && t.k !== "any") {
          this.error(
            "H3067",
            `"${expr.op}" works on numbers, but this is ${typeName(t)}`,
            expr.span,
            `${expr.op} needs a number - the value before the dot must be a number`,
          );
        }
        if (expr.op === "pow") {
          if (expr.args.length !== 1) {
            this.error(
              "H3046",
              `math.pow takes 1 argument but received ${expr.args.length}`,
              expr.span,
            );
          } else {
            const at = this.exprType(expr.args[0], ctx);
            if (at.k !== "number" && at.k !== "any") {
              this.error(
                "H3067",
                `math.pow works on numbers, but this is ${typeName(at)}`,
                expr.args[0].span,
              );
            }
          }
        }
        return T_NUMBER;
      }
    }
  }

  /** The type of a list literal: a list whose element type is the common type. */
  private listType(items: Expr[], ctx: Ctx): Type {
    if (items.length === 0) return { k: "list", of: T_ANY };
    const of = this.unifyTypes(items.map((e) => this.exprType(e, ctx)));
    return { k: "list", of };
  }

  /** Check that an expression is a list (or an unknown `any` value). */
  private requireListType(e: Expr, ctx: Ctx, op: string): void {
    const t = this.exprType(e, ctx);
    if (t.k !== "list" && t.k !== "any") {
      this.error(
        "H3062",
        `${op} needs a list, but this is ${typeName(t)}`,
        e.span,
        "create a list first with: l.save : name = { ... }",
      );
    }
  }

  /** Check that l.add / l.remove / l.change point at an existing list. */
  /** Every file/folder command takes the path as text. */
  private requireTextPath(path: Expr, ctx: Ctx, op: string): void {
    const t = this.exprType(path, ctx);
    if (t.k !== "string" && t.k !== "any") {
      this.error(
        "H3065",
        `${op} needs a text path, but this is ${typeName(t)}`,
        path.span,
        'write the path as text: ' + `${op} : "data.txt"`,
      );
    }
  }

  private requireListTarget(target: string[], span: Span, ctx: Ctx, op: string): Type {    const t = this.pathType(target, span, ctx);
    if (t.k !== "list" && t.k !== "any") {
      this.error(
        "H3062",
        `${op} needs a list, but "${target.join(".")}" is ${typeName(t)}`,
        span,
        "lists are created with: l.save : name = { ... }",
      );
    }
    return t;
  }

  /** A value stored into a list must match the list's element type. */
  private requireElementType(
    listType: Type,
    value: Expr,
    ctx: Ctx,
    target: string[],
    verb: string,
  ): void {
    const vt = this.exprType(value, ctx);
    if (listType.k !== "list") return; // unknown list: nothing more to check
    if (!typeEq(listType.of, vt)) {
      this.error(
        "H3064",
        `the list "${target.join(".")}" holds ${elementName(listType.of)}, so ${typeName(vt)} cannot be ${verb}`,
        value.span,
        "lists keep one element type; lists written with mixed values accept any value",
      );
    }
  }

  private binaryType(expr: Extract<Expr, { kind: "binary" }>, ctx: Ctx): Type {
    const op = expr.op;
    const lt = this.exprType(expr.left, ctx);
    const rt = this.exprType(expr.right, ctx);

    if (op === "and" || op === "or") {
      if (lt.k !== "boolean" && lt.k !== "any") {
        this.error("H3005", `"${op}" needs true or false on the left, but this is ${typeName(lt)}`, expr.left.span);
      }
      if (rt.k !== "boolean" && rt.k !== "any") {
        this.error("H3005", `"${op}" needs true or false on the right, but this is ${typeName(rt)}`, expr.right.span);
      }
      return T_BOOLEAN;
    }

    if (op === "==" || op === "!=") {
      return T_BOOLEAN; // any two values can be compared for equality
    }

    if (op === ">" || op === "<" || op === ">=" || op === "<=") {
      if (lt.k !== "number" && lt.k !== "any") {
        this.error("H3006", `"${op}" compares numbers, but the left side is ${typeName(lt)}`, expr.left.span);
      }
      if (rt.k !== "number" && rt.k !== "any") {
        this.error("H3006", `"${op}" compares numbers, but the right side is ${typeName(rt)}`, expr.right.span);
      }
      return T_BOOLEAN;
    }

    if (op === "+") {
      if (lt.k === "string" || rt.k === "string") {
        // joining text with anything is allowed (numbers are converted)
        if ((lt.k === "boolean" || rt.k === "boolean") && lt.k !== "string" && rt.k !== "string") {
          this.error("H3005", "true or false cannot be joined with +", expr.span);
          return T_STRING;
        }
        return T_STRING;
      }
      if (lt.k === "number" && rt.k === "number") return T_NUMBER;
      if (lt.k === "boolean" || rt.k === "boolean") {
        this.error("H3005", "true or false cannot be added", expr.span);
        return T_ANY;
      }
      return T_ANY;
    }

    // - * /
    if ((lt.k === "number" || lt.k === "any") && (rt.k === "number" || rt.k === "any")) {
      return T_NUMBER;
    }
    this.error(
      "H3005",
      `"${op}" works with numbers, but the sides are ${typeName(lt)} and ${typeName(rt)}`,
      expr.span,
    );
    return T_NUMBER;
  }

  private pathType(parts: string[], span: Span, ctx: Ctx): Type {
    // is.fight.over is one variable whose whole name is "is.fight.over"
    if (parts[0] === "is") {
      return this.lookupVar(parts.join("."), span, ctx);
    }

    if (parts.length === 1) return this.lookupVar(parts[0], span, ctx);

    // member path: root must be a structure instance
    let type = this.lookupVar(parts[0], span, ctx);
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (type.k === "any") return T_ANY;
      if (type.k !== "struct") {
        this.error(
          "H3009",
          `"${parts.slice(0, i).join(".")}" is ${typeName(type)} and has no properties`,
          span,
        );
        return T_ANY;
      }
      const ir = this.structs.get(type.name);
      if (!ir) return T_ANY;
      const at = ir.index.get(part);
      if (at === undefined) {
        const near = suggest(part, ir.props.map((p) => p.name));
        this.error(
          "H3010",
          `the structure "${type.name}" has no property "${part}"`,
          span,
          near ? `did you mean "${near}"?` : undefined,
        );
        return T_ANY;
      }
      type = ir.props[at].type;
    }
    return type;
  }

  private lookupVar(name: string, span: Span, ctx: Ctx): Type {
    if (ctx.func && ctx.locals?.has(name)) return ctx.locals.get(name)!.type;
    if (this.globals.has(name)) return this.globals.get(name)!.type;
    const scopeNames = [
      ...(ctx.locals?.keys() ?? []),
      ...this.globals.keys(),
    ];
    const near = suggest(name, scopeNames);
    this.error(
      "H3011",
      `unknown variable "${name}"`,
      span,
      near ? `did you mean "${near}"?` : "variables are created with: save : name = value",
    );
    return T_ANY;
  }

  // ----------------------------------------------------------- assignments

  /** Resolve a change/t.change target and validate the assignment. */
  private checkAssign(
    target: string[],
    expr: Expr,
    ctx: Ctx,
    opts: { allowRetype: boolean },
  ): { kind: "var"; name: string } | { kind: "prop"; ir: StructIR; propIndex: number } | undefined {
    const valueType = this.exprType(expr, ctx);

    // variable target (single name, or an is.* boolean name of any depth)
    if (target.length === 1 || target[0] === "is") {
      const name = target.length === 1 ? target[0] : target.join(".");
      const holder = this.findVarHolder(name, ctx);
      if (!holder) {
        const scopeNames = [...(ctx.locals?.keys() ?? []), ...this.globals.keys()];
        const near = suggest(name, scopeNames);
        this.error(
          "H3011",
          `unknown variable "${name}"`,
          expr.span,
          near ? `did you mean "${near}"?` : "create it first with: save : name = value",
        );
        return undefined;
      }
      const current = holder.get(name)!;
      this.checkIsNaming(name, valueType, expr.span, `the variable "${name}"`);
      if (!opts.allowRetype && current.type.k !== "any" && valueType.k !== "any" && !typeEq(current.type, valueType)) {
        this.error(
          "H3012",
          `"${name}" holds ${typeName(current.type)} and cannot be changed to ${typeName(valueType)}`,
          expr.span,
          `use t.change : ${name} = ... to change the type of a variable`,
        );
        return { kind: "var", name };
      }
      if (opts.allowRetype) current.type = valueType;
      return { kind: "var", name };
    }

    // property target: alex.health / alex.inventory.coins
    const rootType = this.lookupVar(target[0], expr.span, ctx);
    if (rootType.k === "any") return undefined;
    if (rootType.k !== "struct") {
      this.error(
        "H3009",
        `"${target[0]}" is ${typeName(rootType)} and has no properties`,
        expr.span,
      );
      return undefined;
    }
    let ir = this.structs.get(rootType.name)!;
    let propIndex = -1;
    for (let i = 1; i < target.length; i++) {
      const at = ir.index.get(target[i]);
      if (at === undefined) {
        const near = suggest(target[i], ir.props.map((p) => p.name));
        this.error(
          "H3010",
          `the structure "${ir.name}" has no property "${target[i]}"`,
          expr.span,
          near ? `did you mean "${near}"?` : undefined,
        );
        return undefined;
      }
      propIndex = at;
      if (i < target.length - 1) {
        const t = ir.props[at].type;
        if (t.k === "any") return undefined;
        if (t.k !== "struct") {
          this.error(
            "H3009",
            `"${target.slice(0, i + 1).join(".")}" is ${typeName(t)} and has no properties`,
            expr.span,
          );
          return undefined;
        }
        ir = this.structs.get(t.name)!;
      }
    }
    const prop = ir.props[propIndex];
    this.checkIsNaming(prop.name, valueType, expr.span, `the property "${prop.name}"`);
    if (prop.isConst) {
      this.error(
        "H3013",
        `"${prop.name}" is a const property and can never be changed`,
        expr.span,
        "const. properties are locked when the structure is declared",
      );
      return { kind: "prop", ir, propIndex };
    }
    if (!opts.allowRetype && prop.type.k !== "any" && valueType.k !== "any" && !typeEq(prop.type, valueType)) {
      this.error(
        "H3012",
        `the property "${prop.name}" holds ${typeName(prop.type)} and cannot be changed to ${typeName(valueType)}`,
        expr.span,
      );
    }
    return { kind: "prop", ir, propIndex };
  }

  private checkMultiChange(stmt: Extract<Stmt, { kind: "change" }>, ctx: Ctx): void {
    // resolve the instance the block changes
    const target = stmt.target;
    const rootType = this.lookupVar(target[0], stmt.span, ctx);
    if (rootType.k === "any") return;
    if (rootType.k !== "struct") {
      this.error(
        "H3014",
        `change : ${target.join(".")} { ... } needs a structure instance, but "${target[0]}" is ${typeName(rootType)}`,
        stmt.span,
      );
      return;
    }
    let ir = this.structs.get(rootType.name)!;
    for (let i = 1; i < target.length; i++) {
      const at = ir.index.get(target[i]);
      if (at === undefined) {
        this.error("H3010", `the structure "${ir.name}" has no property "${target[i]}"`, stmt.span);
        return;
      }
      const t = ir.props[at].type;
      if (t.k === "any") return;
      if (t.k !== "struct") {
        this.error(
          "H3014",
          `change : ${target.join(".")} { ... } needs a structure instance, but "${target.slice(0, i + 1).join(".")}" is ${typeName(t)}`,
          stmt.span,
        );
        return;
      }
      ir = this.structs.get(t.name)!;
    }
    for (const p of stmt.props!) {
      if (p.isConst) {
        this.error("H3041", "const. cannot be used when changing an instance", p.span);
        continue;
      }
      const at = ir.index.get(p.name);
      if (at === undefined) {
        const near = suggest(p.name, ir.props.map((x) => x.name));
        this.error(
          "H3010",
          `the structure "${ir.name}" has no property "${p.name}"`,
          p.span,
          near ? `did you mean "${near}"?` : undefined,
        );
        continue;
      }
      const prop = ir.props[at];
      const valueType = this.exprType(p.expr, ctx);
      this.checkIsNaming(prop.name, valueType, p.span, `the property "${prop.name}"`);
      if (prop.isConst) {
        this.error(
          "H3013",
          `"${prop.name}" is a const property and can never be changed`,
          p.span,
          "const. properties are locked when the structure is declared",
        );
        continue;
      }
      if (prop.type.k !== "any" && valueType.k !== "any" && !typeEq(prop.type, valueType)) {
        this.error(
          "H3012",
          `the property "${prop.name}" holds ${typeName(prop.type)} and cannot be changed to ${typeName(valueType)}`,
          p.span,
        );
      }
    }
  }

  private checkOverride(
    ir: StructIR,
    o: { name: string; isConst: boolean; expr: Expr; span: Span },
    ctx: Ctx,
  ): void {
    if (o.isConst) {
      this.error("H3041", "const. cannot be used when creating an instance", o.span);
      return;
    }
    const at = ir.index.get(o.name);
    if (at === undefined) {
      const near = suggest(o.name, ir.props.map((p) => p.name));
      this.error(
        "H3010",
        `the structure "${ir.name}" has no property "${o.name}"`,
        o.span,
        near ? `did you mean "${near}"?` : undefined,
      );
      return;
    }
    const prop = ir.props[at];
    const valueType = this.exprType(o.expr, ctx);
    this.checkIsNaming(prop.name, valueType, o.span, `the property "${prop.name}"`);
    if (prop.isConst) {
      this.error(
        "H3013",
        `"${prop.name}" is a const property and cannot receive a custom value`,
        o.span,
        "const. properties are locked when the structure is declared",
      );
      return;
    }
    if (prop.type.k !== "any" && valueType.k !== "any" && !typeEq(prop.type, valueType)) {
      this.error(
        "H3012",
        `the property "${prop.name}" holds ${typeName(prop.type)} and cannot be created as ${typeName(valueType)}`,
        o.span,
      );
    }
  }

  private findVarHolder(name: string, ctx: Ctx): Map<string, VarInfo> | undefined {
    if (ctx.func && ctx.locals?.has(name)) return ctx.locals;
    if (this.globals.has(name)) return this.globals;
    return undefined;
  }

  private checkIsNaming(name: string, type: Type, span: Span, what: string): void {
    if (name.startsWith("is.")) {
      if (type.k !== "boolean" && type.k !== "any") {
        this.error(
          "H3020",
          `${what} starts with is. so it holds true or false, but this is ${typeName(type)}`,
          span,
        );
      }
    } else if (type.k === "boolean") {
      this.error(
        "H3020",
        `${what} is true or false, so it must be named with is. - for example is.${name}`,
        span,
        "boolean variables use the is. naming convention",
      );
    }
  }

  private requireCondition(cond: Expr, ctx: Ctx, what: string): void {
    const t = this.exprType(cond, ctx);
    if (t.k !== "boolean" && t.k !== "any") {
      this.error(
        "H3015",
        `the condition of ${what} must be true or false, but this is ${typeName(t)}`,
        cond.span,
        "conditions compare values: if : age >= 18 { ... }",
      );
    }
  }

  // ------------------------------------------------------------- functions

  private analyzeCall(call: FuncCall, ctx: Ctx, asValue: boolean): Type {
    const fn = this.funcs.get(call.funcName);
    if (!fn) {
      const near = suggest(call.funcName, this.funcs.keys());
      this.error(
        "H3030",
        `unknown function "${call.funcName}"`,
        call.span,
        near ? `did you mean "${near}"?` : "functions are declared with: func : name { ... }",
      );
      return T_ANY;
    }
    if (ctx.func) ctx.func.calls.add(call.funcName);

    const named = call.args.filter((a) => a.name !== undefined);
    if (named.length > 0 && named.length !== call.args.length) {
      this.error(
        "H3045",
        `the call to "${call.funcName}" mixes positional and named arguments`,
        call.span,
        "use one style: func.c : welcome { \"Alex\" } or func.c : welcome { name = \"Alex\" }",
      );
      for (const a of call.args) this.exprType(a.expr, ctx);
      return fn.returnType;
    }

    if (named.length === 0) {
      if (call.args.length > fn.params.length) {
        this.error(
          "H3046",
          `"${call.funcName}" takes ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"} but received ${call.args.length}`,
          call.span,
        );
      }
      for (let i = call.args.length; i < fn.params.length; i++) {
        if (!fn.params[i].hasDefault) {
          this.error(
            "H3047",
            `the argument "${fn.params[i].name}" is missing in the call to "${call.funcName}"`,
            call.span,
          );
        }
      }
    } else {
      const seen = new Set<string>();
      for (const a of call.args) {
        if (a.name === undefined) continue;
        if (seen.has(a.name)) {
          this.error("H3048", `the argument "${a.name}" is passed twice`, a.span);
          continue;
        }
        seen.add(a.name);
        const p = fn.params.find((x) => x.name === a.name);
        if (!p) {
          const near = suggest(a.name, fn.params.map((x) => x.name));
          this.error(
            "H3049",
            `"${call.funcName}" has no parameter named "${a.name}"`,
            a.span,
            near ? `did you mean "${near}"?` : undefined,
          );
        }
      }
      for (const p of fn.params) {
        if (!p.hasDefault && !seen.has(p.name)) {
          this.error(
            "H3047",
            `the argument "${p.name}" is missing in the call to "${call.funcName}"`,
            call.span,
            `pass it by name: func.c : ${call.funcName} { ${p.name} = ... }`,
          );
        }
      }
    }

    for (let i = 0; i < call.args.length; i++) {
      const a = call.args[i];
      const t = this.exprType(a.expr, ctx);
      const pname =
        a.name !== undefined
          ? a.name
          : fn.params[i]?.name ?? "argument";
      if (pname.startsWith("is.") && t.k !== "boolean" && t.k !== "any") {
        this.error("H3020", `${pname} holds true or false, but this is ${typeName(t)}`, a.expr.span);
      }
    }

    if (asValue && fn.returnType.k === "void") {
      this.error(
        "H3031",
        `the function "${call.funcName}" returns nothing, so its result cannot be used as a value`,
        call.span,
        `add func.r : ... inside "${call.funcName}" to return a value`,
      );
      return T_ANY;
    }
    return fn.returnType;
  }

  private unifyTypes(types: Type[]): Type {
    if (types.length === 0) return T_VOID;
    const first = types[0];
    for (const t of types) {
      if (!typeEq(first, t)) return T_ANY;
    }
    if (first.k === "any") return T_ANY;
    return first;
  }

  private detectRecursion(): void {
    const color = new Map<string, 0 | 1 | 2>(); // 0 fresh, 1 in stack, 2 done
    const stack: string[] = [];
    const reported = new Set<string>();

    const visit = (name: string): void => {
      color.set(name, 1);
      stack.push(name);
      const fn = this.funcs.get(name);
      if (fn) {
        for (const callee of fn.calls) {
          if (!this.funcs.has(callee)) continue;
          const c = color.get(callee) ?? 0;
          if (c === 1) {
            const cycle = [...stack.slice(stack.indexOf(callee)), callee];
            const key = [...cycle].sort().join(">");
            if (!reported.has(key)) {
              reported.add(key);
              this.error(
                "H3057",
                `recursive calls are not allowed: ${cycle.join(" calls ")}`,
                fn.span,
                "restructure the functions so no function calls itself (directly or indirectly)",
              );
            }
          } else if (c === 0) {
            visit(callee);
          }
        }
      }
      stack.pop();
      color.set(name, 2);
    };

    for (const name of this.funcs.keys()) {
      if ((color.get(name) ?? 0) === 0) visit(name);
    }
  }

  // -------------------------------------------------------------- utilities

  private collectUsedVars(stmts: Stmt[]): string[] {
    const names = new Set<string>();
    // is.fight.over is one variable whose whole name is dotted
    const addName = (target: string[]) => {
      if (target[0] === "is" && target.length > 1) names.add(target.join("."));
      else names.add(target[0]);
    };
    const addExpr = (e: Expr) => {
      switch (e.kind) {
        case "path": {
          if (e.parts[0] === "is") names.add(e.parts.join("."));
          else names.add(e.parts[0]);
          break;
        }
        case "round": addExpr(e.inner); break;
        case "neg": addExpr(e.operand); break;
        case "not": addExpr(e.operand); break;
        case "binary": addExpr(e.left); addExpr(e.right); break;
        case "struct.c": for (const o of e.overrides) addExpr(o.expr); break;
        case "func.c": for (const a of e.args) addExpr(a.expr); break;
        case "list.lit": for (const item of e.items) addExpr(item); break;
        case "index": addExpr(e.target); addExpr(e.index); break;
        case "list.count": addExpr(e.list); break;
        case "list.find":
        case "list.find.index":
          addExpr(e.list);
          addExpr(e.value);
          break;
        case "file.read":
        case "file.exists":
          addExpr(e.path);
          break;
        case "math.prop": break; // no variables
        case "math.call":
          for (const a of e.args) addExpr(a);
          break;
        case "math.postfix":
          addExpr(e.inner);
          for (const a of e.args) addExpr(a);
          break;
        default: break;
      }
    };
    const visit = (list: Stmt[]) => {
      for (const s of list) {
        switch (s.kind) {
          case "save": case "assign":
            addName(s.target);
            addExpr(s.expr);
            break;
          case "change":
            addName(s.target);
            if (s.expr) addExpr(s.expr);
            if (s.props) for (const p of s.props) addExpr(p.expr);
            break;
          case "t.change":
            addName(s.target);
            addExpr(s.expr);
            break;
          case "l.save":
          case "l.add":
            addName(s.target);
            for (const item of s.items) addExpr(item);
            break;
          case "l.remove":
            addName(s.target);
            for (const value of s.values) addExpr(value);
            break;
          case "l.change":
            addName(s.target);
            for (const c of s.changes) {
              addExpr(c.index);
              addExpr(c.value);
            }
            break;
          case "log": addExpr(s.expr); break;
          case "if":
            for (const b of s.branches) { addExpr(b.cond); visit(b.body); }
            if (s.elseBody) visit(s.elseBody);
            break;
          case "s.change":
            addExpr(s.subject);
            for (const b of s.branches) { addExpr(b.value); visit(b.body); }
            if (s.defaultBody) visit(s.defaultBody);
            break;
          case "repeat": addExpr(s.cond); visit(s.body); break;
          case "repeat.named":
            if (s.cond) addExpr(s.cond);
            visit(s.body);
            break;
          case "check.error":
            visit([s.protectedStmt]);
            visit(s.handler);
            break;
          case "file.create":
          case "file.delete":
          case "folder.create":
          case "folder.delete":
          case "file.write":
          case "file.add":
            addExpr(s.path);
            break;
          case "func.c.stmt": for (const a of s.call.args) addExpr(a.expr); break;
          case "func.r": addExpr(s.expr); break;
          default: break;
        }
      }
    };
    visit(stmts);
    return [...names];
  }

  private literalType(e: Expr): Type | null {
    switch (e.kind) {
      case "number": return T_NUMBER;
      case "string": return T_STRING;
      case "boolean": return T_BOOLEAN;
      case "neg": return this.literalType(e.operand) === T_NUMBER ? T_NUMBER : null;
      default: return null;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Stable string key for a Type, used to detect inference changes. */
function typeKey(t: Type): string {
  if (t.k === "struct") return `struct:${t.name}`;
  if (t.k === "list") return `list:${typeKey(t.of)}`;
  return t.k;
}

/** Collect every `func.r` expression inside a function body (recursively). */
function collectFuncReturns(stmts: Stmt[]): Expr[] {
  const out: Expr[] = [];
  const visit = (list: Stmt[]) => {
    for (const s of list) {
      switch (s.kind) {
        case "func.r": out.push(s.expr); break;
        case "if":
          for (const b of s.branches) visit(b.body);
          if (s.elseBody) visit(s.elseBody);
          break;
        case "s.change":
          for (const b of s.branches) visit(b.body);
          if (s.defaultBody) visit(s.defaultBody);
          break;
        case "repeat": visit(s.body); break;
        case "repeat.named": visit(s.body); break;
        case "check.error": visit([s.protectedStmt]); visit(s.handler); break;
        default: break;
      }
    }
  };
  visit(stmts);
  return out;
}
