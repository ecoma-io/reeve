/**
 * Configuration as a public behavioural contract.
 *
 * `warrant.test.ts` reads the format field by field — what each key means when
 * it is written correctly, and which mistakes are named. This file asks the
 * different question a consumer asks: **given an input of this class, what is
 * guaranteed to happen?** Every row below is a promise a maintainer can rely on
 * across releases, and every promise is asserted on the message a real run
 * would print, not only on the fact that something threw.
 *
 * Four properties are pinned throughout:
 *
 * 1. **Deterministic.** The same bytes produce the same outcome and the same
 *    sentence, every time. A configuration error that reworded itself between
 *    runs would be a configuration error nobody can search for.
 * 2. **No partial mutation.** Validation completes before anything is resolved,
 *    and a file that fails validation yields no warrant at all — not a
 *    half-built one a caller could reach a capability through. `openAuthority`
 *    is asserted to touch no network before it has decided.
 * 3. **Never a widening.** Every malformed, unknown or surprising input either
 *    fails or is inert. None of them grants a capability the file did not
 *    write, and the deny-by-default edge of a written `duties:` block survives
 *    every one of them.
 * 4. **Blast radius stated.** YAML is a large language and this format uses a
 *    corner of it. Where the parser accepts something this format never
 *    documents — anchors, an integer spelled three ways, whitespace around a
 *    capability — the behaviour is pinned here as it actually is, so a change
 *    to it is a test failure rather than a surprise. Rows marked `ADJUDICATE:`
 *    are pinned-as-found, not blessed.
 *
 * Nothing is mocked except `@actions/core`, which is a runner effect rather
 * than a value.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "./forge.js";
import type { Capability } from "./warrant.js";
import {
  checkLifecycleLabelsExist,
  DEFAULT_PROPOSE_WORKSPACE,
  DEFAULT_WARRANT_PATH,
  openAuthority,
  parseWarrant,
  readWarrant,
} from "./warrant.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  notice: vi.fn(),
}));

const PATH = ".github/reeve.yml";
const AT = { owner: "ecoma-io", repo: "reeve" };

/** The duty default a widening would have to move away from. */
const TRIAGE_FALLBACK: readonly Capability[] = ["label"];

/** The error a source produces, or `null` when it parsed. */
function outcome(source: string): string | null {
  try {
    parseWarrant(PATH, source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// The input-class table
// ---------------------------------------------------------------------------

/**
 * One class of configuration input, and the outcome it is guaranteed to have.
 *
 * `expect` is a fragment of the message, chosen to be the part a maintainer
 * would search the docs for — never the whole sentence, so a reworded tail does
 * not fail a test that is about the class rather than the prose.
 */
const CLASSES: readonly (readonly [name: string, source: string, expected: RegExp | null])[] = [
  ["valid — the minimum a warrant can be", "version: 1\n", null],
  [
    "valid — a whole file",
    [
      "version: 1",
      "about: A build tool.",
      "languages: [en, vi]",
      "pivot: en",
      "memory:",
      "  recall: 4",
      "labels:",
      "  - name: bug",
      "    description: A defect.",
      "duties:",
      "  triage: [label, comment]",
    ].join("\n"),
    null,
  ],
  ["empty config — an empty file is not an empty authority", "", /is not a warrant/],
  ["empty config — whitespace only", "   \n\n\t\n", /is not a warrant/],
  ["empty config — a comment-only file", "# nothing here\n", /is not a warrant/],
  ["malformed — unparseable YAML", "version: 1\n\tlabels: [", /is not valid YAML/],
  ["malformed — a list at the root", "- bug\n- enhancement\n", /is not a warrant/],
  ["malformed — a bare string at the root", "just a sentence\n", /is not a warrant/],
  [
    "malformed — two YAML documents in one file",
    "version: 1\n---\nversion: 1\n",
    /is not valid YAML/,
  ],
  [
    "duplicate keys — refused by the parser, never last-wins",
    "version: 1\nabout: a\nabout: b\n",
    /is not valid YAML/,
  ],
  [
    "duplicate keys — inside `duties:`, where last-wins would be a widening",
    "version: 1\nduties:\n  triage: [none]\n  triage: [edit-file, open-pr]\n",
    /is not valid YAML/,
  ],
  [
    "unknown field — a root key nothing reads",
    "version: 1\nunknown: x\n",
    /unrecognized key `unknown`/,
  ],
  [
    "unknown field — the pre-1.0 `capabilities:` key this format replaced",
    "version: 1\ncapabilities:\n  triage: [label]\n",
    /unrecognized key `capabilities`/,
  ],
  [
    "unknown field — the legacy `apply` key, refused by name rather than honoured",
    "version: 1\napply: true\n",
    /unrecognized key `apply`/,
  ],
  [
    "unknown field — a label key nothing reads",
    "version: 1\nlabels:\n  - name: bug\n    description: d\n    apply: true\n",
    /unrecognized key `apply`/,
  ],
  [
    "invalid duty — a name this build has never heard of",
    "version: 1\nduties:\n  janitor: [label]\n",
    /is not a known duty/,
  ],
  [
    "invalid capability — a name nothing implements",
    "version: 1\nduties:\n  triage: [rewrite-history]\n",
    /is not something a duty can be granted/,
  ],
  [
    "conflicting config — `none` mixed with a real capability says two things at once",
    "version: 1\nduties:\n  triage: [none, label]\n",
    /is not something a duty can be granted/,
  ],
  [
    "conflicting config — a pivot outside the configured languages",
    "version: 1\nlanguages: [en]\npivot: vi\n",
    null, // Deferred to `pivotOrNone`, which has the final list — see below.
  ],
  ["missing required field — no version at all", "labels: []\n", /declares version absent/],
  [
    "missing required field — a label with no description",
    "version: 1\nlabels:\n  - name: bug\n",
    /has no `description`/,
  ],
  [
    "invalid model config — a version this build does not understand",
    "version: 2\n",
    /declares version `2`/,
  ],
  [
    "invalid rule pack — a `duties:` block written with nothing under it",
    "version: 1\nduties:\n",
    /writes `duties:` with nothing under it/,
  ],
  [
    "wrong type — `labels` as a mapping",
    "version: 1\nlabels:\n  bug: d\n",
    /has `labels` as a mapping/,
  ],
  ["wrong type — `duties` as a list", "version: 1\nduties: [triage]\n", /has `duties` as a list/],
  [
    "wrong type — a description that is a number",
    "version: 1\nlabels:\n  - name: bug\n    description: 7\n",
    /expected text/,
  ],
  [
    "wrong type — a confidence that is text",
    "version: 1\nlabels:\n  - name: bug\n    description: d\n    confidence: high\n",
    /expected a number between 0 and 1/,
  ],
  ["null vs absent — an absent `labels` is an empty taxonomy", "version: 1\n", null],
  [
    "null vs absent — `labels:` written null is the same empty taxonomy",
    "version: 1\nlabels:\n",
    null,
  ],
  [
    "null vs absent — `duties:` written null is refused, unlike an absent one",
    "version: 1\nduties: ~\n",
    /writes `duties:` with nothing under it/,
  ],
  [
    "null vs absent — a duty written null is refused, unlike an absent entry",
    "version: 1\nduties:\n  triage:\n",
    /is empty. Use `\[none\]`/,
  ],
  [
    "oversized input — a very long free-text field is carried, not truncated",
    `version: 1\nabout: ${"A".repeat(100_000)}\n`,
    null,
  ],
] as const;

describe("configuration_is_a_deterministic_public_contract", () => {
  it.each(CLASSES)("%s", (_name, source, expected) => {
    const first = outcome(source);

    // Rendered as one value so the row reports both halves of the promise —
    // whether it failed, and with which sentence — in a single comparison.
    expect({
      failed: first !== null,
      named: (first ?? "").startsWith("warrant: `.github/reeve.yml`"),
      matches: expected === null || expected.test(first ?? ""),
      message: first,
    }).toEqual({
      failed: expected !== null,
      // Every message names the file, so a run's log points at a path.
      named: expected !== null,
      matches: true,
      message: first,
    });
  });

  it("same_input_produces_the_same_error_every_time", () => {
    // Determinism is the property that makes an error searchable. Two reads of
    // the same bytes, and a read either side of an unrelated successful parse,
    // all produce the identical sentence.
    const first = CLASSES.map(([, source]) => outcome(source));
    parseWarrant(PATH, "version: 1\n");
    const second = CLASSES.map(([, source]) => outcome(source));

    expect(second).toEqual(first);
  });

  it("the_path_is_the_only_thing_a_message_varies_by", () => {
    const here = outcome("version: 1\nunknown: x\n");
    const elsewhere = ((): string | null => {
      try {
        parseWarrant("ops/reeve.yml", "version: 1\nunknown: x\n");
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(elsewhere).toBe((here ?? "").replace(PATH, "ops/reeve.yml"));
  });
});

// ---------------------------------------------------------------------------
// Nothing malformed ever widens
// ---------------------------------------------------------------------------

describe("malformed_configuration_never_widens_authority", () => {
  it("every refused source yields no warrant at all, not a partial one", () => {
    // A file that fails validation has to leave nothing behind for a caller to
    // reach a capability through — the table below is the whole set of refused
    // classes, each answering "the reader returned nothing".
    const refused = CLASSES.filter(([, , expected]) => expected !== null);
    const returned = refused.map(([name, source]) => {
      try {
        parseWarrant(PATH, source);
        return [name, "returned a warrant"] as const;
      } catch {
        return [name, "returned nothing"] as const;
      }
    });

    expect(returned).toEqual(refused.map(([name]) => [name, "returned nothing"] as const));
  });

  it("a written duties block still denies every duty it does not name, whatever else is in the file", () => {
    // The deny-by-default edge is what a widening would have to cross. It holds
    // across every legal shape of the rest of the file.
    for (const extra of [
      "",
      "about: x\n",
      "labels:\n  - name: bug\n    description: d\n",
      "languages: [en]\n",
      "memory:\n  recall: 0\n",
      `about: ${"A".repeat(10_000)}\n`,
    ]) {
      const warrant = parseWarrant(PATH, `version: 1\n${extra}duties:\n  triage: [label]\n`);

      expect(warrant.granted("triage", TRIAGE_FALLBACK)).toEqual(["label"]);
      for (const other of ["translate", "review", "harmonise", "dependa", "remediation"]) {
        expect(warrant.granted(other, ["edit-file", "open-pr"])).toEqual([]);
        expect(warrant.unnamed(other)).toBe(true);
      }
    }
  });

  it("a taxonomy validated only at the end still refuses the whole file", () => {
    // `exclusive_with` is checked after every entry exists, which means a file
    // can be most of the way through the reader before it fails. It still
    // yields nothing — there is no "labels parsed, cross-check failed, keep the
    // labels" state for a caller to reach.
    const source = [
      "version: 1",
      "duties:",
      "  triage: [label, comment, close]",
      "labels:",
      "  - name: bug",
      "    description: d",
      "    exclusive_with: [ghost]",
    ].join("\n");

    expect(() => parseWarrant(PATH, source)).toThrow(/which is not a label in this file/);
  });
});

// ---------------------------------------------------------------------------
// YAML's blast radius
// ---------------------------------------------------------------------------

describe("yaml_features_this_format_never_documented", () => {
  it("an anchor is accepted and its alias reaches nothing this format reads", () => {
    // ADJUDICATE: anchors are neither documented nor prohibited by
    // `docs/reference/warrant-format.md`. Pinned as found: an anchor on a key
    // this format knows is inert, and the only way to *use* an alias is to
    // park it under a second root key — which the unknown-key check refuses.
    // The blast radius is therefore "an anchor may be written and does
    // nothing", not "a warrant may be assembled out of references".
    const anchored = parseWarrant(
      PATH,
      ["version: 1", "duties: &grants", "  triage: [label]"].join("\n"),
    );
    expect(anchored.granted("triage", TRIAGE_FALLBACK)).toEqual(["label"]);

    expect(() =>
      parseWarrant(
        PATH,
        ["version: 1", "grants: &g [edit-file]", "duties:", "  triage: *g"].join("\n"),
      ),
    ).toThrow(/unrecognized key `grants`/);
  });

  it("a merge key is refused wherever it is written, rather than merging a grant in", () => {
    // `<<` is the one YAML feature that could compose a `duties:` block out of
    // two places. It is refused as a name at every level this format reads.
    expect(() =>
      parseWarrant(PATH, ["version: 1", "duties:", "  <<: {triage: [edit-file]}"].join("\n")),
    ).toThrow(/duties names `<<`/);

    expect(() =>
      parseWarrant(
        PATH,
        [
          "version: 1",
          "labels:",
          "  - &base",
          "    name: bug",
          "    description: d",
          "  - <<: *base",
          "    name: other",
        ].join("\n"),
      ),
    ).toThrow(/unrecognized key `<<`/);
  });

  it("a second YAML document can never be a second configuration", () => {
    expect(() =>
      parseWarrant(
        PATH,
        [
          "version: 1",
          "duties:",
          "  triage: [none]",
          "---",
          "version: 1",
          "duties:",
          "  triage: [edit-file]",
        ].join("\n"),
      ),
    ).toThrow(/is not valid YAML/);
  });

  it("`version` accepts every YAML spelling of the integer one, and nothing else", () => {
    // ADJUDICATE: `1.0`, `0x1` and `+1` are all the scalar `1` to YAML, so they
    // pass a `!== VERSION` check. Pinned as found — none of them widens
    // anything, and refusing them would be a stricter contract than the format
    // reference states.
    const accepted = ["1", "1.0", "0x1", "+1", "0o1"];
    const refused = ['"1"', "'1'", "true", "1.5", "[1]", "01a"];

    expect(accepted.map((spelling) => [spelling, outcome(`version: ${spelling}\n`)])).toEqual(
      accepted.map((spelling) => [spelling, null]),
    );

    expect(
      refused.map((spelling) => [
        spelling,
        (outcome(`version: ${spelling}\n`) ?? "").includes("declares version"),
      ]),
    ).toEqual(refused.map((spelling) => [spelling, true]));
  });

  it("a capability is matched after `String.trim()`, and after nothing else", () => {
    // ADJUDICATE (root: PIN CORRECT, keep). `strings()` trims, so a capability
    // written with surrounding whitespace still reaches the closed set. The
    // exact surface matters and is measured here rather than asserted in
    // general terms: `String.trim()` strips every character Unicode calls
    // whitespace — ASCII space and tab, but also NBSP, the BOM/zero-width
    // no-break space, the ideographic space and the line/paragraph separators
    // — and strips nothing else. Zero-width space, zero-width joiner, the word
    // joiner, a bidi override and NUL all survive it and are therefore refused
    // by the closed-set check, which is the answer this boundary needs.
    const stripped = [
      ["ascii space and tab", '"  label\t"'],
      ["vertical tab and form feed", '"\u000blabel\u000c"'],
      ["no-break space", '"\u00a0label\u00a0"'],
      ["BOM / zero-width no-break space", '"\ufefflabel"'],
      ["ideographic space", '"\u3000label"'],
      ["narrow no-break space", '"\u202flabel"'],
      ["line and paragraph separators", '"\u2028label\u2029"'],
    ] as const;

    expect(
      stripped.map(([name, written]) => [
        name,
        parseWarrant(PATH, `version: 1\nduties:\n  triage: [${written}]\n`).granted(
          "triage",
          TRIAGE_FALLBACK,
        ),
      ]),
    ).toEqual(stripped.map(([name]) => [name, ["label"]]));

    // Everything else, refused. Case, homoglyph, width, encoding and every
    // zero-width or bidi character `trim()` leaves in place.
    const refused = [
      ["case", '"Label"'],
      ["punctuation", '"label."'],
      ["inner space", '"la bel"'],
      ["plural", '"labels"'],
      ["zero-width space", '"\u200blabel"'],
      ["zero-width joiner", '"label\u200d"'],
      ["word joiner", '"label\u2060"'],
      ["bidi override", '"\u202elabel\u202c"'],
      ["NUL", '"label\u0000"'],
      ["Cyrillic homoglyph", '"l\u0430bel"'],
      ["fullwidth", '"\uff4cabel"'],
      ["base64", '"bGFiZWw="'],
    ] as const;

    expect(
      refused.map(([name, written]) => [
        name,
        (outcome(`version: 1\nduties:\n  triage: [${written}]\n`) ?? "").includes(
          "is not something a duty can be granted",
        ),
      ]),
    ).toEqual(refused.map(([name]) => [name, true]));
  });

  it("a YAML comment is never part of a value", () => {
    const warrant = parseWarrant(
      PATH,
      ["version: 1", "duties:", "  triage: [label] # , edit-file, open-pr"].join("\n"),
    );

    expect(warrant.granted("triage", TRIAGE_FALLBACK)).toEqual(["label"]);
  });

  it("a duties key is compared byte for byte, so no spelling of a duty is a second entry", () => {
    const refused = ['"Triage"', '"triage "', '" triage"', '"tri age"'];
    expect(
      refused.map((written) => [
        written,
        (outcome(`version: 1\nduties:\n  ${written}: [label]\n`) ?? "").includes(
          "is not a known duty",
        ),
      ]),
    ).toEqual(refused.map((written) => [written, true]));
  });
});

// ---------------------------------------------------------------------------
// Validation completes before anything is spent
// ---------------------------------------------------------------------------

describe("configuration_errors_happen_before_any_effect", () => {
  let scratch: string;
  let cwd: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "reeve-contract-"));
    cwd = process.cwd();
    process.chdir(scratch);
    await mkdir(".github");
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(scratch, { recursive: true, force: true });
  });

  /** A `TrackerApi` that records whether the labels endpoint was reached at all. */
  function labelsApi(): TrackerApi {
    return {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(() => Promise.resolve({ data: [] })),
        },
      },
    } as unknown as TrackerApi;
  }

  it("malformed_yaml_fails_before_any_network_call", async () => {
    await writeFile(DEFAULT_WARRANT_PATH, "version: 1\n\tduties: [");
    const api = labelsApi();

    await expect(openAuthority(DEFAULT_WARRANT_PATH, api, AT, "triage")).rejects.toThrow(
      /is not valid YAML/,
    );
    expect(vi.mocked(api.rest.issues.listLabelsForRepo)).not.toHaveBeenCalled();
  });

  it("an unknown capability fails before any network call", async () => {
    await writeFile(DEFAULT_WARRANT_PATH, "version: 1\nduties:\n  triage: [rewrite-history]\n");
    const api = labelsApi();

    await expect(openAuthority(DEFAULT_WARRANT_PATH, api, AT, "triage")).rejects.toThrow(
      /is not something a duty can be granted/,
    );
    expect(vi.mocked(api.rest.issues.listLabelsForRepo)).not.toHaveBeenCalled();
  });

  it("a chosen path that is not there fails before any network call", async () => {
    const api = labelsApi();

    await expect(openAuthority(".github/elsewhere.yml", api, AT, "triage")).rejects.toThrow(
      /this run has no authority/,
    );
    expect(vi.mocked(api.rest.issues.listLabelsForRepo)).not.toHaveBeenCalled();
  });

  it("only a genuine absence at the default path ever reaches the forge", async () => {
    const api = labelsApi();

    const opened = await openAuthority(DEFAULT_WARRANT_PATH, api, AT, "triage");

    expect(opened.authority.implicit).toBe(true);
    expect(vi.mocked(api.rest.issues.listLabelsForRepo)).toHaveBeenCalled();
  });

  it("a warrant read from disk is the same value as the same bytes parsed in memory", async () => {
    // Doctor, a duty and this test all read the file through one function. A
    // second reader would be a second chance to disagree about what it says.
    const source = [
      "version: 1",
      "labels:",
      "  - name: bug",
      "    description: A defect.",
      "duties:",
      "  triage: [label, comment]",
    ].join("\n");
    await writeFile(DEFAULT_WARRANT_PATH, source);

    const read = await readWarrant(DEFAULT_WARRANT_PATH, { defaultPath: DEFAULT_WARRANT_PATH });
    const parsed = parseWarrant(DEFAULT_WARRANT_PATH, source);

    expect(read?.labels).toEqual(parsed.labels);
    expect(read?.granted("triage", TRIAGE_FALLBACK)).toEqual(
      parsed.granted("triage", TRIAGE_FALLBACK),
    );
    expect(read?.unnamed("review")).toBe(parsed.unnamed("review"));
  });
});

// ---------------------------------------------------------------------------
// The blocks a duty reads a policy out of
// ---------------------------------------------------------------------------

/**
 * `lifecycle:`, `propose:` and `dependa:` are configuration in exactly the
 * sense the rest of this file means it: a maintainer writes them, a duty acts
 * on them, and a shape nobody validated is a duty acting on a guess. Each row
 * is a value a real workflow produces — a half-finished edit, a key written
 * with nothing under it, a type YAML made for you — paired with the outcome it
 * is guaranteed to have.
 */
const LIFECYCLE_HEAD = [
  "version: 1",
  "labels:",
  "  - name: stale",
  "    description: No movement.",
  "lifecycle:",
  "  exempt:",
  "    labels: [pinned]",
  "  tracks:",
  "    - name: idle",
  "      steps:",
].join("\n");

/** A lifecycle policy whose single step is `step`, indented for the track. */
function lifecycle(step: readonly string[]): string {
  return `${LIFECYCLE_HEAD}\n${step.map((line) => `        ${line}`).join("\n")}\n`;
}

describe("a lifecycle policy is validated shape by shape", () => {
  it("reads `say: true` as the built-in template", () => {
    const warrant = parseWarrant(PATH, lifecycle(["- after: 14d", "  say: true"]));
    expect(warrant.lifecycle?.tracks[0]?.steps[0]?.say).toEqual({ kind: "built-in" });
  });

  it("reads `say: false` as no comment at all — distinct from the built-in one", () => {
    const warrant = parseWarrant(
      PATH,
      lifecycle(["- after: 14d", "  label: stale", "  say: false"]),
    );
    expect(warrant.lifecycle?.tracks[0]?.steps[0]?.say).toBeNull();
  });

  it("reads a language-keyed `say:` mapping, trimmed", () => {
    const warrant = parseWarrant(
      PATH,
      lifecycle([
        "- after: 14d",
        "  say:",
        '    en: "  No movement.  "',
        "    vi: Không có gì mới.",
      ]),
    );
    const say = warrant.lifecycle?.tracks[0]?.steps[0]?.say;

    expect(say?.kind).toBe("map");
    expect(say?.kind === "map" ? [...say.map] : []).toEqual([
      ["en", "No movement."],
      ["vi", "Không có gì mới."],
    ]);
  });

  it("refuses a `say:` mapping entry that is not text, naming the language", () => {
    expect(() => parseWarrant(PATH, lifecycle(["- after: 14d", "  say:", "    en: 7"]))).toThrow(
      /`say\.en` is `7`, expected text/,
    );
    expect(() =>
      parseWarrant(PATH, lifecycle(["- after: 14d", "  say:", '    en: "   "'])),
    ).toThrow(/`say\.en` is the text ` {3}`, expected text/);
  });

  it("refuses a `say:` mapping with nothing under it — a half-finished edit", () => {
    expect(() => parseWarrant(PATH, lifecycle(["- after: 14d", "  say: {}"]))).toThrow(
      /writes `say:` with nothing under it/,
    );
  });

  it("refuses an empty `say:` string rather than posting an empty comment", () => {
    expect(() => parseWarrant(PATH, lifecycle(["- after: 14d", '  say: "  "']))).toThrow(
      /has an empty `say`/,
    );
  });

  it("refuses a `say:` that is a list — neither true, text, nor a mapping", () => {
    expect(() => parseWarrant(PATH, lifecycle(["- after: 14d", "  say: [a, b]"]))).toThrow(
      /has `say` as a list, expected true, text, or a mapping/,
    );
  });

  it("refuses a step that is not a mapping", () => {
    expect(() => parseWarrant(PATH, lifecycle(["- just a sentence"]))).toThrow(
      /entry 1 \(`idle`\) step 1 is the text `just a sentence`, expected a mapping/,
    );
  });

  it("refuses a track that is not a mapping", () => {
    const source = [
      "version: 1",
      "lifecycle:",
      "  exempt:",
      "    labels: [pinned]",
      "  tracks:",
      "    - idle",
    ].join("\n");

    expect(() => parseWarrant(PATH, source)).toThrow(
      /`lifecycle\.tracks` entry 1 is the text `idle`, expected a mapping with a `name`/,
    );
  });

  it("refuses an `exempt:` block that is not a mapping", () => {
    const written = ["exempt: 7", "exempt: [pinned]"];
    const messages = written.map((line) =>
      outcome(
        [
          "version: 1",
          "lifecycle:",
          `  ${line}`,
          "  tracks:",
          "    - name: idle",
          "      steps:",
          "        - after: 14d",
          "          say: true",
        ].join("\n"),
      ),
    );

    expect(messages).toEqual([
      "warrant: `.github/reeve.yml`'s `lifecycle.exempt` is `7`, expected a mapping.",
      "warrant: `.github/reeve.yml`'s `lifecycle.exempt` is a list, expected a mapping.",
    ]);
  });

  it("refuses an `exempt` guard that is neither a boolean nor a list of names", () => {
    const source = [
      "version: 1",
      "lifecycle:",
      "  exempt:",
      "    labels: [pinned]",
      "    milestones: 7",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          say: true",
    ].join("\n");

    expect(() => parseWarrant(PATH, source)).toThrow(
      /has `milestones` as `7`, expected true, false, or a list of names/,
    );
  });

  it("reads `overrides:` written with nothing under it as no overrides", () => {
    const source = [
      "version: 1",
      "labels:",
      "  - name: stale",
      "    description: d",
      "lifecycle:",
      "  overrides:",
      "  exempt:",
      "    labels: [pinned]",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          label: stale",
    ].join("\n");

    expect(parseWarrant(PATH, source).lifecycle?.overrides).toEqual([]);
  });

  it("refuses an override entry that is not a mapping", () => {
    const source = [
      "version: 1",
      "labels:",
      "  - name: stale",
      "    description: d",
      "lifecycle:",
      "  overrides:",
      "    - pinned",
      "  exempt:",
      "    labels: [pinned]",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          label: stale",
    ].join("\n");

    expect(() => parseWarrant(PATH, source)).toThrow(
      /`lifecycle\.overrides` entry 1 is the text `pinned`, expected a mapping with a `label`/,
    );
  });

  it("names every missing lifecycle label at once, singular or plural", () => {
    // The plural arm of the message, and the inactivity-track path where a
    // track names no `when:` at all — the two halves of the check a policy
    // referring to labels nobody created has to fail on.
    const source = [
      "version: 1",
      "lifecycle:",
      "  exempt:",
      "    labels: [pinned]",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          label: stale",
      "        - after: 7d",
      "          label: closing",
    ].join("\n");
    const warrant = parseWarrant(PATH, source);

    const check = (existing: readonly string[]): string => {
      try {
        checkLifecycleLabelsExist(warrant, existing);
        return "passed";
      } catch (error) {
        return (error as Error).message;
      }
    };

    expect([
      check(["pinned"]),
      check(["pinned", "stale"]),
      check(["pinned", "stale", "closing"]),
    ]).toEqual([
      "warrant: `.github/reeve.yml`'s `lifecycle:` names labels this repository does not have — " +
        "`stale`, `closing`. Create them, or correct the policy.",
      "warrant: `.github/reeve.yml`'s `lifecycle:` names a label this repository does not have — " +
        "`closing`. Create them, or correct the policy.",
      "passed",
    ]);
  });

  it("refuses a duration that is not one, in every field written in that grammar", () => {
    // ADJUDICATE: `durationField`'s `allowNever: true` overload has no call
    // site anywhere in `src/` — every caller passes `allowNever: false` — so
    // the `never` value and the " or `never`." half of this message are
    // unreachable today. An override says "never" with its own `never:` key
    // instead. Pinned as the grammar actually is; the dead overload is
    // reported rather than exercised.
    expect(() => parseWarrant(PATH, lifecycle(["- after: soon", "  say: true"]))).toThrow(
      /has `after` as the text `soon`, expected a duration like `14d`\./,
    );
    expect(() => parseWarrant(PATH, lifecycle(["- after: 7", "  say: true"]))).toThrow(
      /has `after` as `7`, expected a duration like `14d`\./,
    );
    expect(() => parseWarrant(PATH, lifecycle(["- after: 0d", "  say: true"]))).toThrow(
      /has `after: 0d`, which is not a duration/,
    );

    const override = [
      "version: 1",
      "labels:",
      "  - name: stale",
      "    description: d",
      "lifecycle:",
      "  overrides:",
      "    - label: stale",
      "      after: soon",
      "  exempt:",
      "    labels: [stale]",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          label: stale",
    ].join("\n");

    expect(() => parseWarrant(PATH, override)).toThrow(
      /`lifecycle\.overrides` entry 1 has `after` as the text `soon`, expected a duration like `14d`\./,
    );
    // `never` is spelled with its own key on an override, and reads as no
    // timing rather than as a duration.
    expect(
      parseWarrant(PATH, override.replace("after: soon", "never: true")).lifecycle?.overrides[0],
    ).toEqual({ label: "stale", after: null, never: true });
  });
});

describe("propose and dependa are validated the same way", () => {
  it("refuses `propose:` that is not a mapping", () => {
    expect(() => parseWarrant(PATH, "version: 1\npropose: [workspace]\n")).toThrow(
      /has `propose` as a list, expected a mapping/,
    );
  });

  it("takes each `propose.workspace` default independently of the others", () => {
    // Only `evidence` is written, so `window` and every other knob have to come
    // from the design's own defaults rather than from a partly-filled block.
    const warrant = parseWarrant(
      PATH,
      ["version: 1", "propose:", "  workspace:", "    evidence: 3"].join("\n"),
    );

    expect(warrant.propose.evidence).toBe(3);
    expect(warrant.propose.window).toBe(DEFAULT_PROPOSE_WORKSPACE.window);
    expect(warrant.propose.name).toBe(DEFAULT_PROPOSE_WORKSPACE.name);
    expect(warrant.propose.retire).toBe(DEFAULT_PROPOSE_WORKSPACE.retire);
  });

  it("takes `evidence` from the defaults when only `window` is written", () => {
    const warrant = parseWarrant(
      PATH,
      ["version: 1", "propose:", "  workspace:", "    window: 30d"].join("\n"),
    );

    expect(warrant.propose.evidence).toBe(DEFAULT_PROPOSE_WORKSPACE.evidence);
    expect(warrant.propose.window).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("reads an ignore rule's `ecosystem:` written null as no ecosystem", () => {
    const warrant = parseWarrant(
      PATH,
      ["version: 1", "dependa:", "  ignore:", "    - name: left-pad", "      ecosystem:"].join(
        "\n",
      ),
    );

    expect(warrant.dependa?.ignore[0]).toEqual({ name: "left-pad", ecosystem: null, types: [] });
  });

  it("deduplicates an ignore rule's update types rather than listing one twice", () => {
    const warrant = parseWarrant(
      PATH,
      [
        "version: 1",
        "dependa:",
        "  ignore:",
        "    - name: left-pad",
        "      types: [major, major, minor]",
      ].join("\n"),
    );

    expect(warrant.dependa?.ignore[0]?.types).toEqual(["major", "minor"]);
  });
});

describe("a label's own optional fields are read or refused, never guessed", () => {
  function labelWith(field: string): string {
    return ["version: 1", "labels:", "  - name: bug", "    description: d", `    ${field}`].join(
      "\n",
    );
  }

  it("normalises a `color:` to lower case, so two spellings of one colour are one value", () => {
    expect(parseWarrant(PATH, labelWith("color: FF00aa")).labels[0]?.color).toBe("ff00aa");
    expect(parseWarrant(PATH, labelWith('color: "  ff00AA  "')).labels[0]?.color).toBe("ff00aa");
  });

  it("reads `color:` written with nothing under it as no colour", () => {
    expect(parseWarrant(PATH, labelWith("color:")).labels[0]?.color).toBeNull();
  });

  it("refuses a `color:` that is not a bare 6-digit hex", () => {
    const refused = [
      'color: "#ff00aa"',
      "color: red",
      "color: 0",
      "color: ff00a",
      "color: [ff00aa]",
    ];
    expect(
      refused.map((written) => [
        written,
        (outcome(labelWith(written)) ?? "").includes("expected a 6-digit hex color with no `#`"),
      ]),
    ).toEqual(refused.map((written) => [written, true]));
  });

  it("reads `create:` written with nothing under it as the default `false`", () => {
    expect(parseWarrant(PATH, labelWith("create:")).labels[0]?.create).toBe(false);
    expect(parseWarrant(PATH, labelWith("create: true")).labels[0]?.create).toBe(true);
  });

  it("refuses a `create:` that is not a boolean rather than reading it as truthy", () => {
    const refused = ['create: "true"', "create: 1", "create: [true]"];
    expect(
      refused.map((written) => [
        written,
        (outcome(labelWith(written)) ?? "").includes("expected true or false"),
      ]),
    ).toEqual(refused.map((written) => [written, true]));
  });
});

describe("a block written as the wrong container is refused, never indexed into", () => {
  it("refuses `lifecycle.overrides` written as a mapping rather than a list", () => {
    const source = [
      "version: 1",
      "labels:",
      "  - name: stale",
      "    description: d",
      "lifecycle:",
      "  overrides:",
      "    stale: never",
      "  exempt:",
      "    labels: [stale]",
      "  tracks:",
      "    - name: idle",
      "      steps:",
      "        - after: 14d",
      "          label: stale",
    ].join("\n");

    expect(outcome(source)).toBe(
      "warrant: `.github/reeve.yml`'s `lifecycle.overrides` is a mapping, expected a list.",
    );
  });

  it("refuses an ignore rule's `ecosystem:` that is not an ecosystem name", () => {
    const source = [
      "version: 1",
      "dependa:",
      "  ignore:",
      "    - name: left-pad",
      "      ecosystem: 7",
    ].join("\n");

    expect(outcome(source)).toBe(
      "warrant: `.github/reeve.yml`'s `dependa.ignore` entry 1 has `ecosystem` as `7`, " +
        "expected an ecosystem name.",
    );
  });
});
