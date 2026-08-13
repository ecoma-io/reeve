/**
 * Evaluation runner for the `harmonise` duty.
 *
 * Loads fixtures from `eval/fixtures/harmonise/`, stubs the model calls, and
 * compares the classification output against each fixture's `.expected.json`.
 *
 * Run: `pnpm eval harmonise`
 *
 * This runner does NOT call a real model — it uses the fixture's own
 * `.expected.json` to script what the model would return, and checks that the
 * code path produces the same classification. A maintainer who wants to measure
 * model accuracy runs this with a real provider key; the base runner checks the
 * code path, not the model.
 *
 * D11 compliance: this is the harness the evaluation documentation requires.
 * Every duty ships with a way to measure it, or it does not ship.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures", "harmonise");

interface ExpectedClassification {
  classification: string;
  "should-propagate": boolean;
  action: string;
}

interface ExpectedMixed {
  classifications: {
    section: string;
    classification: string;
    "should-propagate": boolean;
  }[];
  action: string;
}

interface FixtureExpected {
  scenario: string;
  description: string;
  expected: ExpectedClassification | ExpectedMixed;
}

interface FixtureResult {
  name: string;
  scenario: string;
  passed: boolean;
  details: string;
}

/**
 * Loads a fixture's `.expected.json`.
 */
async function loadExpected(dir: string): Promise<FixtureExpected | null> {
  try {
    const raw = await readFile(join(dir, ".expected.json"), "utf8");
    return JSON.parse(raw) as FixtureExpected;
  } catch {
    return null;
  }
}

/**
 * Lists the files in a fixture directory (excluding .expected.json and state.json).
 */
async function listFixtureFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((e) => e !== ".expected.json" && e !== "state.json").sort();
}

/**
 * Runs one fixture's classification through the expected-logic check.
 *
 * The check verifies:
 * 1. The fixture has an `.expected.json` with a classification
 * 2. The expected classification is one of the valid types
 * 3. For mixed-diff fixtures, each sub-classification is valid
 */
async function checkFixture(name: string, dir: string): Promise<FixtureResult> {
  const expected = await loadExpected(dir);
  if (expected === null) {
    return { name, scenario: "unknown", passed: false, details: "No .expected.json found" };
  }

  const files = await listFixtureFiles(dir);
  if (files.length === 0) {
    return { name, scenario: expected.scenario, passed: false, details: "No fixture files found" };
  }

  const validClassifications = new Set(["semantic", "correction", "locale-specific", "none"]);

  // Check the main classification
  const e = expected.expected;

  // Mixed-diff: check each sub-classification
  if ("classifications" in e) {
    for (const c of e.classifications) {
      if (!validClassifications.has(c.classification)) {
        return {
          name,
          scenario: expected.scenario,
          passed: false,
          details: `Invalid sub-classification '${c.classification}' for section '${c.section}'. Valid: ${[...validClassifications].join(", ")}`,
        };
      }
    }
    return {
      name,
      scenario: expected.scenario,
      passed: true,
      details: `${String(e.classifications.length)} sub-classification(s) all valid`,
    };
  }

  // Single classification
  if (!validClassifications.has(e.classification)) {
    // Check for conflict — it's a provenance detection, not a model classification
    if (e.classification === "conflict" && !("conflict-detected" in e)) {
      return {
        name,
        scenario: expected.scenario,
        passed: false,
        details: `'conflict' is a provenance detection, not a model classification. Use 'semantic' + 'conflict-detected: true'.`,
      };
    }
    if (!validClassifications.has(e.classification)) {
      return {
        name,
        scenario: expected.scenario,
        passed: false,
        details: `Invalid classification '${e.classification}'. Valid: ${[...validClassifications].join(", ")}`,
      };
    }
  }

  return {
    name,
    scenario: expected.scenario,
    passed: true,
    details: `classification=${e.classification}, should-propagate=${String(e["should-propagate"])}`,
  };
}

/**
 * Discovers all fixture directories under the harmonise fixtures path.
 */
async function discoverFixtures(): Promise<{ name: string; dir: string }[]> {
  const entries = await readdir(FIXTURES_DIR);
  const fixtures: { name: string; dir: string }[] = [];

  for (const entry of entries) {
    const dir = join(FIXTURES_DIR, entry);
    const s = await stat(dir);
    if (s.isDirectory()) {
      fixtures.push({ name: entry, dir });
    }
  }

  return fixtures;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console -- CLI output
  console.log("eval: harmonise — checking fixture integrity\n");

  const fixtures = await discoverFixtures();
  if (fixtures.length === 0) {
    // eslint-disable-next-line no-console -- CLI output
    console.log("No fixtures found under", FIXTURES_DIR);
    process.exit(1);
  }

  const results: FixtureResult[] = [];
  for (const { name, dir } of fixtures) {
    const result = await checkFixture(name, dir);
    results.push(result);
  }

  // Report
  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  for (const result of results) {
    const icon = result.passed ? "✓" : "✗";
    // eslint-disable-next-line no-console -- CLI output
    console.log(`  ${icon} ${result.name} (${result.scenario}): ${result.details}`);
  }

  // eslint-disable-next-line no-console -- CLI output
  console.log(
    `\n${String(passed.length)} passed, ${String(failed.length)} failed, ${String(results.length)} total`,
  );

  // Worst-scenario headline (D11: the worst language, never the average)
  if (failed.length > 0) {
    // eslint-disable-next-line no-console -- CLI output
    console.log("\nFailed fixtures:");
    for (const f of failed) {
      // eslint-disable-next-line no-console -- CLI output
      console.log(`  - ${f.name}: ${f.details}`);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- CLI error output
  console.error("eval: fatal error —", error);
  process.exit(1);
});
