// File/folder commands and check.error.
//
// These tests use real directories under the OS temp folder, build absolute
// HAZMA string paths with forward slashes (valid on Windows and POSIX), and
// verify both the program output and the bytes actually written to disk.
import { describe, it, after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedentRawBlock } from "../src/lexer/lexer.js";
import { assert, expectDiag, expectOut, runSource } from "./support.js";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "hazma-files-"));
  roots.push(dir);
  return dir.replace(/\\/g, "/");
}

/** A HAZMA string literal for a filesystem path. */
function lit(path: string): string {
  return '"' + path + '"';
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("raw text blocks", () => {
  it("dedents by the common indent and keeps one trailing newline", () => {
    assert.equal(
      dedentRawBlock("\n    Line one\n        indented\n    Line two\n"),
      "Line one\n    indented\nLine two\n",
    );
  });

  it("keeps interior blank lines and an empty block writes nothing", () => {
    assert.equal(dedentRawBlock("\n    a\n\n    b\n"), "a\n\nb\n");
    assert.equal(dedentRawBlock("\n"), "");
    assert.equal(dedentRawBlock(""), "");
  });

  it("only ends at a line containing just }", () => {
    const dir = root();
    const p = `${dir}/braces.txt`;
    expectOut(
      [
        `file.create : ${lit(p)}`,
        `file.write : ${lit(p)} {`,
        "    if : x { y }",
        "    end",
        "}",
        `log.out { file.read : ${lit(p)} }`,
      ].join("\n"),
      ["if : x { y }\nend\n"],
    );
  });

  it("requires the opening brace on the command line", () => {
    expectDiag(['file.write : "x.txt"', "    text"].join("\n"), "H2002", "file.write");
  });
});

describe("files", () => {
  it("creates, writes, appends and reads exact bytes", () => {
    const dir = root();
    const p = `${dir}/data.txt`;
    expectOut(
      [
        `file.create : ${lit(p)}`,
        `file.write : ${lit(p)} {`,
        "    Hello from HAZMA!",
        "}",
        `file.add : ${lit(p)} {`,
        "    Another line!",
        "}",
        `save : content = file.read : ${lit(p)}`,
        "log.out { content }",
      ].join("\n"),
      ["Hello from HAZMA!\nAnother line!\n"],
    );
    assert.equal(readFileSync(p, "utf8"), "Hello from HAZMA!\nAnother line!\n");
  });

  it("reports file.exists for files, folders and missing paths", () => {
    const dir = root();
    const p = `${dir}/present.txt`;
    writeFileSync(p, "x");
    expectOut(
      [
        `log.out { file.exists : ${lit(p)} }`,
        `log.out { file.exists : ${lit(dir)} }`,
        `log.out { file.exists : ${lit(dir + "/absent.txt")} }`,
      ].join("\n"),
      ["true", "false", "false"],
    );
  });

  it("file.create on an existing file keeps its contents", () => {
    const dir = root();
    const p = `${dir}/keep.txt`;
    writeFileSync(p, "original");
    expectOut(
      [
        `file.create : ${lit(p)}`,
        `log.out { file.read : ${lit(p)} }`,
      ].join("\n"),
      ["original"],
    );
    assert.equal(readFileSync(p, "utf8"), "original");
  });

  it("writing a file replaces everything, appending adds to it", () => {
    const dir = root();
    const p = `${dir}/replace.txt`;
    writeFileSync(p, "old contents");
    expectOut(
      [
        `file.write : ${lit(p)} {`,
        "    new",
        "}",
        `file.add : ${lit(p)} {`,
        "    tail",
        "}",
        `log.out { file.read : ${lit(p)} }`,
      ].join("\n"),
      ["new\ntail\n"],
    );
  });

  it("reading a missing file is an error", () => {
    const dir = root();
    expectDiag(
      `save : c = file.read : ${lit(dir + "/missing.txt")}`,
      "H6001",
      "file.read cannot find",
    );
  });

  it("writing or appending to a missing file is an error", () => {
    const dir = root();
    expectDiag(
      [`file.write : ${lit(dir + "/missing.txt")} {`, "    x", "}"].join("\n"),
      "H6001",
      "file.write cannot find",
    );
    expectDiag(
      [`file.add : ${lit(dir + "/missing.txt")} {`, "    x", "}"].join("\n"),
      "H6001",
      "file.add cannot find",
    );
  });

  it("deleting a missing file is an error", () => {
    const dir = root();
    expectDiag(`file.delete : ${lit(dir + "/missing.txt")}`, "H6001");
  });

  it("file.delete removes the file", () => {
    const dir = root();
    const p = `${dir}/gone.txt`;
    writeFileSync(p, "bye");
    expectOut(
      [
        `file.delete : ${lit(p)}`,
        `log.out { file.exists : ${lit(p)} }`,
      ].join("\n"),
      ["false"],
    );
    assert.equal(existsSync(p), false);
  });

  it("a file path that is a folder is rejected, and vice versa", () => {
    const dir = root();
    expectDiag(`file.delete : ${lit(dir)}`, "H6006", "is a folder, not a file");
    writeFileSync(`${dir}/plain.txt`, "");
    expectDiag(`folder.delete : ${lit(dir + "/plain.txt")}`, "H6006", "is a file, not a folder");
  });

  it("every file command needs a text path", () => {
    expectDiag("file.create : 5", "H3065", "needs a text path");
    expectDiag("file.delete : true", "H3065");
    expectDiag("log.out { file.exists : 5 }", "H3065");
  });
});

describe("folders", () => {
  it("folder.create makes one folder", () => {
    const dir = root();
    const p = `${dir}/made`;
    expectOut(
      [
        `folder.create : ${lit(p)}`,
        `log.out { file.exists : ${lit(p + "/x.txt")} }`,
      ].join("\n"),
      ["false"],
    );
    assert.equal(existsSync(p), true);
  });

  it("folder.create does not create missing parents", () => {
    const dir = root();
    expectDiag(`folder.create : ${lit(dir + "/parent/child")}`, "H6002", "parent folder");
  });

  it("folder.delete removes files, subfolders and everything inside", () => {
    const dir = root();
    const p = `${dir}/tree`;
    mkdirSync(p);
    mkdirSync(`${p}/nested`);
    writeFileSync(`${p}/one.txt`, "1");
    writeFileSync(`${p}/nested/two.txt`, "2");
    expectOut(`folder.delete : ${lit(p)}`, []);
    assert.equal(existsSync(p), false);
  });

  it("deleting a missing folder is an error", () => {
    const dir = root();
    expectDiag(`folder.delete : ${lit(dir + "/absent")}`, "H6001");
  });
});

describe("check.error", () => {
  it("runs the handler only when the guarded command fails", () => {
    const dir = root();
    const good = `${dir}/good.txt`;
    writeFileSync(good, "ok");
    expectOut(
      [
        "save : note = \"none\"",
        `file.create : ${lit(good)}`,
        "check.error {",
        "    change : note = \"ran\"",
        "}",
        "log.out { note }",
        `save : ignored = file.read : ${lit(dir + "/absent.txt")}`,
        "check.error {",
        "    change : note = \"recovered\"",
        "}",
        "log.out { note }",
      ].join("\n"),
      ["none", "recovered"],
    );
  });

  it("catches a runtime error and the program continues", () => {
    const dir = root();
    expectOut(
      [
        `save : missing = file.read : ${lit(dir + "/nope.txt")}`,
        "check.error {",
        '    log.out { "caught" }',
        "}",
        'log.out { "after" }',
      ].join("\n"),
      ["caught", "after"],
    );
  });

  it("catches a folder error too", () => {
    const dir = root();
    expectOut(
      [
        `folder.create : ${lit(dir + "/a/b")}`,
        "check.error {",
        '    log.out { "no parent" }',
        "}",
      ].join("\n"),
      ["no parent"],
    );
  });

  it("needs a statement before it", () => {
    expectDiag("check.error {\n    log.out { 1 }\n}", "H2048", "nothing to watch");
  });

  it("wraps only the preceding command inside a block", () => {
    expectOut(
      [
        "if : true {",
        "    log.out { 1 }",
        "    check.error {",
        '        log.out { "not reached" }',
        "    }",
        "}",
      ].join("\n"),
      ["1"],
    );
  });

  it("is rejected as the first command of a block", () => {
    expectDiag(
      ["if : true {", "    check.error {", "        log.out { 1 }", "    }", "}"].join("\n"),
      "H2048",
    );
  });

  it("does not swallow errors raised in the handler itself", () => {
    const dir = root();
    expectDiag(
      [
        `save : c = file.read : ${lit(dir + "/no/such/file.txt")}`,
        "check.error {",
        `    save : d = file.read : ${lit(dir + "/no/such/other.txt")}`,
        "}",
      ].join("\n"),
      "H6001",
    );
  });

  it("cannot guard a command that pauses a repeat", () => {
    expectDiag(
      [
        "save : n = 0",
        "repeat : loop {",
        "    till n > 0",
        "    repeat.break : loop",
        "    check.error {",
        '        log.out { "never" }',
        "    }",
        "}",
      ].join("\n"),
      "H3066",
      "pauses a repeat",
    );
  });

  it("lets func.r leave the guarded command and the handler", () => {
    const dir = root();
    const src = [
      "func : safe_read {",
      "    func.p : path",
      "    save : text = file.read : path",
      "    check.error {",
      '        func.r : "fallback"',
      "    }",
      "    func.r : text",
      "}",
      `log.out { func.c : safe_read { ${lit(dir + "/present.txt")} } }`,
    ].join("\n");
    expectOut(src, ["fallback"]);
    writeFileSync(`${dir}/present.txt`, "present\n");
    expectOut(src, ["present\n"]);
  });

  it("catches an error inside a loop body and keeps looping", () => {
    const dir = root();
    expectOut(
      [
        "save : n = 0",
        "repeat : loop {",
        "    till n > 1",
        `    save : missing = file.read : ${lit(dir + "/absent.txt")}`,
        "    check.error {",
        '        log.out { "caught " + n }',
        "    }",
        "    change : n = n + 1",
        "    repeat.break : loop",
        "}",
        'log.out { "n " + n }',
      ].join("\n"),
      ["caught 0", "n 1"],
    );
  });
});
