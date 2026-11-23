// HAZMA - runtime interpreter.
//
// A tree-walking interpreter with an explicit frame machine. The frame
// machine is what makes HAZMA's repeats work: a named repeat can be paused
// with repeat.break at any statement, frozen (including loops nested inside
// it mid-iteration), and later resumed or restarted with repeat.continue /
// repeat.new from wherever the program is.

import { HazmaError, type Span } from "../errors.js";
import type { Expr, PropAssign, RepeatNamed, Stmt } from "../ast/nodes.js";
import type { AnalysisResult, FuncIR, StructIR } from "../semantic/analyzer.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

export class StructInstance {
  constructor(
    public def: StructIR,
    public values: RuntimeValue[],
  ) {}
}

/** A mutable, ordered list. Variables hold a reference to it. */
export class ListValue {
  constructor(public items: RuntimeValue[]) {}
}

export type RuntimeValue = number | string | boolean | StructInstance | ListValue;

function isStruct(v: RuntimeValue): v is StructInstance {
  return v instanceof StructInstance;
}

function isList(v: RuntimeValue): v is ListValue {
  return v instanceof ListValue;
}

export function sameValueType(a: RuntimeValue, b: RuntimeValue): boolean {
  if (typeof a === "number" && typeof b === "number") return true;
  if (typeof a === "string" && typeof b === "string") return true;
  if (typeof a === "boolean" && typeof b === "boolean") return true;
  if (isStruct(a) && isStruct(b)) return a.def === b.def;
  if (isList(a) && isList(b)) return true;
  return false;
}

export function valueEquals(a: RuntimeValue, b: RuntimeValue): boolean {
  if (!sameValueType(a, b)) return false;
  if (isStruct(a) && isStruct(b)) return a === b; // instances compare by identity
  if (isList(a) && isList(b)) return a === b; // lists compare by identity
  return a === b;
}

export function fmtType(v: RuntimeValue): string {
  if (typeof v === "number") return "a number";
  if (typeof v === "string") return "a string";
  if (typeof v === "boolean") return "true or false";
  if (isList(v)) return "a list";
  return `a ${v.def.name} instance`;
}

export function format(v: RuntimeValue): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isList(v)) return "[" + v.items.map(format).join(", ") + "]";
  const parts = v.def.props.map((p, i) => `${p.name}: ${format(v.values[i])}`);
  return `${v.def.name}{ ${parts.join(", ")} }`;
}

function deepCopy(v: RuntimeValue): RuntimeValue {
  if (isStruct(v)) return new StructInstance(v.def, v.values.map(deepCopy));
  if (isList(v)) return new ListValue(v.items.map(deepCopy));
  return v;
}

// ---------------------------------------------------------------------------
// scopes, loops, frames
// ---------------------------------------------------------------------------

class Scope {
  vars = new Map<string, RuntimeValue>();
  /** named repeats declared in this scope (one per activation) */
  loops = new Map<RepeatNamed, LoopInstance>();

  constructor(
    public parent: Scope | null,
    public isFunction: boolean,
  ) {}
}

type LoopState = "fresh" | "running" | "paused" | "frozen" | "finished";

class LoopInstance {
  state: LoopState = "fresh";
  savedFrames: Frame[] = [];
  snapshots: [string, RuntimeValue][] | null = null;
  homeScope: Scope | null = null;

  constructor(public decl: RepeatNamed) {}
}

interface Frame {
  stmts: Stmt[];
  ip: number;
  kind: "block" | "do-until" | "named" | "func";
  cond?: Expr;
  loop?: LoopInstance;
  scope: Scope;
  owner: LoopInstance | null;
}

/** Thrown by repeat.break after the pause has been recorded. */
class PauseHandled extends Error {}

/** Thrown by func.r. */
class ReturnSignal {
  constructor(public value: RuntimeValue | undefined) {}
}

// ---------------------------------------------------------------------------
// interpreter
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** where log.out lines go (defaults to console-style printing) */
  out?: (line: string) => void;
}

export class Interpreter {
  private frames: Frame[] = [];
  private globalScope = new Scope(null, false);
  private out: (line: string) => void;

  constructor(
    private result: AnalysisResult,
    options: RunOptions = {},
  ) {
    this.out = options.out ?? ((line) => process.stdout.write(line + "\n"));
  }

  run(): void {
    this.frames.push({
      stmts: this.result.stmts,
      ip: 0,
      kind: "block",
      scope: this.globalScope,
      owner: null,
    });
    try {
      this.runUntil(0);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        throw new HazmaError("H4099", "func.r was used outside a function", undefined);
      }
      if (e instanceof PauseHandled) return;
      throw e;
    }
  }

  // ---------------------------------------------------------- frame machine

  private runUntil(depth: number): RuntimeValue | undefined {
    while (this.frames.length > depth) {
      const fr = this.frames[this.frames.length - 1];
      if (fr.ip >= fr.stmts.length) {
        if (fr.kind === "do-until") {
          if (fr.cond) {
            const c = this.evalBool(fr.cond, fr.scope, "the repeat condition", fr.cond.span);
            if (c) {
              this.frames.pop();
              continue;
            }
          }
          fr.ip = 0;
          continue;
        }
        if (fr.kind === "named") {
          const loop = fr.loop!;
          if (loop.decl.cond) {
            const c = this.evalBool(loop.decl.cond, fr.scope, "the till condition", loop.decl.cond.span);
            if (c) {
              this.frames.pop();
              loop.state = "finished";
              continue;
            }
          }
          fr.ip = 0;
          continue;
        }
        this.frames.pop();
        continue;
      }
      const stmt = fr.stmts[fr.ip++];
      try {
        this.execStmt(stmt, fr);
      } catch (e) {
        if (e instanceof PauseHandled) continue;
        throw e;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------- statements

  private execStmt(stmt: Stmt, fr: Frame): void {
    switch (stmt.kind) {
      case "save":
      case "assign": {
        const name = stmt.target[0];
        const value = this.eval(stmt.expr, fr.scope, stmt.span);
        this.checkIsNaming(name, value, stmt.span);
        const holder = this.findVarHolder(name, fr.scope);
        if (holder) {
          // re-executed save = re-initialize, keeping the type (change rules)
          this.checkAssignType(holder.vars.get(name)!, value, name, stmt.span, false);
          holder.vars.set(name, value);
        } else {
          fr.scope.vars.set(name, value);
        }
        break;
      }

      case "change": {
        if (stmt.expr) {
          const value = this.eval(stmt.expr, fr.scope, stmt.span);
          this.assignTo(stmt.target, value, stmt.span, false);
        } else if (stmt.props) {
          this.multiAssign(stmt.target, stmt.props, stmt.span, fr.scope);
        }
        break;
      }

      case "t.change": {
        const value = this.eval(stmt.expr, fr.scope, stmt.span);
        this.assignTo(stmt.target, value, stmt.span, true);
        break;
      }

      case "l.save": {
        const name = stmt.target[0];
        const value = new ListValue(stmt.items.map((item) => this.eval(item, fr.scope, item.span)));
        this.checkIsNaming(name, value, stmt.span);
        const holder = this.findVarHolder(name, fr.scope);
        if (holder) {
          // re-executed l.save re-initializes the list, like save does
          this.checkAssignType(holder.vars.get(name)!, value, name, stmt.span, false);
          holder.vars.set(name, value);
        } else {
          fr.scope.vars.set(name, value);
        }
        break;
      }

      case "l.add": {
        const list = this.requireListPath(stmt.target, fr.scope, stmt.span, "l.add");
        for (const item of stmt.items) {
          list.items.push(this.eval(item, fr.scope, item.span));
        }
        break;
      }

      case "l.remove": {
        const list = this.requireListPath(stmt.target, fr.scope, stmt.span, "l.remove");
        for (const valueExpr of stmt.values) {
          const value = this.eval(valueExpr, fr.scope, valueExpr.span);
          const at = list.items.findIndex((item) => valueEquals(item, value));
          if (at === -1) {
            throw new HazmaError(
              "H4063",
              `${format(value)} is not in "${stmt.target.join(".")}", so it cannot be removed`,
              valueExpr.span,
              "l.remove removes the first matching element - check the value with l.find first",
            );
          }
          list.items.splice(at, 1);
        }
        break;
      }

      case "l.change": {
        const list = this.requireListPath(stmt.target, fr.scope, stmt.span, "l.change");
        for (const c of stmt.changes) {
          const at = this.listIndex(c.index, fr.scope, list);
          list.items[at] = this.eval(c.value, fr.scope, c.value.span);
        }
        break;
      }

      case "check.error": {
        this.execCheckError(stmt, fr);
        break;
      }

      case "file.create": {
        const p = this.pathArg(stmt.path, fr.scope, "file.create");
        try {
          if (existsSync(p)) {
            if (!statSync(p).isFile()) {
              throw new HazmaError(
                "H6006",
                `"${p}" is a folder, not a file`,
                stmt.span,
                "file.create creates files - use folder.create for folders",
              );
            }
            break; // creating an existing file does nothing
          }
          this.retryBusy(() => writeFileSync(p, ""));
        } catch (e) {
          if (e instanceof HazmaError) throw e;
          throw this.fsFailure(e, p, stmt.span, "create");
        }
        break;
      }

      case "file.write":
      case "file.add": {
        const op = stmt.kind;
        const p = this.pathArg(stmt.path, fr.scope, op);
        if (!existsSync(p)) {
          throw new HazmaError(
            "H6001",
            `${op} cannot find "${p}"`,
            stmt.span,
            "create the file first with file.create",
          );
        }
        if (!statSync(p).isFile()) {
          throw new HazmaError("H6006", `"${p}" is a folder, not a file`, stmt.span);
        }
        try {
          if (op === "file.write") this.retryBusy(() => writeFileSync(p, stmt.rawText));
          else this.retryBusy(() => appendFileSync(p, stmt.rawText));
        } catch (e) {
          if (e instanceof HazmaError) throw e;
          throw this.fsFailure(e, p, stmt.span, op === "file.write" ? "write" : "append");
        }
        break;
      }

      case "file.delete": {
        const p = this.pathArg(stmt.path, fr.scope, "file.delete");
        if (!existsSync(p)) {
          throw new HazmaError("H6001", `file.delete cannot find "${p}"`, stmt.span);
        }
        if (!statSync(p).isFile()) {
          throw new HazmaError(
            "H6006",
            `"${p}" is a folder, not a file`,
            stmt.span,
            "use folder.delete to remove a folder and everything inside it",
          );
        }
        try {
          this.retryBusy(() => unlinkSync(p));
        } catch (e) {
          if (e instanceof HazmaError) throw e;
          throw this.fsFailure(e, p, stmt.span, "delete-file");
        }
        break;
      }

      case "folder.create": {
        const p = this.pathArg(stmt.path, fr.scope, "folder.create");
        if (existsSync(p)) {
          if (!statSync(p).isDirectory()) {
            throw new HazmaError("H6006", `"${p}" is a file, not a folder`, stmt.span);
          }
          break; // already exists
        }
        try {
          this.retryBusy(() => mkdirSync(p)); // non-recursive: a missing parent is an error
        } catch (e) {
          if (e instanceof HazmaError) throw e;
          throw this.fsFailure(e, p, stmt.span, "folder-create");
        }
        break;
      }

      case "folder.delete": {
        const p = this.pathArg(stmt.path, fr.scope, "folder.delete");
        if (!existsSync(p)) {
          throw new HazmaError("H6001", `folder.delete cannot find "${p}"`, stmt.span);
        }
        if (!statSync(p).isDirectory()) {
          throw new HazmaError(
            "H6006",
            `"${p}" is a file, not a folder`,
            stmt.span,
            "use file.delete to remove a single file",
          );
        }
        try {
          this.retryBusy(() => rmSync(p, { recursive: true }));
        } catch (e) {
          if (e instanceof HazmaError) throw e;
          throw this.fsFailure(e, p, stmt.span, "delete-folder");
        }
        break;
      }

      case "log": {
        this.out(format(this.eval(stmt.expr, fr.scope, stmt.span)));
        break;
      }

      case "if": {
        for (const b of stmt.branches) {
          if (this.evalBool(b.cond, fr.scope, "the if condition", b.cond.span)) {
            this.pushBlock(b.body, fr);
            return;
          }
        }
        if (stmt.elseBody) this.pushBlock(stmt.elseBody, fr);
        break;
      }

      case "s.change": {
        const subject = this.eval(stmt.subject, fr.scope, stmt.span);
        for (const b of stmt.branches) {
          const v = this.eval(b.value, fr.scope, b.value.span);
          if (valueEquals(subject, v)) {
            this.pushBlock(b.body, fr);
            return;
          }
        }
        if (stmt.defaultBody) this.pushBlock(stmt.defaultBody, fr);
        break;
      }

      case "repeat": {
        this.frames.push({
          stmts: stmt.body,
          ip: 0,
          kind: "do-until",
          cond: stmt.cond,
          scope: fr.scope,
          owner: fr.owner,
        });
        break;
      }

      case "repeat.named": {
        const loop = this.getOrCreateLoop(stmt, fr.scope);
        switch (loop.state) {
          case "fresh": {
            loop.snapshots = this.captureSnapshots(stmt.usedVars ?? [], fr.scope);
            this.startLoop(loop, fr);
            break;
          }
          case "paused":
            this.resumeLoop(loop);
            break;
          case "running":
            throw new HazmaError(
              "H4020",
              `repeat "${stmt.name}" is already running`,
              stmt.span,
              "a running repeat cannot be started again - use repeat.break : to pause it first",
            );
          case "frozen":
            throw new HazmaError(
              "H4021",
              `repeat "${stmt.name}" is frozen inside a paused repeat`,
              stmt.span,
              "resume the outer repeat first with repeat.continue :",
            );
          case "finished":
            throw new HazmaError(
              "H4022",
              `repeat "${stmt.name}" has already finished`,
              stmt.span,
              `use repeat.new : ${stmt.name} to start it again`,
            );
        }
        break;
      }

      case "repeat.break": {
        const loop = this.getLoop(stmt, fr.scope);
        if (loop.state !== "running" || !this.loopIsOnStack(loop)) {
          throw new HazmaError(
            "H4023",
            `repeat "${stmt.name}" is not running right now`,
            stmt.span,
            loop.state === "paused"
              ? "it is already paused - resume it with repeat.continue :"
              : loop.state === "finished"
                ? "it already finished - use repeat.new : to run it again"
                : undefined,
          );
        }
        let idx = -1;
        for (let i = this.frames.length - 1; i >= 0; i--) {
          if (this.frames[i].loop === loop) {
            idx = i;
            break;
          }
        }
        if (idx === -1) {
          throw new HazmaError("H4023", `repeat "${stmt.name}" is not running right now`, stmt.span);
        }
        const removed = this.frames.splice(idx);
        loop.savedFrames = removed;
        for (const f of removed) {
          if (f.kind === "named" && f.loop && f.loop !== loop && f.loop.state === "running") {
            f.loop.state = "frozen";
          }
        }
        loop.state = "paused";
        throw new PauseHandled();
      }

      case "repeat.continue": {
        const loop = this.getLoop(stmt, fr.scope);
        switch (loop.state) {
          case "fresh": {
            loop.snapshots = this.captureSnapshots(loop.decl.usedVars ?? [], fr.scope);
            this.startLoop(loop, fr);
            break;
          }
          case "paused":
            this.resumeLoop(loop);
            break;
          case "running":
            throw new HazmaError("H4020", `repeat "${stmt.name}" is already running`, stmt.span);
          case "frozen":
            throw new HazmaError(
              "H4021",
              `repeat "${stmt.name}" is frozen inside a paused repeat`,
              stmt.span,
              "resume the outer repeat first with repeat.continue :",
            );
          case "finished":
            throw new HazmaError(
              "H4024",
              `repeat "${stmt.name}" has already finished`,
              stmt.span,
              `use repeat.new : ${stmt.name} to run it again`,
            );
        }
        break;
      }

      case "repeat.new": {
        const loop = this.getLoop(stmt, fr.scope);
        switch (loop.state) {
          case "fresh": {
            loop.snapshots = this.captureSnapshots(loop.decl.usedVars ?? [], fr.scope);
            this.startLoop(loop, fr);
            break;
          }
          case "paused":
          case "finished": {
            this.restoreSnapshots(loop);
            loop.savedFrames = [];
            this.startLoop(loop, fr);
            break;
          }
          case "running":
            throw new HazmaError(
              "H4025",
              `repeat "${stmt.name}" is running and cannot be restarted from inside itself`,
              stmt.span,
              "pause it first with repeat.break :",
            );
          case "frozen":
            throw new HazmaError(
              "H4021",
              `repeat "${stmt.name}" is frozen inside a paused repeat`,
              stmt.span,
              "resume the outer repeat first with repeat.continue :",
            );
        }
        break;
      }

      case "func":
      case "struct":
        break; // handled during analysis

      case "func.c.stmt": {
        this.callFunction(stmt.call, fr.scope, stmt.span);
        break;
      }

      case "func.r": {
        throw new ReturnSignal(this.eval(stmt.expr, fr.scope, stmt.span));
      }

      case "func.p":
        break; // consumed by the parser into parameters
    }
  }

  /**
   * Runs the guarded statement in a nested frame. A thrown runtime error makes
   * the handler run; a return or a pause is control flow, not a failure.
   */
  private execCheckError(stmt: Extract<Stmt, { kind: "check.error" }>, fr: Frame): void {
    const depth = this.frames.length;
    this.frames.push({
      stmts: [stmt.protectedStmt],
      ip: 0,
      kind: "block",
      scope: fr.scope,
      owner: fr.owner,
    });
    let failure: unknown = null;
    try {
      this.runUntil(depth);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.frames.length = Math.min(this.frames.length, depth);
        throw e;
      }
      if (e instanceof PauseHandled) {
        // Backstop only: the analyzer rejects a pause command directly under
        // check.error with H3066, so a pause should never reach this point.
        this.frames.length = Math.min(this.frames.length, depth);
        throw new HazmaError(
          "H4098",
          "check.error cannot watch a command that pauses a repeat",
          stmt.protectedStmt.span,
          "move repeat.break : outside the command guarded by check.error",
        );
      }
      failure = e;
      this.frames.length = Math.min(this.frames.length, depth);
    }
    if (failure !== null) {
      const handlerDepth = this.frames.length;
      this.frames.push({
        stmts: stmt.handler,
        ip: 0,
        kind: "block",
        scope: fr.scope,
        owner: fr.owner,
      });
      this.runUntil(handlerDepth);
    }
  }

  /** Evaluates a file/folder path and requires it to be non-empty text. */
  private pathArg(expr: Expr, scope: Scope, op: string): string {
    const v = this.eval(expr, scope, expr.span);
    if (typeof v !== "string") {
      throw new HazmaError(
        "H6003",
        `${op} needs a text path, but this is ${fmtType(v)}`,
        expr.span,
      );
    }
    if (v.length === 0) {
      throw new HazmaError("H6003", `${op} needs a non-empty path`, expr.span);
    }
    return v;
  }

  /** Windows antivirus scanners briefly lock a file right after it is written.
   *  EBUSY/EAGAIN here are transient sharing violations, so retry briefly. */
  private retryBusy<T>(op: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try {
        return op();
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if ((code !== "EBUSY" && code !== "EAGAIN") || attempt >= 6) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  /** Maps a Node filesystem error onto a stable HAZMA diagnostic. */
  private fsFailure(
    e: unknown,
    path: string,
    span: Span | undefined,
    action: "create" | "write" | "append" | "read" | "delete-file" | "delete-folder" | "folder-create",
  ): HazmaError {
    const code = (e as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      if (action === "create" || action === "folder-create") {
        return new HazmaError(
          "H6002",
          `cannot create "${path}" because its parent folder does not exist`,
          span,
          "create the parent folder first with folder.create",
        );
      }
      return new HazmaError("H6001", `"${path}" does not exist`, span);
    }
    if (code === "EACCES" || code === "EPERM") {
      return new HazmaError("H6003", `no permission to access "${path}"`, span);
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG" || code === "ENOTDIR") {
      return new HazmaError("H6003", `"${path}" is not a valid path`, span);
    }
    switch (action) {
      case "read":
        return new HazmaError("H6008", `could not read "${path}"`, span);
      case "delete-file":
        return new HazmaError("H6007", `could not delete "${path}"`, span);
      case "delete-folder":
        return new HazmaError("H6005", `could not delete the folder "${path}"`, span);
      default:
        return new HazmaError("H6004", `could not write "${path}"`, span);
    }
  }

  private pushBlock(stmts: Stmt[], fr: Frame): void {
    this.frames.push({ stmts, ip: 0, kind: "block", scope: fr.scope, owner: fr.owner });
  }

  // ------------------------------------------------------------- loop utils

  private findLoop(decl: RepeatNamed, scope: Scope): LoopInstance | undefined {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const l = s.loops.get(decl);
      if (l) return l;
    }
    return undefined;
  }

  private activationScope(scope: Scope): Scope {
    let s = scope;
    while (!s.isFunction && s.parent !== null) s = s.parent;
    return s;
  }

  private getOrCreateLoop(decl: RepeatNamed, scope: Scope): LoopInstance {
    const existing = this.findLoop(decl, scope);
    if (existing) return existing;
    const owner = decl.scopeKind === "global" ? this.globalScope : this.activationScope(scope);
    const loop = new LoopInstance(decl);
    owner.loops.set(decl, loop);
    return loop;
  }

  private getLoop(stmt: { kind: string; name: string; span: Span; targetDecl?: RepeatNamed }, scope: Scope): LoopInstance {
    if (!stmt.targetDecl) {
      throw new HazmaError("H4099", `internal: repeat "${stmt.name}" has no target`, stmt.span);
    }
    const loop = this.findLoop(stmt.targetDecl, scope);
    if (!loop) {
      throw new HazmaError(
        "H4026",
        `there is no active repeat named "${stmt.name}"`,
        stmt.span,
        "repeats declared inside a function stop existing when the function returns",
      );
    }
    return loop;
  }

  private loopIsOnStack(loop: LoopInstance): boolean {
    return this.frames.some((f) => f.loop === loop);
  }

  private startLoop(loop: LoopInstance, fr: Frame): void {
    loop.state = "running";
    loop.homeScope = fr.scope;
    this.frames.push({
      stmts: loop.decl.body,
      ip: 0,
      kind: "named",
      loop,
      scope: fr.scope,
      owner: loop,
    });
  }

  private resumeLoop(loop: LoopInstance): void {
    loop.state = "running";
    const saved = loop.savedFrames;
    loop.savedFrames = [];
    for (const f of saved) {
      if (f.kind === "named" && f.loop && f.loop.state === "frozen") f.loop.state = "running";
      this.frames.push(f);
    }
  }

  private captureSnapshots(names: string[], scope: Scope): [string, RuntimeValue][] {
    const snaps: [string, RuntimeValue][] = [];
    for (const name of names) {
      const holder = this.findVarHolder(name, scope);
      if (holder) snaps.push([name, deepCopy(holder.vars.get(name)!)]);
    }
    return snaps;
  }

  private restoreSnapshots(loop: LoopInstance): void {
    if (!loop.snapshots) return;
    const home = loop.homeScope ?? this.globalScope;
    for (const [name, value] of loop.snapshots) {
      const holder = this.findVarHolder(name, home);
      if (holder) holder.vars.set(name, deepCopy(value));
    }
  }

  // ------------------------------------------------------------- assignments

  private checkIsNaming(name: string, value: RuntimeValue, span: Span): void {
    if (name.startsWith("is.")) {
      if (typeof value !== "boolean") {
        throw new HazmaError(
          "H4010",
          `"${name}" starts with is. so it holds true or false, but ${format(value)} was saved`,
          span,
        );
      }
    } else if (typeof value === "boolean") {
      throw new HazmaError(
        "H4010",
        `booleans use the is. naming - save : is.${name} = ${format(value)}`,
        span,
      );
    }
  }

  private checkAssignType(
    current: RuntimeValue,
    value: RuntimeValue,
    name: string,
    span: Span,
    allowRetype: boolean,
  ): void {
    if (allowRetype || sameValueType(current, value)) return;
    throw new HazmaError(
      "H4002",
      `"${name}" holds ${fmtType(current)} and cannot be changed to ${fmtType(value)}`,
      span,
      `use t.change : ${name} = ... to change the type of a variable`,
    );
  }

  private assignTo(target: string[], value: RuntimeValue, span: Span, allowRetype: boolean): void {
    // plain variable (single name, or an is.* boolean name of any depth)
    if (target.length === 1 || target[0] === "is") {
      const name = target.length === 1 ? target[0] : target.join(".");
      const holder = this.findVarHolder(name, this.currentScope());
      if (!holder) {
        throw new HazmaError("H4001", `unknown variable "${name}"`, span);
      }
      this.checkIsNaming(name, value, span);
      this.checkAssignType(holder.vars.get(name)!, value, name, span, allowRetype);
      holder.vars.set(name, value);
      return;
    }

    // property path: alex.health.coins
    const holder = this.findVarHolder(target[0], this.currentScope());
    if (!holder) {
      throw new HazmaError("H4001", `unknown variable "${target[0]}"`, span);
    }
    let cur = holder.vars.get(target[0])!;
    for (let i = 1; i < target.length; i++) {
      const prop = target[i];
      if (!isStruct(cur)) {
        throw new HazmaError(
          "H4009",
          `"${target.slice(0, i).join(".")}" is ${fmtType(cur)} and has no properties`,
          span,
        );
      }
      const at = cur.def.index.get(prop);
      if (at === undefined) {
        throw new HazmaError(
          "H4013",
          `the structure "${cur.def.name}" has no property "${prop}"`,
          span,
        );
      }
      if (i < target.length - 1) {
        cur = cur.values[at];
        continue;
      }
      if (cur.def.props[at].isConst) {
        throw new HazmaError(
          "H4011",
          `"${prop}" is a const property and can never be changed`,
          span,
          "const. properties are locked when the structure is declared",
        );
      }
      this.checkIsNaming(prop, value, span);
      this.checkAssignType(cur.values[at], value, target.join("."), span, allowRetype);
      cur.values[at] = value;
      return;
    }
  }

  /** Resolve a path (variable or struct property) that must hold a list. */
  private requireListPath(target: string[], scope: Scope, span: Span, op: string): ListValue {
    const v = this.readPath(target, span, scope);
    if (!isList(v)) {
      throw new HazmaError(
        "H4064",
        `${op} needs a list, but "${target.join(".")}" is ${fmtType(v)}`,
        span,
        "create a list first with: l.save : name = { ... }",
      );
    }
    return v;
  }

  /** Evaluate an expression that must produce a list. */
  private evalList(expr: Expr, scope: Scope, op: string): ListValue {
    const v = this.eval(expr, scope, expr.span);
    if (!isList(v)) {
      throw new HazmaError(
        "H4064",
        `${op} needs a list, but this is ${fmtType(v)}`,
        expr.span,
        "create a list first with: l.save : name = { ... }",
      );
    }
    return v;
  }

  /** Turn a 1-based index expression into a 0-based offset, validating it. */
  private listIndex(expr: Expr, scope: Scope, list: ListValue): number {
    const raw = this.eval(expr, scope, expr.span);
    const n = list.items.length;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw new HazmaError(
        "H4061",
        `list indexes are whole numbers starting at 1, but the index is ${format(raw)}`,
        expr.span,
        n === 0 ? "the list is empty" : `the list has ${n} element${n === 1 ? "" : "s"}`,
      );
    }
    if (raw > n) {
      throw new HazmaError(
        "H4062",
        `index ${raw} is out of range - the list has ${n} element${n === 1 ? "" : "s"}`,
        expr.span,
        n === 0 ? "the list is empty, so there is nothing to access" : `use an index from 1 to ${n}`,
      );
    }
    return raw - 1;
  }

  private multiAssign(
    target: string[],
    props: PropAssign[],
    span: Span,
    scope: Scope,
  ): void {
    const holder = this.findVarHolder(target[0], scope);
    if (!holder) {
      throw new HazmaError("H4001", `unknown variable "${target[0]}"`, span);
    }
    let cur: RuntimeValue = holder.vars.get(target[0])!;
    for (let i = 1; i < target.length; i++) {
      if (!isStruct(cur)) {
        throw new HazmaError(
          "H4009",
          `"${target.slice(0, i).join(".")}" is ${fmtType(cur)} and has no properties`,
          span,
        );
      }
      const at = cur.def.index.get(target[i]);
      if (at === undefined) {
        throw new HazmaError(
          "H4013",
          `the structure "${cur.def.name}" has no property "${target[i]}"`,
          span,
        );
      }
      cur = cur.values[at];
    }
    if (!isStruct(cur)) {
      throw new HazmaError(
        "H4014",
        `change : ${target.join(".")} { ... } needs a structure instance, but it is ${fmtType(cur)}`,
        span,
      );
    }
    for (const p of props) {
      const at = cur.def.index.get(p.name);
      if (at === undefined) {
        throw new HazmaError(
          "H4013",
          `the structure "${cur.def.name}" has no property "${p.name}"`,
          p.span,
        );
      }
      if (cur.def.props[at].isConst) {
        throw new HazmaError(
          "H4011",
          `"${p.name}" is a const property and can never be changed`,
          p.span,
          "const. properties are locked when the structure is declared",
        );
      }
      const value = this.eval(p.expr, scope, p.span);
      this.checkIsNaming(p.name, value, p.span);
      this.checkAssignType(cur.values[at], value, `${target.join(".")}.${p.name}`, p.span, false);
      cur.values[at] = value;
    }
  }

  /** The scope of the frame currently being executed. */
  private currentScope(): Scope {
    return this.frames[this.frames.length - 1].scope;
  }

  private findVarHolder(name: string, scope: Scope): Scope | undefined {
    for (let s: Scope | null = scope; s; s = s.parent) {
      if (s.vars.has(name)) return s;
    }
    return undefined;
  }

  // ------------------------------------------------------------- expressions

  private eval(expr: Expr, scope: Scope, span?: Span): RuntimeValue {
    switch (expr.kind) {
      case "number":
      case "string":
      case "boolean":
        return expr.value;

      case "path":
        return this.readPath(expr.parts, expr.span ?? span, scope);

      case "round": {
        const v = this.eval(expr.inner, scope, span);
        if (typeof v !== "number") {
          throw new HazmaError(
            "H4027",
            `price.r rounds numbers, but this is ${fmtType(v)}`,
            expr.span,
          );
        }
        return Math.round(v);
      }

      case "neg": {
        const v = this.eval(expr.operand, scope, span);
        if (typeof v !== "number") {
          throw new HazmaError(
            "H4029",
            `a minus sign works on numbers, but this is ${fmtType(v)}`,
            expr.span,
          );
        }
        return -v;
      }

      case "not": {
        const v = this.eval(expr.operand, scope, span);
        if (typeof v !== "boolean") {
          throw new HazmaError(
            "H4033",
            `not works on true or false, but this is ${fmtType(v)}`,
            expr.span,
          );
        }
        return !v;
      }

      case "binary":
        return this.evalBinary(expr, scope);

      case "struct.c":
        return this.instantiate(expr.structName, expr.overrides, expr.span, scope);

      case "func.c": {
        const v = this.callFunction(expr, scope, expr.span);
        if (v === undefined) {
          throw new HazmaError(
            "H4028",
            `the function "${expr.funcName}" returns nothing, so it cannot be used as a value`,
            expr.span,
          );
        }
        return v;
      }

      case "list.lit":
        return new ListValue(expr.items.map((item) => this.eval(item, scope, item.span)));

      case "index": {
        const target = this.eval(expr.target, scope, expr.span);
        if (!isList(target)) {
          throw new HazmaError(
            "H4060",
            `${fmtType(target)} cannot be indexed - only lists are indexed, like weapons[1]`,
            expr.span,
          );
        }
        return target.items[this.listIndex(expr.index, scope, target)];
      }

      case "list.count": {
        const list = this.evalList(expr.list, scope, "l.count");
        return list.items.length;
      }

      case "list.find": {
        const list = this.evalList(expr.list, scope, "l.find");
        const value = this.eval(expr.value, scope, expr.value.span);
        return list.items.some((item) => valueEquals(item, value));
      }

      case "list.find.index": {
        const list = this.evalList(expr.list, scope, "l.find.index");
        const value = this.eval(expr.value, scope, expr.value.span);
        const at = list.items.findIndex((item) => valueEquals(item, value));
        return at === -1 ? 0 : at + 1;
      }

      case "file.read": {
        const p = this.pathArg(expr.path, scope, "file.read");
        if (!existsSync(p)) {
          throw new HazmaError(
            "H6001",
            `file.read cannot find "${p}"`,
            expr.span,
            "check the path with file.exists first, or wrap this in check.error",
          );
        }
        if (!statSync(p).isFile()) {
          throw new HazmaError("H6006", `"${p}" is a folder, not a file`, expr.span);
        }
        try {
          return this.retryBusy(() => readFileSync(p, "utf8"));
        } catch (e) {
          throw this.fsFailure(e, p, expr.span, "read");
        }
      }

      case "file.exists": {
        const p = this.pathArg(expr.path, scope, "file.exists");
        try {
          return existsSync(p) && statSync(p).isFile();
        } catch {
          return false;
        }
      }
    }
  }

  private evalBinary(
    expr: Extract<Expr, { kind: "binary" }>,
    scope: Scope,
  ): RuntimeValue {
    const op = expr.op;

    if (op === "and" || op === "or") {
      const l = this.evalBool(expr.left, scope, `"${op}"`, expr.left.span);
      if (op === "and" && !l) return false;
      if (op === "or" && l) return true;
      return this.evalBool(expr.right, scope, `"${op}"`, expr.right.span);
    }

    const l = this.eval(expr.left, scope, expr.span);
    const r = this.eval(expr.right, scope, expr.span);

    switch (op) {
      case "+": {
        if (typeof l === "string" || typeof r === "string") {
          return format(l) + format(r);
        }
        if (typeof l === "number" && typeof r === "number") return l + r;
        throw new HazmaError(
          "H4029",
          `+ works with numbers or text, but this is ${fmtType(l)} + ${fmtType(r)}`,
          expr.span,
        );
      }
      case "-":
      case "*": {
        if (typeof l !== "number" || typeof r !== "number") {
          throw new HazmaError(
            "H4029",
            `"${op}" works with numbers, but this is ${fmtType(l)} and ${fmtType(r)}`,
            expr.span,
          );
        }
        return op === "-" ? l - r : l * r;
      }
      case "/": {
        if (typeof l !== "number" || typeof r !== "number") {
          throw new HazmaError(
            "H4029",
            `"/" works with numbers, but this is ${fmtType(l)} and ${fmtType(r)}`,
            expr.span,
          );
        }
        if (r === 0) {
          throw new HazmaError("H4031", "division by zero", expr.span);
        }
        return l / r;
      }
      case "==":
        return valueEquals(l, r);
      case "!=":
        return !valueEquals(l, r);
      case ">":
      case "<":
      case ">=":
      case "<=": {
        if (typeof l !== "number" || typeof r !== "number") {
          throw new HazmaError(
            "H4032",
            `"${op}" compares numbers, but this is ${fmtType(l)} and ${fmtType(r)}`,
            expr.span,
          );
        }
        switch (op) {
          case ">": return l > r;
          case "<": return l < r;
          case ">=": return l >= r;
          default: return l <= r;
        }
      }
      default:
        return false;
    }
  }

  private evalBool(expr: Expr, scope: Scope, what: string, span: Span): boolean {
    const v = this.eval(expr, scope, span);
    if (typeof v !== "boolean") {
      throw new HazmaError(
        "H4033",
        `${what} must be true or false, but this is ${fmtType(v)}`,
        span,
      );
    }
    return v;
  }

  private readPath(parts: string[], span: Span | undefined, scope: Scope): RuntimeValue {
    if (parts[0] === "is") {
      // is.fight.over is one variable whose whole name is dotted
      return this.readVar(parts.join("."), span, scope);
    }
    if (parts.length === 1) return this.readVar(parts[0], span, scope);

    let cur = this.readVar(parts[0], span, scope);
    for (let i = 1; i < parts.length; i++) {
      if (!isStruct(cur)) {
        throw new HazmaError(
          "H4009",
          `"${parts.slice(0, i).join(".")}" is ${fmtType(cur)} and has no properties`,
          span,
        );
      }
      const at = cur.def.index.get(parts[i]);
      if (at === undefined) {
        throw new HazmaError(
          "H4013",
          `the structure "${cur.def.name}" has no property "${parts[i]}"`,
          span,
        );
      }
      cur = cur.values[at];
    }
    return cur;
  }

  private readVar(name: string, span: Span | undefined, scope: Scope): RuntimeValue {
    const holder = this.findVarHolder(name, scope);
    if (!holder) {
      throw new HazmaError("H4001", `unknown variable "${name}"`, span);
    }
    return holder.vars.get(name)!;
  }

  private instantiate(
    structName: string,
    overrides: PropAssign[],
    span: Span,
    scope: Scope,
  ): RuntimeValue {
    const def = this.structs.get(structName);
    if (!def) {
      throw new HazmaError("H4015", `unknown structure "${structName}"`, span);
    }
    const values = def.props.map((p) => this.constEval(p.defaultExpr, scope, span));
    for (const o of overrides) {
      const at = def.index.get(o.name);
      if (at === undefined) {
        throw new HazmaError(
          "H4013",
          `the structure "${def.name}" has no property "${o.name}"`,
          o.span,
        );
      }
      if (def.props[at].isConst) {
        throw new HazmaError(
          "H4011",
          `"${o.name}" is a const property and cannot receive a custom value`,
          o.span,
        );
      }
      values[at] = this.eval(o.expr, scope, o.span);
    }
    return new StructInstance(def, values);
  }

  /** Structure defaults are literals or nested struct.c (validated by analysis). */
  private constEval(expr: Expr, scope: Scope, span: Span): RuntimeValue {
    switch (expr.kind) {
      case "number":
      case "string":
      case "boolean":
        return expr.value;
      case "neg": {
        const v = this.constEval(expr.operand, scope, span);
        return typeof v === "number" ? -v : v;
      }
      case "struct.c":
        return this.instantiate(expr.structName, expr.overrides, expr.span, scope);
      case "list.lit":
        return new ListValue(expr.items.map((item) => this.constEval(item, scope, span)));
      default:
        throw new HazmaError(
          "H4016",
          "structure defaults must be literal values",
          expr.span,
        );
    }
  }

  // -------------------------------------------------------------- functions

  private callFunction(call: { funcName: string; args: { name?: string; expr: Expr }[] }, scope: Scope, span?: Span): RuntimeValue | undefined {
    const fn = this.funcs.get(call.funcName);
    if (!fn) {
      throw new HazmaError("H4017", `unknown function "${call.funcName}"`, span);
    }

    const local = new Scope(this.globalScope, true);
    const bound = new Map<string, RuntimeValue>();
    const named = call.args.some((a) => a.name !== undefined);
    if (named) {
      for (const a of call.args) {
        if (a.name === undefined) continue;
        bound.set(a.name, this.eval(a.expr, scope, span));
      }
    } else {
      call.args.forEach((a, i) => {
        const p = fn.params[i];
        if (!p) return; // compile-time error
        bound.set(p.name, this.eval(a.expr, scope, span));
      });
    }

    for (const p of fn.params) {
      if (bound.has(p.name)) {
        const v = bound.get(p.name)!;
        if (p.name.startsWith("is.") && typeof v !== "boolean") {
          throw new HazmaError(
            "H4010",
            `${p.name} holds true or false, but ${format(v)} was passed`,
            span,
          );
        }
        local.vars.set(p.name, v);
        continue;
      }
      if (p.hasDefault && p.defaultExpr) {
        local.vars.set(p.name, this.eval(p.defaultExpr, local, span));
        continue;
      }
      throw new HazmaError(
        "H4026",
        `the argument "${p.name}" is missing in the call to "${fn.name}"`,
        span,
      );
    }

    const depth = this.frames.length;
    this.frames.push({ stmts: fn.body, ip: 0, kind: "func", scope: local, owner: null });
    try {
      this.runUntil(depth);
      return undefined;
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.frames.length = Math.min(this.frames.length, depth);
        return e.value;
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- lookups

  private get structs(): Map<string, StructIR> {
    return this.result.structs;
  }

  private get funcs(): Map<string, FuncIR> {
    return this.result.funcs;
  }
}
