/**
 * Doctor and runtime resolve authority consistently — intent matrix B5, made
 * executable across the whole warrant format rather than at two points.
 *
 * `diagnose.test.ts` already pins the two failure cases the matrix cites: a
 * warrant that does not parse is red in doctor, and so is a chosen path with no
 * file. What it does not pin is the case a maintainer actually opens `doctor`
 * for — a warrant that *does* parse, whose report has to describe the run they
 * are about to get. A doctor that quietly disagreed with the runtime about a
 * grant would be worse than no doctor at all: it would be a green page in front
 * of a duty that cannot act, or a reassuring one in front of a duty that can.
 *
 * So every row below resolves the same file twice — once through `diagnose`,
 * once through `parseWarrant` + each duty's own `capabilities.ts` the way that
 * duty's `main.ts` does — and asserts the two answers are the same value. Each
 * duty's constants are imported here from the same module `main.ts` and
 * `diagnose.ts` both import, so this test cannot drift into being a third
 * opinion about what a default is.
 *
 * The warrants are chosen to cover every shape `granted`/`unnamed` can take:
 * no block, an explicit list, `true`, `false`, `[none]`, and a block that
 * simply does not mention a duty.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "../core/forge.js";
import { parseWarrant, type Capability } from "../core/warrant.js";
import {
  DEFAULT_CAPABILITIES as DEPENDA_DEFAULTS,
  DEPENDA_CAPABILITIES,
} from "../duties/dependa/capabilities.js";
import {
  DEFAULT_CAPABILITIES as DUPLICATE_DEFAULTS,
  DUPLICATE_CAPABILITIES,
} from "../duties/duplicate/capabilities.js";
import {
  DEFAULT_CAPABILITIES as HARMONISE_DEFAULTS,
  HARMONISE_CAPABILITIES,
} from "../duties/harmonise/capabilities.js";
import {
  DEFAULT_CAPABILITIES as LIFECYCLE_DEFAULTS,
  LIFECYCLE_CAPABILITIES,
} from "../duties/lifecycle/capabilities.js";
import {
  REMEDIATION_CAPABILITIES,
  REMEDIATION_DEFAULTS,
} from "../duties/remediation/capabilities.js";
import {
  DEFAULT_CAPABILITIES as RESPOND_DEFAULTS,
  RESPOND_CAPABILITIES,
} from "../duties/respond/capabilities.js";
import {
  DEFAULT_CAPABILITIES as REVIEW_DEFAULTS,
  REVIEW_CAPABILITIES,
} from "../duties/review/capabilities.js";
import {
  DEFAULT_CAPABILITIES as TRANSLATE_DEFAULTS,
  TRANSLATE_CAPABILITIES,
} from "../duties/translate/capabilities.js";
import {
  DEFAULT_CAPABILITIES as TRIAGE_DEFAULTS,
  TRIAGE_CAPABILITIES,
} from "../duties/triage/capabilities.js";
import { DUTIES } from "../refusal.js";

import { diagnose, problems, type Report } from "./diagnose.js";

const AT = { owner: "ecoma-io", repo: "reeve" };

/**
 * Each duty's own default and its own ladder, read from the same `capabilities.ts`
 * `main.ts` and `diagnose.ts` both read. Never re-typed here.
 */
const OWN: ReadonlyMap<
  string,
  { readonly defaults: readonly Capability[]; readonly ladder: readonly Capability[] }
> = new Map([
  ["translate", { defaults: TRANSLATE_DEFAULTS, ladder: TRANSLATE_CAPABILITIES }],
  ["triage", { defaults: TRIAGE_DEFAULTS, ladder: TRIAGE_CAPABILITIES }],
  ["duplicate", { defaults: DUPLICATE_DEFAULTS, ladder: DUPLICATE_CAPABILITIES }],
  ["respond", { defaults: RESPOND_DEFAULTS, ladder: RESPOND_CAPABILITIES }],
  ["lifecycle", { defaults: LIFECYCLE_DEFAULTS, ladder: LIFECYCLE_CAPABILITIES }],
  ["harmonise", { defaults: HARMONISE_DEFAULTS, ladder: HARMONISE_CAPABILITIES }],
  ["dependa", { defaults: DEPENDA_DEFAULTS, ladder: DEPENDA_CAPABILITIES }],
  ["review", { defaults: REVIEW_DEFAULTS, ladder: REVIEW_CAPABILITIES }],
  ["remediation", { defaults: REMEDIATION_DEFAULTS, ladder: REMEDIATION_CAPABILITIES }],
]);

const TAXONOMY = ["version: 1", "labels:", "  - name: bug", "    description: A defect."].join(
  "\n",
);

/**
 * Every shape a `duties:` block can take, as a file a consumer could commit.
 *
 * `harmonise: [edit-file, open-pr]` and `remediation: [propose]` are here
 * because they are the grants that write outside a thread — the ones a doctor
 * disagreeing with the runtime would be most expensive about.
 */
const WARRANTS: readonly (readonly [name: string, source: string])[] = [
  ["no duties block at all — every duty keeps its own default", `${TAXONOMY}\n`],
  [
    "an explicit list",
    `${TAXONOMY}\nduties:\n  triage: [label, comment]\n  translate: [edit-body]\n`,
  ],
  [
    "`true` — the duty's own documented default, spelled out",
    `${TAXONOMY}\nduties:\n  triage: true\n  review: true\n`,
  ],
  [
    "`false` — the duty disabled while the block still names it",
    `${TAXONOMY}\nduties:\n  triage: false\n`,
  ],
  [
    "`[none]` — nothing, explicitly",
    `${TAXONOMY}\nduties:\n  triage: [none]\n  lifecycle: [none]\n`,
  ],
  [
    "a block that names some duties and not others",
    `${TAXONOMY}\nduties:\n  triage: [label]\n  duplicate: [comment]\n`,
  ],
  [
    "the grants that write outside a thread",
    `${TAXONOMY}\nduties:\n  harmonise: [edit-file, open-pr]\n  remediation: [propose]\n  dependa: [edit-file, open-pr, comment]\n`,
  ],
  [
    "every duty named at once",
    `${TAXONOMY}\nduties:\n${DUTIES.map((duty) => `  ${duty}: true`).join("\n")}\n`,
  ],
] as const;

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

let scratch: string;
let warrantPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "reeve-agreement-"));
  warrantPath = join(scratch, "reeve.yml");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function reportFor(source: string, duty: string | null = null): Promise<Report> {
  await writeFile(warrantPath, source);
  return diagnose({
    api: labelsApi(["bug"]),
    at: AT,
    warrantPath,
    defaultWarrantPath: warrantPath,
    duty,
  });
}

describe("doctor_and_runtime_resolve_authority_consistently", () => {
  it.each(WARRANTS)("%s", async (_name, source) => {
    const report = await reportFor(source);
    const warrant = parseWarrant(warrantPath, source);

    expect(report.authority.map((row) => row.duty)).toEqual([...DUTIES]);

    // Both sides computed as one table and compared once, so a disagreement
    // names the duty and shows both answers rather than only the first failure.
    const fromRuntime = report.authority.map((row) => {
      const { defaults, ladder } = OWN.get(row.duty)!;
      // The runtime's own two lines, in the order every `main.ts` runs them.
      const denied = warrant.unnamed(row.duty);
      const raw = denied ? [] : warrant.granted(row.duty, defaults);
      return {
        duty: row.duty,
        denied,
        granted: raw.filter((capability) => ladder.includes(capability)),
        unused: raw.filter((capability) => !ladder.includes(capability)),
      };
    });

    expect(
      report.authority.map(({ duty, denied, granted, unused }) => ({
        duty,
        denied,
        granted,
        unused,
      })),
    ).toEqual(fromRuntime);
  });

  it("a duty-scoped report answers exactly what the whole-run report said about that duty", async () => {
    const source = `${TAXONOMY}\nduties:\n  triage: [label, comment]\n  review: true\n`;
    const whole = await reportFor(source);

    const scoped = [];
    for (const duty of DUTIES) {
      scoped.push((await reportFor(source, duty)).authority);
    }

    expect(scoped).toEqual(
      DUTIES.map((duty) => [whole.authority.find((row) => row.duty === duty)]),
    );
  });

  it("a level-0 report describes the same narrowest authority a level-0 run acts under", async () => {
    // No file at the path, which is the implicit warrant on both sides: every
    // duty keeps its own default, and nothing is denied.
    const report = await diagnose({
      api: labelsApi(["bug", "docs"]),
      at: AT,
      warrantPath: join(scratch, "reeve.yml"),
      defaultWarrantPath: join(scratch, "reeve.yml"),
      duty: null,
      workspaceDir: scratch,
    });

    expect(report.implicit).toBe(true);
    expect(
      report.authority.map(({ duty, denied, granted }) => ({ duty, denied, granted })),
    ).toEqual(
      report.authority.map(({ duty }) => {
        const own = OWN.get(duty)!;
        return {
          duty,
          denied: false,
          granted: own.defaults.filter((capability) => own.ladder.includes(capability)),
        };
      }),
    );
  });
});

describe("doctor_fails_red_on_exactly_what_a_run_fails_red_on", () => {
  /**
   * Every configuration a run refuses, and the fact that doctor refuses it too.
   *
   * The pairing is the point: `parseWarrant` throwing and `diagnose` reporting
   * a red finding have to be the same set. A file doctor called healthy and a
   * run rejected would be a report that cost a maintainer a green CI run and a
   * red production one.
   */
  const REFUSED: readonly (readonly [name: string, source: string])[] = [
    ["unparseable YAML", "version: 1\n\tduties: ["],
    ["a version this build does not understand", "version: 2\n"],
    ["a root key nothing reads", "version: 1\nunrecognized: x\n"],
    ["a capability nothing implements", "version: 1\nduties:\n  triage: [rewrite-history]\n"],
    ["a duty this build has never heard of", "version: 1\nduties:\n  janitor: [label]\n"],
    ["a `duties:` key written with nothing under it", "version: 1\nduties:\n"],
    ["a label with no description", "version: 1\nlabels:\n  - name: bug\n"],
    ["an empty file", ""],
    ["a list at the root", "- bug\n"],
  ] as const;

  it.each(REFUSED)("%s — red in doctor, and thrown by the reader", async (_name, source) => {
    const report = await reportFor(source);

    // Exactly one, not "at least one": a configuration this build refuses
    // produces the reader's single sentence and stops. A report carrying two
    // problems for one mistake would be a report that kept going after the
    // authority failed to resolve.
    expect(problems(report)).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.authority).toEqual([]);
    expect(() => parseWarrant(warrantPath, source)).toThrow();
  });

  it.each(REFUSED)(
    "%s — the finding is the reader's own sentence, not a second one",
    async (_name, source) => {
      const report = await reportFor(source);
      let thrown = "";
      try {
        parseWarrant(warrantPath, source);
      } catch (error) {
        thrown = (error as Error).message;
      }

      // Doctor reports `message(error)` verbatim, so a maintainer searching for
      // the sentence a run printed finds the doctor page that predicted it.
      expect(report.findings.some((finding) => finding.text === thrown)).toBe(true);
    },
  );

  it("a chosen path with no file is red in doctor exactly as it is fatal to a run", async () => {
    const report = await diagnose({
      api: labelsApi([]),
      at: AT,
      warrantPath: join(scratch, "nowhere.yml"),
      defaultWarrantPath: join(scratch, "reeve.yml"),
      duty: null,
    });

    expect(problems(report)).toBe(1);
    expect(report.findings[0]?.text).toMatch(/this run has no authority/);
  });
});

describe("doctor_never_grants_anything_of_its_own", () => {
  it("a warrant that grants nothing produces a table of nothing, not a table of defaults", async () => {
    // The shape a report would take if doctor ever filled a blank row in from
    // a duty's own default rather than from the file. `false` and `[none]` both
    // mean nothing was granted, and both have to survive the round trip
    // through the report.
    const source = `${TAXONOMY}\nduties:\n${DUTIES.map((duty) => `  ${duty}: [none]`).join("\n")}\n`;
    const report = await reportFor(source);

    expect(report.authority).toEqual(
      DUTIES.map((duty) => ({
        duty,
        granted: [],
        unused: [],
        denied: false,
        isDefault: OWN.get(duty)!.defaults.length === 0,
      })),
    );
    // Granting nothing is a decision, not a fault.
    expect(problems(report)).toBe(0);
  });

  it("an inert grant is reported red rather than shown as effective authority", async () => {
    // `duplicate` has no use for `close`, so a warrant granting it is a
    // misspelled grant. Doctor narrows it out of `granted` — exactly as a run
    // does — and says so, instead of printing a capability nothing reads.
    const report = await reportFor(`${TAXONOMY}\nduties:\n  duplicate: [comment, close]\n`);
    const row = report.authority.find((entry) => entry.duty === "duplicate");

    expect(row?.granted).toEqual(["comment"]);
    expect(row?.unused).toEqual(["close"]);
    // Exactly one problem: the inert grant. The taxonomy and the labels
    // listing are both healthy in this fixture, so a second red finding would
    // mean doctor had invented one.
    expect(problems(report)).toBe(1);
  });

  it("a denied duty is a table row, never a problem — it is a decision, not a fault", async () => {
    const report = await reportFor(`${TAXONOMY}\nduties:\n  triage: [label]\n`);
    const row = report.authority.find((entry) => entry.duty === "translate");

    expect(row?.denied).toBe(true);
    expect(row?.granted).toEqual([]);
    expect(report.findings.some((finding) => finding.text.includes("translate"))).toBe(false);
  });
});
