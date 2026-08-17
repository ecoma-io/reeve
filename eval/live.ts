/**
 * The maintainer's register of evaluation: a real provider, run deliberately.
 *
 * `pnpm eval <duty>` (the runner) measures against the stub harness — every
 * completion is scripted, so a fork's PR needs no secrets and the fail-closed
 * gate runs on every push. This file is the other half the evaluation doc
 * promises: the same duties over the same fixtures, but with the completion
 * endpoint pointed at a real provider, for the accuracy number the CI gate
 * cannot measure. The GitHub side of the world stays stubbed (the fixture
 * routes still serve their threads and PRs); only the provider is real.
 *
 * Run it from the repository root, with the provider in the environment:
 *
 *   REEVE_EVAL_BASE_URL=http://localhost:20128/v1 \
 *   REEVE_EVAL_API_KEY=sk-... \
 *   REEVE_EVAL_MODELS=oc/deepseek-v4-flash-free \
 *   node --experimental-strip-types eval/live.ts
 *
 * The number it prints is the worst-language headline: for each language a
 * fixture declared, how often the duty identified it right, then the lowest
 * of those rates — the language that costs the maintainer the most, never the
 * average. A duty that only ever saw one language reports one number.
 *
 * A provider is never hardcoded here and never committed; the key lives only
 * in the environment. The numbers it produces are committed — see
 * docs/development/evaluation.md.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runBundle, saying, scratchFiles, startStub } from "./harness.ts";
import type { Ask, Run } from "./harness.ts";
import { fixturesFor as discoverFixtures } from "./fixtures.ts";
import {
  scenarioOf as triageScenarioOf,
  triageRoutes,
  newTracker as newTriageTracker,
} from "./drivers/triage.ts";
import {
  scenarioOf as respondScenarioOf,
  respondRoutes,
  newTracker as newRespondTracker,
} from "./drivers/respond.ts";
import {
  scenarioOf as reviewScenarioOf,
  reviewRoutes,
  newTracker as newReviewTracker,
} from "./drivers/review.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "eval", "fixtures");

/** The provider's endpoint, key and model, read once from the environment. */
function provider(): { baseUrl: string; apiKey: string; models: string } {
  const baseUrl = process.env.REEVE_EVAL_BASE_URL ?? "";
  const apiKey = process.env.REEVE_EVAL_API_KEY ?? "";
  const models = process.env.REEVE_EVAL_MODELS ?? "";
  if (baseUrl.length === 0) {
    throw new Error(
      "live: REEVE_EVAL_BASE_URL is not set — point it at the provider, e.g. http://localhost:20128/v1",
    );
  }
  if (models.length === 0) {
    throw new Error(
      "live: REEVE_EVAL_MODELS is not set — name the model to measure, e.g. oc/deepseek-v4-flash-free",
    );
  }
  return { baseUrl, apiKey, models };
}

/**
 * The completion the stub would script — but never does. Every completion a
 * run makes goes to the real provider (`base-url` points at it), so this
 * route is a type-shaped null: it exists because `startStub` requires a
 * completion handler, and it can never be reached because the bundle's
 * completions never go to the stub.
 */
function stubCompletion(_ask: Ask): ReturnType<typeof saying> {
  return saying("");
}

/**
 * The inputs one duty run gets, in the same shape the runner builds them, with
 * the provider's endpoint/key/model swapped in and the GitHub stub's left as
 * the runner leaves them. `base-url` is the only line that differs from the
 * CI register — that is the whole point of this file.
 *
 * `warrantPath` is written (and set) only when the fixture declares a warrant;
 * an absent one is a genuine cold start, exactly as the runner treats it.
 */
function liveInputs(
  base: Record<string, string>,
  stubUrl: string,
  overrides: Record<string, string>,
  warrantPath: string | null,
): Record<string, string> {
  const warrant = warrantPath === null ? {} : { warrant: warrantPath };
  return { ...base, "base-url": `${stubUrl}/v1`, ...warrant, ...overrides };
}

/** The fixtures of one duty, in the fixture set's own order. */
async function fixturesOf(duty: string): Promise<string[]> {
  return discoverFixtures(duty, FIXTURES);
}

/** One measurement: the language the run identified, and whether it ran. */
interface Sample {
  readonly fixture: string;
  readonly duty: string;
  readonly expected: string | undefined;
  readonly identified: string;
  /** The label of the language this fixture declared, or "" for "not declared". */
  readonly ran: boolean;
  readonly code: number | null;
}

async function main(): Promise<void> {
  const p = provider();
  const requested = process.argv[2] ?? "all";
  const duties = requested === "all" ? ["triage", "respond", "review"] : [requested];

  const scratch = await mkdtemp(join(tmpdir(), "reeve-live-"));
  const samples: Sample[] = [];
  try {
    for (const duty of duties) {
      // eslint-disable-next-line no-console -- CLI measurement output
      console.log(`live: ${duty} — building…`);
      await build(duty);
      for (const fixture of await fixturesOf(duty)) {
        // eslint-disable-next-line no-console -- CLI measurement output
        console.log(`live: ${duty}/${fixture} — measuring…`);
        const sample = await measureOne(duty, fixture, scratch, p);
        samples.push(sample);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  report(samples);
}

/** Build one duty's bundle, exactly as the runner does, so a stale dist is never measured. */
async function build(duty: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, [join(ROOT, "tools", "build.mjs"), duty], {
    cwd: ROOT,
  });
}

/** Run one fixture against the real provider, reading the language it identified. */
async function measureOne(
  duty: string,
  fixture: string,
  scratch: string,
  p: { baseUrl: string; apiKey: string; models: string },
): Promise<Sample> {
  const directory = join(FIXTURES, duty, fixture);
  const base: Record<string, string> =
    duty === "triage" ? TRIAGE_INPUTS : duty === "respond" ? RESPOND_INPUTS : REVIEW_INPUTS;

  const expected = await expectedLanguage(directory);
  const overrides = { "base-url": p.baseUrl, "api-key": p.apiKey, models: p.models };

  // A throttled provider can abort a language-identifying run before the
  // language is ever written (free tiers 429 on a moment's notice), which
  // would otherwise read as a misidentification — the exact thing this
  // register exists to detect. Retry only a bounded number of times and only
  // while the run came back with no language at all; a model that actively
  // identified the wrong language is measured on the first pass.
  let attempt = 0;
  for (;;) {
    const sample = await runOnce(duty, fixture, scratch, base, expected, overrides, directory);
    const needsLanguage = expected !== undefined;
    const gotOne = sample.identified.length > 0;
    if (!needsLanguage || gotOne || attempt >= 2) return sample;
    attempt += 1;
  }
}

/** One attempt at one fixture; the provider is live, the GitHub side stubbed. */
async function runOnce(
  duty: string,
  fixture: string,
  scratch: string,
  base: Record<string, string>,
  expected: string | undefined,
  overrides: Record<string, string>,
  directory: string,
): Promise<Sample> {
  const warrantPath = join(scratch, `warrant-${fixture}.yml`);
  let stub;
  let run: Run;
  if (duty === "triage") {
    const scenario = await triageScenarioOf(fixture, directory);
    const tracker = newTriageTracker();
    stub = await startStub({ routes: triageRoutes(scenario, tracker), completion: stubCompletion });
    try {
      if (scenario.warrant !== null) {
        await writeFile(warrantPath, scenario.warrant);
      }
      const path = scenario.warrant === null ? null : warrantPath;
      run = await runBundle(
        duty,
        stub.url,
        liveInputs(base, stub.url, overrides, path),
        scratchFiles(scratch),
      );
    } finally {
      await stub.close();
    }
    if (run.code !== 0) {
      // eslint-disable-next-line no-console -- CLI measurement output
      console.error(`live: ${duty}/${fixture} exited ${String(run.code)} —\n${run.log}`);
    }
    return {
      fixture,
      duty,
      expected,
      identified: run.outputs.language ?? "",
      ran: true,
      code: run.code,
    };
  }
  if (duty === "respond") {
    const scenario = await respondScenarioOf(fixture, directory);
    const tracker = newRespondTracker();
    stub = await startStub({
      routes: respondRoutes(scenario, tracker),
      completion: stubCompletion,
    });
    try {
      if (scenario.warrant !== null) {
        await writeFile(warrantPath, scenario.warrant);
      }
      const path = scenario.warrant === null ? null : warrantPath;
      run = await runBundle(
        duty,
        stub.url,
        liveInputs(base, stub.url, overrides, path),
        scratchFiles(scratch),
      );
    } finally {
      await stub.close();
    }
    if (run.code !== 0) {
      // eslint-disable-next-line no-console -- CLI measurement output
      console.error(`live: ${duty}/${fixture} exited ${String(run.code)} —\n${run.log}`);
    }
    return {
      fixture,
      duty,
      expected,
      identified: run.outputs.language ?? "",
      ran: true,
      code: run.code,
    };
  }
  // review — the language is read off the summary's `| Language | <code> |` row.
  // Every review fixture runs under an explicit warrant (`ReviewScenario.warrant`
  // is never null), so the write is unconditional here, unlike the thread duties.
  const scenario = await reviewScenarioOf(fixture, directory);
  const tracker = newReviewTracker();
  stub = await startStub({ routes: reviewRoutes(scenario, tracker), completion: stubCompletion });
  try {
    await writeFile(warrantPath, scenario.warrant);
    run = await runBundle(
      duty,
      stub.url,
      liveInputs(base, stub.url, overrides, warrantPath),
      scratchFiles(scratch),
    );
  } finally {
    await stub.close();
  }
  if (run.code !== 0) {
    // eslint-disable-next-line no-console -- CLI measurement output
    console.error(`live: ${duty}/${fixture} exited ${String(run.code)} —\n${run.log}`);
  }
  return {
    fixture,
    duty,
    expected,
    identified: languageFromSummary(run.summary),
    ran: true,
    code: run.code,
  };
}

/** The language a fixture declares it must be identified as, or undefined. */
async function expectedLanguage(directory: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  const doc = JSON.parse(await readFile(join(directory, ".expected.json"), "utf8")) as {
    readonly expected?: { readonly language?: unknown };
  };
  const language = doc.expected?.language;
  return typeof language === "string" ? language : undefined;
}

/** The language code a review run identified, off its summary's `| Language | id |` row. */
function languageFromSummary(summary: string): string {
  for (const line of summary.split("\n")) {
    const match = /^\|\s*Language\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (match) return match[1]?.trim() ?? "";
  }
  return "";
}

/** The inputs each duty's run needs, mirrored from the runner's constants. */
const TRIAGE_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "",
  models: "",
  "screen-models": "",
  warrant: "",
  confidence: "0.75",
  "corrections-dir": ".reeve/corrections",
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

const RESPOND_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "",
  models: "",
  "judge-models": "",
  drafts: "1",
  warrant: "",
  confidence: "0.75",
  guidance: "",
  "screen-models": "",
  about: "",
  "corrections-dir": ".reeve/corrections",
  "max-body-chars": "6000",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
  "dry-run": "false",
};

const REVIEW_INPUTS: Record<string, string> = {
  "github-token": "stub-token",
  number: "42",
  "base-url": "",
  "api-key": "",
  models: "",
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
};

/** Per-language accuracy, then the worst-language headline. */
function report(samples: readonly Sample[]): void {
  // eslint-disable-next-line no-console -- CLI measurement output
  console.log(`\nlive: ${String(samples.length)} fixture(s) measured`);
  for (const s of samples) {
    // eslint-disable-next-line no-console -- CLI measurement output
    console.log(
      `  ${s.duty}/${s.fixture} code=${String(s.code)} expected=${JSON.stringify(s.expected)} identified=${JSON.stringify(s.identified)}`,
    );
  }
  const perLanguage = new Map<string, { correct: number; total: number }>();
  for (const s of samples) {
    if (s.expected === undefined) continue;
    const key = s.expected;
    const acc = perLanguage.get(key) ?? { correct: 0, total: 0 };
    acc.total += 1;
    if (s.identified === s.expected) acc.correct += 1;
    perLanguage.set(key, acc);
  }
  for (const [language, acc] of [...perLanguage.entries()].sort()) {
    // eslint-disable-next-line no-console -- CLI measurement output
    console.log(`  ${language.padEnd(14)} ${String(acc.correct)}/${String(acc.total)}`);
  }
  let worst: { language: string; rate: number } | null = null;
  for (const [language, acc] of perLanguage) {
    const rate = acc.total === 0 ? 1 : acc.correct / acc.total;
    if (worst === null || rate < worst.rate) worst = { language, rate };
  }
  if (worst === null) {
    // eslint-disable-next-line no-console -- CLI measurement output
    console.log("  (no fixture declared a language)");
  } else {
    const percent = Math.round(worst.rate * 100);
    // eslint-disable-next-line no-console -- CLI measurement output
    console.log(`\nworst language: ${worst.language} at ${String(percent)}%`);
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- CLI error output
  console.error("live: fatal —", error);
  process.exit(1);
});
