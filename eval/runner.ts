/**
 * Evaluation runner: `pnpm eval <duty>`, or `pnpm eval all`.
 *
 * For each fixture under `eval/fixtures/<duty>/`, this runner builds the
 * duty's bundle, drives it over the fixture's inputs with the shared harness,
 * and reports every run against the fixture's `.expected.json` as exactly one
 * of three outcomes:
 *
 * - `finding`  — the run succeeded and did the thing the fixture expected.
 * - `failed`   — the duty's bundle errored (setFailed, crash, nonzero exit).
 * - `skipped`  — the run succeeded but deliberately did nothing: dry-run,
 *   warrant denial, screened-out, already-synced, already-answered, or a
 *   below-floor verdict. Reported as itself, never as a finding.
 *
 * The exit code is fail-closed: 0 only when every fixture is a `finding` and
 * none failed. A duty with no fixtures fails the run, so an unevaluated duty
 * is never mistaken for a passing one.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  completionRoute,
  publishRoutes,
  repoRoutes,
  runBundle,
  saying,
  scratchFiles,
  startStub,
} from "./harness.ts";
import type { Route, Run, StubOptions } from "./harness.ts";
import { answering, scenarioOf } from "./drivers/harmonise.ts";
import type { Scenario } from "./drivers/harmonise.ts";
import {
  newTracker as newTriageTracker,
  scriptTriage,
  scenarioOf as triageScenarioOf,
  triageRoutes,
} from "./drivers/triage.ts";
import type { TriageScenario } from "./drivers/triage.ts";
import {
  newTracker as newRespondTracker,
  respondRoutes,
  scenarioOf as respondScenarioOf,
  scriptRespond,
} from "./drivers/respond.ts";
import type { RespondScenario } from "./drivers/respond.ts";
import {
  newTracker as newTranslateTracker,
  scenarioOf as translateScenarioOf,
  scriptTranslate,
  translateRoutes,
} from "./drivers/translate.ts";
import type { TranslateScenario } from "./drivers/translate.ts";
import {
  duplicateRoutes,
  newTracker as newDuplicateTracker,
  scenarioOf as duplicateScenarioOf,
  scriptDuplicate,
} from "./drivers/duplicate.ts";
import type { DuplicateScenario } from "./drivers/duplicate.ts";
import {
  lifecycleRoutes,
  newTracker as newLifecycleTracker,
  scenarioOf as lifecycleScenarioOf,
} from "./drivers/lifecycle.ts";
import type { LifecycleScenario } from "./drivers/lifecycle.ts";
import {
  dependaRoutes,
  scenarioOf as dependaScenarioOf,
  scriptDependa,
} from "./drivers/dependa.ts";
import type { DependaScenario } from "./drivers/dependa.ts";
import {
  newTracker as newReviewTracker,
  reviewRoutes,
  scenarioOf as reviewScenarioOf,
  scriptReview,
} from "./drivers/review.ts";
import type { ReviewEffect, ReviewScenario } from "./drivers/review.ts";
// The exit gate lives in `./exit-code.ts`, side-effect-free, so the contract
// suite pins every outcome→exit-code pairing without spawning a run.
import { exitCodeFor } from "./exit-code.ts";
import type { Line } from "./exit-code.ts";
// The language dimension of a fixture, decided apart from its effects — a
// declared language that was misidentified makes the run `failed`, never a
// clean stop. See `./language.ts`.
import { languageLine } from "./language.ts";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "eval", "fixtures");

/** Every duty the runner knows how to drive. */
const DUTIES = [
  "harmonise",
  "triage",
  "respond",
  "translate",
  "duplicate",
  "lifecycle",
  "dependa",
  "review",
] as const;

/**
 * Fixture discovery — extracted to `./fixtures.ts` so the contract suite can
 * pin it without importing the runner. Imported locally so `main()` below can
 * call it, and re-exported for any caller that wants it without the runner's
 * side effects.
 */
import { fixturesFor as discoverFixtures, hasFixtures as dutyHasFixtures } from "./fixtures.ts";
export { fixturesFor as discoverFixtures, hasFixtures as dutyHasFixtures } from "./fixtures.ts";

/** Builds one duty's bundle so the run measures this source, not the committed dist. */
async function build(duty: string): Promise<void> {
  await exec(process.execPath, [join(ROOT, "tools", "build.mjs"), duty], { cwd: ROOT });
}

/** The warrant harmonise fixtures run under — the write pair, granted. */
function harmoniseWarrant(): string {
  return "version: 1\n\n# Every fixture grants its duty the write pair, so a run reports what it\n# would publish. The bundle measures the duty, not the warrant's absence.\nduties:\n  harmonise: [edit-file, open-pr]\n";
}

async function runHarmonise(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "harmonise", fixture);
  const scenario = await scenarioOf(fixture, directory);
  const stub = await startStub(harmoniseStub(scenario));
  try {
    const files = scratchFiles(scratch);
    await writeFile(join(scratch, "reeve.yml"), harmoniseWarrant());
    const run = await runBundle(
      "harmonise",
      stub.url,
      harmoniseInputs(stub.url, scenario, scratch),
      files,
    );
    return harmoniseLine(fixture, scenario, run);
  } finally {
    await stub.close();
  }
}

function harmoniseStub(scenario: Scenario): StubOptions {
  const routes: Route[] = [
    ...repoRoutes(scenario.contents),
    ...publishRoutes(scenario.contents),
    completionRoute((ask) => answering(scenario, ask.system)),
  ];
  return { routes, completion: () => saying("stub") };
}

function harmoniseInputs(
  stubUrl: string,
  scenario: Scenario,
  scratch: string,
): Record<string, string> {
  const warrantPath = join(scratch, "reeve.yml");
  return {
    "github-token": "stub-token",
    "base-url": `${stubUrl}/v1`,
    "api-key": "sk-stub-key",
    models: "stub-model",
    "judge-models": "",
    "source-language": "en",
    languages: scenario.languages,
    warrant: warrantPath,
    drafts: "1",
    "provenance-dir": ".reeve/provenance",
    "state-branch": "",
    "glossary-dir": ".reeve/glossary.yml",
    paths: "",
    "max-requests": "none",
    "chunk-chars": "0",
    ignore: "true",
    "dry-run": "false",
    sweep: "false",
    // `threadNumber()` requires a real number or a triggered thread — the
    // `issues` event carries none, so every run names one explicitly.
    number: "1",
    since: "",
    limit: "none",
    endpoints: "",
    "api-keys": "",
    "request-timeout": "120s",
    temperature: "",
  };
}

/** The outcome for one harmonise fixture, from the run's code and reported effect. */
function harmoniseLine(fixture: string, scenario: Scenario, run: Run): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const classified = parseIds(run.outputs.classified);
  const synced = parseIds(run.outputs.synced);
  const conflicts = parseConflicts(run.outputs.conflicts);
  const skipped = parseIds(run.outputs.skipped);

  const expected = scenario.expected;
  const matches =
    idsEqual(synced, expected.synced) &&
    idsEqual(classified, expected.classified) &&
    idsEqual(skipped, expected.skipped) &&
    conflictsEqual(conflicts, expected.conflicts);

  return matches
    ? { fixture, outcome: "finding", detail: scenario.detail }
    : {
        fixture,
        outcome: "skipped",
        detail: `effect mismatch — synced=${run.outputs.synced ?? ""}`,
      };
}

/** The `Done` object the triage `applied` output holds — its labels, in order. */
function parseDone(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const labels = (parsed as { labels?: unknown }).labels;
    if (!Array.isArray(labels)) return [];
    return labels.filter((label): label is string => typeof label === "string");
  } catch {
    return [];
  }
}

/** The group-ids array a harmonise output holds. */
function parseIds(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** The `{group, locales}` array the conflicts output holds. */
function parseConflicts(raw: string | undefined): readonly { group: string; locales: string[] }[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is { group: string; locales: string[] } =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { group?: unknown }).group === "string" &&
        Array.isArray((e as { locales?: unknown }).locales),
    );
  } catch {
    return [];
  }
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function conflictsEqual(
  left: readonly { group: string; locales: string[] }[],
  right: readonly { group: string; locales: readonly string[] }[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined) return false;
    if (a.group !== b.group || !idsEqual(a.locales, b.locales)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// triage
// ---------------------------------------------------------------------------

async function runTriage(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "triage", fixture);
  const scenario = await triageScenarioOf(fixture, directory);
  const tracker = newTriageTracker();
  const stub = await startStub({
    routes: [...triageRoutes(scenario, tracker)],
    completion: scriptTriage(scenario),
  });
  try {
    // An explicit fixture warrant is written to the scratch, so an absent
    // `warrant` (the implicit one) is a genuine cold start the run measures.
    if (scenario.warrant !== null) {
      await writeFile(join(scratch, `warrant-${fixture}.yml`), scenario.warrant);
    }
    const run = await runBundle(
      "triage",
      stub.url,
      triageInputs(stub.url, scratch, scenario, fixture),
      scratchFiles(scratch),
    );
    return triageLine(fixture, scenario, tracker.effect, run);
  } finally {
    await stub.close();
  }
}

const TRIAGE_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "stub-model",
  "screen-models": "",
  warrant: "",
  confidence: "0.75",
  "corrections-dir": "",
  "min-body-chars": "40",
  "max-body-chars": "6000",
  about: "",
  "dry-run": "false",
  sweep: "false",
  since: "",
  limit: "50",
  "sweep-state": "open",
  "state-branch": "",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

function triageInputs(
  stubUrl: string,
  scratch: string,
  scenario: TriageScenario,
  fixture: string,
): Record<string, string> {
  const warrantPath = join(scratch, `warrant-${fixture}.yml`);
  return {
    ...TRIAGE_INPUTS,
    "base-url": `${stubUrl}/v1`,
    // `corrections-dir` is read `{ required: true }` and doubles as a Contents
    // API path, so it must be repo-relative — an absolute scratch path is
    // refused. A directory the repository does not have is the cold start
    // `readStore` already treats as an empty store, `.reeve/corrections`.
    "corrections-dir": ".reeve/corrections",
    ...(scenario.warrant === null ? {} : { warrant: warrantPath }),
    ...(scenario.inputs ?? {}),
  };
}

/** The outcome for one triage fixture. */
function triageLine(
  fixture: string,
  scenario: TriageScenario,
  tracker: TrackerEffectLike,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;

  // A fixture that declares effects asserts them; one that omits them asserts
  // a clean no-op — the two shapes can never be confused because a delegated
  // write and a skipped one disagree on every key.
  const effect = expected.effects ?? { applied: [], commented: false, assigned: [], closed: false };
  const effectsMatch =
    idsEqual(effect.applied, tracker.applied) &&
    effect.commented === tracker.commented &&
    idsEqual(effect.assigned.slice(), tracker.assigned) &&
    effect.closed === tracker.closed;

  const screened = run.outputs["screened-out"] ?? "";
  const duplicate = run.outputs["duplicate-of"] ?? "";
  const applied = parseDone(run.outputs.applied);
  const names = expected["applied-names"];

  const screenedMatch = (expected["screened-out"] ?? "") === screened;
  const duplicateMatch = String(expected["duplicate-of"] ?? "") === duplicate;
  const namesMatch = names === undefined ? true : idsEqual(names, applied);

  const finding = effectsMatch && screenedMatch && duplicateMatch && namesMatch;
  const detail = `screened="${screened}" duplicate="${duplicate}" applied=${JSON.stringify(applied)}`;

  // The language dimension wins over both: a thread the pipeline identified as
  // the wrong language was handled wrong, and that can never be a clean stop.
  const language = languageLine(fixture, expected.language, run.outputs.language ?? "");
  if (language !== null) return language;

  if (finding) {
    const detailText =
      expected.effects === undefined
        ? `clean stop — ${screened === "" ? "nothing applied, nothing written" : `screened out as \`${screened}\``}`
        : `applied ${JSON.stringify(applied)}, commented, closed=${String(tracker.closed)}`;
    return { fixture, outcome: "finding", detail: detailText };
  }
  return { fixture, outcome: "skipped", detail };
}

interface TrackerEffectLike {
  readonly applied: readonly string[];
  readonly commented: boolean;
  readonly assigned: readonly string[];
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

async function runRespond(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "respond", fixture);
  const scenario = await respondScenarioOf(fixture, directory);
  const tracker = newRespondTracker();
  const stub = await startStub({
    routes: [...respondRoutes(scenario, tracker)],
    completion: scriptRespond(scenario),
  });
  try {
    if (scenario.warrant !== null) {
      await writeFile(join(scratch, `warrant-${fixture}.yml`), scenario.warrant);
    }
    const run = await runBundle(
      "respond",
      stub.url,
      respondInputs(stub.url, scratch, scenario, fixture),
      scratchFiles(scratch),
    );
    return respondLine(fixture, scenario, tracker.effect.commented, run);
  } finally {
    await stub.close();
  }
}

const RESPOND_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "stub-model",
  "judge-models": "",
  drafts: "1",
  warrant: "",
  confidence: "0.75",
  guidance: "",
  "screen-models": "",
  about: "",
  "corrections-dir": "",
  "max-body-chars": "6000",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
  "dry-run": "false",
};

function respondInputs(
  stubUrl: string,
  scratch: string,
  scenario: RespondScenario,
  fixture: string,
): Record<string, string> {
  const warrantPath = join(scratch, `warrant-${fixture}.yml`);
  return {
    ...RESPOND_INPUTS,
    "base-url": `${stubUrl}/v1`,
    "corrections-dir": ".reeve/corrections",
    ...(scenario.warrant === null ? {} : { warrant: warrantPath }),
    ...(scenario.inputs ?? {}),
  };
}

/** The outcome for one respond fixture. */
function respondLine(
  fixture: string,
  scenario: RespondScenario,
  commented: boolean,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const wantedCommented = expected.effects?.commented ?? false;
  // The respond duty writes every outcome the same way in outputs — `false`
  // for `responded`, nothing for `respond-text` — and explains a stop only
  // on the summary page, in the `### Verdict` note. That note is the one
  // place a spam stop and a human-reply stop are told apart, so the fixture
  // asserts a `stopped-for` phrase against it.
  const patch = run.outputs["respond-text"] ?? "";
  const verdict = run.summary.includes("### Verdict")
    ? run.summary.slice(run.summary.indexOf("### Verdict"))
    : run.summary;

  const commentedMatch = commented === wantedCommented;
  const stoppedFor = expected["stopped-for"];
  const stoppedMatch = stoppedFor === undefined ? true : verdict.includes(stoppedFor);
  const patchMatch =
    expected.patch === undefined || expected.patch === null
      ? patch === ""
      : expected.patch.trim() === patch.trim();

  const finding = commentedMatch && stoppedMatch && patchMatch;

  // The language dimension wins over both: a thread the pipeline identified as
  // the wrong language was handled wrong, and that can never be a clean stop.
  const language = languageLine(fixture, expected.language, run.outputs.language ?? "");
  if (language !== null) return language;

  if (finding) {
    const detailText =
      commented && wantedCommented
        ? "posted the first reply"
        : expected.effects === undefined
          ? `clean stop — ${stoppedFor === undefined ? "nothing drafted, nothing posted" : `stopped for \`${stoppedFor}\``}`
          : "no comment (correctly)";
    return { fixture, outcome: "finding", detail: detailText };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `commented=${String(commented)} stopped="${stoppedFor ?? ""}" patch=${JSON.stringify(patch)}`,
  };
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

async function runTranslate(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "translate", fixture);
  const scenario = await translateScenarioOf(fixture, directory);
  const tracker = newTranslateTracker();
  const stub = await startStub({
    routes: [...translateRoutes(scenario, tracker)],
    completion: scriptTranslate(scenario),
  });
  try {
    const warrant = join(scratch, `warrant-${fixture}.yml`);
    if (scenario.warrant !== null) await writeFile(warrant, scenario.warrant);
    const run = await runBundle(
      "translate",
      stub.url,
      translateInputs(stub.url, warrant),
      scratchFiles(scratch),
    );
    return translateLine(fixture, scenario, tracker.effect.edited, run);
  } finally {
    await stub.close();
  }
}

const TRANSLATE_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "stub-model",
  warrant: "",
  "judge-models": "",
  drafts: "1",
  "max-body-chars": "6000",
  "translate-replies": "false",
  "max-replies": "100",
  "chunk-chars": "6000",
  "max-requests": "none",
  "show-attribution": "none",
  "dry-run": "false",
  sweep: "false",
  since: "",
  limit: "50",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

function translateInputs(stubUrl: string, warrant: string): Record<string, string> {
  return {
    ...TRANSLATE_INPUTS,
    "base-url": `${stubUrl}/v1`,
    warrant,
  };
}

/** The outcome for one translate fixture. */
function translateLine(
  fixture: string,
  scenario: TranslateScenario,
  edited: boolean,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const translated = parseIds(run.outputs.translated);
  const expectedTranslated = expected.translated ?? [];
  const expectedEdited = expected.effects?.edited ?? false;
  const source = run.outputs["source-language"] ?? "";
  const sourceMatches = source === (expected["source-language"] ?? "");
  const finding =
    idsEqual(translated, expectedTranslated) && sourceMatches && edited === expectedEdited;

  if (finding) {
    const detail = expectedEdited
      ? `published ${translated.join(", ")}`
      : `clean stop — ${scenario.alreadyTranslated ? "already translated" : "warrant denies translate"}`;
    return { fixture, outcome: "finding", detail };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `translated=${JSON.stringify(translated)} source=${JSON.stringify(source)} edited=${String(edited)}`,
  };
}

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

async function runDuplicate(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "duplicate", fixture);
  const scenario = await duplicateScenarioOf(fixture, directory);
  const tracker = newDuplicateTracker();
  const stub = await startStub({
    routes: [...duplicateRoutes(scenario, tracker)],
    completion: scriptDuplicate(scenario),
  });
  try {
    const warrant = join(scratch, `warrant-${fixture}.yml`);
    if (scenario.warrant !== null) await writeFile(warrant, scenario.warrant);
    const run = await runBundle(
      "duplicate",
      stub.url,
      duplicateInputs(stub.url, warrant),
      scratchFiles(scratch),
    );
    return duplicateLine(fixture, scenario, tracker.effect.commented, run);
  } finally {
    await stub.close();
  }
}

const DUPLICATE_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "stub-model",
  warrant: "",
  confidence: "0.75",
  candidates: "5",
  "corpus-limit": "50",
  "corpus-since": "",
  "max-body-chars": "6000",
  "show-attribution": "none",
  "dry-run": "false",
  sweep: "false",
  since: "",
  limit: "50",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

function duplicateInputs(stubUrl: string, warrant: string): Record<string, string> {
  return {
    ...DUPLICATE_INPUTS,
    "base-url": `${stubUrl}/v1`,
    warrant,
  };
}

/** The outcome for one duplicate fixture. */
function duplicateLine(
  fixture: string,
  scenario: DuplicateScenario,
  commented: boolean,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const duplicate = run.outputs["duplicate-of"] ?? "";
  const score = run.outputs.score ?? "";
  const expectedComments = expected.effects?.commented ?? false;
  const finding =
    duplicate === (expected["duplicate-of"] ?? "") &&
    score === (expected.score ?? "") &&
    commented === expectedComments;

  if (finding) {
    const detail = expectedComments
      ? `proposed #${duplicate}`
      : `clean stop — ${duplicate === "" ? "warrant denies duplicate" : `#${duplicate} named but ${score} under the floor`}`;
    return { fixture, outcome: "finding", detail };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `duplicate-of=${duplicate} score=${score} commented=${String(commented)}`,
  };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function runLifecycle(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "lifecycle", fixture);
  const scenario = await lifecycleScenarioOf(fixture, directory);
  const tracker = newLifecycleTracker();
  const stub = await startStub({
    routes: [...lifecycleRoutes(scenario, tracker)],
    // lifecycle never calls a model, so this completion is never reached — it
    // exists only because the harness requires one to be mounted.
    completion: () => saying("unused"),
  });
  try {
    await writeFile(join(scratch, "reeve.yml"), scenario.warrant);
    const run = await runBundle(
      "lifecycle",
      stub.url,
      lifecycleInputs(scratch),
      scratchFiles(scratch),
    );
    return lifecycleLine(fixture, scenario, tracker.effect, run);
  } finally {
    await stub.close();
  }
}

const LIFECYCLE_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  // lifecycle never calls a model — the shared provider inputs are not read,
  // and the interface requires none. The input set is only the ones
  // `readSettings` reads.
  warrant: "",
  "dry-run": "false",
  sweep: "false",
  since: "",
  limit: "50",
};

function lifecycleInputs(scratch: string): Record<string, string> {
  return { ...LIFECYCLE_INPUTS, warrant: join(scratch, "reeve.yml") };
}

// ---------------------------------------------------------------------------
// dependa
// ---------------------------------------------------------------------------

async function runDependa(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "dependa", fixture);
  const scenario = await dependaScenarioOf(fixture, directory);
  const stub = await startStub({
    routes: dependaRoutes(scenario),
    completion: scriptDependa(),
  });
  try {
    const warrant = join(scratch, `warrant-dependa-${fixture}.yml`);
    await writeFile(warrant, scenario.warrant);
    const run = await runBundle(
      "dependa",
      stub.url,
      dependaInputs(stub.url, warrant),
      scratchFiles(scratch),
    );
    return dependaLine(fixture, scenario, run);
  } finally {
    await stub.close();
  }
}

const DEPENDA_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "",
  warrant: "",
  ecosystems: "",
  drafts: "0",
  "dry-run": "false",
  "max-requests": "none",
  paths: "",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

function dependaInputs(stubUrl: string, warrant: string): Record<string, string> {
  return {
    ...DEPENDA_INPUTS,
    "base-url": `${stubUrl}/v1`,
    warrant,
  };
}

/** The outcome for one dependa fixture. */
function dependaLine(fixture: string, scenario: DependaScenario, run: Run): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const proposed = run.outputs.proposed ?? "";
  const refused = run.outputs.refused ?? "";
  const security = run.outputs.security ?? "";
  const pullRequests = run.outputs["pull-requests"] ?? "";
  const starved = run.outputs.starved ?? "";
  const budgetExhausted = run.outputs["budget-exhausted"] ?? "";

  const finding =
    proposed === (expected.proposed ?? "[]") &&
    refused === (expected.refused ?? "[]") &&
    security === (expected.security ?? "[]") &&
    pullRequests === (expected["pull-requests"] ?? "[]") &&
    starved === (expected.starved ?? "false") &&
    budgetExhausted === (expected["budget-exhausted"] ?? "false");

  if (finding) {
    return {
      fixture,
      outcome: "finding",
      detail: `clean stop — nothing proposed (${JSON.stringify(proposed)})`,
    };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `proposed=${JSON.stringify(proposed)} refused=${JSON.stringify(refused)} security=${JSON.stringify(security)} pull-requests=${JSON.stringify(pullRequests)}`,
  };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

async function runReview(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "review", fixture);
  const scenario = await reviewScenarioOf(fixture, directory);
  const tracker = newReviewTracker();
  const stub = await startStub({
    routes: reviewRoutes(scenario, tracker),
    completion: scriptReview(scenario),
  });
  try {
    const warrant = join(scratch, `warrant-review-${fixture}.yml`);
    await writeFile(warrant, scenario.warrant);
    // The rules file lives in the checkout — the run reads it from
    // `GITHUB_WORKSPACE`, so the fixture's rules are written there.
    await mkdir(join(scratch, ".github"), { recursive: true });
    if (scenario.rules === null) {
      await writeFile(join(scratch, ".github", "reeve-rules.yml"), "");
    } else {
      await writeFile(join(scratch, ".github", "reeve-rules.yml"), scenario.rules);
    }
    const run = await runBundle(
      "review",
      stub.url,
      reviewInputs(stub.url, warrant, scenario.profile),
      scratchFiles(scratch),
      { GITHUB_WORKSPACE: scratch },
    );
    return reviewLine(fixture, scenario, tracker.effect, run);
  } finally {
    await stub.close();
  }
}

const REVIEW_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "sk-stub-key",
  models: "stub-model",
  warrant: "",
  "rules-path": ".github/reeve-rules.yml",
  trigger: "pr",
  "max-diff-chars": "none",
  confidence: "0.75",
  "dry-run": "false",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
  profile: "default",
};

function reviewInputs(
  stubUrl: string,
  warrant: string,
  profile = "default",
): Record<string, string> {
  return {
    ...REVIEW_INPUTS,
    "base-url": `${stubUrl}/v1`,
    warrant,
    ...(profile === "default" ? {} : { profile }),
  };
}

/** The outcome for one review fixture. */
function reviewLine(
  fixture: string,
  scenario: ReviewScenario,
  effect: ReviewEffect,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const echoed = run.outputs.commented ?? "";
  const findings = run.outputs.findings ?? "";
  const headSha = run.outputs["head-sha"] ?? "";
  const finding =
    echoed === (expected.commented ?? "false") &&
    findings === (expected.findings ?? "0") &&
    headSha === (expected["head-sha"] ?? "") &&
    effect.commented === (expected.commented === "true") &&
    // A fixture that pins the update path asserts the run PATCHed its own
    // previous comment rather than POSTing a second one.
    (expected.wrote === undefined || effect.wrote === expected.wrote) &&
    // A fixture that pins verification asserts the evidence engine ran and
    // produced the expected count, read off the summary's `| Verification |`
    // row.
    (expected.verified === undefined || verifiedFromSummary(run.summary) === expected.verified);

  // The language dimension wins over both: a pull request the pipeline
  // identified as the wrong language was handled wrong, and that can never be
  // a clean stop — the same fail-closed pairing the thread duties' `language`
  // assertion uses, read off the summary's `| Language | <code> |` row.
  if (expected.language !== undefined) {
    const identified = languageFromSummary(run.summary);
    if (identified !== expected.language) {
      return {
        fixture,
        outcome: "failed",
        detail: `identified the pull request as \`${identified}\`; fixture expects \`${expected.language}\``,
      };
    }
  }

  if (expected.verified !== undefined) {
    const verified = verifiedFromSummary(run.summary);
    if (verified !== expected.verified) {
      return {
        fixture,
        outcome: "failed",
        detail: `verified ${verified} finding(s); fixture expects ${expected.verified}`,
      };
    }
  }

  if (finding) {
    const detail = effect.commented
      ? `${effect.wrote === "patch" ? "replaced" : "posted"} ${findings} finding(s) — comments: ${echoed}`
      : `clean stop — ${echoed === "false" ? "warrant denies review" : "nothing posted"}`;
    return { fixture, outcome: "finding", detail };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `commented=${JSON.stringify(echoed)} findings=${JSON.stringify(findings)} head-sha=${JSON.stringify(headSha)} wrote=${JSON.stringify(effect.wrote)}`,
  };
}

/**
 * The language code a review run identified, off its summary's `| Language | id |` row.
 *
 * `cell()` only escapes `\`, `|` and newlines — it does not backtick-wrap — so
 * the code stands bare in the value column. An unidentified run renders
 * "not identified", which reads as no code.
 */
function languageFromSummary(summary: string): string {
  const row = /^\|\s*Language\s*\|\s*([^|]+?)\s*\|$/m.exec(summary);
  if (row?.[1] === undefined) return "";
  const code = row[1];
  if (code === "not identified") return "";
  return code;
}

/**
 * The number of findings a review run verified, off its summary's
 * `| Verification | N verified · M not verified |` row. A run with no
 * verification row reads as no verified findings.
 */
function verifiedFromSummary(summary: string): string {
  const row = /^\|\s*Verification\s*\|\s*(\d+)\s*verified/m.exec(summary);
  if (row?.[1] === undefined) return "0";
  return row[1];
}

/** The outcome for one lifecycle fixture. */
function lifecycleLine(
  fixture: string,
  scenario: LifecycleScenario,
  effect: LifecycleEffectLike,
  run: Run,
): Line {
  if (run.code !== 0)
    return { fixture, outcome: "failed", detail: `bundle exited ${String(run.code)}` };

  const expected = scenario.expected;
  const skipped = run.outputs.skipped ?? "";
  const reminded = run.outputs.reminded ?? "";
  const labeled = run.outputs.labeled ?? "";
  const closed = run.outputs.closed ?? "";
  const unstaled = run.outputs.unstaled ?? "";
  const dueNotGranted = run.outputs["due-not-granted"] ?? "";

  const effects = expected.effects ?? {};
  const effectsMatch =
    (effects.labeled ?? false) === effect.labeled &&
    (effects.commented ?? false) === effect.commented &&
    (effects.closed ?? false) === effect.closed &&
    (effects.unstaled ?? false) === effect.unstaled;

  const finding =
    skipped === (expected.skipped ?? "") &&
    reminded === (expected.reminded ?? "") &&
    labeled === (expected.labeled ?? "") &&
    closed === (expected.closed ?? "") &&
    unstaled === (expected.unstaled ?? "") &&
    dueNotGranted === (expected["due-not-granted"] ?? "") &&
    effectsMatch;

  if (finding) {
    const detail =
      expected.skipped === "true"
        ? "clean stop — warrant writes no lifecycle policy"
        : effect.closed
          ? "closed"
          : effect.commented
            ? "reminded"
            : effect.labeled
              ? "labeled"
              : effect.unstaled
                ? "unstaled"
                : "evaluated, nothing due";
    return { fixture, outcome: "finding", detail };
  }
  return {
    fixture,
    outcome: "skipped",
    detail: `skipped=${skipped} reminded=${reminded} labeled=${labeled} closed=${closed} unstaled=${unstaled}`,
  };
}

interface LifecycleEffectLike {
  readonly labeled: boolean;
  readonly commented: boolean;
  readonly closed: boolean;
  readonly unstaled: boolean;
}

// ---------------------------------------------------------------------------
// The banner and the run.
// ---------------------------------------------------------------------------

/** Counts per outcome, then the aggregate verdict line. */
function banner(lines: readonly Line[]): void {
  const finding = lines.filter((l) => l.outcome === "finding").length;
  const failed = lines.filter((l) => l.outcome === "failed").length;
  const skipped = lines.filter((l) => l.outcome === "skipped").length;
  // eslint-disable-next-line no-console -- CLI output
  console.log(
    `\nfinding ${String(finding)} · failed ${String(failed)} · skipped ${String(skipped)}`,
  );
}

/** Maps a duty to its driver. */
function driverFor(duty: string): ((fixture: string, scratch: string) => Promise<Line>) | null {
  switch (duty) {
    case "harmonise":
      return runHarmonise;
    case "triage":
      return runTriage;
    case "respond":
      return runRespond;
    case "translate":
      return runTranslate;
    case "duplicate":
      return runDuplicate;
    case "lifecycle":
      return runLifecycle;
    case "dependa":
      return runDependa;
    case "review":
      return runReview;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const duties: readonly string[] = requested === "all" ? DUTIES : [requested ?? "all"];
  if (
    requested !== undefined &&
    requested !== "all" &&
    !(DUTIES as readonly string[]).includes(requested)
  ) {
    // eslint-disable-next-line no-console -- CLI output
    console.error(`eval: unknown duty \`${requested}\`. Known: ${DUTIES.join(", ")} or all.`);
    process.exit(2);
  }

  const scratch = await mkdtemp(join(tmpdir(), "reeve-eval-"));
  let all: Line[] = [];
  try {
    for (const duty of duties) {
      if (!(await dutyHasFixtures(duty, FIXTURES))) {
        // eslint-disable-next-line no-console -- CLI output
        console.error(`eval: no fixtures for \`${duty}\` under ${FIXTURES}/${duty} — add some.`);
        process.exit(1);
      }
      // eslint-disable-next-line no-console -- CLI output
      console.log(`eval: ${duty} — building…`);
      await build(duty);
      // eslint-disable-next-line no-console -- CLI output
      console.log(`eval: ${duty} — running fixtures…`);
      const runFixture = driverFor(duty);
      if (runFixture === null) {
        // eslint-disable-next-line no-console -- CLI output
        console.error(`eval: no driver implemented for \`${duty}\`.`);
        process.exit(1);
      }
      for (const fixture of await discoverFixtures(duty, FIXTURES)) {
        const line = await runFixture(fixture, scratch);
        // eslint-disable-next-line no-console -- CLI output
        console.log(`  [${line.outcome.padEnd(7)}] ${duty}/${fixture}: ${line.detail}`);
        all = all.concat(line);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  banner(all);
  // Fail-closed: 0 only when every fixture was a finding and none failed or
  // skipped. A skipped fixture means the run deliberately did nothing — a
  // duty the warrant no longer grants reads as `skipped` everywhere, and that
  // must not look like a passing run at the CI gate. Pinned by the contract
  // suite in `exit-code.ts`.
  process.exitCode = exitCodeFor(all);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- CLI error output
  console.error("eval: fatal —", error);
  process.exit(1);
});
