# The HAZMA Language Specification

**Version 0.3.0 — Phase 1–8, native backend, Lists included**

HAZMA is one language intended to eventually replace HTML, CSS and JavaScript
for building websites and web applications. This document specifies the core
language as it exists today: the lexical rules, the commands, the type rules
and the runtime semantics. Everything here is implemented and covered by the
test suite. `hazma run` compiles to a native executable by default; the
tree-walking interpreter remains available as `hazma run --interpret`. Layers
that are architected but not built yet (the web document layer, the direct
LLVM backend) are marked **[planned]** and are not described as if they
existed.

---

## 1. Lexical structure

### 1.1 Source files

- Encoding: UTF-8 text. Convention: the extension is `.hz`.
- Statements are separated by **newlines**. There are **no semicolons**.
- A source that does not end with a newline behaves as if a final newline
  were present (the lexer emits one virtual newline before end of file).

### 1.2 Comments

- `//` starts a comment that runs to the end of the line.
- Block comments do not exist yet **[open question]**.

### 1.3 Identifiers and dotted names

An identifier is `[a-zA-Z_][a-zA-Z0-9_]*`. The lexer joins a run of
identifiers separated by single dots into **one token**, so
`t.change`, `log.out`, `struct.c`, `func.p` and `is.fight.over` are each a
single token. This is why dotted commands can never be split across lines.

### 1.4 Reserved words

Reserved words can never be variable names, property names, repeat names,
parameter names or values used in expressions:

```
save  change  t.change  log   if    else   s
repeat  func  struct  till  default  and  or  not
true  false  const  is
l.save  l.add  l.remove  l.change  l.count  l.find  l.find.index
```

Notes:

- `is` alone is reserved, but `is.` names (`is.ready`, `is.fight.over`) are
  valid boolean variable names of any depth.
- `r` is not in this list, but property named `r` is forbidden because `.r`
  is the round suffix (error H3034).
- The `l.*` names are commands; `l.count`, `l.find` and `l.find.index`
  are values and cannot be used as variable names.

### 1.5 Numbers

Decimal numbers with an optional fractional part (`18`, `2.2`). No
underscores, no exponents, no hex **[planned]**.

### 1.6 Strings

Double quotes with escapes `\n`, `\t`, `\"`, `\\`. Unterminated strings and
unknown escapes are lexer errors (H1002, H1004). Single quotes do not make
strings.

### 1.7 Operators

```
:   =   ==   !=   >=   <=   >   <   +   -   *   /   ,   (   )   {   }   [   ]
```

The postfix round operator is written `.r` and lexes as its own token.
`[` `]` delimit 1-based list indexes (§10.5).

---

## 2. Values and types

Five types exist today:

| Type    | Written as          | Notes                                       |
| ------- | ------------------- | ------------------------------------------- |
| number  | `18`, `2.2`         | 64-bit float; `.r` rounds (half away from negative: `Math.round` semantics — `-2.5.r` is `-2`) |
| string  | `"Alex"`            | compared with `==` / `!=` at runtime        |
| boolean | `true`, `false`     | variables holding booleans **must** be named `is.*` |
| struct  | `struct.c : name {}`| instance of a declared structure            |
| list    | `{ "Sword" "Gun" }` | mutable, ordered, allows duplicates (§10)   |

There is deliberately no `null` and no map yet **[planned]**.

### 2.1 Boolean naming (`is.`)

Every boolean variable name starts with `is.` and may go any number of
levels deep: `is.ready`, `is.fight.over`, `is.game.has.won`. The whole
dotted name is **one variable** — `is.fight.over` is not a property access.

Violations are compile errors:

- a boolean saved into a non-`is.` name → H3020
- a non-boolean saved into an `is.` name → H3020 / H4010

### 2.2 Rounding (`.r`)

`expr.r` rounds to the nearest whole number using JavaScript `Math.round`
(halves round toward positive infinity). `.r` may follow a number, a
dotted property path or a parenthesized expression: `price.r`,
`2.2.r`, `(a + b) / 2).r` style nesting works. Applying `.r` to a
non-number is H3001 / H4027.

### 2.3 Type stability

- `change :` keeps the variable's type; changing the type is H3012 / H4002.
- `t.change :` explicitly changes the type.
- Structure property types are checked on every assignment (H3012/H3040).

---

## 3. Variables

```
save : name = value          // create (or re-initialize) a variable
change : name = value        // update, same type
t.change : name = value      // update, new type allowed
name = value                 // shorthand for change (top level and functions)
```

- `save` on an existing variable **re-initializes** it (useful inside
  repeats: each pass starts fresh). The new value must have the same type
  as before (H3012) unless `t.change` semantics are used.
- Locals inside functions must not share a name with a global (H3007),
  with a parameter (H3008) or with another local.
- Globals are pre-collected before bodies are checked, so a function may
  reference a global that is declared later in the file.

---

## 4. Output

```
log.out { expression }
```

Prints one value per command:

- strings print without quotes, numbers plainly, booleans as `true`/`false`,
  lists as `[Sword, Gun]`, and structure instances as
  `name{ prop: value, ... }`.
- `+` joins text with anything (numbers are converted); `string + boolean`
  is allowed.

---

## 5. Conditions

```
if : condition {
    ...
} else if : condition {
    ...
} else : {
    ...
}
```

- Conditions must be boolean (H3015 / H4033).
- Boolean operators: `and`, `or`, `not`, parentheses.
- `else` / `else if` may sit on the next line (the parser looks past
  newlines). `else` without `if` is H2023.

---

## 6. Selection (`s.change`)

```
s.change : subject {
    label = literal {
        ...
    }
    label = literal {
        ...
    }
    default : {
        ...
    }
}
```

- `subject` is any expression (usually a variable).
- Each branch is `label = literal`. The **value** after `=` is what the
  subject is compared against; the label is a readable name only.
- Only the first matching branch runs; `default` runs when nothing matches
  and must be last (H2026 twice = error, middle default = error).
- Branch values must be literals (H3043) and type-check against the
  subject (H3044).
- Branches nest: a `default` body may contain another `s.change`.

---

## 7. Repeats

Two forms, one model. Both are **do-until**: the body runs before the
condition is ever checked.

### 7.1 Anonymous form

```
repeat till condition {
    ...
}
```

### 7.2 Named form

```
repeat : name {
    till condition
    ...
}
```

- `till` must be the **first statement** of the body (H2035 elsewhere).
- Names are unique per scope: top level (globals) or inside one function
  (H3021). Reserved words cannot name a repeat (H2039).

### 7.3 Control

```
repeat.break : name        // pause the named repeat (suspend, do not discard)
repeat.continue : name     // resume a paused repeat where it stopped
repeat.new : name          // restart a paused repeat from its first pass
```

Semantics (this is the unusual part, chosen deliberately):

- `repeat.break` does **not** discard the loop. It freezes it: the loop's
  own frame and every frame nested inside it (inner repeats, function
  calls made from inside it) are parked in a saved state. Execution
  continues at the statement after the repeat statement.
- `repeat.continue` parks the saved frames back into the machine. The
  machine naturally resumes inside the loop at the statement after the
  `repeat.break` that paused it. Statements after the `repeat.continue`
  run only after the loop pauses or finishes again.
- `repeat.new` does the same as `continue`, but first restores the
  variables the body referenced to the snapshot taken when the loop
  started (its first pass), and resumes the loop from its current
  position in the machine.
- `repeat.break` targets must lexically enclose the break (same
  activation), otherwise H3050.
- `repeat.continue` / `repeat.new` work from the same scope or (for
  global repeats) from inside any function; targeting a repeat that is
  frozen inside a paused repeat is H4021; restarting from inside itself
  is H4025 / H3051.
- Continuing a repeat that already finished is H4022 / H4024; restarting
  one that is running is H4020 / H4025. `repeat.new` on a finished repeat
  is allowed: it restores the snapshot and runs again from the top.
- Native compilation note: a `func.r` inside a **named** repeat is
  rejected with **H5001**, because a named repeat becomes its own C
  function in the compiled program. Move the return outside the repeat,
  or run with `hazma run --interpret`.

Example trace (from the test suite):

```
save : i = 0
repeat : main {
    till i > 3
    log.out { "pass " + i }
    change : i = i + 1
    repeat.break : main
}
log.out { "paused" }
repeat.continue : main
log.out { "end" }
// pass 0
// paused
// pass 1     <- resumed after the break, till now sees i = 1
// end        <- paused again by the second break
```

---

## 8. Functions

```
func : name {
    func.p : param
    func.p : other = "default"
    ...
    func.r : value          // return a value (optional)
}
```

Call:

```
func.c : name { 1  2 }                 // positional arguments
func.c : name { b = 2  a = 1 }         // named arguments
save : x = func.c : name { 1  2 }      // calls as values when func.r used
```

Rules:

- Functions are declared at the top level only (H3053). `func.p` lines
  must come before any command (H2031).
- Recursion is statically rejected with a cycle report (H3057).
- Return types are inferred from `func.r` expressions; calls before the
  inference still type-check (a quiet fixpoint pass runs first).
- A function whose calls return nothing may not be used as a value
  (H4028).
- Argument mismatches: mixed positional/named (H3045), count (H3046),
  missing (H3047), twice (H3048), unknown named (H3049).
- Functions may read and `change` globals; `save` inside a function
  creates a local.

---

## 9. Structures

```
struct : npc_structure {
    id = 1
    health = 50
    const. kind = "goblin"
}

struct : boss_npc {
    struct.base : npc_structure
    title = "Boss"
}
```

- Defaults must be literals or nested `struct.c` values (H3042); `const.`
  defaults too (H3042 covers literal-only defaults).
- `const.` properties are locked forever: instances cannot set them
  (H3041 / H4011) and children cannot override them (H3038).
- Property named `r` is forbidden (H3034). Property names must not be
  reserved words (H2016/H2044 at parse).
- Inheritance: `struct.base : parent` (single or multiple). Conflicting
  inherited properties are H3037; children may override inherited
  non-const properties with the same type (H3040 otherwise).
- Creation with overrides:

```
save : g = struct.c : npc_structure {
    health = 70
}
```

- Instances are compared by identity with `==`.
- Property access: `g.health`; multi-level: `g.inventory.coins`.
- `change : g { health = 80 }` changes one or many properties;
  `change : g.health = 80` also works.

---

## 10. Lists

Lists are a native type: a **mutable, ordered** collection of supported
values (text, numbers, Booleans, structure instances and other lists).
Duplicates are allowed and insertion order is preserved everywhere.

### 10.1 Creating a list — `l.save :`

```hazma
l.save : weapons = {
    "Sword"
    "Gun"
    "Bow"
}
```

- `l.save :` creates a new list bound to a name. Elements sit between
  `{ }`, one per line; commas are also accepted as separators.
- `l.save : name = { }` creates an empty list.
- The element type is inferred from the elements. An empty list starts as
  a list of anything and accepts values of any type later; a literal that
  mixes value types is also a list of anything.
- `l.add` and `l.change` must store values that match the list's element
  type (H3064); lists of anything accept every value.
- Re-running `l.save :` re-initializes the variable with a fresh list,
  exactly like `save :`.
- `l.save :` only accepts a list literal. To store a list returned by a
  function use `save : name = func.c : ...` (H2067 otherwise).

### 10.2 Adding elements — `l.add :`

```hazma
l.add : weapons {
    "Shield"
    "Dagger"
}
```

- Appends one or more elements in the order written.
- Duplicates are allowed.
- The target may be a plain variable or a property path such as
  `bag.items` (lists inside structures are supported).
- The target must be a list (H3062 at compile time, H4064 at runtime).
- The added values must match the list's element type (H3064).

### 10.3 Removing elements — `l.remove :`

```hazma
l.remove : weapons {
    "Gun"
}
```

- Removes elements **by value**, never by index. Numeric values are
  treated as values: `l.remove : numbers { 20 }` removes the value `20`.
- When a value appears more than once, **only the first matching
  occurrence is removed** (the same occurrence `l.find.index` reports).
- Removing a value that is not present is a runtime error (H4063). It is
  never a silent no-op.

### 10.4 Changing elements — `l.change :`

```hazma
l.change : weapons {
    2 = "Rifle"
}
```

- The left side is a **1-based index**; the right side is the new value.
- The element keeps its position; only its value changes.
- The index must be a whole number starting at 1 (H3063 when the type is
  known to be wrong, H4061 for 0/negative/fractional values at runtime)
  and must exist in the list (H4062).
- The new value must match the list's element type (H3064).
- Several lines may change several elements in one block.

### 10.5 Reading elements — `list[index]`

```hazma
log.out {
    weapons[1]
}
```

- Indexing is **1-based**: `weapons[1]` is the first element.
- Indexing a non-list is H3060 (compile time) / H4060 (runtime).
- A non-numeric index is H3061; `0`, negative or fractional indexes are
  H4061; an index past the end is H4062.
- Indexing nests: `grid[2][1]`.

### 10.6 Counting — `l.count :`

```hazma
log.out {
    l.count : weapons
}
```

Returns the number of elements. An empty list returns `0`.

### 10.7 Searching — `l.find :` and `l.find.index :`

```hazma
log.out {
    l.find : weapons {
        "Sword"
    }
}

log.out {
    l.find.index : weapons {
        "Sword"
    }
}
```

- `l.find` returns `true` or `false`.
- `l.find.index` returns the 1-based position of the **first** matching
  occurrence, or `0` when the value is absent. `0` is deliberately not a
  valid position, so it is an unambiguous "not found" marker.
- Both are values and can be used in `log.out`, `save :` and `if :`
  conditions.
- Values are compared with HAZMA's equality rules: values of different
  types never match (the number `1` and the text `"1"` are different).

### 10.8 Reference semantics

Like structure instances, a list is a **reference value**: assigning it or
passing it to a function shares the same list, so `l.add` inside a
function is visible to the caller. `repeat.new` restores a deep copy of
the variables it snapshots, so a restarted repeat gets fresh lists.

Lists compare with `==` / `!=` by identity, not element by element.

### 10.9 Lists in functions and structures

- Function parameters can receive lists and mutate them with
  `l.add` / `l.remove` / `l.change`.
- A structure property may default to a list literal:
  `items = { "map" }`. Every instance receives its own list.
- Lists may contain structure instances and other lists.

## 11. Expressions and precedence

Loosest to tightest:

1. `or`
2. `and`
3. `not` (unary, binds tighter than `and`/`or` but looser than comparisons)
4. comparisons `==` `!=` `>` `<` `>=` `<=` (non-associative chains allowed left-to-right)
5. `+` `-`
6. `*` `/`
7. unary `-`
8. postfix `.r` and `[ index ]`
9. primary: number, string, `true`, `false`, `( expr )`, list literal,
   variable/path, `struct.c : name {...}`, `func.c : name {...}`,
   `l.count : list`, `l.find : list { value }`,
   `l.find.index : list { value }`

Type rules:

- `-` `*` `/` need numbers (H3002/H3005/H3006, runtime H4029/H4031/H4032).
- `and`/`or`/`not` need booleans (H3003/H3005, runtime H4033).
- `+` with a string on either side joins into a string; `number + number`
  adds; boolean met without a string is H3005.
- Comparisons need numbers on both sides when types are known (H3006);
  strings may be compared with `==` / `!=` at runtime.
- Division by zero is a runtime error H4031 (no infinity).

---

## 12. Program structure

A program is a sequence of top-level statements. `struct` and `func`
declarations may appear anywhere at the top level; references to globals
declared later are allowed (globals are pre-collected). The program runs
top to bottom; paused repeats are kept alive until the program ends.

---

## 13. Diagnostics

Every problem is an `H` code + message + file/line/col span + optional
`help:` line. Ranges:

| Range   | Layer            |
| ------- | ---------------- |
| H1xxx   | lexer            |
| H2xxx   | parser           |
| H3xxx   | semantic analyzer|
| H4xxx   | runtime          |

### 13.1 Lexer (H1xxx)

| Code  | Message                                           |
| ----- | ------------------------------------------------- |
| H1001 | unexpected character "c"                          |
| H1002 | unterminated string - missing closing "           |
| H1004 | unknown escape sequence \x                        |

### 13.2 Parser (H2xxx)

| Code  | Message |
| ----- | ------- |
| H2002 | expected "x" ... but found ... |
| H2003 | expected a name ... but found ... |
| H2010 | unknown command "x" (with the command list as help) |
| H2011 | unexpected token after ... |
| H2013 | "x" is not a valid boolean name |
| H2014 | "s" is a reserved word and cannot be used after is. |
| H2015 | "x" is not a valid variable name |
| H2016 | "x" is a reserved word and cannot be a variable/property/parameter name |
| H2017 | "x" is not a valid path |
| H2018 | the reserved word "p" cannot be used in a path |
| H2019 | unexpected } - no block is open here |
| H2020 | expected a command but found ... |
| H2021 | unknown command "x" (change context) |
| H2022 | log.out needs a value to print |
| H2023 | else without a matching if |
| H2024 | s.change block is not closed - missing } |
| H2025 | expected a branch name inside s.change but found ... |
| H2026 | default can only appear once in an s.change / default must be last |
| H2027 | unknown command "x" (did you mean "s.change"?) |
| H2028 | repeat "name" is not closed - missing } |
| H2029 | repeat needs a condition or a name |
| H2030 | unknown command "x" (repeat context) |
| H2031 | func.p declares parameters and must come before the commands of the function |
| H2032 | unknown command "x" (func context) |
| H2033 | struct.base holds a single structure declaration |
| H2034 | struct.c creates a value - assign it to a variable |
| H2035 | till belongs inside a named repeat |
| H2036 | default belongs inside an s.change block |
| H2037 | "is" alone is not a name |
| H2038 | "x" cannot start a command |
| H2039 | "name" is a reserved word and cannot name a repeat |
| H2040 | block is not closed - missing } |
| H2041 | expected a property name but found ... |
| H2042 | "x" is not a valid const property name |
| H2043 | const. is only allowed inside structures |
| H2044 | "x" is not a valid property name |
| H2045 | the reserved word "p" cannot be used as a value |
| H2046 | expected a value but found ... |
| H2047 | arguments block for "name" is not closed - missing } |
| H2060 | "x" is a value, not a command / "x" is a command, not a value |
| H2061 | unknown command "l.x" (the list commands are named in the help) |
| H2062 | the list is not closed - missing } |
| H2064 | the l.change block is not closed - missing } |
| H2065 | l.change needs at least one index = value line |
| H2066 | l.find / l.find.index needs a value to search for |
| H2067 | l.save : needs a list written with { } |

### 13.3 Semantic analyzer (H3xxx)

| Code  | Message |
| ----- | ------- |
| H3001 | price.r rounds numbers, but this is a string |
| H3002 | a minus sign works on numbers, but this is a string |
| H3003 | not works on true or false, but this is a number |
| H3004 | unknown structure "name" |
| H3005 | "op" needs true or false / compares / joins - per-op message |
| H3006 | "op" compares numbers, but the left/right side is a string |
| H3007 | the parameter/local "x" has the same name as a global variable |
| H3008 | "x" is already a parameter of "f" |
| H3009 | "a.b" is a number and has no properties |
| H3010 | the structure "S" has no property "p" (+ did-you-mean) |
| H3011 | unknown variable "x" (+ did-you-mean) |
| H3012 | "x" holds a string and cannot be changed to a number |
| H3013 | "p" is a const property and can never be changed |
| H3014 | change : a.b { ... } needs a structure instance, but "a" is a number |
| H3015 | the condition of if/repeat must be true or false |
| H3020 | "x" starts with is. so it holds true or false, but this is a number (and the mirror case) |
| H3021 | two repeats are named "x" |
| H3030 | a function named "f" already exists |
| H3031 | the parameter "p" is declared twice in "f" |
| H3032 | a structure named "S" already exists |
| H3033 | the property "p" is declared twice in "S" |
| H3034 | "r" is reserved for the round suffix (price.r) and cannot be a property name |
| H3035 | "p" is listed twice as a parent of "S" |
| H3036 | unknown structure "p" (in struct.base) |
| H3037 | the property "p" is inherited from both A and B |
| H3038 | "p" is a const property inherited from a parent and cannot be overridden |
| H3039 | "p" is inherited from a parent and cannot be redeclared as const |
| H3040 | the property "p" is inherited as a number and cannot be overridden as a string |
| H3041 | const. cannot be used when creating/changing an instance |
| H3042 | structure defaults must be literal values |
| H3043 | the branch "label" must compare against a literal value |
| H3044 | the branch "label" compares a string against a subject of a number |
| H3045 | the call to "f" mixes positional and named arguments |
| H3046 | "f" takes N arguments but received M |
| H3047 | the argument "a" is missing in the call to "f" |
| H3048 | the argument "a" is passed twice |
| H3049 | "f" has no parameter named "a" |
| H3050 | there is no enclosing repeat named "x" |
| H3051 | repeat "x" cannot use repeat.continue/repeat.new from inside itself |
| H3052 | there is no repeat named "x" visible from here |
| H3053 | the function "f" must be declared at the top level |
| H3054 | func.r can only be used inside a function |
| H3055 | the structure "S" must be declared at the top level |
| H3056 | func.p can only be used inside a function |
| H3057 | recursive calls are not allowed: a calls b calls a |
| H3060 | a number cannot be indexed - only lists are indexed |
| H3061 | list indexes are whole numbers starting at 1 |
| H3062 | l.add / l.remove / l.change / l.count / l.find needs a list |
| H3063 | l.change indexes by position - the left side must be a whole number |
| H3064 | the list "x" holds text, so a number cannot be added |

### 13.4 Runtime (H4xxx)

| Code  | Message |
| ----- | ------- |
| H4001 | unknown variable "x" |
| H4002 | "x" holds a string and cannot be changed to a number |
| H4009 | "a" is a number and has no properties |
| H4010 | "x" starts with is. so it holds true or false, but 5 was saved |
| H4011 | "p" is a const property and can never be changed |
| H4013 | the structure "S" has no property "p" |
| H4014 | change : a.b { ... } needs a structure instance, but it is a number |
| H4015 | unknown structure "S" |
| H4016 | structure defaults must be literal values |
| H4017 | unknown function "f" |
| H4020 | repeat "x" is already running |
| H4021 | repeat "x" is frozen inside a paused repeat |
| H4022 | repeat "x" has already finished |
| H4023 | repeat "x" is not running right now |
| H4024 | repeat "x" has already finished (new context) |
| H4025 | repeat "x" is running and cannot be restarted from inside itself |
| H4026 | there is no active repeat named "x" |
| H4027 | price.r rounds numbers, but this is a string |
| H4028 | the function "f" returns nothing, so it cannot be used as a value |
| H4029 | a minus sign works on numbers, but this is a string |
| H4031 | division by zero |
| H4032 | ">" compares numbers, but this is a string and a number |
| H4033 | condition/not must be true or false |
| H4060 | a number cannot be indexed - only lists are indexed (runtime) |
| H4061 | list indexes are whole numbers starting at 1, but the index is 0 |
| H4062 | index 5 is out of range - the list has 2 elements |
| H4063 | "Gun" is not in "weapons", so it cannot be removed |
| H4064 | l.add / l.remove / l.change / l.count / l.find needs a list |
| H4099 | func.r was used outside a function (internal guard) |

### 13.5 Native backend (H5xxx)

These are produced only by the native code generator
(`hazma run` / `hazma build`); `--interpret` never emits them.

| Code  | Message | Meaning |
| ----- | ------- | ------- |
| H5000 | native compilation failed: ... | the C toolchain was missing, or the generated C did not compile; the message includes the compiler output and generated file path |
| H5001 | func.r inside repeat "x" cannot be compiled natively yet | a named repeat is a separate C function, so it cannot return a value to its caller; move the `func.r` outside the repeat or use `hazma run --interpret` |

---

## 14. What is implemented vs planned

Implemented (phases 1–8, plus the native backend): lexer, parser, AST,
semantic analysis with a full diagnostic model, tree-walking interpreter
with the frame-based repeat pause/resume machine, the native List system,
a C-emitting native backend that produces real executables (MSVC by
default, `HAZMA_CC` for clang/gcc), CLI (`run`, `build`, `interpret`,
`check`, `ast`, `new`, `version`, `help`), test suite, examples, docs.

Still **not built**: a direct LLVM/object-code backend, memory
reclamation in the native runtime, the web/document layer (elements,
styling, events replacing HTML/CSS/JS DOM), a package manager, LSP
language server, and the browser runtime.

### 14.1 Native runtime limits (honest list)

- **Windows fibers** implement named-repeat pause/resume. Programs using
  `repeat.break` / `repeat.continue` / `repeat.new` need Windows today;
  other targets can compile and run programs that do not use them.
- **No reclamation.** Values, strings, lists and structure instances are
  allocated and kept until the process exits. Long-running programs that
  allocate in a loop grow.
- **Fiber leaks.** A paused loop whose owning function has already
  returned cannot be resumed; its fiber is not reclaimed.
- **Runtime errors** print `runtime error[code]: message` plus
  `--> file:line`. They do not include the caret excerpt or the `help:`
  line that the analyzer prints at compile time.
- **`func.r` in named repeats** is H5001 (see above).
- **Performance is not claimed.** Generated C plus a dynamic-value
  runtime should be measured against your workload; no comparison with
  C, C++ or Rust is asserted.
