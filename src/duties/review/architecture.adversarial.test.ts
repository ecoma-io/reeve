/**
 * The architecture scanner against text that is trying to look like code.
 *
 * `architecture.test.ts` covers extraction, resolution and assessment of real
 * imports. This file covers the opposite claim, the one the module doc makes
 * and the one a contributor can attack: **an `import ... from` that is not code
 * never becomes an edge.** A forged edge is worse than a missed one here — the
 * finding it produces is deterministic, carries a marker, and is published on
 * somebody's pull request as a fact about an import that does not exist.
 *
 * The cases below are grouped by what hides the text. The multi-line ones are
 * the ones that regressed: the scanner used to start each line from scratch,
 * so anything opened on one line and closed on another left its interior lines
 * reading as code.
 */
import { describe, expect, it } from "vitest";

import { extractEdges } from "./architecture.js";

const file = (lines: [number, string][]): { path: string; lines: Map<number, string> } => ({
  path: "src/app/a.ts",
  lines: new Map(lines),
});

const specifiers = (lines: [number, string][]): string[] =>
  extractEdges(file(lines)).map((edge) => edge.specifier);

describe("a construct that spans lines hides what is inside it", () => {
  it("a block comment opened mid-line hides the lines after it", () => {
    // The opener is not at the start of its line, which is what the scanner
    // used to require before it would carry the comment forward.
    expect(
      specifiers([
        [1, "const x = 1; /* explaining a rule:"],
        [2, '   import bad from "../infra/db.js"'],
        [3, "*/"],
      ]),
    ).toEqual([]);
  });

  it("a multi-line template literal hides the lines inside it", () => {
    // A prompt, a SQL statement, an HTML fragment — every one of them is a
    // template literal in this codebase, and every one of them can quote code.
    expect(
      specifiers([
        [1, "const prompt = `"],
        [2, '  import bad from "../infra/db.js"'],
        [3, "`;"],
      ]),
    ).toEqual([]);
  });

  it("keeps hiding across a template that closes and a comment that opens", () => {
    expect(
      specifiers([
        [1, "const prompt = `"],
        [2, '  import first from "../infra/a.js"'],
        [3, "`; /* and now a comment"],
        [4, '  import second from "../infra/b.js"'],
        [5, "*/"],
      ]),
    ).toEqual([]);
  });

  it("still extracts real code after the block comment closes", () => {
    expect(
      specifiers([
        [1, "const x = 1; /* note"],
        [2, "*/"],
        [3, 'import real from "../infra/db.js";'],
      ]),
    ).toEqual(["../infra/db.js"]);
  });

  it("still extracts real code after the template literal closes", () => {
    expect(
      specifiers([
        [1, "const prompt = `"],
        [2, "`;"],
        [3, 'import real from "../infra/db.js";'],
      ]),
    ).toEqual(["../infra/db.js"]);
  });

  it("extracts code that follows a block comment closing on the same line", () => {
    expect(specifiers([[1, '/* note */ import real from "../infra/db.js";']])).toEqual([
      "../infra/db.js",
    ]);
  });
});

describe("a construct that ends with its line does not hide the next one", () => {
  it("an unterminated single-quoted string does not swallow the following line", () => {
    // `"` and `'` cannot span lines in JavaScript, so an unterminated one is a
    // syntax error on its own line — never a reason to stop reading the file.
    expect(
      specifiers([
        [1, "const broken = 'oops"],
        [2, 'import real from "../infra/db.js";'],
      ]),
    ).toEqual(["../infra/db.js"]);
  });

  it("a line comment ends at its own newline", () => {
    expect(
      specifiers([
        [1, '// import bad from "../infra/db.js"'],
        [2, 'import real from "../infra/db.js";'],
      ]),
    ).toEqual(["../infra/db.js"]);
  });
});

describe("text that only looks like a delimiter", () => {
  it("a comment opener inside a string opens no comment", () => {
    expect(
      specifiers([[1, 'const s = "not a /* comment"; import real from "../infra/db.js";']]),
    ).toEqual(["../infra/db.js"]);
  });

  it("an escaped backtick does not close the template that carries it", () => {
    expect(specifiers([[1, 'const t = `a \\` b import bad from "../infra/db.js"`;']])).toEqual([]);
  });

  it("a substitution does not reopen code inside a template", () => {
    // `${...}` is real code, and a dynamic import written in one is a real
    // edge — but reading it needs a parser, so the whole literal stays opaque
    // and the edge is missed. A miss is the safe direction; a forgery is not.
    expect(
      specifiers([
        [1, "const t = `a ${"],
        [2, '  await import("../infra/db.js")'],
        [3, "} b`;"],
      ]),
    ).toEqual([]);
  });
});
