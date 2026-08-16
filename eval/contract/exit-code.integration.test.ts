/**
 * Drives the real `pnpm eval` command and asserts the fail-closed exit codes
 * end to end — the branches the pure gate in `exit-code.ts` cannot reach: the
 * all-finding path, the skipped path (via a temporarily mutated fixture), the
 * unknown duty, and a duty with no fixtures.
 *
 * The skipped branch mutates the triage labels fixture so the expected effect
 * requires capabilities the warrant does not grant, then restores it in a
 * finally. Every branch asserts both the outcome line and the process exit
 * code, so a change that lets a skipped or failed run exit green is a test
 * failure here.
 *
 * These cases rebuild a duty bundle each time, so the suite is slow by
 * intent: it measures the real gate the CI workflow would see, not a
 * reimplementation of it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURES = join(ROOT, "eval", "fixtures");
const LABELS = join(FIXTURES, "triage", "labels", ".expected.json");

/** The original labels fixture, so every mutation can be undone. */
const ORIGINAL_LABELS = await readFile(LABELS, "utf8");

const temp = await mkdtemp(join(tmpdir(), "reeve-exit-"));
const scrubs: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const scrub of scrubs) await scrub();
  void temp;
});

function evalDuty(duty: string): Promise<{ exit: number; out: string }> {
  return new Promise((done, reject) => {
    execFile("pnpm", ["eval", duty], { cwd: ROOT }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(new Error(`pnpm eval ${duty} failed: ${error.message}`));
        return;
      }
      const exit = error === null || typeof error.code !== "number" ? 0 : error.code;
      done({ exit, out: `${stdout}\n${stderr}` });
    });
  });
}

/**
 * Mutate the labels fixture so the run must come out `skipped`: the warrant
 * grants only `label`, while the expected effect asks for `comment` and
 * `assign` the grant cannot reach — the run applies the label and stops,
 * and no set of effects the warrant allows can satisfy the expectation.
 */
async function makeUngranted(): Promise<void> {
  const doc = JSON.parse(ORIGINAL_LABELS) as TriageDoc;
  doc.warrant =
    "version: 1\nlabels:\n  - name: bug\n    description: Something that used to work.\nduties:\n  triage: [label]\n";
  doc.expected = {
    "applied-names": ["bug"],
    "duplicate-of": null,
    "screened-out": "",
    effects: { applied: ["bug"], commented: true, assigned: ["ana"], closed: false },
  };
  await writeFile(LABELS, JSON.stringify(doc, null, 2));
  scrubs.push(async () => {
    await writeFile(LABELS, ORIGINAL_LABELS);
  });
}

interface TriageEffects {
  applied: string[];
  commented: boolean;
  assigned: string[];
  closed: boolean;
}
interface TriageDoc {
  warrant: string;
  expected: {
    "applied-names"?: string[];
    "duplicate-of"?: number | null;
    "screened-out"?: string;
    effects?: TriageEffects;
  };
}

/** Rename a duty's fixtures directory so the runner sees no fixtures. */
async function hideFixtures(duty: string, hiddenName: string): Promise<void> {
  const from = join(FIXTURES, duty);
  const to = join(FIXTURES, hiddenName);
  await rename(from, to);
  scrubs.push(async () => {
    await rename(to, from);
  });
}

describe("the eval runner's fail-closed exit code, end to end", () => {
  it("exits 0 when every fixture is a finding", async () => {
    const run = await evalDuty("all");
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(/finding 14 · failed 0 · skipped 0/);
  });

  it("exits 1 when a fixture is skipped — the clean-stop collapse", async () => {
    await makeUngranted();
    const run = await evalDuty("triage");
    expect(run.out).toMatch(/\[skipped\] triage\/labels/);
    expect(run.exit).toBe(1);
  });

  it("exits 2 for a duty it does not know", async () => {
    const run = await evalDuty("nonexistent-duty");
    expect(run.exit).toBe(2);
    expect(run.out).toMatch(/unknown duty `nonexistent-duty`/);
  });

  it("exits 1 for a duty with no fixtures — unevaluated is not passing", async () => {
    await hideFixtures("respond", "respond-hidden");
    const run = await evalDuty("respond");
    expect(run.out).toMatch(/no fixtures for `respond`/);
    expect(run.exit).toBe(1);
  });
});
