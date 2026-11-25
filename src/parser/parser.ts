// HAZMA - parser.
//
// A recursive-descent parser that turns the token stream into an AST.
// HAZMA statements are newline-separated; blocks use { }.

import { HazmaError, type Span } from "../errors.js";
import type {
  BinaryOp,
  CallArg,
  CheckError,
  Expr,
  FuncCall,
  If,
  PropAssign,
  RepeatNamed,
  Stmt,
  StructDecl,
  StructProp,
} from "../ast/nodes.js";
import type { Token } from "../lexer/tokens.js";
import { RESERVED_WORDS } from "../lexer/tokens.js";

/** Postfix math operators that bind tighter than unary minus. */
const MATH_POSTFIX_OPS = new Set(["abs", "sqrt", "floor", "ceil", "round", "pow"]);
type MathPostfixOp = "abs" | "sqrt" | "floor" | "ceil" | "round" | "pow";

/** Zero-argument math constants. */
const MATH_PROPS = new Set(["pi", "e"]);

/** Multi-argument math helpers. */
const MATH_CALLS = new Set(["min", "max", "random", "sin", "cos", "tan", "clamp"]);
type MathCallFn = "min" | "max" | "random" | "sin" | "cos" | "tan" | "clamp";

export class Parser {
  private toks: Token[];
  private i = 0;

  constructor(tokens: Token[]) {
    this.toks = tokens;
  }

  // ------------------------------------------------------------------ utils

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }

  private prev(): Token {
    return this.toks[Math.max(0, this.i - 1)];
  }

  private next(): Token {
    const t = this.toks[this.i];
    if (t.kind !== "eof") this.i++;
    return t;
  }

  private check(kind: Token["kind"], text?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (text === undefined || t.text === text);
  }

  private acceptPunct(text: string): boolean {
    if (this.check("punct", text)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectPunct(text: string, what: string): void {
    if (!this.acceptPunct(text)) {
      const t = this.peek();
      throw new HazmaError(
        "H2002",
        `expected "${text}" ${what} but found ${describeToken(t)}`,
        spanTok(t),
        hintFor(text, what),
      );
    }
  }

  private expectIdent(what: string): string {
    const t = this.peek();
    if (t.kind !== "ident") {
      throw new HazmaError(
        "H2003",
        `expected a name ${what} but found ${describeToken(t)}`,
        spanTok(t),
      );
    }
    this.next();
    return t.text;
  }

  private expectColon(cmd: string): void {
    this.expectPunct(":", `after "${cmd}"`);
  }

  /** Comma-separated expressions in parentheses, as used by math helpers. */
  private parseParenArgs(what: string): Expr[] {
    this.expectPunct("(", `to open the arguments of ${what}`);
    const args: Expr[] = [];
    this.skipNewlines();
    if (!this.check("punct", ")")) {
      args.push(this.parseExpression());
      while (this.check("punct", ",")) {
        this.next();
        this.skipNewlines();
        args.push(this.parseExpression());
      }
    }
    this.skipNewlines();
    this.expectPunct(")", `to close the arguments of ${what}`);
    return args;
  }

  private spanFrom(startIndex: number): Span {
    const a = this.toks[startIndex];
    const b = this.prev();
    return { start: { line: a.line, col: a.col }, end: { line: b.endLine, col: b.endCol } };
  }

  private skipNewlines(): void {
    while (this.check("newline")) this.next();
  }

  /** The next token after any newlines, without consuming them. */
  private peekPastNewlines(): Token {
    let j = this.i;
    while (this.toks[j] && this.toks[j].kind === "newline") j++;
    return this.toks[j];
  }

  /**
   * HAZMA discipline: one command per line. After a statement the next token
   * must be a newline, `}` or the end of the file.
   */
  private endStatement(context: string): "close" | "eof" | "more" {
    const t = this.peek();
    if (t.kind === "newline") return "more";
    if (t.kind === "punct" && t.text === "}") return "close";
    if (t.kind === "eof") return "eof";
    throw new HazmaError(
      "H2011",
      `unexpected ${describeToken(t)} after ${context}`,
      spanTok(t),
      'HAZMA keeps one command per line - no semicolons are used',
    );
  }

  // -------------------------------------------------------------- variables

  /** Validate a variable target such as `age` or `is.ready`. Returns parts. */
  private varTarget(what: string): string[] {
    const text = this.expectIdent(what);
    if (text.startsWith("is.")) {
      const segments = text.split(".").slice(1);
      if (segments.length === 0 || segments.some((s) => s.length === 0)) {
        throw new HazmaError(
          "H2013",
          `"${text}" is not a valid boolean name`,
          spanTok(this.prev()),
          "boolean names start with is. - for example is.ready",
        );
      }
      for (const s of segments) {
        if (RESERVED_WORDS.has(s)) {
          throw new HazmaError(
            "H2014",
            `"${s}" is a reserved word and cannot be used after is.`,
            spanTok(this.prev()),
          );
        }
      }
      return [text];
    }
    if (text.includes(".")) {
      throw new HazmaError(
        "H2015",
        `"${text}" is not a valid variable name`,
        spanTok(this.prev()),
        `variables are single names like age - to change a property use change : ${text.split(".")[0]} {{ ... }}`,
      );
    }
    if (RESERVED_WORDS.has(text)) {
      throw new HazmaError(
        "H2016",
        `"${text}" is a reserved word and cannot be a variable name`,
        spanTok(this.prev()),
      );
    }
    return [text];
  }

  /** Validate a path target such as `alex.health` or a plain variable. */
  private pathTarget(what: string): string[] {
    const text = this.expectIdent(what);
    const parts = text.split(".");
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.length === 0) {
        throw new HazmaError("H2017", `"${text}" is not a valid path`, spanTok(this.prev()));
      }
      if (RESERVED_WORDS.has(part) && !(p === 0 && part === "is")) {
        throw new HazmaError(
          "H2018",
          `the reserved word "${part}" cannot be used in a path`,
          spanTok(this.prev()),
        );
      }
    }
    return parts;
  }

  // ------------------------------------------------------------- statements

  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    this.skipNewlines();
    while (!this.check("eof")) {
      this.parseMember(stmts);
      const end = this.endStatement("a command");
      if (end === "close") {
        throw new HazmaError(
          "H2019",
          "unexpected } - no block is open here",
          spanTok(this.peek()),
        );
      }
      if (end === "eof") break;
      this.skipNewlines();
    }
    return stmts;
  }

  /**
   * Parses one statement into `stmts`. `check.error` is special: it takes the
   * statement that was just pushed and wraps it, so the guarded command and its
   * handler stay together as one AST node.
   */
  private parseMember(stmts: Stmt[]): void {
    if (this.check("ident", "check.error")) {
      stmts.push(this.parseCheckError(stmts));
      return;
    }
    stmts.push(this.parseStatement());
  }

  private parseCheckError(stmts: Stmt[]): CheckError {
    const start = this.i;
    const t = this.next(); // check.error
    if (stmts.length === 0) {
      throw new HazmaError(
        "H2048",
        "check.error has nothing to watch",
        spanTok(t),
        "put the command that may fail directly above check.error { ... }",
      );
    }
    const protectedStmt = stmts.pop()!;
    this.expectPunct("{", "to open the check.error block");
    const handler: Stmt[] = [];
    this.parseBlockCore(handler);
    return { kind: "check.error", protectedStmt, handler, span: this.spanFrom(start) };
  }

  parseStatement(): Stmt {
    const start = this.i;
    const t = this.peek();
    if (t.kind !== "ident") {
      throw new HazmaError(
        "H2020",
        `expected a command but found ${describeToken(t)}`,
        spanTok(t),
        'commands look like: save : age = 18, log.out { "hi" }, if : age >= 18 { ... }',
      );
    }

    const parts = t.text.split(".");

    // save : name = expr
    if (t.text === "save") {
      this.next();
      this.expectColon("save");
      const target = this.varTarget("after save :");
      this.expectPunct("=", "after the variable name");
      const expr = this.parseExpression();
      return { kind: "save", target, expr, span: this.spanFrom(start) };
    }

    // name = expr   (struct-friendly assignment, same rules as save)
    const bareOk =
      (parts.length === 1 && !RESERVED_WORDS.has(t.text)) ||
      t.text.startsWith("is.");
    if (bareOk && this.peek(1).kind === "punct" && this.peek(1).text === "=") {
      const target = this.varTarget("");
      this.next(); // '='
      const expr = this.parseExpression();
      return { kind: "assign", target, expr, span: this.spanFrom(start) };
    }

    // change : path = expr   |   change : path { prop = expr ... }
    if (t.text === "change") {
      this.next();
      this.expectColon("change");
      const target = this.pathTarget("after change :");
      if (this.check("punct", "=")) {
        this.next();
        const expr = this.parseExpression();
        return { kind: "change", target, expr, span: this.spanFrom(start) };
      }
      const props = this.parsePropAssignBlock(false);
      return { kind: "change", target, props, span: this.spanFrom(start) };
    }

    // t.change : name = expr
    if (t.text === "t.change") {
      this.next();
      this.expectColon("t.change");
      const target = this.varTarget("after t.change :");
      this.expectPunct("=", "after the variable name");
      const expr = this.parseExpression();
      return { kind: "t.change", target, expr, span: this.spanFrom(start) };
    }

    // ------------------------------------------------------------- lists
    // l.save : name = { ... }
    if (t.text === "l.save") {
      this.next();
      this.expectColon("l.save");
      const target = this.varTarget("after l.save :");
      this.expectPunct("=", "after the list name");
      if (!this.check("punct", "{")) {
        throw new HazmaError(
          "H2067",
          `l.save : needs a list written with { }, but found ${describeToken(this.peek())}`,
          spanTok(this.peek()),
          "to store a list returned by a function, use: save : name = func.c : ...",
        );
      }
      this.next();
      const items = this.parseListItems("the list");
      return { kind: "l.save", target, items, span: this.spanFrom(start) };
    }

    // l.add : name { ... }
    if (t.text === "l.add") {
      this.next();
      this.expectColon("l.add");
      const target = this.pathTarget("after l.add :");
      this.expectPunct("{", "to open the l.add block");
      const items = this.parseListItems("the l.add block");
      return { kind: "l.add", target, items, span: this.spanFrom(start) };
    }

    // l.remove : name { ... }
    if (t.text === "l.remove") {
      this.next();
      this.expectColon("l.remove");
      const target = this.pathTarget("after l.remove :");
      this.expectPunct("{", "to open the l.remove block");
      const values = this.parseListItems("the l.remove block");
      return { kind: "l.remove", target, values, span: this.spanFrom(start) };
    }

    // l.change : name { index = value ... }
    if (t.text === "l.change") {
      this.next();
      this.expectColon("l.change");
      const target = this.pathTarget("after l.change :");
      const changes = this.parseListChanges();
      return { kind: "l.change", target, changes, span: this.spanFrom(start) };
    }

    if (parts[0] === "l") {
      if (t.text === "l.count" || t.text === "l.find" || t.text === "l.find.index") {
        throw new HazmaError(
          "H2060",
          `"${t.text}" is a value, not a command`,
          spanTok(t),
          "use it inside log.out or a condition: log.out { l.count : weapons }",
        );
      }
      throw new HazmaError(
        "H2061",
        `unknown command "${t.text}"`,
        spanTok(t),
        "the list commands are l.save, l.add, l.remove and l.change",
      );
    }

    // ------------------------------------------------------------ files/folders
    // file.create : path   |   file.delete : path
    if (t.text === "file.create" || t.text === "file.delete") {
      this.next();
      this.expectColon(t.text);
      const path = this.parseExpression();
      if (t.text === "file.create") {
        return { kind: "file.create", path, span: this.spanFrom(start) };
      }
      return { kind: "file.delete", path, span: this.spanFrom(start) };
    }

    // file.write : path { raw text }   |   file.add : path { raw text }
    if (t.text === "file.write" || t.text === "file.add") {
      this.next();
      this.expectColon(t.text);
      const path = this.parseExpression();
      this.expectPunct("{", `to open the ${t.text} block`);
      const raw = this.peek();
      if (raw.kind !== "raw") {
        throw new HazmaError(
          "H2071",
          `${t.text} needs literal text between { and }`,
          spanTok(raw),
          "write the text on its own lines and end the block with a line containing only }",
        );
      }
      this.next();
      this.expectPunct("}", `to close the ${t.text} block`);
      const rawText = String(raw.value ?? "");
      if (t.text === "file.write") {
        return { kind: "file.write", path, rawText, span: this.spanFrom(start) };
      }
      return { kind: "file.add", path, rawText, span: this.spanFrom(start) };
    }

    // folder.create : path   |   folder.delete : path
    if (t.text === "folder.create" || t.text === "folder.delete") {
      this.next();
      this.expectColon(t.text);
      const path = this.parseExpression();
      if (t.text === "folder.create") {
        return { kind: "folder.create", path, span: this.spanFrom(start) };
      }
      return { kind: "folder.delete", path, span: this.spanFrom(start) };
    }

    if (parts[0] === "file" || parts[0] === "folder") {
      throw new HazmaError(
        "H2070",
        `unknown command "${t.text}"`,
        spanTok(t),
        "the file commands are file.create, file.write, file.add, file.delete and file.exists; " +
          "the folder commands are folder.create and folder.delete",
      );
    }

    // log.out { expr }
    if (parts[0] === "log") {
      if (parts.length !== 2 || parts[1] !== "out") {
        throw new HazmaError(
          "H2021",
          `unknown command "${t.text}"`,
          spanTok(t),
          'the output command is log.out { ... }',
        );
      }
      this.next();
      this.expectPunct("{", "to open the log.out block");
      this.skipNewlines();
      if (this.check("punct", "}")) {
        throw new HazmaError(
          "H2022",
          "log.out needs a value to print",
          spanTok(this.peek()),
          'example: log.out { "Hello HAZMA!" }',
        );
      }
      const expr = this.parseExpression();
      this.skipNewlines();
      this.expectPunct("}", "to close the log.out block");
      return { kind: "log", expr, span: this.spanFrom(start) };
    }

    // if : cond { ... }  /  else if : cond { ... }  /  else : { ... }
    if (t.text === "if") {
      this.next();
      const node: If = { kind: "if", branches: [], span: this.spanFrom(start) };
      let branchStart = start;
      while (true) {
        this.expectColon(this.prev().text === "else" ? "else" : "if");
        const cond = this.parseExpression();
        const body = this.parseBlock();
        node.branches.push({ cond, body, span: this.spanFrom(branchStart) });
        const upcoming = this.peekPastNewlines();
        if (upcoming.kind === "ident" && upcoming.text === "else") {
          this.skipNewlines();
          branchStart = this.i;
          this.next(); // else
          if (this.check("ident", "if")) {
            this.next();
            continue; // else if : ...
          }
          this.expectColon("else");
          node.elseBody = this.parseBlock();
        }
        break;
      }
      return node;
    }

    if (t.text === "else") {
      throw new HazmaError(
        "H2023",
        "else without a matching if",
        spanTok(t),
        "else belongs right after an if block",
      );
    }

    // s.change : subject { label = value { ... } ... default : { ... } }
    if (parts[0] === "s" && parts.length === 2 && parts[1] === "change") {
      this.next();
      this.expectColon("s.change");
      const subject = this.parseExpression();
      this.expectPunct("{", "to open the s.change block");
      const branches = [];
      let defaultBody;
      let defaultSeen = false;
      this.skipNewlines();
      while (!this.check("punct", "}")) {
        if (this.check("eof")) {
          throw new HazmaError("H2024", "s.change block is not closed - missing }", spanTok(this.peek()));
        }
        const bt = this.peek();
        if (bt.kind !== "ident") {
          throw new HazmaError(
            "H2025",
            `expected a branch name inside s.change but found ${describeToken(bt)}`,
            spanTok(bt),
            "branches look like:  sword = 1 { ... }   and the fallback:  default : { ... }",
          );
        }
        if (bt.text === "default") {
          if (defaultBody !== undefined) {
            throw new HazmaError("H2026", "default can only appear once in an s.change", spanTok(bt));
          }
          this.next();
          this.expectColon("default");
          defaultBody = this.parseBlock();
          defaultSeen = true;
        } else {
          if (defaultSeen) {
            throw new HazmaError(
              "H2026",
              "default must be the last branch in an s.change",
              spanTok(bt),
            );
          }
          this.next();
          const label = bt.text;
          this.expectPunct("=", `after the branch name "${label}"`);
          const value = this.parseExpression();
          const body = this.parseBlock();
          branches.push({ label, value, body, span: this.spanFrom(start) });
        }
        this.skipNewlines();
      }
      this.next(); // close }
      if (branches.length === 0 && defaultBody === undefined) {
        throw new HazmaError("H2026", "s.change needs at least one branch", spanTok(t));
      }
      return { kind: "s.change", subject, branches, defaultBody, span: this.spanFrom(start) };
    }

    if (parts[0] === "s") {
      throw new HazmaError("H2027", `unknown command "${t.text}"`, spanTok(t), 'did you mean "s.change"?');
    }

    // repeat till cond { body }   |   repeat : name { till cond ... }
    // repeat.break : name / repeat.continue : name / repeat.new : name
    if (t.text === "repeat" && parts.length === 1) {
      this.next();
      if (this.check("ident", "till")) {
        this.next();
        const cond = this.parseExpression();
        const body = this.parseBlock();
        return { kind: "repeat", cond, body, span: this.spanFrom(start) };
      }
      if (this.check("punct", ":")) {
        this.next();
        const name = this.expectIdent("after repeat :");
        this.checkRepeatName(name);
        const body: Stmt[] = [];
        this.expectPunct("{", `to open the repeat block for "${name}"`);
        this.skipNewlines();
        let cond;
        if (this.check("ident", "till")) {
          this.next();
          cond = this.parseExpression();
          const end = this.endStatement("till");
          if (end === "eof") {
            throw new HazmaError("H2028", `repeat "${name}" is not closed - missing }`, spanTok(this.peek()));
          }
          if (end === "close") {
            this.next();
            return { kind: "repeat.named", name, cond, body, span: this.spanFrom(start) };
          }
          this.skipNewlines();
        }
        this.parseBlockCore(body);
        return { kind: "repeat.named", name, cond, body, span: this.spanFrom(start) };
      }
      throw new HazmaError(
        "H2029",
        "repeat needs a condition or a name",
        spanTok(this.peek()),
        "write: repeat till number > 10 { ... }  or: repeat : main { till ... }",
      );
    }

    if (parts[0] === "repeat" && parts.length === 2 && (parts[1] === "break" || parts[1] === "continue" || parts[1] === "new")) {
      this.next();
      this.expectColon(`repeat.${parts[1]}`);
      const name = this.expectIdent(`after repeat.${parts[1]} :`);
      this.checkRepeatName(name);
      const kind = `repeat.${parts[1]}` as "repeat.break" | "repeat.continue" | "repeat.new";
      return { kind, name, span: this.spanFrom(start) } as Stmt;
    }

    if (parts[0] === "repeat") {
      throw new HazmaError(
        "H2030",
        `unknown command "${t.text}"`,
        spanTok(t),
        "repeat controls are repeat.break, repeat.continue and repeat.new",
      );
    }

    // func : name { ... }  /  func.c : name { args }  /  func.r : expr
    if (parts[0] === "func" && parts.length === 1) {
      this.next();
      this.expectColon("func");
      const name = this.expectIdent("after func :");
      const body = this.parseBlock();
      // leading func.p statements become the parameter list
      const params = [];
      let cursor = 0;
      while (cursor < body.length && body[cursor].kind === "func.p") {
        const p = body[cursor] as Extract<Stmt, { kind: "func.p" }>;
        params.push({ name: p.name, hasDefault: p.hasDefault, defaultExpr: p.defaultExpr, span: p.span });
        cursor++;
      }
      if (cursor < body.length && body.some((s, idx) => idx >= cursor && s.kind === "func.p")) {
        const bad = body.find((s, idx) => idx >= cursor && s.kind === "func.p")!;
        throw new HazmaError(
          "H2031",
          "func.p declares parameters and must come before the commands of the function",
          bad.span,
        );
      }
      const realBody = body.slice(cursor);
      return { kind: "func", name, params, body: realBody, span: this.spanFrom(start) };
    }

    if (parts[0] === "func" && parts.length === 2 && parts[1] === "p") {
      this.next();
      this.expectColon("func.p");
      const name = this.expectIdent("after func.p :");
      let hasDefault = false;
      let defaultExpr;
      if (this.acceptPunct("=")) {
        hasDefault = true;
        defaultExpr = this.parseExpression();
      }
      return { kind: "func.p", name, hasDefault, defaultExpr, span: this.spanFrom(start) };
    }

    if (parts[0] === "func" && parts.length === 2 && parts[1] === "c") {
      this.next();
      const call = this.parseFuncCall();
      return { kind: "func.c.stmt", call, span: this.spanFrom(start) };
    }

    if (parts[0] === "func" && parts.length === 2 && parts[1] === "r") {
      this.next();
      this.expectColon("func.r");
      const expr = this.parseExpression();
      return { kind: "func.r", expr, span: this.spanFrom(start) };
    }

    if (parts[0] === "func") {
      throw new HazmaError(
        "H2032",
        `unknown command "${t.text}"`,
        spanTok(t),
        "the function commands are func, func.p, func.c and func.r",
      );
    }

    // struct : name { ... }  |  struct.base : parents { struct : child { ... } }
    if (parts[0] === "struct" && parts.length === 1) {
      this.next();
      return this.parseStructDecl(start);
    }

    if (parts[0] === "struct" && parts.length === 2 && parts[1] === "base") {
      this.next();
      this.expectColon("struct.base");
      const parents: string[] = [];
      parents.push(this.expectIdent("after struct.base :"));
      while (this.acceptPunct(",")) {
        parents.push(this.expectIdent("after ,"));
      }
      this.expectPunct("{", "to open the struct.base block");
      this.skipNewlines();
      const childTok = this.peek();
      if (!(childTok.kind === "ident" && childTok.text === "struct")) {
        throw new HazmaError(
          "H2033",
          "struct.base holds a single structure declaration",
          spanTok(childTok),
          "write: struct.base : parent { struct : child { ... } }",
        );
      }
      this.next();
      const child = this.parseStructDecl(this.i - 1);
      this.skipNewlines();
      this.expectPunct("}", "to close the struct.base block");
      return { ...child, parents, span: this.spanFrom(start) };
    }

    if (parts[0] === "struct") {
      if (parts.length === 2 && parts[1] === "c") {
        throw new HazmaError(
          "H2034",
          "struct.c creates a value - assign it to a variable",
          spanTok(t),
          "example: alex = struct.c : npc_structure",
        );
      }
      throw new HazmaError(
        "H2032",
        `unknown command "${t.text}"`,
        spanTok(t),
        "the structure commands are struct, struct.c and struct.base",
      );
    }

    if (t.text === "till") {
      throw new HazmaError(
        "H2035",
        "till belongs inside a named repeat",
        spanTok(t),
        "write: repeat : main { till number > 10 ... }",
      );
    }

    if (t.text === "default") {
      throw new HazmaError(
        "H2036",
        "default belongs inside an s.change block",
        spanTok(t),
        "write: default : { ... } after the s.change branches",
      );
    }

    if (t.text === "is") {
      throw new HazmaError(
        "H2037",
        `"is" alone is not a name`,
        spanTok(t),
        "boolean names look like is.ready",
      );
    }

    // true / false / and / or / not cannot start a statement
    if (RESERVED_WORDS.has(t.text)) {
      throw new HazmaError(
        "H2038",
        `"${t.text}" cannot start a command`,
        spanTok(t),
        "statements start with a command (save, change, log.out, if, ...) or an assignment (name = value)",
      );
    }

    // dotted unknown command
    if (parts.length > 1) {
      throw new HazmaError(
        "H2010",
        `unknown command "${t.text}"`,
        spanTok(t),
        "HAZMA commands start with: save, change, t.change, log.out, if, s.change, repeat, func, struct",
      );
    }

    // unknown bare word
    throw new HazmaError(
      "H2010",
      `unknown command "${t.text}"`,
      spanTok(t),
      "statements start with a command (save, change, log.out, if, ...) or an assignment (name = value)",
    );
  }

  private checkRepeatName(name: string): void {
    if (RESERVED_WORDS.has(name)) {
      throw new HazmaError(
        "H2039",
        `"${name}" is a reserved word and cannot name a repeat`,
        spanTok(this.prev()),
      );
    }
  }

  // ------------------------------------------------------------------ blocks

  private parseBlock(): Stmt[] {
    const stmts: Stmt[] = [];
    this.expectPunct("{", "to open a block");
    this.parseBlockCore(stmts);
    return stmts;
  }

  /** Parses statements until the matching `}` (which is consumed). */
  private parseBlockCore(stmts: Stmt[]): void {
    this.skipNewlines();
    while (true) {
      if (this.check("punct", "}")) {
        this.next();
        return;
      }
      if (this.check("eof")) {
        throw new HazmaError(
          "H2040",
          "block is not closed - missing }",
          spanTok(this.peek()),
          "close the block with }",
        );
      }
      this.parseMember(stmts);
      const end = this.endStatement("a command");
      if (end === "close") {
        this.next();
        return;
      }
      if (end === "eof") {
        throw new HazmaError("H2040", "block is not closed - missing }", spanTok(this.peek()));
      }
      this.skipNewlines();
    }
  }

  /** `{ name = expr ... }` lines (and `const.name = expr` when allowed). */
  private parsePropAssignBlock(allowConst: boolean): PropAssign[] {
    this.expectPunct("{", "to open the block");
    const props: PropAssign[] = [];
    this.skipNewlines();
    while (!this.check("punct", "}")) {
      if (this.check("eof")) {
        throw new HazmaError("H2040", "block is not closed - missing }", spanTok(this.peek()));
      }
      const t = this.peek();
      if (t.kind !== "ident") {
        throw new HazmaError(
          "H2041",
          `expected a property name but found ${describeToken(t)}`,
          spanTok(t),
          "properties look like:  health = 100",
        );
      }
      this.next();
      let isConst = false;
      let name = t.text;
      if (t.text.startsWith("const.")) {
        isConst = true;
        name = t.text.slice("const.".length);
        if (name.length === 0 || name.includes(".")) {
          throw new HazmaError(
            "H2042",
            `"${t.text}" is not a valid const property name`,
            spanTok(t),
            "write: const.id = 1",
          );
        }
        if (!allowConst) {
          throw new HazmaError(
            "H2043",
            "const. is only allowed inside structures",
            spanTok(t),
            "const. locks a structure property so it can never be changed",
          );
        }
        if (RESERVED_WORDS.has(name)) {
          throw new HazmaError("H2016", `"${name}" is a reserved word and cannot be a property name`, spanTok(t));
        }
      } else if (t.text.includes(".")) {
        throw new HazmaError(
          "H2044",
          `"${t.text}" is not a valid property name`,
          spanTok(t),
          "properties are single names like health",
        );
      } else if (RESERVED_WORDS.has(t.text)) {
        throw new HazmaError("H2016", `"${t.text}" is a reserved word and cannot be a property name`, spanTok(t));
      }
      this.expectPunct("=", `after the property "${name}"`);
      const expr = this.parseExpression();
      props.push({ name, isConst, expr, span: spanTok(t) });
      const end = this.endStatement("a property");
      if (end === "close") {
        this.next();
        return props;
      }
      if (end === "eof") {
        throw new HazmaError("H2040", "block is not closed - missing }", spanTok(this.peek()));
      }
      this.skipNewlines();
    }
    this.next();
    return props;
  }

  // ------------------------------------------------------------------ lists

  /** `{ element ... }` - elements separated by newlines and/or commas. */
  private parseListItems(what: string): Expr[] {
    const items: Expr[] = [];
    this.skipNewlines();
    while (!this.check("punct", "}")) {
      if (this.check("eof")) {
        throw new HazmaError("H2062", `${what} is not closed - missing }`, spanTok(this.peek()));
      }
      if (this.check("punct", ",")) {
        this.next();
        this.skipNewlines();
        continue;
      }
      items.push(this.parseExpression());
      const t = this.peek();
      if (t.kind === "punct" && t.text === "}") break;
      if (t.kind === "newline") {
        this.skipNewlines();
        continue;
      }
      if (t.kind === "punct" && t.text === ",") {
        this.next();
        this.skipNewlines();
        continue;
      }
      if (t.kind === "eof") {
        throw new HazmaError("H2062", `${what} is not closed - missing }`, spanTok(t));
      }
      throw new HazmaError(
        "H2011",
        `unexpected ${describeToken(t)} after a list element`,
        spanTok(t),
        "list elements are separated by newlines or commas",
      );
    }
    this.expectPunct("}", `to close ${what}`);
    return items;
  }

  /** `{ index = value ... }` lines for l.change (1-based indexes, validated later). */
  private parseListChanges(): { index: Expr; value: Expr; span: Span }[] {
    this.expectPunct("{", "to open the l.change block");
    const changes: { index: Expr; value: Expr; span: Span }[] = [];
    this.skipNewlines();
    while (!this.check("punct", "}")) {
      if (this.check("eof")) {
        throw new HazmaError(
          "H2064",
          "the l.change block is not closed - missing }",
          spanTok(this.peek()),
        );
      }
      if (this.check("punct", ",")) {
        this.next();
        this.skipNewlines();
        continue;
      }
      const index = this.parseExpression();
      this.expectPunct("=", "after the list index");
      const value = this.parseExpression();
      changes.push({ index, value, span: span2(index.span, value.span) });
      const t = this.peek();
      if (t.kind === "punct" && t.text === "}") break;
      if (t.kind === "newline") {
        this.skipNewlines();
        continue;
      }
      if (t.kind === "punct" && t.text === ",") {
        this.next();
        this.skipNewlines();
        continue;
      }
      if (t.kind === "eof") {
        throw new HazmaError("H2064", "the l.change block is not closed - missing }", spanTok(t));
      }
      throw new HazmaError(
        "H2011",
        `unexpected ${describeToken(t)} after a list change`,
        spanTok(t),
        'each line looks like: 2 = "Rifle"',
      );
    }
    this.expectPunct("}", "to close the l.change block");
    if (changes.length === 0) {
      throw new HazmaError(
        "H2065",
        "l.change needs at least one index = value line",
        spanTok(this.prev()),
        'example: l.change : weapons { 2 = "Rifle" }',
      );
    }
    return changes;
  }

  // ------------------------------------------------------------ declarations

  private parseStructDecl(start: number): StructDecl {
    this.expectColon("struct");
    const name = this.expectIdent("after struct :");
    if (RESERVED_WORDS.has(name)) {
      throw new HazmaError("H2016", `"${name}" is a reserved word and cannot name a structure`, spanTok(this.prev()));
    }
    const props: StructProp[] = this.parsePropAssignBlock(true).map((p) => ({
      name: p.name,
      isConst: p.isConst,
      defaultExpr: p.expr,
      span: p.span,
    }));
    return { kind: "struct", name, props, parents: [], span: this.spanFrom(start) };
  }

  // ------------------------------------------------------------- expressions

  parseExpression(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.check("ident", "or")) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right, span: span2(left.span, right.span) };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.check("ident", "and")) {
      this.next();
      const right = this.parseNot();
      left = { kind: "binary", op: "and", left, right, span: span2(left.span, right.span) };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.check("ident", "not")) {
      const t = this.next();
      const operand = this.parseNot();
      return { kind: "not", operand, span: span2(spanTok(t), operand.span) };
    }
    return this.parseComparison();
  }

  private static readonly COMPARE_OPS = ["==", "!=", ">", "<", ">=", "<="];

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.peek().kind === "punct" && Parser.COMPARE_OPS.includes(this.peek().text)) {
      const op = this.next().text as BinaryOp;
      const right = this.parseAdditive();
      left = { kind: "binary", op, left, right, span: span2(left.span, right.span) };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.check("punct", "+") || this.check("punct", "-")) {
      const op = this.next().text as BinaryOp;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right, span: span2(left.span, right.span) };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePostfix();
    while (this.check("punct", "*") || this.check("punct", "/")) {
      const op = this.next().text as BinaryOp;
      const right = this.parsePostfix();
      left = { kind: "binary", op, left, right, span: span2(left.span, right.span) };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.check("punct", "-")) {
      const t = this.next();
      const operand = this.parseUnary();
      return this.negateInside(operand, (x) => ({
        kind: "neg",
        operand: x,
        span: span2(spanTok(t), operand.span),
      }));
    }
    return this.parsePrimary();
  }

  /**
   * Unary minus binds tighter than postfix math, so it reaches the value
   * underneath a chain parsed from a dotted name: `-p.r` rounds `-p`.
   */
  private negateInside(e: Expr, makeNeg: (x: Expr) => Expr): Expr {
    if (e.kind === "round") return { ...e, inner: this.negateInside(e.inner, makeNeg) };
    if (e.kind === "math.postfix") return { ...e, inner: this.negateInside(e.inner, makeNeg) };
    return makeNeg(e);
  }

  /** Postfix binds looser than unary minus: `-15.abs` is `abs(-15)` = 15. */
  private parsePostfix(): Expr {
    let e = this.parseUnary();
    while (true) {
      if (this.check("punct", ".r")) {
        this.next();
        e = { kind: "round", inner: e, span: span2(e.span, spanTok(this.prev())) };
        continue;
      }
      const t = this.peek();
      if (t.kind === "punct" && t.text.startsWith(".") && t.text !== ".r") {
        const op = t.text.slice(1) as MathPostfixOp;
        if (MATH_POSTFIX_OPS.has(op)) {
          this.next();
          let args: Expr[] = [];
          if (op === "pow") {
            args = this.parseParenArgs(op);
          }
          e = {
            kind: "math.postfix",
            op,
            inner: e,
            args,
            span: span2(e.span, spanTok(this.prev())),
          };
          continue;
        }
      }
      if (this.check("punct", "[")) {
        this.next();
        const index = this.parseExpression();
        this.expectPunct("]", "to close the list index");
        e = { kind: "index", target: e, index, span: span2(e.span, spanTok(this.prev())) };
        continue;
      }
      break;
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const start = this.i;

    if (t.kind === "number") {
      this.next();
      return { kind: "number", value: t.value as number, span: spanTok(t) };
    }

    if (t.kind === "string") {
      this.next();
      return { kind: "string", value: t.value as string, span: spanTok(t) };
    }

    if (t.kind === "punct" && t.text === "(") {
      this.next();
      const e = this.parseExpression();
      this.expectPunct(")", "to close the parentheses");
      return { ...e, span: span2(spanTok(t), spanTok(this.prev())) };
    }

    // { element ... } - a list literal in value position
    if (t.kind === "punct" && t.text === "{") {
      this.next();
      const items = this.parseListItems("the list");
      return { kind: "list.lit", items, span: this.spanFrom(start) };
    }

    if (t.kind === "ident") {
      if (t.text === "true" || t.text === "false") {
        this.next();
        return { kind: "boolean", value: t.text === "true", span: spanTok(t) };
      }

      const parts = t.text.split(".");

      if (parts.length === 2 && parts[0] === "struct" && parts[1] === "c") {
        this.next();
        this.expectColon("struct.c");
        const structName = this.expectIdent("after struct.c :");
        let overrides: PropAssign[] = [];
        if (this.check("punct", "{")) {
          overrides = this.parsePropAssignBlock(false);
        }
        return { kind: "struct.c", structName, overrides, span: this.spanFrom(start) };
      }

      if (parts.length === 2 && parts[0] === "func" && parts[1] === "c") {
        this.next();
        const call = this.parseFuncCall();
        return call;
      }

      // file.read : path   /   file.exists : path
      if (t.text === "file.read" || t.text === "file.exists") {
        const isRead = t.text === "file.read";
        const name = t.text;
        this.next();
        this.expectColon(name);
        const path = this.parsePostfix();
        return isRead
          ? { kind: "file.read", path, span: this.spanFrom(start) }
          : { kind: "file.exists", path, span: this.spanFrom(start) };
      }

      // statement-only list commands cannot be used as values
      if (
        t.text === "l.save" ||
        t.text === "l.add" ||
        t.text === "l.remove" ||
        t.text === "l.change"
      ) {
        throw new HazmaError(
          "H2060",
          `"${t.text}" is a command, not a value`,
          spanTok(t),
          `${t.text} stands on its own line - it cannot be used inside an expression`,
        );
      }

      // l.count : list
      if (t.text === "l.count") {
        this.next();
        this.expectColon("l.count");
        const list = this.parsePostfix();
        return { kind: "list.count", list, span: this.spanFrom(start) };
      }

      // l.find : list { value }   /   l.find.index : list { value }
      if (t.text === "l.find" || t.text === "l.find.index") {
        const isIndex = t.text === "l.find.index";
        const name = isIndex ? "l.find.index" : "l.find";
        this.next();
        this.expectColon(name);
        const list = this.parsePostfix();
        this.expectPunct("{", `to open the ${name} block`);
        this.skipNewlines();
        if (this.check("punct", "}")) {
          throw new HazmaError(
            "H2066",
            `${name} needs a value to search for`,
            spanTok(this.peek()),
            `example: ${name} : weapons { "Sword" }`,
          );
        }
        const value = this.parseExpression();
        this.skipNewlines();
        this.expectPunct("}", `to close the ${name} block`);
        return isIndex
          ? { kind: "list.find.index", list, value, span: this.spanFrom(start) }
          : { kind: "list.find", list, value, span: this.spanFrom(start) };
      }

      // math.pi / math.e   /   math.min(3, 5) ...
      if (parts.length === 2 && parts[0] === "math") {
        const name = parts[1];
        this.next();
        if (MATH_PROPS.has(name)) {
          return { kind: "math.prop", name: name as "pi" | "e", span: spanTok(t) };
        }
        if (MATH_CALLS.has(name)) {
          this.expectPunct("(", `to open the arguments of math.${name}`);
          const args: Expr[] = [];
          this.skipNewlines();
          if (!this.check("punct", ")")) {
            args.push(this.parseExpression());
            while (this.check("punct", ",")) {
              this.next();
              this.skipNewlines();
              args.push(this.parseExpression());
            }
          }
          this.skipNewlines();
          this.expectPunct(")", `to close the arguments of math.${name}`);
          return { kind: "math.call", fn: name as MathCallFn, args, span: this.spanFrom(start) };
        }
        throw new HazmaError(
          "H2010",
          `unknown command "math.${name}"`,
          spanTok(t),
          "math helpers are math.min, math.max, math.random, math.sin, math.cos, math.tan, math.clamp, and the constants math.pi and math.e",
        );
      }

      for (const p of parts) {
        if (RESERVED_WORDS.has(p) && !(p === "is" && parts[0] === "is" && p === parts[0])) {
          throw new HazmaError(
            "H2045",
            `the reserved word "${p}" cannot be used as a value`,
            spanTok(t),
          );
        }
      }

      this.next();

      return this.dottedValue(parts, spanTok(t));
    }

    throw new HazmaError(
      "H2046",
      `expected a value but found ${describeToken(t)}`,
      spanTok(t),
      "values look like: 18, \"Alex\", is.ready, price.r, (a + b)",
    );
  }

  /**
   * Builds a value from a dotted name, turning trailing postfix operators into
   * math nodes: `price.r` rounds, `x.abs` takes an absolute value, and
   * `x.pow(2)` raises to a power. A trailing math name is always the operator;
   * a property with that name is reached only when it is not the last segment.
   */
  private dottedValue(parts: string[], span: Span): Expr {
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (last === "r") {
        return { kind: "round", inner: this.dottedValue(parts.slice(0, -1), span), span };
      }
      if (MATH_POSTFIX_OPS.has(last)) {
        const op = last as MathPostfixOp;
        let args: Expr[] = [];
        if (op === "pow") {
          args = this.parseParenArgs(op);
        }
        return {
          kind: "math.postfix",
          op,
          inner: this.dottedValue(parts.slice(0, -1), span),
          args,
          span,
        };
      }
    }
    return { kind: "path", parts, span };
  }

  private parseFuncCall(): FuncCall {
    const start = this.i - 1 >= 0 ? this.i - 1 : this.i;
    this.expectColon("func.c");
    const funcName = this.expectIdent("after func.c :");
    this.expectPunct("{", `to open the arguments block for "${funcName}"`);
    const args: CallArg[] = [];
    this.skipNewlines();
    while (!this.check("punct", "}")) {
      if (this.check("eof")) {
        throw new HazmaError("H2047", `arguments block for "${funcName}" is not closed - missing }`, spanTok(this.peek()));
      }
      const t = this.peek();
      if (t.kind === "ident" && this.peek(1).kind === "punct" && this.peek(1).text === "=") {
        this.next();
        this.next();
        const expr = this.parseExpression();
        args.push({ name: t.text, expr, span: span2(spanTok(t), expr.span) });
      } else {
        const expr = this.parseExpression();
        args.push({ expr, span: expr.span });
      }
      const end = this.endStatement("an argument");
      if (end === "close") break;
      if (end === "eof") {
        throw new HazmaError("H2047", `arguments block for "${funcName}" is not closed - missing }`, spanTok(this.peek()));
      }
      this.skipNewlines();
    }
    this.expectPunct("}", `to close the arguments block for "${funcName}"`);
    return {
      kind: "func.c",
      funcName,
      args,
      span: this.spanFrom(start),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function spanTok(t: Token): Span {
  return { start: { line: t.line, col: t.col }, end: { line: t.endLine, col: t.endCol } };
}

function span2(a: Span, b: Span): Span {
  return {
    start: a.start.line < b.start.line || (a.start.line === b.start.line && a.start.col <= b.start.col)
      ? a.start
      : b.start,
    end: a.end.line > b.end.line || (a.end.line === b.end.line && a.end.col >= b.end.col) ? a.end : b.end,
  };
}

function describeToken(t: Token): string {
  switch (t.kind) {
    case "eof": return "the end of the file";
    case "newline": return "the end of the line";
    case "string": return `the text "${t.value}"`;
    default: return `"${t.text}"`;
  }
}

function hintFor(text: string, what: string): string | undefined {
  if (text === "{") return `blocks open with { and close with } - ${what} expects {`;
  if (text === "}") return `blocks close with } - ${what} expects }`;
  if (text === ":") return "HAZMA commands use a colon: save : age = 18";
  if (text === "=") return "assignments use = : save : age = 18";
  return undefined;
}
