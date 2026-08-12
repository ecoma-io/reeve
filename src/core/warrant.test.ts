import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkLabelsExist,
  checkLifecycleLabelsExist,
  implicitWarrant,
  parseWarrant,
  readWarrant,
  resolveAbout,
  resolveLanguages,
  resolvePivot,
  type Warrant,
} from "./warrant.js";

// Nothing is mocked, in the tests that read a file the ordinary way. The YAML
// parser is a library, not a collaborator, and every assertion here is about
// what this module does with what it returns. `readWarrant`'s own suite is
// the exception: absence is a filesystem fact, and a fake one would be a fact
// about a mock rather than about ENOENT.

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
      confidence: null,
      paths: [],
      create: false,
      color: null,
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

describe("confidence", () => {
  it("is null when a label writes no floor of its own", () => {
    expect(warrant(MINIMAL).labelNamed("bug")?.confidence).toBeNull();
  });

  it("reads a label's own floor", () => {
    const source = `${MINIMAL}    confidence: 0.9\n`;
    expect(warrant(source).labelNamed("bug")?.confidence).toBe(0.9);
  });

  it("accepts the boundaries, 0 and 1", () => {
    expect(warrant(`${MINIMAL}    confidence: 0\n`).labelNamed("bug")?.confidence).toBe(0);
    expect(warrant(`${MINIMAL}    confidence: 1\n`).labelNamed("bug")?.confidence).toBe(1);
  });

  it("refuses a value outside 0 through 1", () => {
    expect(() => warrant(`${MINIMAL}    confidence: 1.5\n`)).toThrow(
      /`confidence` as .+, expected a number between 0 and 1/,
    );
    expect(() => warrant(`${MINIMAL}    confidence: -0.1\n`)).toThrow(
      /expected a number between 0 and 1/,
    );
  });

  it("refuses a confidence that is not a number", () => {
    expect(() => warrant(`${MINIMAL}    confidence: "high"\n`)).toThrow(
      /`confidence` as the text `high`, expected a number between 0 and 1/,
    );
  });
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

  it("grants nothing to a duty a written block does not name, not even the fallback", () => {
    // Once a maintainer has written `capabilities:`, it is taken as the whole
    // roster of who may act. A name it forgot is refused everything, not
    // handed the default it would have kept had the block never existed.
    expect(warrant(FULL).granted("close-stale", ["comment"])).toEqual([]);
  });

  it("grants a duty its own default when the file has no capabilities block at all", () => {
    // A taxonomy-only file is a legitimate configuration and must keep
    // working exactly as it did before this distinction existed.
    expect(warrant(MINIMAL).granted("close-stale", ["comment"])).toEqual(["comment"]);
  });

  it("does not mark a duty unnamed when there is no capabilities block at all", () => {
    expect(warrant(MINIMAL).unnamed("triage")).toBe(false);
  });

  it("marks a duty unnamed when a written block exists and does not mention it", () => {
    expect(warrant(FULL).unnamed("close-stale")).toBe(true);
  });

  it("does not mark a duty unnamed when the block names it, even as `none`", () => {
    // `[none]` is a decision about the duty, not silence about it — `unnamed`
    // has to tell those two "nothing" apart even though `granted` cannot.
    const source = "version: 1\ncapabilities:\n  triage: [none]\n";
    expect(warrant(source).unnamed("triage")).toBe(false);
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });

  it("marks every duty unnamed when the block is written but empty", () => {
    // `capabilities: {}` is a block that exists and answers nothing — the
    // question was asked, and every duty is refused for want of an answer.
    const source = "version: 1\ncapabilities: {}\n";
    expect(warrant(source).unnamed("triage")).toBe(true);
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });
});

describe("languages", () => {
  it("is null when the key was never written", () => {
    // `null` is not the same fact as an empty list — this is what lets
    // `resolveLanguages` tell "the file is silent" from "the file already
    // answered".
    expect(warrant(MINIMAL).languages).toBeNull();
  });

  it("reads a bare code the same way the input's grammar does", () => {
    const source = `${MINIMAL}languages:\n  - en\n  - vi\n`;
    expect(warrant(source).languages).toEqual([
      { code: "en", label: "English", scripts: ["Latn"] },
      { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] },
    ]);
  });

  it("reads a spelled-out `code:Label:Script` entry the same way the input does", () => {
    const source = `${MINIMAL}languages:\n  - "zh-Hans:简体中文:Han"\n`;
    expect(warrant(source).languages).toEqual([
      { code: "zh-Hans", label: "简体中文", scripts: ["Han"] },
    ]);
  });

  it("refuses a `languages` key that is not a list", () => {
    const source = `${MINIMAL}languages: en\n`;
    expect(() => warrant(source)).toThrow(/`languages` as the text `en`, expected a list/);
  });

  it("refuses an entry that is not text", () => {
    const source = `${MINIMAL}languages:\n  - 3\n`;
    expect(() => warrant(source)).toThrow(/entry 1 is `3`, expected text/);
  });

  it("refuses an empty list, the same way an empty input is refused", () => {
    // A maintainer who wrote the key at all meant something by it — an empty
    // list is not read as "leave this to the input".
    const source = `${MINIMAL}languages: []\n`;
    expect(() => warrant(source)).toThrow(/no entries/);
  });

  it("refuses the key written with nothing under it, rather than consulting the input", () => {
    // `languages:` alone parses as YAML null. Reading it as absence would
    // silently hand the answer back to the input behind a key the file
    // visibly wrote — an unfinished edit read as a decision.
    const source = `${MINIMAL}languages:\n`;
    expect(() => warrant(source)).toThrow(/writes `languages:` with nothing under it/);
  });

  it("refuses an empty entry, which the input's own splitting would have dropped", () => {
    const source = `${MINIMAL}languages:\n  - en\n  - "  "\n`;
    expect(() => warrant(source)).toThrow(/entry 2 is empty/);
  });

  it("keeps a comma inside a spelled-out label, where the input would read a separator", () => {
    // A YAML element is one entry by construction — the one-line grammar's
    // comma rule has no business inside it.
    const source = `${MINIMAL}languages:\n  - "vi:Tiếng Việt, phổ thông:Latin"\n`;
    expect(warrant(source).languages).toEqual([
      { code: "vi", label: "Tiếng Việt, phổ thông", scripts: ["Latin"] },
    ]);
  });

  it("refuses a bare code the runtime knows no language by, the same as the input", () => {
    const source = `${MINIMAL}languages:\n  - qqq\n`;
    expect(() => warrant(source)).toThrow(/`qqq` is not a language code/);
  });
});

describe("resolveLanguages", () => {
  it("lets the warrant's own key win outright, with a notice naming both sources", () => {
    const source = `${MINIMAL}languages:\n  - en\n`;
    const resolution = resolveLanguages(warrant(source), "vi, zh");

    expect(resolution.languages).toEqual([{ code: "en", label: "English", scripts: ["Latn"] }]);
    expect(resolution.notice).toContain(`\`${PATH}\`'s \`languages:\` key`);
    expect(resolution.notice).toContain("not the `languages` input");
  });

  it("falls back to the input when the warrant never mentions the key", () => {
    const resolution = resolveLanguages(warrant(MINIMAL), "en, vi");

    expect(resolution.languages).toEqual([
      { code: "en", label: "English", scripts: ["Latn"] },
      { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] },
    ]);
    expect(resolution.notice).toBeNull();
  });

  it("refuses a run where neither source names a language, naming both", () => {
    const refusing = (): void => {
      resolveLanguages(warrant(MINIMAL), "  ");
    };
    expect(refusing).toThrow(`Write \`languages:\` in the warrant (\`${PATH}\`)`);
    expect(refusing).toThrow("or set the `languages` input");
  });
});

describe("pivot", () => {
  it("is null when the key was never written", () => {
    expect(warrant(MINIMAL).pivot).toBeNull();
  });

  it("reads a language code", () => {
    expect(warrant(`${MINIMAL}pivot: en\n`).pivot).toBe("en");
  });

  it("refuses the key written with nothing under it", () => {
    expect(() => warrant(`${MINIMAL}pivot:\n`)).toThrow(
      /`pivot` as empty, expected a language code/,
    );
  });

  it("refuses a pivot that is not text", () => {
    expect(() => warrant(`${MINIMAL}pivot: 3\n`)).toThrow(
      /`pivot` as .+3.+, expected a language code/,
    );
  });
});

describe("memory", () => {
  it("is null when the key was never written", () => {
    expect(warrant(MINIMAL).memory).toBeNull();
  });

  it("reads a recall count", () => {
    expect(warrant(`${MINIMAL}memory:\n  recall: 6\n`).memory).toEqual({ recall: 6 });
  });

  it("accepts 0, which turns recall off", () => {
    expect(warrant(`${MINIMAL}memory:\n  recall: 0\n`).memory).toEqual({ recall: 0 });
  });

  it("refuses a `memory` block with no `recall`", () => {
    expect(() => warrant(`${MINIMAL}memory: {}\n`)).toThrow(/`memory` has no `recall`/);
  });

  it("refuses `memory:` written with nothing under it, rather than reading it as absent", () => {
    expect(() => warrant(`${MINIMAL}memory:\n`)).toThrow(/writes `memory:` with nothing under it/);
  });

  it("refuses a `memory` key that is not a mapping", () => {
    expect(() => warrant(`${MINIMAL}memory: 4\n`)).toThrow(/`memory` as .+4.+, expected a mapping/);
  });

  it("refuses a `recall` that is not a whole number of 0 or more", () => {
    expect(() => warrant(`${MINIMAL}memory:\n  recall: -1\n`)).toThrow(
      /`memory\.recall` is .+, expected a whole number of 0 or more/,
    );
    expect(() => warrant(`${MINIMAL}memory:\n  recall: 1.5\n`)).toThrow(
      /expected a whole number of 0 or more/,
    );
  });
});

describe("about", () => {
  it("is null when the key was never written", () => {
    expect(warrant(MINIMAL).about).toBeNull();
  });

  it("reads the sentence", () => {
    expect(warrant(`${MINIMAL}about: A database export tool.\n`).about).toBe(
      "A database export tool.",
    );
  });

  it("treats a key written empty as null, the same as never writing it", () => {
    expect(warrant(`${MINIMAL}about: "   "\n`).about).toBeNull();
  });

  it("refuses an `about` that is not text", () => {
    expect(() => warrant(`${MINIMAL}about: 3\n`)).toThrow(/`about` as .+3.+, expected text/);
  });
});

describe("resolvePivot", () => {
  const EN = { code: "en", label: "English", scripts: ["Latn"] };
  const VI = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };

  it("is the first configured language when the warrant never wrote `pivot:`", () => {
    expect(resolvePivot(warrant(MINIMAL), [EN, VI])).toBe(EN);
  });

  it("lets the warrant's own `pivot:` win, case-insensitively", () => {
    expect(resolvePivot(warrant(`${MINIMAL}pivot: VI\n`), [EN, VI])).toBe(VI);
  });

  it("refuses a pivot that names a language outside the configured list", () => {
    expect(() => resolvePivot(warrant(`${MINIMAL}pivot: zh\n`), [EN, VI])).toThrow(
      /`pivot: zh` is not one of the configured languages \(en, vi\)/,
    );
  });

  it("refuses when there are no languages to pivot among, even absent", () => {
    expect(() => resolvePivot(warrant(MINIMAL), [])).toThrow(/no languages are configured/);
  });
});

describe("resolveAbout", () => {
  it("lets the warrant's own key win outright, with a notice naming both sources", () => {
    const resolution = resolveAbout(
      warrant(`${MINIMAL}about: A database export tool.\n`),
      "ignored",
    );

    expect(resolution.about).toBe("A database export tool.");
    expect(resolution.notice).toContain(`\`${PATH}\`'s \`about:\` key`);
    expect(resolution.notice).toContain("not the `about` input");
  });

  it("falls back to the input, trimmed, when the warrant never mentions the key", () => {
    const resolution = resolveAbout(warrant(MINIMAL), "  A database export tool.  ");

    expect(resolution.about).toBe("A database export tool.");
    expect(resolution.notice).toBeNull();
  });

  it("falls back to an empty string when neither source answers", () => {
    const resolution = resolveAbout(warrant(MINIMAL), "");
    expect(resolution.about).toBe("");
    expect(resolution.notice).toBeNull();
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

  it("returns a `create: true` entry instead of failing over it", () => {
    const source =
      "version: 1\nlabels:\n  - name: area:billing\n    description: Billing work.\n    create: true\n";
    const toCreate = checkLabelsExist(warrant(source), []);
    expect(toCreate.map((label) => label.name)).toEqual(["area:billing"]);
  });

  it("still fails on a missing entry without `create: true`, alongside one that has it", () => {
    const source =
      "version: 1\n" +
      "labels:\n" +
      "  - name: area:billing\n    description: Billing work.\n    create: true\n" +
      "  - name: bug\n    description: A defect.\n";
    expect(checking(source, [])).toThrow(/does not have — `bug`/);
  });

  it("does not ask the caller to create a label that already exists", () => {
    const source =
      "version: 1\nlabels:\n  - name: area:billing\n    description: Billing work.\n    create: true\n";
    expect(checkLabelsExist(warrant(source), ["area:billing"])).toEqual([]);
  });
});

describe("checkLifecycleLabelsExist", () => {
  const LIFECYCLE_SOURCE =
    "version: 1\n" +
    "lifecycle:\n" +
    "  tracks:\n" +
    "    - name: stale\n" +
    "      when: needs-info\n" +
    "      steps:\n" +
    "        - say: Ping.\n" +
    "          after: 7d\n" +
    "        - label: stale\n" +
    "          after: 14d\n" +
    "  exempt:\n" +
    "    labels: [pinned]\n";

  it("passes silently when there is no `lifecycle:` policy at all", () => {
    expect(() => {
      checkLifecycleLabelsExist(warrant(MINIMAL), []);
    }).not.toThrow();
  });

  it("passes when every label the policy names exists", () => {
    expect(() => {
      checkLifecycleLabelsExist(warrant(LIFECYCLE_SOURCE), ["needs-info", "stale", "pinned"]);
    }).not.toThrow();
  });

  it("fails, naming every missing label the policy refers to at once", () => {
    expect(() => {
      checkLifecycleLabelsExist(warrant(LIFECYCLE_SOURCE), []);
    }).toThrow(/`needs-info`, `stale`, `pinned`/);
  });

  it("is red on a missing clock-hand label even though it need not be a taxonomy entry", () => {
    expect(() => {
      checkLifecycleLabelsExist(warrant(LIFECYCLE_SOURCE), ["pinned"]);
    }).toThrow(/does not have/);
  });
});

describe("readPropose", () => {
  it("takes the design's own defaults when `propose:` is never written", () => {
    const found = warrant(MINIMAL).propose;
    expect(found).toEqual({
      name: "area:{package}",
      except: [],
      evidence: 3,
      window: 90 * 24 * 60 * 60 * 1000,
      retire: false,
    });
  });

  it("takes the defaults when `propose:` is written without a `workspace:` sub-key", () => {
    const found = warrant("version: 1\npropose: {}\n").propose;
    expect(found.name).toBe("area:{package}");
  });

  it("reads every knob under `propose.workspace`", () => {
    const source =
      "version: 1\n" +
      "propose:\n" +
      "  workspace:\n" +
      "    name: team:{package}\n" +
      "    except: [internal-*]\n" +
      "    evidence: 5\n" +
      "    window: 30d\n" +
      "    retire: true\n";
    expect(warrant(source).propose).toEqual({
      name: "team:{package}",
      except: ["internal-*"],
      evidence: 5,
      window: 30 * 24 * 60 * 60 * 1000,
      retire: true,
    });
  });

  it("refuses a `name` template with no `{package}` placeholder", () => {
    const source = "version: 1\npropose:\n  workspace:\n    name: area\n";
    expect(() => warrant(source)).toThrow(/exactly one `\{package\}` placeholder/);
  });

  it("refuses a `name` template with more than one `{package}` placeholder", () => {
    const source = "version: 1\npropose:\n  workspace:\n    name: area:{package}:{package}\n";
    expect(() => warrant(source)).toThrow(/exactly one `\{package\}` placeholder/);
  });

  it("refuses `propose:` written with nothing under it", () => {
    expect(() => warrant("version: 1\npropose:\n")).toThrow(/nothing under it/);
  });

  it("refuses `propose.workspace` that is not a mapping", () => {
    expect(() => warrant("version: 1\npropose:\n  workspace: nope\n")).toThrow(
      /expected a mapping/,
    );
  });
});

describe("readWarrant", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "reeve-warrant-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("runs at the narrowest authority when the default path is simply absent", async () => {
    // Deleting the warrant still withdraws everything a written one would
    // have granted — the implicit authority is narrower than any file grants
    // — so this is `null`, not an error.
    const path = join(scratch, "reeve.yml");
    await expect(readWarrant(path, { defaultPath: path })).resolves.toBeNull();
  });

  it("fails red when a path a consumer chose is the one that is missing", async () => {
    // They named a file that is not there, which is a configuration mistake
    // rather than a silence the default path gets the benefit of.
    const path = join(scratch, "reeve.yml");
    await expect(
      readWarrant(path, { defaultPath: join(scratch, "elsewhere.yml") }),
    ).rejects.toThrow(/this run has no authority/);
  });

  it("fails red on a read error that is not simple absence, even at the default path", async () => {
    // A directory where a file was expected cannot have been "not read yet" —
    // it was read, and it was not a warrant — so the default path earns it no
    // special treatment.
    const path = join(scratch, "reeve.yml");
    await mkdir(path);
    await expect(readWarrant(path, { defaultPath: path })).rejects.toThrow(
      /this run has no authority/,
    );
  });

  it("reads and parses a warrant that exists at the default path", async () => {
    const path = join(scratch, "reeve.yml");
    await writeFile(path, MINIMAL);
    const found = await readWarrant(path, { defaultPath: path });
    expect(found?.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  it("still fails on a warrant that exists at the default path but does not parse", async () => {
    // Absence cannot be misread; a file that is there and wrong still can be.
    const path = join(scratch, "reeve.yml");
    await writeFile(path, "version: 2\nlabels: []\n");
    await expect(readWarrant(path, { defaultPath: path })).rejects.toThrow(/declares version `2`/);
  });
});

describe("implicitWarrant", () => {
  it("builds a taxonomy from the repository's own label descriptions", () => {
    const { warrant, excluded } = implicitWarrant(PATH, [
      { name: "bug", description: "Something broke." },
      { name: "docs", description: "The documentation is wrong." },
    ]);

    expect(warrant.labels).toEqual([
      {
        name: "bug",
        description: "Something broke.",
        not: null,
        examples: [],
        owner: null,
        exclusiveWith: [],
        confidence: null,
        paths: [],
        create: false,
        color: null,
      },
      {
        name: "docs",
        description: "The documentation is wrong.",
        not: null,
        examples: [],
        owner: null,
        exclusiveWith: [],
        confidence: null,
        paths: [],
        create: false,
        color: null,
      },
    ]);
    expect(excluded).toEqual([]);
  });

  it("excludes a label with no description on GitHub, and reports which ones", () => {
    // A name alone gives a model nothing to match a thread against honestly.
    const { warrant, excluded } = implicitWarrant(PATH, [
      { name: "bug", description: "Something broke." },
      { name: "triage", description: null },
      { name: "blank", description: "   " },
    ]);

    expect(warrant.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(excluded).toEqual(["triage", "blank"]);
  });

  it("grants a duty its own fallback, since no capabilities block was ever written", () => {
    const { warrant } = implicitWarrant(PATH, []);
    expect(warrant.granted("triage", ["label"])).toEqual(["label"]);
    expect(warrant.unnamed("triage")).toBe(false);
  });

  it("finds a label by its exact name, the same as a written warrant would", () => {
    const { warrant } = implicitWarrant(PATH, [{ name: "bug", description: "Something broke." }]);
    expect(warrant.labelNamed("bug")?.description).toBe("Something broke.");
    expect(warrant.labelNamed("missing")).toBeUndefined();
  });
});
