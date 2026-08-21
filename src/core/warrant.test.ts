import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "./forge.js";
import {
  checkLabelsExist,
  checkLifecycleLabelsExist,
  dutyLanguages,
  implicitWarrant,
  openAuthority,
  parseWarrant,
  pivotOrNone,
  readWarrant,
  resolveAbout,
  resolveLanguages,
  DEFAULT_WARRANT_PATH,
  type Warrant,
} from "./warrant.js";
import { parseLanguages } from "./languages.js";

// Nothing is mocked, in the tests that read a file the ordinary way. The YAML
// parser is a library, not a collaborator, and every assertion here is about
// what this module does with what it returns. `readWarrant`'s own suite is
// the exception: absence is a filesystem fact, and a fake one would be a fact
// about a mock rather than about ENOENT.
//
// `core.notice` is the other exception: it is an effect on the runner rather
// than a value, and whether a run says something once is exactly what
// `dutyLanguages` is responsible for.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  notice: vi.fn(),
}));

const PATH = ".github/reeve.yml";

/** The repository every authority here is resolved against. */
const AT = { owner: "ecoma-io", repo: "reeve" };

const FULL = `
version: 1

duties:
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

  it("refuses an unrecognized root key rather than silently ignoring a typo", () => {
    expect(() => warrant(`${MINIMAL}capabilites:\n  triage: [label]\n`)).toThrow(
      /unrecognized key `capabilites`/,
    );
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
    // A repository that wrote a warrant only to configure duties is a
    // configuration, not a mistake. The duty that needs a taxonomy says so.
    expect(warrant("version: 1\nduties:\n  triage: [label]\n").labels).toEqual([]);
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

  it("refuses an unrecognized label key rather than silently ignoring a typo", () => {
    expect(() =>
      warrant(
        "version: 1\nlabels:\n  - name: bug\n    description: A defect.\n    confidnce: 0.9\n",
      ),
    ).toThrow(/unrecognized key `confidnce`/);
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

describe("duties", () => {
  it("reads what a duty was granted", () => {
    expect(warrant(FULL).granted("triage", ["label"])).toEqual(["label", "comment"]);
  });

  it("falls back to the duty's own default when the file says nothing", () => {
    // The default belongs to the duty: only `triage` knows its cheapest
    // reversible action is a label.
    expect(warrant(MINIMAL).granted("triage", ["label"])).toEqual(["label"]);
  });

  it("expands an explicit `duties: { triage: true }` to that same documented default", () => {
    // `true` is the sentinel that spells "this duty's own default" out — the
    // two forms (`true` and the bare absent key) must agree, so a maintainer
    // can write either and get the same grant.
    const source = "version: 1\nduties:\n  triage: true\n";
    expect(warrant(source).granted("triage", ["label"])).toEqual(["label"]);
    expect(warrant(source).unnamed("triage")).toBe(false);
  });

  it("distinguishes an explicit `none` from an absent entry", () => {
    const source = `version: 1\nduties:\n  triage: [none]\n`;
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });

  it("drops a repeated capability rather than granting it twice", () => {
    const source = `version: 1\nduties:\n  triage: [label, label]\n`;
    expect(warrant(source).granted("triage", [])).toEqual(["label"]);
  });

  it("refuses a misspelling rather than silently granting nothing", () => {
    // A silently ignored `lablel` is a bug a maintainer discovers months later
    // as an absence, which is the hardest kind to notice.
    const source = `version: 1\nduties:\n  triage: [lablel]\n`;
    expect(() => warrant(source)).toThrow(/names `lablel`, which is not something a duty/);
  });

  it("refuses an unknown duty rather than silently creating a dead grant", () => {
    const source = `version: 1\nduties:\n  traige: [label]\n`;
    expect(() => warrant(source)).toThrow(/names `traige`, which is not a known duty/);
  });

  it("refuses an empty list, which is what a half-finished edit leaves behind", () => {
    const source = `version: 1\nduties:\n  triage: []\n`;
    expect(() => warrant(source)).toThrow(/is empty\. Use `\[none\]`/);
  });

  it("refuses `none` mixed with a real capability, which says two things at once", () => {
    const source = `version: 1\nduties:\n  triage: [none, label]\n`;
    expect(() => warrant(source)).toThrow(/names `none`/);
  });

  it("refuses a duties block that is not a mapping", () => {
    expect(() => warrant("version: 1\nduties: [label]\n")).toThrow(/`duties` as a list/);
  });

  it("grants nothing to a duty a written block does not name, not even the fallback", () => {
    // Once a maintainer has written `duties:`, it is taken as the whole
    // roster of who may act. A name it forgot is refused everything, not
    // handed the default it would have kept had the block never existed.
    expect(warrant(FULL).granted("close-stale", ["comment"])).toEqual([]);
  });

  it("grants a duty its own default when the file has no duties block at all", () => {
    // A taxonomy-only file is a legitimate configuration and must keep
    // working exactly as it did before this distinction existed.
    expect(warrant(MINIMAL).granted("close-stale", ["comment"])).toEqual(["comment"]);
  });

  it("does not mark a duty unnamed when there is no duties block at all", () => {
    expect(warrant(MINIMAL).unnamed("triage")).toBe(false);
  });

  it("marks a duty unnamed when a written block exists and does not mention it", () => {
    expect(warrant(FULL).unnamed("close-stale")).toBe(true);
  });

  it("does not mark a duty unnamed when the block names it, even as `none`", () => {
    // `[none]` is a decision about the duty, not silence about it — `unnamed`
    // has to tell those two "nothing" apart even though `granted` cannot.
    const source = "version: 1\nduties:\n  triage: [none]\n";
    expect(warrant(source).unnamed("triage")).toBe(false);
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });

  it("marks every duty unnamed when the block is written but empty", () => {
    // `duties: {}` is a block that exists and answers nothing — the
    // question was asked, and every duty is refused for want of an answer.
    const source = "version: 1\nduties: {}\n";
    expect(warrant(source).unnamed("triage")).toBe(true);
    expect(warrant(source).granted("triage", ["label"])).toEqual([]);
  });

  it("refuses a bare `duties:` key, which is a half-finished edit rather than a decision", () => {
    // YAML reads a key with nothing under it as `null`, and every sibling key
    // refuses that same shape — `languages:`, `memory:`, `lifecycle:`,
    // `pivot:`. Reading it as "no block at all" would silently keep the
    // widest default while the maintainer believed they had started writing
    // a restriction.
    expect(() => warrant("version: 1\nduties:\n")).toThrow(
      /writes `duties:` with nothing under it/,
    );
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
  it("lets the warrant's own key win outright, with a notice naming the file", () => {
    const source = `${MINIMAL}languages:\n  - en\n`;
    const fallback = parseLanguages("vi, zh");
    const resolution = resolveLanguages(warrant(source), fallback);

    expect(resolution.languages).toEqual([{ code: "en", label: "English", scripts: ["Latn"] }]);
    expect(resolution.notice).toContain(`\`${PATH}\`'s \`languages:\` key`);
    expect(resolution.notice).toContain("the file is the whole answer");
  });

  it("falls back to the duty's own default when the warrant never mentions the key", () => {
    const fallback = parseLanguages("en, vi");
    const resolution = resolveLanguages(warrant(MINIMAL), fallback);

    expect(resolution.languages).toEqual([
      { code: "en", label: "English", scripts: ["Latn"] },
      { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] },
    ]);
    expect(resolution.notice).toBeNull();
  });
});

describe("dutyLanguages", () => {
  beforeEach(() => {
    vi.mocked(core.notice).mockClear();
  });

  it("resolves against the warrant and says once when the warrant's key won", () => {
    const languages = dutyLanguages(
      warrant(`${MINIMAL}languages:\n  - en\n`),
      false,
      parseLanguages("vi, zh"),
    );

    expect(languages).toEqual([{ code: "en", label: "English", scripts: ["Latn"] }]);
    expect(vi.mocked(core.notice)).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the duty's own default answered and there was nothing to explain", () => {
    expect(dutyLanguages(warrant(MINIMAL), false, parseLanguages("en"))).toHaveLength(1);
    expect(vi.mocked(core.notice)).not.toHaveBeenCalled();
  });

  it("answers a denied duty with no languages rather than resolving at all", () => {
    // The point of the guard: a granted duty would read its own default and a
    // run promised a green no-op has no business spending anything on resolving
    // a languages nobody configured for it.
    expect(dutyLanguages(warrant(MINIMAL), true, parseLanguages("en, vi"))).toEqual([]);
    expect(vi.mocked(core.notice)).not.toHaveBeenCalled();
  });
});

describe("openAuthority", () => {
  let scratch: string;
  let cwd: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "reeve-open-"));
    // `openAuthority` names `DEFAULT_WARRANT_PATH` itself — that is the point
    // of it — so the only way to put a run at that path, or to leave it
    // genuinely absent, is to run from a directory of this suite's own.
    cwd = process.cwd();
    process.chdir(scratch);
    await mkdir(".github");
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(scratch, { recursive: true, force: true });
  });

  /** A `TrackerApi` answering the repository's own labels — page two ends the walk. */
  function labelsApi(names: readonly string[]): TrackerApi {
    return {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(({ page }: { page?: number }) =>
            Promise.resolve({
              data: (page ?? 1) === 1 ? names.map((name) => ({ name, description: "d" })) : [],
            }),
          ),
        },
      },
    } as unknown as TrackerApi;
  }

  it("reads a written warrant, and never asks the forge for labels", async () => {
    await writeFile(DEFAULT_WARRANT_PATH, `${MINIMAL}duties:\n  triage: [label]\n`);
    const api = labelsApi(["bug"]);

    const opened = await openAuthority(DEFAULT_WARRANT_PATH, api, AT, "triage");

    expect(opened.authority.implicit).toBe(false);
    expect(opened.denied).toBe(false);
    expect(vi.mocked(api.rest.issues.listLabelsForRepo)).not.toHaveBeenCalled();
  });

  it("reports a duty a written `duties:` block never named as denied", async () => {
    // The block is the total enumeration, so silence about `translate` is a
    // refusal rather than an omission — and deciding it here, once, is what
    // lets a run spend nothing on a duty it was never granted.
    await writeFile(DEFAULT_WARRANT_PATH, `${MINIMAL}duties:\n  triage: [label]\n`);

    const opened = await openAuthority(DEFAULT_WARRANT_PATH, labelsApi(["bug"]), AT, "translate");

    expect(opened.denied).toBe(true);
  });

  it("builds the implicit warrant from repository labels when the default path is absent", async () => {
    // Absence at the path nobody moved it from is the narrowest authority,
    // not an error — and the labels listing is the only place that authority
    // can come from.
    const opened = await openAuthority(
      DEFAULT_WARRANT_PATH,
      labelsApi(["bug", "docs"]),
      AT,
      "triage",
    );

    expect(opened.authority.implicit).toBe(true);
    expect(opened.authority.warrant.labels.map((label) => label.name)).toEqual(["bug", "docs"]);
  });

  it("fails red when the path a consumer chose is the one that is missing", async () => {
    // `DEFAULT_WARRANT_PATH` is what tells the two apart, and this proves the
    // helper passes it rather than treating every absence as the implicit one.
    await expect(
      openAuthority(".github/elsewhere.yml", labelsApi([]), AT, "triage"),
    ).rejects.toThrow(/this run has no authority/);
  });

  it("names the default path every duty's `action.yml` defaults to", () => {
    expect(DEFAULT_WARRANT_PATH).toBe(".github/reeve.yml");
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

describe("pivotOrNone", () => {
  const EN = { code: "en", label: "English", scripts: ["Latn"] };
  const VI = { code: "vi", label: "Tiếng Việt", scripts: ["Latn"] };

  it("is the first configured language when the warrant never wrote `pivot:`", () => {
    expect(pivotOrNone(warrant(MINIMAL), [EN, VI])).toBe(EN);
  });

  it("lets the warrant's own `pivot:` win, case-insensitively", () => {
    expect(pivotOrNone(warrant(`${MINIMAL}pivot: VI\n`), [EN, VI])).toBe(VI);
  });

  it("refuses a pivot that names a language outside the configured list", () => {
    expect(() => pivotOrNone(warrant(`${MINIMAL}pivot: zh\n`), [EN, VI])).toThrow(
      /`pivot: zh` is not one of the configured languages \(en, vi\)/,
    );
  });

  it("lets the warrant's pivot win when there is a list to choose from", () => {
    expect(pivotOrNone(warrant(`${MINIMAL}pivot: vi\n`), [EN, VI])).toBe(VI);
  });

  it("reads an empty list as nothing to bridge, rather than as a fault", () => {
    // A single-language project recalls in its own language and never spends
    // a request on a translation — that is not a misconfiguration to refuse.
    expect(pivotOrNone(warrant(MINIMAL), [])).toBeNull();
  });

  it("still refuses a `pivot:` that names a language outside the list", () => {
    // The leniency is about the empty list only. A pivot nothing translates
    // into or out of is still a warrant that cannot mean what it says.
    expect(() => pivotOrNone(warrant(`${MINIMAL}pivot: zh\n`), [EN, VI])).toThrow(
      /`pivot: zh` is not one of the configured languages/,
    );
  });
});

describe("resolveAbout", () => {
  beforeEach(() => {
    vi.mocked(core.notice).mockClear();
  });

  it("lets the warrant's own key win outright, and says once which source answered", () => {
    const about = resolveAbout(warrant(`${MINIMAL}about: A database export tool.\n`), "ignored");

    expect(about).toBe("A database export tool.");
    expect(vi.mocked(core.notice)).toHaveBeenCalledTimes(1);
    const [said] = vi.mocked(core.notice).mock.calls[0] ?? [];
    expect(said).toContain(`\`${PATH}\`'s \`about:\` key`);
    expect(said).toContain("not the `about` input");
  });

  it("falls back to the input, trimmed, when the warrant never mentions the key", () => {
    expect(resolveAbout(warrant(MINIMAL), "  A database export tool.  ")).toBe(
      "A database export tool.",
    );
    expect(vi.mocked(core.notice)).not.toHaveBeenCalled();
  });

  it("falls back to an empty string when neither source answers, and says nothing", () => {
    expect(resolveAbout(warrant(MINIMAL), "")).toBe("");
    expect(vi.mocked(core.notice)).not.toHaveBeenCalled();
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

describe("readLifecycle", () => {
  const BASE =
    "version: 1\n" +
    "lifecycle:\n" +
    "  tracks:\n" +
    "    - name: stale\n" +
    "      steps:\n" +
    "        - label: stale\n" +
    "          after: 14d\n";

  it("is null when `lifecycle:` is never written", () => {
    expect(warrant(MINIMAL).lifecycle).toBeNull();
  });

  it("refuses `lifecycle:` written with nothing under it", () => {
    expect(() => warrant("version: 1\nlifecycle:\n")).toThrow(/nothing under it/);
  });

  it("refuses `lifecycle:` that is not a mapping", () => {
    expect(() => warrant("version: 1\nlifecycle: nope\n")).toThrow(/expected a mapping/);
  });

  it("refuses an unrecognized key on the `lifecycle:` block itself", () => {
    expect(() => warrant(`${BASE}  wehn: oops\n`)).toThrow(/unrecognized key `wehn`/);
  });

  it("defaults `threads:` to `issues`", () => {
    expect(warrant(BASE).lifecycle?.threads).toBe("issues");
  });

  it("reads `threads: prs` and `threads: both`", () => {
    expect(warrant(`${BASE}  threads: prs\n`).lifecycle?.threads).toBe("prs");
    expect(warrant(`${BASE}  threads: both\n`).lifecycle?.threads).toBe("both");
  });

  it("refuses a `threads:` value that is none of `issues`, `prs`, `both`", () => {
    expect(() => warrant(`${BASE}  threads: everything\n`)).toThrow(
      /expected `issues`, `prs`, or `both`/,
    );
  });

  it("requires at least one track", () => {
    expect(() => warrant("version: 1\nlifecycle:\n  tracks: []\n")).toThrow(/no `tracks`/);
  });

  it("refuses an unrecognized key on a track entry", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      wehn: needs-info\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n";
    expect(() => warrant(source)).toThrow(/unrecognized key `wehn`/);
  });

  it("names a track lowercase-hyphenated only", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: Stale Track\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n";
    expect(() => warrant(source)).toThrow(/expected lowercase letters/);
  });

  it("refuses two tracks with the same name", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - label: other\n" +
      "          after: 7d\n";
    expect(() => warrant(source)).toThrow(/names `stale` more than once/);
  });

  it("requires at least one step per track", () => {
    const source = "version: 1\nlifecycle:\n  tracks:\n    - name: stale\n      steps: []\n";
    expect(() => warrant(source)).toThrow(/no `steps`/);
  });

  it("defaults `resets` to `author` for a `when:` track and `any` for an inactivity track", () => {
    const whenSource =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n";
    expect(warrant(whenSource).lifecycle?.tracks[0]?.resets).toBe("author");
    expect(warrant(BASE).lifecycle?.tracks[0]?.resets).toBe("any");
  });

  it("reads an explicit `resets:` over the shape-based default", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      resets: author\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n";
    expect(warrant(source).lifecycle?.tracks[0]?.resets).toBe("author");
  });

  it("refuses a `resets:` that is neither `author` nor `any`", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      resets: everyone\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n";
    expect(() => warrant(source)).toThrow(/expected `author` or `any`/);
  });

  it("refuses an inactivity track whose first step closes", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - close: true\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(() => warrant(source)).toThrow(/first step closes/);
  });

  it("allows a `when:` track whose first step closes — the label application was the warning", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - close: true\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(() => warrant(source)).not.toThrow();
  });

  it("refuses `close` on a step that is not the track's last", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - close: true\n" +
      "          after: 7d\n" +
      "        - label: stale\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(() => warrant(source)).toThrow(/close must be the/);
  });

  it("reads `close: not_planned` as the same decision as `close: true`", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - close: not_planned\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(warrant(source).lifecycle?.tracks[0]?.steps[0]?.close).toBe(true);
  });

  it("refuses `close: completed` by name, because nothing Reeve closes was completed by it closing", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - close: completed\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(() => warrant(source)).toThrow(/closes only as `not_planned`/);
  });

  it("refuses a `close:` that is none of the accepted spellings", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - close: someday\n" +
      "          after: 14d\n" +
      "  exempt:\n" +
      "    labels: [pinned]\n";
    expect(() => warrant(source)).toThrow(/expected true or false/);
  });

  it("refuses a step carrying none of `label`, `say`, `close`", () => {
    const source =
      "version: 1\nlifecycle:\n  tracks:\n    - name: stale\n      steps:\n        - after: 14d\n";
    expect(() => warrant(source)).toThrow(/a step must do something/);
  });

  it("refuses `after: 0d` — not a duration", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 0d\n";
    expect(() => warrant(source)).toThrow(/0d.*not a duration/);
  });

  it("refuses an unrecognized key on a step", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: stale\n" +
      "      steps:\n" +
      "        - label: stale\n" +
      "          after: 14d\n" +
      "          sya: true\n";
    expect(() => warrant(source)).toThrow(/unrecognized key `sya`/);
  });

  it("requires `exempt.labels` non-empty before a `close` step may be configured at all", () => {
    const source =
      "version: 1\n" +
      "lifecycle:\n" +
      "  tracks:\n" +
      "    - name: reminder\n" +
      "      when: needs-info\n" +
      "      steps:\n" +
      "        - close: true\n" +
      "          after: 14d\n";
    expect(() => warrant(source)).toThrow(/permanent escape hatch must exist/);
  });

  it("defaults every `exempt` layer, plus `drafts`, when `exempt:` is absent", () => {
    expect(warrant(BASE).lifecycle?.exempt).toEqual({
      labels: [],
      milestones: true,
      assignees: true,
      taxonomy: true,
      comments: null,
      drafts: true,
    });
  });

  it("reads an explicit `exempt:` block", () => {
    const source =
      BASE +
      "  exempt:\n" +
      "    labels: [pinned]\n" +
      "    milestones: false\n" +
      "    assignees: [carol]\n" +
      "    taxonomy: false\n" +
      "    comments: 2\n" +
      "    drafts: false\n";
    expect(warrant(source).lifecycle?.exempt).toEqual({
      labels: ["pinned"],
      milestones: false,
      assignees: ["carol"],
      taxonomy: false,
      comments: 2,
      drafts: false,
    });
  });

  it("refuses an unrecognized key on `lifecycle.exempt`", () => {
    const source = `${BASE}  exempt:\n    exmept: [pinned]\n`;
    expect(() => warrant(source)).toThrow(/unrecognized key `exmept`/);
  });

  it("reads `lifecycle.overrides`, both the `after` and `never` shapes", () => {
    const source =
      BASE +
      "  overrides:\n" +
      "    - label: pinned\n" +
      "      never: true\n" +
      "    - label: low-priority\n" +
      "      after: 30d\n";
    expect(warrant(source).lifecycle?.overrides).toEqual([
      { label: "pinned", after: null, never: true },
      { label: "low-priority", after: 30 * 24 * 60 * 60 * 1000, never: false },
    ]);
  });

  it("refuses an override with both `after` and `never`", () => {
    const source = `${BASE}  overrides:\n    - label: pinned\n      after: 30d\n      never: true\n`;
    expect(() => warrant(source)).toThrow(/has both `after` and `never`/);
  });

  it("refuses an override with neither `after` nor `never`", () => {
    const source = `${BASE}  overrides:\n    - label: pinned\n`;
    expect(() => warrant(source)).toThrow(/has neither `after` nor `never`/);
  });

  it("refuses an unrecognized key on an override entry", () => {
    const source = `${BASE}  overrides:\n    - label: pinned\n      never: true\n      afetr: 1d\n`;
    expect(() => warrant(source)).toThrow(/unrecognized key `afetr`/);
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

  it("refuses an unrecognized key on `propose:` itself", () => {
    expect(() => warrant("version: 1\npropose:\n  wokrspace: {}\n")).toThrow(
      /unrecognized key `wokrspace`/,
    );
  });

  it("refuses an unrecognized key under `propose.workspace`", () => {
    const source = "version: 1\npropose:\n  workspace:\n    evidnce: 5\n";
    expect(() => warrant(source)).toThrow(/unrecognized key `evidnce`/);
  });

  it("refuses `evidence: 0` — a floor of zero is no floor", () => {
    const source = "version: 1\npropose:\n  workspace:\n    evidence: 0\n";
    expect(() => warrant(source)).toThrow(/expected a whole number of 1 or more/);
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

  it("grants a duty its own fallback, since no duties block was ever written", () => {
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

describe("readDependa", () => {
  it("is null when `dependa:` is never written", () => {
    expect(warrant(MINIMAL).dependa).toBeNull();
  });

  it("refuses `dependa:` written with nothing under it", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n`)).toThrow(
      /writes `dependa:` with nothing under it/,
    );
  });

  it("refuses `dependa:` that is not a mapping", () => {
    expect(() => warrant(`${MINIMAL}dependa: [patch]\n`)).toThrow(
      /`dependa` as a list, expected a mapping/,
    );
    expect(() => warrant(`${MINIMAL}dependa: 3\n`)).toThrow(/`dependa` as `3`, expected a mapping/);
  });

  it("refuses an unrecognized key on the `dependa:` block", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  tpyes: [patch]\n`)).toThrow(
      /unrecognized key `tpyes`/,
    );
  });

  it("takes every default when `dependa:` is written as an empty mapping", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.ecosystems).toEqual([]);
    expect(policy.allowedTypes).toEqual([
      "patch",
      "minor",
      "pin",
      "digest",
      "rollback",
      "security",
    ]);
    expect(policy.ignore).toEqual([]);
    expect(policy.grouping).toBe("by-ecosystem");
    expect(policy.securitySeparate).toBe(true);
    expect(policy.autoApprove).toBe("minor");
    expect(policy.autoClose).toBe(false);
    expect(policy.autoRebase).toBe(true);
    expect(policy.schedule).toBeNull();
  });

  // ── ecosystems ───────────────────────────────────────────────────────

  it("reads the ecosystems list", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  ecosystems: [npm, cargo]\n`).dependa!;
    expect(policy.ecosystems).toEqual(["npm", "cargo"]);
  });

  it("deduplicates ecosystem entries", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  ecosystems: [npm, npm]\n`).dependa!;
    expect(policy.ecosystems).toEqual(["npm"]);
  });

  it("refuses an unknown ecosystem name", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  ecosystems: [pip]\n`)).toThrow(
      /`pip`, which is not a known ecosystem/,
    );
  });

  it("defaults to an empty list when `ecosystems:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.ecosystems).toEqual([]);
  });

  // ── allowed-types ────────────────────────────────────────────────────

  it("reads the allowed-types list", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  allowed-types: [patch, minor]\n`).dependa!;
    expect(policy.allowedTypes).toEqual(["patch", "minor"]);
  });

  it("defaults to all non-major types when `allowed-types:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.allowedTypes).toEqual([
      "patch",
      "minor",
      "pin",
      "digest",
      "rollback",
      "security",
    ]);
    expect(policy.allowedTypes).not.toContain("major");
  });

  it("refuses an empty `allowed-types:` list", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  allowed-types: []\n`)).toThrow(
      /`dependa\.allowed-types` is empty/,
    );
  });

  it("refuses an unknown update type", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  allowed-types: [mega]\n`)).toThrow(
      /`mega`, which is not a known update type/,
    );
  });

  it("deduplicates allowed-types entries", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  allowed-types: [patch, patch]\n`).dependa!;
    expect(policy.allowedTypes).toEqual(["patch"]);
  });

  it("allows major when explicitly listed", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  allowed-types: [major, patch]\n`).dependa!;
    expect(policy.allowedTypes).toContain("major");
  });

  // ── ignore ───────────────────────────────────────────────────────────

  it("reads ignore rules with name, ecosystem, and types", () => {
    const policy = warrant(
      `${MINIMAL}dependa:\n  ignore:\n    - name: "@types/*"\n      ecosystem: npm\n      types: [major]\n`,
    ).dependa!;
    expect(policy.ignore).toEqual([{ name: "@types/*", ecosystem: "npm", types: ["major"] }]);
  });

  it("defaults ecosystem and types on an ignore rule", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  ignore:\n    - name: lodash\n`).dependa!;
    expect(policy.ignore).toEqual([{ name: "lodash", ecosystem: null, types: [] }]);
  });

  it("reads multiple ignore rules", () => {
    const policy = warrant(
      `${MINIMAL}dependa:\n  ignore:\n    - name: lodash\n    - name: eslint\n      ecosystem: npm\n`,
    ).dependa!;
    expect(policy.ignore).toHaveLength(2);
  });

  it("defaults to an empty list when `ignore:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.ignore).toEqual([]);
  });

  it("refuses `ignore:` that is not a list", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  ignore: lodash\n`)).toThrow(
      /`dependa\.ignore` is the text `lodash`, expected a list/,
    );
  });

  it("refuses an ignore entry without a `name`", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  ignore:\n    - ecosystem: npm\n`)).toThrow(
      /has no `name`/,
    );
  });

  it("refuses an unknown ecosystem in an ignore rule", () => {
    expect(() =>
      warrant(`${MINIMAL}dependa:\n  ignore:\n    - name: lodash\n      ecosystem: pip\n`),
    ).toThrow(/not a known ecosystem/);
  });

  it("refuses an unknown update type in an ignore rule", () => {
    expect(() =>
      warrant(`${MINIMAL}dependa:\n  ignore:\n    - name: lodash\n      types: [mega]\n`),
    ).toThrow(/not a known update type/);
  });

  it("refuses an ignore entry that is not a mapping", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  ignore:\n    - lodash\n`)).toThrow(
      /expected a mapping/,
    );
  });

  it("refuses an unrecognized key on an ignore entry", () => {
    expect(() =>
      warrant(`${MINIMAL}dependa:\n  ignore:\n    - name: lodash\n      ecosystm: npm\n`),
    ).toThrow(/unrecognized key `ecosystm`/);
  });

  // ── grouping ─────────────────────────────────────────────────────────

  it("defaults to `by-ecosystem` when `grouping:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.grouping).toBe("by-ecosystem");
  });

  it.each(["by-ecosystem", "by-package", "single"] as const)("accepts `%s`", (grouping) => {
    const policy = warrant(`${MINIMAL}dependa:\n  grouping: ${grouping}\n`).dependa!;
    expect(policy.grouping).toBe(grouping);
  });

  it("refuses an unknown grouping value", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  grouping: by-name\n`)).toThrow(
      /expected `by-ecosystem`, `by-package`, or `single`/,
    );
  });

  // ── auto-approve ─────────────────────────────────────────────────────

  it("defaults to `minor` when `auto-approve:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.autoApprove).toBe("minor");
  });

  it.each(["patch", "minor", "major"] as const)("accepts a known update type `%s`", (ut) => {
    const policy = warrant(`${MINIMAL}dependa:\n  auto-approve: ${ut}\n`).dependa!;
    expect(policy.autoApprove).toBe(ut);
  });

  it('accepts `"none"` to disable auto-approve', () => {
    const policy = warrant(`${MINIMAL}dependa:\n  auto-approve: none\n`).dependa!;
    expect(policy.autoApprove).toBe("none");
  });

  it("refuses an unknown auto-approve value", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  auto-approve: always\n`)).toThrow(
      /expected an update type or `none`/,
    );
  });

  // ── security-separate ────────────────────────────────────────────────

  it("defaults security-separate to true", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.securitySeparate).toBe(true);
  });

  it("reads an explicit `security-separate: false`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  security-separate: false\n`).dependa!;
    expect(policy.securitySeparate).toBe(false);
  });

  // ── auto-close ───────────────────────────────────────────────────────

  it("defaults auto-close to false", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.autoClose).toBe(false);
  });

  it("reads an explicit `auto-close: true`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  auto-close: true\n`).dependa!;
    expect(policy.autoClose).toBe(true);
  });

  // ── auto-rebase ──────────────────────────────────────────────────────

  it("defaults auto-rebase to true", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.autoRebase).toBe(true);
  });

  it("reads an explicit `auto-rebase: false`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  auto-rebase: false\n`).dependa!;
    expect(policy.autoRebase).toBe(false);
  });

  // ── schedule ─────────────────────────────────────────────────────────

  it("defaults to null when `schedule:` is absent", () => {
    const policy = warrant(`${MINIMAL}dependa: {}\n`).dependa!;
    expect(policy.schedule).toBeNull();
  });

  it("reads an interval shorthand like `7d`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  schedule: 7d\n`).dependa!;
    expect(policy.schedule).toEqual({ kind: "interval", days: 7 });
  });

  it("reads a longer interval shorthand like `30d`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  schedule: 30d\n`).dependa!;
    expect(policy.schedule).toEqual({ kind: "interval", days: 30 });
  });

  it("refuses `0d` as a schedule — not a duration", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule: 0d\n`)).toThrow(
      /`dependa\.schedule: 0d` is not a schedule/,
    );
  });

  it("reads a cron expression as a string", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  schedule: "0 3 * * 1"\n`).dependa!;
    expect(policy.schedule).toEqual({ kind: "cron", expression: "0 3 * * 1" });
  });

  it("reads a schedule as a mapping with `interval`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  schedule:\n    interval: 14\n`).dependa!;
    expect(policy.schedule).toEqual({ kind: "interval", days: 14 });
  });

  it("reads a schedule as a mapping with `cron`", () => {
    const policy = warrant(`${MINIMAL}dependa:\n  schedule:\n    cron: "0 6 * * 1-5"\n`).dependa!;
    expect(policy.schedule).toEqual({ kind: "cron", expression: "0 6 * * 1-5" });
  });

  it("refuses a schedule mapping with both `interval` and `cron`", () => {
    expect(() =>
      warrant(`${MINIMAL}dependa:\n  schedule:\n    interval: 7\n    cron: "0 3 * * *"\n`),
    ).toThrow(/has both `interval` and `cron`/);
  });

  it("refuses a schedule mapping with neither `interval` nor `cron`", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule: {}\n`)).toThrow(
      /neither `interval` nor `cron`/,
    );
  });

  it("refuses a schedule that is not a string or mapping", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule: 42\n`)).toThrow(
      /expected a duration, a cron expression, or a mapping/,
    );
  });

  it("refuses an empty `cron` string", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule:\n    cron: ""\n`)).toThrow(
      /expected a cron expression/,
    );
  });

  it("refuses a non-string `cron` value", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule:\n    cron: 5\n`)).toThrow(
      /expected a cron expression/,
    );
  });

  it("refuses an unrecognized key on the schedule mapping", () => {
    expect(() => warrant(`${MINIMAL}dependa:\n  schedule:\n    itnerval: 7\n`)).toThrow(
      /unrecognized key `itnerval`/,
    );
  });

  // ── full policy read ─────────────────────────────────────────────────

  it("reads every knob at once", () => {
    const source =
      `${MINIMAL}dependa:\n` +
      `  ecosystems: [npm, github-actions]\n` +
      `  allowed-types: [patch, minor, security]\n` +
      `  ignore:\n` +
      `    - name: "@types/*"\n` +
      `      ecosystem: npm\n` +
      `      types: [major]\n` +
      `    - name: eslint\n` +
      `  grouping: by-package\n` +
      `  security-separate: false\n` +
      `  auto-approve: patch\n` +
      `  auto-close: true\n` +
      `  auto-rebase: false\n` +
      `  schedule: 14d\n`;
    const policy = warrant(source).dependa!;
    expect(policy.ecosystems).toEqual(["npm", "github-actions"]);
    expect(policy.allowedTypes).toEqual(["patch", "minor", "security"]);
    expect(policy.ignore).toEqual([
      { name: "@types/*", ecosystem: "npm", types: ["major"] },
      { name: "eslint", ecosystem: null, types: [] },
    ]);
    expect(policy.grouping).toBe("by-package");
    expect(policy.securitySeparate).toBe(false);
    expect(policy.autoApprove).toBe("patch");
    expect(policy.autoClose).toBe(true);
    expect(policy.autoRebase).toBe(false);
    expect(policy.schedule).toEqual({ kind: "interval", days: 14 });
  });
});
