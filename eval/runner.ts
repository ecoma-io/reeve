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
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
// The exit gate lives in `./exit-code.ts`, side-effect-free, so the contract
// suite pins every outcome→exit-code pairing without spawning a run.
import { exitCodeFor } from "./exit-code.ts";
import type { Line } from "./exit-code.ts";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "eval", "fixtures");

/** Every duty the runner knows how to drive. */
const DUTIES = ["harmonise", "triage", "respond"] as const;

/** Whether a duty has fixtures on disk to run. */
async function hasFixtures(duty: string): Promise<boolean> {
  try {
    const entries = await readdir(join(FIXTURES, duty));
    for (const entry of entries) {
      const s = await stat(join(FIXTURES, duty, entry));
      if (s.isDirectory()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The fixture names under one duty, in listing order. */
async function fixturesFor(duty: string): Promise<string[]> {
  const entries = await readdir(join(FIXTURES, duty));
  const fixtures: string[] = [];
  for (const entry of entries) {
    const s = await stat(join(FIXTURES, duty, entry));
    if (s.isDirectory()) fixtures.push(entry);
  }
  return fixtures;
}

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
      if (!(await hasFixtures(duty))) {
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
      for (const fixture of await fixturesFor(duty)) {
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
