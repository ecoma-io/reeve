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
const VI_REPORT = join(FIXTURES, "triage", "vi-report", ".expected.json");

/** The original labels fixture, so every mutation can be undone. */
const ORIGINAL_LABELS = await readFile(LABELS, "utf8");
/** The original multilingual fixture, so the misidentified mutation can be undone. */
const ORIGINAL_VI_REPORT = await readFile(VI_REPORT, "utf8");

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

/**
 * Mutate the multilingual vi-report fixture so the run must come out `failed`:
 * the thread is Vietnamese and detection identifies it as such, but the
 * fixture's declared language is set to something it can never be — the strict
 * language assertion, which is what makes a misidentified language `failed`
 * rather than a `skipped` clean stop.
 */
async function makeMisidentified(): Promise<void> {
  const doc = JSON.parse(ORIGINAL_VI_REPORT) as { expected: { language: string } };
  doc.expected.language = "English";
  await writeFile(VI_REPORT, JSON.stringify(doc, null, 2));
  scrubs.push(async () => {
    await writeFile(VI_REPORT, ORIGINAL_VI_REPORT);
  });
}

describe("the eval runner's fail-closed exit code, end to end", () => {
  it("exits 0 when every fixture is a finding", async () => {
    const run = await evalDuty("all");
    expect(run.exit).toBe(0);
    // 12 triage + 11 respond + 7 harmonise + 3 translate + 3 duplicate + 4 lifecycle + 3 dependa + 9 review = 52, multilingual fixtures included.
    expect(run.out).toMatch(/finding 52 · failed 0 · skipped 0/);
  });

  it("exits 1 when a fixture is skipped — the clean-stop collapse", async () => {
    await makeUngranted();
    const run = await evalDuty("triage");
    expect(run.out).toMatch(/\[skipped\] triage\/labels/);
    expect(run.exit).toBe(1);
  });

  it("exits 1 when a multilingual fixture's language is misidentified — failed, not skipped", async () => {
    await makeMisidentified();
    const run = await evalDuty("triage");
    expect(run.out).toMatch(/\[failed[ ]*\] triage\/vi-report/);
    expect(run.out).toMatch(/identified the thread as/);
    expect(run.out).not.toMatch(/\[skipped\] triage\/vi-report/);
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
