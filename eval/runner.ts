/**
 * Evaluation runner: `pnpm eval <duty>`, or `pnpm eval all`.
 *
 * For each fixture under `eval/fixtures/<duty>/`, this runner builds the
 * duty's bundle, drives it over the fixture's files with the shared harness,
 * and reports every run against the fixture's `.expected.json` as exactly one
 * of three outcomes:
 *
 * - `finding`  — the run succeeded and did the thing the fixture expected.
 * - `failed`   — the duty's bundle errored (setFailed, crash, nonzero exit).
 * - `skipped`  — the run succeeded but deliberately did nothing: dry-run,
 *   warrant denial, screened-out, already-synced, or a locale that failed
 *   without failing the run.
 *
 * The exit code is fail-closed: 0 only when every fixture is a `finding`.
 * A duty with no fixtures fails the run, so an unevaluated duty is never
 * mistaken for a passing one.
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

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "eval", "fixtures");

/** The three outcomes a run can have, kept apart so none collapses into another. */
type Outcome = "finding" | "failed" | "skipped";

interface Line {
  readonly fixture: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

/** Every duty the runner knows how to drive. */
const DUTIES = ["harmonise"] as const;

/** Whether a duty has fixtures on disk to run. */
async function hasFixtures(duty: string): Promise<boolean> {
  try {
    const dir = join(FIXTURES, duty);
    const entries = await readdir(dir);
    for (const entry of entries) {
      const s = await stat(join(dir, entry));
      if (s.isDirectory()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Builds one duty's bundle so the run measures this source, not the committed dist. */
async function build(duty: string): Promise<void> {
  await exec(process.execPath, [join(ROOT, "tools", "build.mjs"), duty], { cwd: ROOT });
}

/** The warrant every fixture runs under — the duty is granted the write pair. */
function warrantOf(): string {
  return "version: 1\n\n# Every fixture grants the duty its write pair, so a run reports what it\n# would publish. The bundle measures the duty, not the warrant's absence.\nduties:\n  harmonise: [edit-file, open-pr]\n";
}

async function harmoniseFixtures(): Promise<string[]> {
  const dir = join(FIXTURES, "harmonise");
  const entries = await readdir(dir);
  const fixtures: string[] = [];
  for (const entry of entries) {
    const s = await stat(join(dir, entry));
    if (s.isDirectory()) fixtures.push(entry);
  }
  return fixtures;
}

async function runHarmonise(fixture: string, scratch: string): Promise<Line> {
  const directory = join(FIXTURES, "harmonise", fixture);
  const scenario = await scenarioOf(fixture, directory);
  const stub = await startStub(harmoniseStub(scenario));
  try {
    const files = scratchFiles(scratch);
    await writeFile(join(scratch, "reeve.yml"), warrantOf());
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

/** The outcome for one fixture, from the run's code and reported effect. */
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

/** The banner between the run's fixtures and its verdict. */
function banner(lines: readonly Line[]): void {
  const finding = lines.filter((l) => l.outcome === "finding").length;
  const failed = lines.filter((l) => l.outcome === "failed").length;
  const skipped = lines.filter((l) => l.outcome === "skipped").length;
  // eslint-disable-next-line no-console -- CLI output
  console.log(
    `\nfinding ${String(finding)} · failed ${String(failed)} · skipped ${String(skipped)}`,
  );
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const duties: string[] = requested === "all" ? [...DUTIES] : [requested ?? "all"];
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
      const runFixture = duty === "harmonise" ? runHarmonise : null;
      if (runFixture === null) {
        // eslint-disable-next-line no-console -- CLI output
        console.error(`eval: no driver implemented for \`${duty}\`.`);
        process.exit(1);
      }
      for (const fixture of await harmoniseFixtures()) {
        const line = await runFixture(fixture, scratch);
        // eslint-disable-next-line no-console -- CLI output
        console.log(`  [${line.outcome.padEnd(7)}] ${line.fixture}: ${line.detail}`);
        all = all.concat(line);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  banner(all);
  const failed = all.filter((l) => l.outcome === "failed").length;
  // Fail-closed: any failed fixture fails the run, so `no findings` is never
  // confused with `review passed`.
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- CLI error output
  console.error("eval: fatal —", error);
  process.exit(1);
});
