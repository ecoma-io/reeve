/**
 * The harmonise driver: what one fixture means, and what a run over it must
 * show. The runner (eval/runner.ts) does the actual spawning and asserting —
 * this module builds the scenario and scripts the model answers.
 *
 * The fixture's own `state.json` is treated as intent documentation only —
 * the driver seeds the runtime-shape state itself, because the runtime's
 * `parseState` requires the array shape and the stale/conflict detection
 * compares the recorded SHAs against the current file SHAs. The driver
 * computes those SHAs deterministically (`shaOf`) and writes a state array
 * that makes exactly the fixture's scenario true.
 *
 * Which fixture file is the "current" source, which is the blob seeded as
 * `sourceRevision`, and which locale's `synced` SHA is recorded all come
 * from the fixture's naming convention:
 *
 * - `en.changed.md` is the current source; `en.md` is the previous revision
 *   the state seeds as `sourceRevision` (the change fixtures).
 * - `en.md` alone (no `en.changed.md`) is the current source. Seeding
 *   `sourceRevision` to its own SHA makes the run idempotent (the early
 *   return in `markStale`).
 * - `vi.original.md` names the previous revision of the vi file, as the
 *   source of the `synced` SHA for a conflict: the current vi then differs
 *   from what was last synced, which is the human edit.
 *
 * The runs are `warrant`-gated (apply is not an input anymore): a fixture
 * whose `.expected.json` says the change propagates seeds the state so the
 * run reports the locales it would sync, exactly as the dogfood workflow
 * observes it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Answer, Ask, ContentMap } from "../harness.ts";
import { failing, saying, shaOf } from "../harness.ts";

/** What one run produced, narrowed to the four things a harmonise run declares. */
export interface HarmoniseObserved {
  readonly classified: string;
  readonly synced: string;
  readonly conflicts: string;
  readonly skipped: string;
  readonly summary: string;
}

export interface HarmoniseResult {
  readonly name: string;
  readonly code: number | null;
  readonly observed: HarmoniseObserved;
  readonly passed: boolean;
  readonly details: string;
}

/** One fixture file, under the path it is served from. */
interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The changes a fixture expects, as the four output arrays the run must
 * report. Compared as parsed JSON (`string[]` for the first three, and the
 * `{group, locales}` objects for `conflicts`).
 */
export interface ExpectedEffects {
  readonly synced: readonly string[];
  readonly classified: readonly string[];
  readonly conflicts: readonly { readonly group: string; readonly locales: readonly string[] }[];
  readonly skipped: readonly string[];
}

/** The fixture's `.expected.json`, as far as the driver reads it. */
export interface FixtureExpected {
  readonly scenario: string;
  readonly description: string;
  readonly expected:
    | { readonly classification: string; readonly "conflict-detected"?: boolean }
    | { readonly classifications: readonly { readonly classification: string }[] };
}

/** The seeded provenance state — the exact shape `serialiseState` writes. */
export interface SeededState {
  readonly id: string;
  readonly files: Record<string, string>;
  readonly sourceRevision: string;
  readonly synced: Record<string, string>;
}

/** The JSON text of the seeded state, as the stub serves it at the state path. */
function stateOf(state: readonly SeededState[]): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/** The answer to script for one completion request, decided from its prompt. */
export interface AnswerScript {
  readonly classify: string;
  readonly draft: Record<string, string>;
}

const GROUP = "docs/guide";

/** The fixture directory → the scenario that makes its condition true. */
export async function scenarioOf(name: string, directory: string): Promise<Scenario> {
  const expected = await expectedOf(directory);
  const read = async (file: string): Promise<FixtureFile | null> => {
    try {
      const content = await readFile(join(directory, file), "utf8");
      return { path: file, content };
    } catch {
      return null;
    }
  };

  const [en, changed, vi, zh, viOriginal] = await Promise.all([
    read("en.md"),
    read("en.changed.md"),
    read("vi.md"),
    read("zh.md"),
    read("vi.original.md"),
  ]);

  if (en === null) throw new Error(`harmonise: ${name} fixture has no en.md`);

  // The current source — `en.changed.md` when the fixture changes it.
  const currentSource = changed ?? en;

  // The runtime discovers document groups from locale-suffixed file names —
  // `docs/guide.md` for the source and `docs/guide.vi.md` for its locales.
  // The fixture's own directory layout (en.md, vi.md, …) is rewired onto that
  // naming so `discoverGroups` finds exactly one group.
  const currentPath = `${GROUP}.md`;
  const localePath = (locale: "vi" | "zh"): string => `${GROUP}.${locale}.md`;

  const locales = (["vi", "zh"] as const).filter((locale): locale is "vi" | "zh" =>
    locale === "vi" ? vi !== null : zh !== null,
  );

  // The seed: `sourceRevision` is the previous source content, and each
  // locale's `synced` is the SHA it was synced to.
  const synced: Record<string, string> = {};
  for (const locale of locales) {
    const current = locale === "vi" ? vi : zh;
    if (current === null) continue;
    const previous = locale === "vi" ? (viOriginal ?? current) : current;
    synced[locale] = shaOf(previous.content);
  }

  const state: SeededState[] = [
    {
      id: GROUP,
      files: {
        en: currentPath,
        ...Object.fromEntries(locales.map((locale) => [locale, localePath(locale)])),
      },
      // A change fixture: the previous source revision is `en.md` itself; an
      // idempotent fixture: the source has not moved, so nothing goes stale.
      sourceRevision: changed !== null ? shaOf(en.content) : shaOf(currentSource.content),
      synced,
    },
  ];

  // The previous source revision, reachable by SHA and absent from the tree —
  // exactly what a recorded `sourceRevision` describes.
  const blobs = new Map<string, { content: string; sha: string }>([
    [currentPath, { content: en.content, sha: shaOf(en.content) }],
  ]);

  const contents = new Map<string, { content: string; sha: string }>([
    [currentPath, { content: currentSource.content, sha: shaOf(currentSource.content) }],
    // The run reads its provenance state from the repo, so the seed is a file
    // in the stub's tree — the exact array shape `parseState` requires.
    [`.reeve/provenance/state.json`, { content: stateOf(state), sha: shaOf(stateOf(state)) }],
  ]);
  for (const locale of locales) {
    const file = locale === "vi" ? vi : zh;
    if (file !== null)
      contents.set(localePath(locale), { content: file.content, sha: shaOf(file.content) });
  }

  const scenario: Scenario = {
    name,
    contents,
    blobs,
    state,
    languages: locales.join(", "),
    classify: "",
    draft: {},
    expected: { synced: [], classified: [], conflicts: [], skipped: [] },
    detail: "",
    conflict: false,
  };

  // Decide the effect the run must show from the fixture's expected contract.
  return withExpected(scenario, expected);
}

/** Reads the fixture's `.expected.json`. */
async function expectedOf(directory: string): Promise<FixtureExpected> {
  const raw = await readFile(join(directory, ".expected.json"), "utf8");
  return JSON.parse(raw) as FixtureExpected;
}

export interface Scenario {
  readonly name: string;
  readonly contents: ContentMap;
  /**
   * The previous revision of the source, addressable by its blob SHA but not
   * listed in the tree — what `sourceRevision` in the seeded state points at.
   *
   * A fixture never needed this before, because nothing ever read it: the diff
   * branch in `processGroup` compared `doc.sourceRevision` against the current
   * SHA *after* `markStale` had already set them equal, so every change was
   * classified from the whole document and the blob read was unreachable. With
   * the baseline read per locale that branch runs, and a fixture that seeds a
   * previous revision has to be able to serve it.
   */
  readonly blobs?: ContentMap;
  readonly state: SeededState[];
  readonly languages: string;
  readonly classify: string;
  /** The fixture's model roster override, when one — comma-separated ids. */
  readonly models?: string;
  /**
   * The classify answer per model, when a fixture scripts rotation. Absent,
   * every classify request answers `classify`. Present, a model not listed
   * fails (so the run must rotate past it to the roster's next model).
   */
  readonly classifyPerModel?: Record<string, string>;
  readonly draft: Record<string, string>;
  readonly expected: ExpectedEffects;
  readonly detail: string;
  readonly conflict: boolean;
}

/** Per-fixture behaviour: how the scenario interprets the fixture semantics. */
function withExpected(scenario: Scenario, expected: FixtureExpected): Scenario {
  const name = scenario.name;

  switch (name) {
    case "conflict": {
      return {
        ...scenario,
        classify: "semantic|the changed section",
        draft: {},
        expected: {
          synced: [],
          classified: [],
          conflicts: [{ group: GROUP, locales: ["vi"] }],
          // The runtime's `skipped` filter also names a group it only reported
          // a conflict for — `classification !== semantic` and nothing synced.
          skipped: [GROUP],
        },
        detail: `conflict: vi has a human edit since the last sync — ${GROUP} reports a conflict, not a sync`,
        conflict: true,
      };
    }
    case "semantic-change":
    case "semantic-change-zh":
    case "mixed-diff": {
      return {
        ...scenario,
        classify: classifyOf(expected),
        draft: { vi: draftFor("vi", viOf(scenario)) },
        expected: {
          synced: [GROUP],
          classified: [GROUP],
          conflicts: [],
          skipped: [],
        },
        detail: `synced: ${name} propagates the semantic change to its locale`,
        conflict: false,
      };
    }
    case "rotation": {
      // The first roster model is scripted to fail, the second to classify.
      // Rotation must pass the failure and let the second model's answer
      // decide the propagation — the whole point of the fix.
      return {
        ...scenario,
        models: "stub-model,stub-model-2",
        classify: "correction|unreachable",
        classifyPerModel: {
          "stub-model": "",
          "stub-model-2": classifyOf(expected),
        },
        draft: { vi: draftFor("vi", viOf(scenario)) },
        expected: {
          synced: [GROUP],
          classified: [GROUP],
          conflicts: [],
          skipped: [],
        },
        detail: `synced: ${name} rotates past the failing first roster model to classify on the second`,
        conflict: false,
      };
    }
    default: {
      return {
        ...scenario,
        classify: "none|no stale locales",
        draft: {},
        expected: { synced: [], classified: [], conflicts: [], skipped: [GROUP] },
        detail: `skipped: ${name} has no stale locale — the run reports it skipped, not synced`,
        conflict: false,
      };
    }
  }
}

/** The draft to script for a locale, admissible and in-script. */
function draftFor(locale: string, current: string): string {
  return current + (locale === "zh" ? zhSection : viSection);
}

const viSection =
  "\n\n## Xác minh cài đặt\n\nMở một vấn đề bằng ngôn ngữ đã định cấu hình. Quy trình làm việc sẽ hoàn thành mà không thay đổi vấn đề khi không có quyền được cấp.";

const zhSection =
  "\n\n## 验证安装\n\n打开一个已配置语言的问题。当没有授予任何能力时，工作流应完成且不更改该问题。";

/** The current locale file the `vi` draft extends. */
function viOf(scenario: Scenario): string {
  const file = scenario.contents.get(`${GROUP}.vi.md`);
  return file?.content ?? "";
}

/** Whether the fixture expects any semantic change to propagate. */
function isSemantic(expected: FixtureExpected): boolean {
  const e = expected.expected;
  return "classifications" in e
    ? e.classifications.some((c) => c.classification === "semantic")
    : e.classification === "semantic";
}

/** The classification answer to script for a fixture. */
function classifyOf(expected: FixtureExpected): string {
  const e = expected.expected;
  return "classifications" in e
    ? e.classifications
        .map((c, index) => `${c.classification}|section ${String(index + 1)}`)
        .join("\n")
    : `${isSemantic(expected) ? "semantic" : "correction"}|the changed section`;
}

/**
 * The answer for one completion request, from the prompt it actually sent.
 *
 * The harmonise stages are distinguishable by their system prompt. The
 * classify stage sends the classification prompt; the draft stage sends the
 * translation prompt; the judge stage only runs when a panel is configured
 * (ours is not, so the best-scored draft wins without one).
 */
export function answering(scenario: Scenario, ask: Ask): Answer {
  if (ask.system.includes("You classify changes in a source document")) {
    const scripted = scenario.classifyPerModel?.[ask.model];
    if (scripted !== undefined) {
      // A model scripted to fail is answered with the outage, not with
      // content: rotation must be driven by the wire, not by a parse.
      return scripted === "" ? failing(503, "overloaded") : saying(scripted);
    }
    return saying(scenario.classify);
  }
  if (ask.system.includes("You update a locale translation to incorporate semantic changes")) {
    return saying(draftFor(scenario.languages === "zh" ? "zh" : "vi", viOf(scenario)));
  }
  return saying("correction|unrecognised stage");
}
