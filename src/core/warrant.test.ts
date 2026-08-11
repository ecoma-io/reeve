import { describe, expect, it } from "vitest";

import { checkLabelsExist, parseWarrant, type Warrant } from "./warrant.js";

// Nothing is mocked. The YAML parser is a library, not a collaborator, and
// every assertion here is about what this module does with what it returns.

const PATH = ".github/reeve.yml";

const FULL = `
version: 1

capabilities:
  triage: [label, comment]
  translate: [edit-body]

labels:
  - name: bug
    description: Released behaviour contradicts its own documentation.
    not: A capability that was never built.
    examples:
      - "Export produces an empty file when the table has exactly one row"
    owner: "@ecoma-io/runtime"

  - name: needs reproduction
    description: A plausible defect report without enough to reproduce it.
    exclusive_with: [bug]
`;

function warrant(source: string): Warrant {
  return parseWarrant(PATH, source);
}

const MINIMAL = "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n";

describe("parseWarrant", () => {
  it("reads the taxonomy in the order it was written", () => {
    // That order reaches the prompt, so it is not incidental.
    expect(warrant(FULL).labels.map((label) => label.name)).toEqual(["bug", "needs reproduction"]);
  });

  it("reads every field of an entry", () => {
    const [bug] = warrant(FULL).labels;

    expect(bug).toEqual({
      name: "bug",
      description: "Released behaviour contradicts its own documentation.",
      not: "A capability that was never built.",
      examples: ["Export produces an empty file when the table has exactly one row"],
      owner: "@ecoma-io/runtime",
      exclusiveWith: [],
    });
  });

  it("leaves an absent optional field absent rather than empty-stringed", () => {
    const found = warrant(FULL).labelNamed("needs reproduction");

    expect(found?.not).toBeNull();
    expect(found?.owner).toBeNull();
    expect(found?.examples).toEqual([]);
  });

  it("finds a label by its exact name, which is how GitHub applies one", () => {
    expect(warrant(FULL).labelNamed("bug")?.name).toBe("bug");
    expect(warrant(FULL).labelNamed("Bug")).toBeUndefined();
  });

  it("keeps the path, so every message about the file can name it", () => {
    expect(warrant(MINIMAL).path).toBe(PATH);
  });
});

describe("version", () => {
  it("refuses a version this build does not understand", () => {
    // Naming the version rather than parsing a future format into something
    // plausible and wrong.
    expect(() => warrant("version: 2\nlabels: []\n")).toThrow(/declares version `2`/);
  });

  it("refuses a file with no version at all", () => {
    expect(() => warrant("labels: []\n")).toThrow(/declares version absent/);
  });

  it("refuses an empty file rather than reading it as an empty authority", () => {
    expect(() => warrant("")).toThrow(/is not a warrant/);
  });

  it("refuses a file that is not a mapping", () => {
    expect(() => warrant("- bug\n- enhancement\n")).toThrow(/is not a warrant/);
  });

  it("refuses YAML that does not parse, naming the file", () => {
    expect(() => warrant("version: 1\nlabels:\n  - name: [unclosed\n")).toThrow(
      /`\.github\/reeve\.yml` is not valid YAML/,
    );
  });
});

describe("labels", () => {
  it("treats an absent taxonomy as an empty one", () => {
    // A repository that wrote a warrant only to configure capabilities is a
    // configuration, not a mistake. The duty that needs a taxonomy says so.
    expect(warrant("version: 1\ncapabilities:\n  triage: [label]\n").labels).toEqual([]);
  });

  it("refuses a taxonomy that is not a list", () => {
    expect(() => warrant("version: 1\nlabels: bug\n")).toThrow(/expected a list/);
  });

  it("refuses an entry with no name", () => {
    expect(() => warrant("version: 1\nlabels:\n  - description: A defect.\n")).toThrow(
      /label 1 has no `name`/,
    );
  });

  it("refuses an entry with no description", () => {
    // A name on its own tells a model what your project decided about nothing.
    expect(() => warrant("version: 1\nlabels:\n  - name: bug\n")).toThrow(
      /\(`bug`\) has no `description`/,
    );
  });

  it("refuses an empty description rather than sending whitespace to a model", () => {
    expect(() => warrant('version: 1\nlabels:\n  - name: bug\n    description: "   "\n')).toThrow(
      /empty `description`/,
    );
  });

  it("refuses a repeated name", () => {
    const source = `${MINIMAL}  - name: bug\n    description: Another defect.\n`;
    expect(() => warrant(source)).toThrow(/names `bug` more than once/);
  });

  it("refuses two names differing only in case", () => {
    // GitHub will not hold both, so the file is describing something the
    // tracker cannot represent.
    const source = `${MINIMAL}  - name: Bug\n    description: Another defect.\n`;
    expect(() => warrant(source)).toThrow(/more than once/);
  });

  it("refuses an entry that is not a mapping", () => {
    expect(() => warrant("version: 1\nlabels:\n  - bug\n")).toThrow(/label 1 is the text `bug`/);
  });

  it("refuses a description that is not text", () => {
    expect(() => warrant("version: 1\nlabels:\n  - name: bug\n    description: 3\n")).toThrow(
      /`description` as `3`, expected text/,
    );
  });
});

describe("exclusive_with", () => {
  it("reads the labels an entry may not be applied alongside", () => {
    expect(warrant(FULL).labelNamed("needs reproduction")?.exclusiveWith).toEqual(["bug"]);
  });

  it("reads a bare string as one entry", () => {
    const source = `${MINIMAL}  - name: question\n    description: A question.\n    exclusive_with: bug\n`;
    expect(warrant(source).labelNamed("question")?.exclusiveWith).toEqual(["bug"]);
  });

  it("refuses a name that is not a label in the same file", () => {
    // Checked after every entry exists, so this names the typo rather than
    // being resolved against a half-built map.
    const source = `${MINIMAL}    exclusive_with: [bg]\n`;
    expect(() => warrant(source)).toThrow(/exclusive with `bg`, which is not a label in this file/);
  });

  it("refuses an empty entry", () => {
    const source = `${MINIMAL}    exclusive_with: [""]\n`;
    expect(() => warrant(source)).toThrow(/empty `exclusive_with` entry/);
  });

  it("refuses an entry that is not text", () => {
    const source = `${MINIMAL}    exclusive_with: [3]\n`;
    expect(() => warrant(source)).toThrow(/entry 1 as `3`, expected text/);
  });
});

describe("owner", () => {
  it.each([["@user"], ["@ecoma-io/runtime"], ["@a"]])("accepts `%s`", (owner) => {
    expect(warrant(`${MINIMAL}    owner: "${owner}"\n`).labelNamed("bug")?.owner).toBe(owner);
  });

  it.each([["runtime"], ["@"], ["@user/"], ["@-user"], ["@user name"]])(
    "refuses `%s`, which is not a handle",
    (owner) => {
      // Whether the handle can be assigned is the API's answer at apply time.
      // Whether it is shaped like one at all is answerable here, for nothing.
      expect(() => warrant(`${MINIMAL}    owner: "${owner}"\n`)).toThrow(/is not a handle/);
    },
  );
});

describe("capabilities", () => {
  it("reads what a duty was granted", () => {
    expect(warrant(FULL).granted("triage", ["label"])).toEqual(["label", "comment"]);
  });

  it("falls back to the duty's own default when the file says nothing", () => {
    // The default belongs to the duty: only `triage` knows its cheapest
    // reversible action is a label.
    expect(warrant(MINIMAL).granted("triage", ["label"])).toEqual(["label"]);
  });

  it("distinguishes an explicit `none` from an absent entry", () => {
    const source = `version: 1\ncapabilities:\n  triage: [none]\n`;
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });

  it("drops a repeated capability rather than granting it twice", () => {
    const source = `version: 1\ncapabilities:\n  triage: [label, label]\n`;
    expect(warrant(source).granted("triage", [])).toEqual(["label"]);
  });

  it("refuses a misspelling rather than silently granting nothing", () => {
    // A silently ignored `lablel` is a bug a maintainer discovers months later
    // as an absence, which is the hardest kind to notice.
    const source = `version: 1\ncapabilities:\n  triage: [lablel]\n`;
    expect(() => warrant(source)).toThrow(/names `lablel`, which is not something a duty/);
  });

  it("refuses an empty list, which is what a half-finished edit leaves behind", () => {
    const source = `version: 1\ncapabilities:\n  triage: []\n`;
    expect(() => warrant(source)).toThrow(/is empty\. Use `\[none\]`/);
  });

  it("refuses `none` mixed with a real capability, which says two things at once", () => {
    const source = `version: 1\ncapabilities:\n  triage: [none, label]\n`;
    expect(() => warrant(source)).toThrow(/names `none`/);
  });

  it("refuses a capabilities block that is not a mapping", () => {
    expect(() => warrant("version: 1\ncapabilities: [label]\n")).toThrow(
      /`capabilities` as a list/,
    );
  });

  it("says nothing about a duty the file never mentions", () => {
    expect(warrant(FULL).granted("close-stale", ["comment"])).toEqual(["comment"]);
  });
});

describe("checkLabelsExist", () => {
  /** The check as a thunk, which is the shape `toThrow` reads. */
  function checking(source: string, existing: readonly string[]): () => void {
    return () => {
      checkLabelsExist(warrant(source), existing);
    };
  }

  it("passes when every name is a label the repository has", () => {
    expect(checking(FULL, ["bug", "needs reproduction", "wontfix"])).not.toThrow();
  });

  it("names every missing label at once", () => {
    // Reporting the first would make fixing a three-label rename three failed
    // runs.
    expect(checking(FULL, ["wontfix"])).toThrow(/`bug`, `needs reproduction`/);
  });

  it("is case-sensitive, because GitHub applies a label by its exact name", () => {
    expect(checking(MINIMAL, ["Bug"])).toThrow(/does not have — `bug`/);
  });

  it("says `a label` for one and `labels` for several", () => {
    expect(checking(MINIMAL, [])).toThrow(/names a label this repository/);
    expect(checking(FULL, [])).toThrow(/names labels this repository/);
  });

  it("passes an empty taxonomy, which claims nothing", () => {
    expect(checking("version: 1\n", [])).not.toThrow();
  });
});
