// HAZMA - Abstract Syntax Tree node definitions.
// Every node carries a source Span so diagnostics can point at exact locations.

import type { Span } from "../errors.js";

export interface BaseNode {
  span: Span;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | Path
  | Round
  | UnaryNeg
  | Binary
  | Not
  | StructCreate
  | FuncCall;

export interface NumberLit extends BaseNode {
  kind: "number";
  value: number;
}

export interface StringLit extends BaseNode {
  kind: "string";
  value: string;
}

export interface BoolLit extends BaseNode {
  kind: "boolean";
  value: boolean;
}

/** Dotted path such as `age`, `is.ready`, `alex.inventory.coins`. */
export interface Path extends BaseNode {
  kind: "path";
  parts: string[];
}

/** Postfix round operator: `price.r` */
export interface Round extends BaseNode {
  kind: "round";
  inner: Expr;
}

export interface UnaryNeg extends BaseNode {
  kind: "neg";
  operand: Expr;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/"
  | "==" | "!=" | ">" | "<" | ">=" | "<="
  | "and" | "or";

export interface Binary extends BaseNode {
  kind: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface Not extends BaseNode {
  kind: "not";
  operand: Expr;
}

/** Property assignment line inside struct bodies / change blocks. */
export interface PropAssign {
  name: string;
  /** true when written as `const.name` */
  isConst: boolean;
  expr: Expr;
  span: Span;
}

export interface StructCreate extends BaseNode {
  kind: "struct.c";
  structName: string;
  overrides: PropAssign[];
}

export interface CallArg {
  /** present for named arguments: `name = "Alex"` */
  name?: string;
  expr: Expr;
  span: Span;
}

export interface FuncCall extends BaseNode {
  kind: "func.c";
  funcName: string;
  args: CallArg[];
  span: Span;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Stmt =
  | Save
  | BareAssign
  | Change
  | TypeChange
  | Log
  | If
  | Selection
  | RepeatUnnamed
  | RepeatNamed
  | RepeatBreak
  | RepeatContinue
  | RepeatNew
  | FuncDecl
  | FuncCallStmt
  | FuncReturn
  | StructDecl
  /** `func.p : name` - only valid as the first lines of a function body. */
  | FuncParamStmt;

export interface FuncParamStmt extends BaseNode {
  kind: "func.p";
  name: string;
  hasDefault: boolean;
  defaultExpr?: Expr;
}

/** `save : name = expr` - declares a variable (or re-initializes it when re-executed). */
export interface Save extends BaseNode {
  kind: "save";
  target: string[];
  expr: Expr;
}

/** `name = expr` - same rules as save, the struct-friendly shorthand. */
export interface BareAssign extends BaseNode {
  kind: "assign";
  target: string[];
  expr: Expr;
}

/**
 * `change : path = expr` or the multi-property form
 * `change : instance { prop = expr ... }`
 */
export interface Change extends BaseNode {
  kind: "change";
  target: string[];
  expr?: Expr;
  props?: PropAssign[];
}

/** `t.change : name = expr` - assigns a value of a different type, retyping the variable. */
export interface TypeChange extends BaseNode {
  kind: "t.change";
  target: string[];
  expr: Expr;
}

/** `log.out { expr }` */
export interface Log extends BaseNode {
  kind: "log";
  expr: Expr;
}

export interface IfBranch {
  cond: Expr;
  body: Stmt[];
  span: Span;
}

export interface If extends BaseNode {
  kind: "if";
  branches: IfBranch[];
  elseBody?: Stmt[];
}

export interface SelectionBranch {
  label: string;
  value: Expr;
  body: Stmt[];
  span: Span;
}

export interface Selection extends BaseNode {
  kind: "s.change";
  subject: Expr;
  branches: SelectionBranch[];
  defaultBody?: Stmt[];
}

/** `repeat till cond { body }` - body always executes before the condition. */
export interface RepeatUnnamed extends BaseNode {
  kind: "repeat";
  cond: Expr;
  body: Stmt[];
}

/**
 * `repeat : name { till cond ... body }`
 * The analyzer fills `usedVars` (names the body reads or writes) which the
 * runtime snapshots so `repeat.new` can restore them.
 */
export interface RepeatNamed extends BaseNode {
  kind: "repeat.named";
  name: string;
  cond?: Expr;
  body: Stmt[];
  usedVars?: string[];
  /** filled by the analyzer: where this repeat's runtime state lives */
  scopeKind?: "global" | "function";
}

export interface RepeatBreak extends BaseNode {
  kind: "repeat.break";
  name: string;
  /** filled by the analyzer: the enclosing RepeatNamed this break pauses */
  targetDecl?: RepeatNamed;
}

export interface RepeatContinue extends BaseNode {
  kind: "repeat.continue";
  name: string;
  /** filled by the analyzer: the RepeatNamed this statement resumes */
  targetDecl?: RepeatNamed;
}

export interface RepeatNew extends BaseNode {
  kind: "repeat.new";
  name: string;
  /** filled by the analyzer: the RepeatNamed this statement restarts */
  targetDecl?: RepeatNamed;
}

export interface FuncParam {
  name: string;
  hasDefault: boolean;
  defaultExpr?: Expr;
  span: Span;
}

export interface FuncDecl extends BaseNode {
  kind: "func";
  name: string;
  params: FuncParam[];
  body: Stmt[];
}

/** `func.c : name { args }` used as a statement. */
export interface FuncCallStmt extends BaseNode {
  kind: "func.c.stmt";
  call: FuncCall;
}

/** `func.r : expr` */
export interface FuncReturn extends BaseNode {
  kind: "func.r";
  expr: Expr;
}

export interface StructProp {
  name: string;
  isConst: boolean;
  defaultExpr: Expr;
  span: Span;
}

export interface StructDecl extends BaseNode {
  kind: "struct";
  name: string;
  props: StructProp[];
  /** parents from `struct.base : a, b { struct : child { ... } }` */
  parents: string[];
}

export interface Program {
  stmts: Stmt[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Describe an expression node kind in error messages. */
export function describeExpr(e: Expr): string {
  switch (e.kind) {
    case "number": return "a number";
    case "string": return "a string";
    case "boolean": return "true or false";
    case "path": return `the variable "${e.parts.join(".")}"`;
    case "round": return "a rounded number";
    case "neg": return "a negative number";
    case "binary": return "a calculation";
    case "not": return "a negated condition";
    case "struct.c": return `a ${e.structName} instance`;
    case "func.c": return `the result of ${e.funcName}`;
  }
}
