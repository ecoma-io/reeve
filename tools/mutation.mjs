#!/usr/bin/env node
/**
 * The mutation harness: does the reveiwed suite still catch the failure a named
 * edit would cause?
 *
 * Every mutation below names one way the code could regress and the source
 * file it would live in. The harness applies that edit to a COPY of the file
 * (the working tree is never left dirty), runs the vitest cases that exercise
 * that seam, and reports whether the suite noticed:
 *
 *   - KILLED   — at least one case failed under the mutated file. The suite
 *                holds the invariant.
 *   - SURVIVED — every case passed. The invariant is not actually asserted,
 *                which is a gap the mutation table must own.
 *
 * Deliberately small on purpose: it is a harness, not a suite. Each mutation
 * is the tersest edit that expresses the regression, the runs are per-mutation
 * and per-seam, and the report is one table. It calls the repository's own
 * vitest, so it needs no dependencies beyond what the repository already has.
 *
 * Scratch lives in `.tmp/mutation/` (gitignored) and is removed on exit. A
 * crashed run can leave `.tmp/` behind; it is safe to delete.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(ROOT, ".tmp", "mutation");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");

/**
 * One mutation: the file it edits, the match it replaces, its replacement, and
 * the vitest targets that must notice it.
 *
 * The critical list from the hardening brief is mapped to a seam each would
 * live in, and to the existing tests that made it a KILLED row. A mutation on
 * an entry point (`src/duties/{duty}/main.ts`) is deliberately not here: those are
 * excluded from coverage and driven via built bundles, so a mutation there is a
 * rebuild-and-integration concern, not a unit seam.
 */
const MUTATIONS = [
  {
    name: "roster uses models[0] instead of rotating",
    file: "src/core/provider.ts",
    from: "for (const model of models) {",
    to: "for (const model of [models[0]]) {",
    targets: ["src/core/provider.test.ts"],
    note: "THE roster invariant: only the first model is ever tried.",
  },
  {
    name: "fallback skipped after first model failure",
    file: "src/core/provider.ts",
    from: "if (completion.ok) return { success: completion, failures };",
    to: "return { success: completion, failures };",
    targets: ["src/core/provider.test.ts"],
    note: "A failed first model ends the run instead of trying the next.",
  },
  {
    name: "return success on provider failure",
    file: "src/core/provider.ts",
    from: "return { success: null, failures };",
    to: "return { success: null, failures: [] };",
    targets: ["src/core/provider.test.ts"],
    note: "Failures are laundered: nothing explains a starved run.",
  },
  {
    name: "bypass the authority check",
    file: "src/core/enforce.ts",
    from: "const entry = byName.get(name);\n    if (entry === undefined) {",
    to: 'const entry = byName.get(name) ?? { name, confidence: null, exclusiveWith: [], description: "", not: null, examples: [], owner: null, paths: [], create: false, color: null };\n    if (false) {',
    targets: ["src/core/enforce.test.ts"],
    note: "A label the warrant never named is applied anyway.",
  },
  {
    name: "skip the confidence floor",
    file: "src/core/enforce.ts",
    from: "if (!Number.isFinite(confidence) || confidence < labelFloor) {",
    to: "if (false) {",
    targets: ["src/core/enforce.test.ts"],
    note: "A low-confidence proposal is applied anyway.",
  },
  {
    name: "ignore dry-run",
    file: "src/duties/review/threads.ts",
    from: "): Promise<ThreadSync> {\n  const { threads, uncertain } = await listOwnedThreads(api, at);\n  const plan = planThreads(reconciled, standing, threads);\n  return {",
    to: '): Promise<ThreadSync> {\n  return syncThreads(api, at, reconciled, standing, "dry-run-sha");\n  return {',
    targets: ["src/duties/review/threads.test.ts"],
    note: "Dry-run performs the writes it rehearsed.",
  },
  {
    name: "skip idempotency check",
    file: "src/duties/review/publish.ts",
    from: "      : existing.payload?.startsWith(renderFingerprintMarker(pub, payload)) === true",
    to: "      : false",
    targets: ["src/duties/review/publish.test.ts"],
    note: "A rerun replaces its own comment instead of recognising it.",
  },
  {
    name: "accept malformed model output as success",
    file: "src/duties/review/verdict.ts",
    from: "if (!file.lines.has(line)) return null;",
    to: "if (false) return null;",
    targets: ["src/duties/review/verdict.test.ts"],
    note: "A finding naming a line the diff never proved is admitted.",
  },
  {
    name: "skip evidence verification",
    file: "src/duties/review/providers.ts",
    from: "if (!proven.includes(claim) && !claim.includes(proven)) return null;",
    to: "if (false) return null;",
    targets: ["src/duties/review/providers.test.ts", "src/duties/review/verify.test.ts"],
    note: "A model's claim is verified without diff-proven text.",
  },
];

async function apply(original, srcPath, mutation) {
  const text = await readFile(original, "utf8");
  if (!text.includes(mutation.from)) {
    throw new Error(`no match in ${mutation.file} for "${mutation.from.slice(0, 60)}"`);
  }
  await writeFile(srcPath, text.replace(mutation.from, mutation.to));
}

async function run() {
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  const rows = [];
  let failed = 0;
  for (const mutation of MUTATIONS) {
    const srcPath = join(ROOT, mutation.file);
    const original = join(SCRATCH, `orig-${mutation.name.replace(/[^a-z0-9]+/gi, "-")}.ts`);
    await rename(srcPath, original);
    try {
      await apply(original, srcPath, mutation);
      const result = spawnSync(VITEST, ["run", "--no-coverage", ...mutation.targets], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const killed = result.status !== 0;
      rows.push({ name: mutation.name, killed, note: mutation.note });
      if (!killed) failed += 1;
      const mark = killed ? "KILLED" : "SURVIVED";
      console.log(`${mark}  ${mutation.name}`);
    } finally {
      await rename(original, srcPath);
    }
  }

  await rm(SCRATCH, { recursive: true, force: true });

  console.log("\nMutation results:");
  console.log("KILLED  " + rows.filter((row) => row.killed).length);
  console.log("SURVIVED " + rows.filter((row) => !row.killed).length);
  for (const row of rows) {
    console.log(`  ${row.killed ? "✓" : "✗"}  ${row.name}`);
  }

  if (failed > 0) {
    console.error(
      "\nA critical mutation survived. The tests it targets do not assert what the mutation breaks.",
    );
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
