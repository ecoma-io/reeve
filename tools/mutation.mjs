#!/usr/bin/env node
/**
 * The mutation harness: does the reviewed suite still catch the failure a named
 * edit would cause?
 *
 * Every mutation below names one way the code could regress and the source
 * file it would live in. The harness applies that edit to a COPY of the file
 * (the working tree is never left dirty), runs the vitest cases that exercise
 * that seam, and reports whether the suite noticed:
 *
 *   - KILLED   — at least one case failed under the mutated file, and the same
 *                cases pass against the pristine file: the failure is caused
 *                by the mutation, not merely shared with it. The suite holds
 *                the invariant.
 *   - SURVIVED — every case passed with the mutation in place, or the same
 *                failure exists without the mutation — a failure the row is
 *                not responsible for must not be claimed as evidence. Either
 *                way the mutation proved nothing, which is a gap the table
 *                must own.
 *   - STALE    — the `from` string no longer names exactly one seam in the
 *                file it names, or is disambiguated only by a comment line
 *                while its code exists identically elsewhere. The mutation was
 *                never applied, or applied to a copy nobody chose, so it proved
 *                nothing. A stale row is a silently missing gate and fails the
 *                run exactly as loudly as a survivor does.
 *
 * Deliberately small on purpose: it is a harness, not a suite. Each mutation
 * is the tersest edit that expresses the regression, the runs are per-mutation
 * and per-seam, and the report is one table. It calls the repository's own
 * vitest, so it needs no dependencies beyond what the repository already has.
 *
 * Usage:
 *   node tools/mutation.mjs                  every mutation
 *   node tools/mutation.mjs --stage fast     the local pre-push subset; CI runs the whole table
 *   node tools/mutation.mjs --only roster    every mutation whose name contains "roster"
 *   node tools/mutation.mjs --list           print the table and exit
 *
 * `--only` and `--stage` narrow which mutations are *run*. Neither narrows the
 * staleness preflight: every row in the table is checked against its file on
 * every invocation, because a `from` string that has drifted is a gate that
 * stopped existing, and finding that out only on the one run that happened to
 * select it is how a gate goes missing for a year.
 *
 * Scratch lives in `.tmp/mutation/` (gitignored) and is removed on exit. A
 * crashed run can leave a source file renamed into it; the next run detects
 * that and puts it back before doing anything else — see `recover`.
 *
 * ── Why a table and not a sample ───────────────────────────────────────────
 *
 * A suite can be green three ways: the assertion holds, the assertion is
 * missing, or the branch was never reached. Coverage separates the third from
 * the other two. **Nothing but a mutation separates the first from the
 * second** — and at the integration tier, where a fixture decides which
 * branches exist at all, the second and third are the same mistake wearing
 * different clothes. TL2 put it exactly, after auditing eleven capability
 * gates that every gate in this repository had reported green:
 *
 *   "Every one of these eleven gates was green under mutation because a
 *    fixture made its branch UNREACHABLE, not because an assertion was
 *    missing. At the integration tier an unreachable branch and an unasserted
 *    one look identical from outside, and only a mutation tells them apart."
 *
 * That is the argument for gating every capability gate rather than a
 * representative few, and it generalises well past this repository.
 *
 * ── Two lessons this table learned the hard way ────────────────────────────
 *
 * Both are checklist items for whoever extends this file, not history.
 *
 * **1. Two independent gates that share an exclusion list are one gate.**
 * `src/duties/{duty}/main.ts` was excluded from coverage for a sound reason (those
 * files call `run()` at import time, so importing one to measure it executes
 * the action in the test worker) and excluded from this table for a different
 * sound reason (a mutation there needs a bundle rebuild). Each argument held
 * alone. Together they were a hole: the two mechanisms meant to cover each
 * other's blind spots had the same blind spot, and nothing named them as the
 * same set of files. Two auditors then flipped `dependa`'s and `harmonise`'s
 * publish gates fully open and every gate in the repository stayed green.
 * Nobody had forgotten a test. **When a file is excluded from a gate, ask what
 * else excludes it** — and if a second, independent gate excludes it for its
 * own good reason, the file is not doubly protected, it is unprotected, and
 * the two sound arguments are what hide that.
 *
 * **2. A `from` string should match what the seam IS, not the order of things
 * around it.** One row went STALE when two unrelated and entirely correct
 * fixes moved the lines around the seam it named. Its `from` had matched four
 * consecutive statements — this call, then that call, then this return — which
 * is the part of a function most likely to change for reasons that have
 * nothing to do with the invariant. The repaired row matches the return shape
 * unique to the function it gates. A `from` spanning several statements in
 * sequence will go stale the first time somebody legitimately inserts a line.
 */
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(ROOT, ".tmp", "mutation");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");

/**
 * The smallest table this harness will run.
 *
 * A gate whose own contents can be deleted is not a gate. Emptying `MUTATIONS`
 * below used to print `KILLED 0 · SURVIVED 0 · STALE 0` and **exit 0** — the
 * check this repository ranks first among its gates, and the only one that
 * measures protection rather than execution, reporting success because it had
 * been asked to check nothing. That is the same class of
 * failure as a coverage `exclude` that hides a file: the number improves
 * because the denominator moved.
 *
 * So the count is written down. **It never goes down, for exactly the reason
 * the coverage thresholds in `vitest.config.ts` never go down:** a row that
 * stops applying is a missing gate, and the fix is to re-point the row, not to
 * shrink the floor. Raise it when the table grows; a diff that lowers it is a
 * diff that should have to explain itself in review.
 *
 * This cannot stop somebody editing the constant and the table together, and
 * nothing in a self-checking script could. What it does is make the deletion
 * deliberate and visible rather than silent — which is the whole difference
 * between a gate that failed and a gate that was never asked.
 */
const TABLE_FLOOR = 90;

/**
 * One mutation: the file it edits, the match it replaces, its replacement, the
 * vitest targets that must notice it, the stage that runs it, and the task lead
 * who owns the seam if it survives.
 *
 * `stage` is what makes a staged CI gate possible rather than documentary.
 * `"fast"` is the subset that runs on every pull request: the invariants whose
 * violation is silent — a write that repeats, an authority check that does not
 * check, a red run that reports green. `"full"` adds the rest and runs where a
 * few extra seconds cost nobody a review cycle. Nothing is `"full"` because it
 * matters less; `"full"` rows are the ones whose regression a human notices on
 * the first run instead of on the hundredth.
 *
 * The critical list from the hardening brief is mapped to a seam each would
 * live in, and to the existing tests that made it a KILLED row.
 *
 * **Entry points (`src/duties/{duty}/main.ts`) are `"full"`-tier rows, not
 * absent ones.** This comment used to say a mutation there was "a
 * rebuild-and-integration concern, not a unit seam" and leave it at that,
 * which read as a reason to have none — and that sentence is how a hole
 * stayed invisible for a whole round. `main.ts` was outside the coverage
 * `include` list AND outside this table at the same time, for the same
 * stated reason, so both auditors could flip `dependa`'s and `harmonise`'s
 * publish gates fully open and every gate in the repository stayed green.
 * Nobody had forgotten a test; the two mechanisms that would each have caught
 * it shared one exclusion, and nobody had noticed they shared it.
 *
 * The true statement is narrower: an entry-point row costs a bundle rebuild
 * and a spawned child, so it is too slow for the `"fast"` tier — not too
 * slow to exist. Such a row carries `rebuilds: "<duty>"` so the harness can
 * put the duty's committed bundle back afterwards, because the target suite
 * rebuilds it from the mutated source.
 */
export const MUTATIONS = [
  // ── model orchestration and fallback ────────────────────────────────────
  {
    name: "roster uses models[0] instead of rotating",
    file: "src/core/provider.ts",
    from: "for (const model of models) {",
    to: "for (const model of [models[0]]) {",
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "THE roster invariant: only the first model is ever tried.",
  },
  {
    name: "fallback skipped after first model failure",
    file: "src/core/provider.ts",
    from: "if (completion.ok) return { success: completion, failures };",
    to: "return { success: completion, failures };",
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A failed first model ends the run instead of trying the next.",
  },
  {
    name: "return success on provider failure",
    file: "src/core/provider.ts",
    from: "return { success: null, failures };",
    to: "return { success: null, failures: [] };",
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "Failures are laundered: nothing explains a starved run.",
  },
  {
    name: "auth failure classified as capacity weather",
    file: "src/core/provider.ts",
    from: 'if (status === 401 || status === 403) return "auth";',
    to: 'if (status === 401 || status === 403) return "capacity";',
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "D12 inverted: a refused key rotates and the run finishes green instead of failing red.",
  },
  {
    name: "starvation reported as roster exhaustion",
    file: "src/core/provider.ts",
    from: 'failures.every((f) => f.kind !== "capacity")',
    to: 'failures.some((f) => f.kind !== "capacity")',
    targets: ["src/core/provider.test.ts", "src/core/summary.contract.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A rate-limited roster with one bad answer in it is reported as a configuration error \u2014 which reddens a whole sweep over one degraded item, because every caller sits inside a per-item loop.",
  },
  {
    name: "an endpoint that refused the key is not a configuration error",
    file: "src/core/provider.ts",
    from: 'failures.every((f) => f.kind !== "capacity")',
    to: 'failures.every((f) => f.kind === "protocol")',
    targets: ["src/core/provider.test.ts", "src/core/summary.contract.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "The multi-endpoint hole reopens: `settleAuth` does not throw while another endpoint still authenticates, so a run that saw a 401 and delivered nothing exits green.",
  },
  {
    name: "judge seat consumes only its first model",
    file: "src/core/judge.ts",
    from: "  for (const model of order) {",
    to: "  for (const model of [order[0]]) {",
    targets: ["src/core/judge.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "A panel seat never falls back: one grounded model empties the seat.",
  },
  {
    name: "duty stage always starts at models[0]",
    file: "src/duties/translate/draft.ts",
    from: "  const start = draft % live.length;",
    to: "  const start = 0;",
    targets: ["src/duties/translate/draft.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "Every draft is asked of the same first model, so N drafts are one model's opinion N times.",
  },
  {
    name: "cheap screen roster skipped for the expensive one",
    file: "src/core/recall.ts",
    from: "  const models = rosters.screenModels.length > 0 ? rosters.screenModels : rosters.models;",
    to: "  const models = rosters.models;",
    targets: ["src/core/recall.test.ts"],
    stage: "full",
    owner: "TL3",
    note: "`screen-models` is ignored and the expensive roster pays for a query nobody reads.",
  },
  {
    name: "cheap screen roster skipped in a duty",
    file: "src/duties/triage/record.ts",
    from: "  const pivotModels = settings.screenModels.length > 0 ? settings.screenModels : settings.models;",
    to: "  const pivotModels = settings.models;",
    targets: ["src/duties/triage/record.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "Same regression one layer up: the duty spends its deliverable roster on a pivot.",
  },

  // ── authority and configuration ─────────────────────────────────────────
  {
    name: "bypass the authority check",
    file: "src/core/enforce.ts",
    from: "const entry = byName.get(name);\n    if (entry === undefined) {",
    to: 'const entry = byName.get(name) ?? { name, confidence: null, exclusiveWith: [], description: "", not: null, examples: [], owner: null, paths: [], create: false, color: null };\n    if (false) {',
    targets: ["src/core/enforce.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A label the warrant never named is applied anyway.",
  },
  {
    name: "skip the confidence floor",
    file: "src/core/enforce.ts",
    from: "if (!Number.isFinite(confidence) || confidence < labelFloor) {",
    to: "if (false) {",
    targets: ["src/core/enforce.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A low-confidence proposal is applied anyway.",
  },
  {
    name: "bypass warrant key validation",
    file: "src/core/warrant.ts",
    from: "    if (!known.includes(key)) {",
    to: "    if (false) {",
    targets: ["src/core/warrant.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A typo'd warrant key is accepted, so a rule the maintainer wrote silently does nothing.",
  },
  {
    name: "accept an empty model roster",
    file: "src/core/inputs.ts",
    from: 'throw new Error("models: no entries. Expected at least one model id.");',
    to: "",
    targets: ["src/core/inputs.test.ts"],
    stage: "full",
    owner: "TL3",
    note: "A run configured with no models starts anyway and reports nothing to ask.",
  },

  // ── the GitHub boundary ─────────────────────────────────────────────────
  {
    name: "every GitHub failure read as not-there",
    file: "src/core/forge.ts",
    from: 'return typeof error === "object" && error !== null && "status" in error && error.status === 404;',
    to: 'return typeof error === "object" && error !== null;',
    targets: ["src/core/forge.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A 500 or a 403 from the Contents API is laundered into an empty cold start.",
  },
  {
    name: "undecodable contents file read as a cold start",
    file: "src/core/forge.ts",
    from: "  throw new UnreadableContentsFile(path);",
    to: "  return null;",
    targets: ["src/core/forge.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A shard too large to inline is treated as absent, so the next write overwrites its history.",
  },

  // ── idempotency, duplicate side effects and dry-run ──────────────────────
  {
    name: "ignore dry-run",
    file: "src/duties/review/threads.ts",
    from: "  const plan = planThreads(reconciled, standing, threads);\n  return {\n    created: plan.creates.length,",
    to: '  return syncThreads(api, at, reconciled, standing, "dry-run-sha");\n  const plan = planThreads(reconciled, standing, threads);\n  return {\n    created: plan.creates.length,',
    targets: ["src/duties/review/threads.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Dry-run performs the writes it rehearsed.",
  },
  {
    name: "ignore dry-run outside review",
    file: "src/duties/dependa/publish.ts",
    from: "  if (dryRun) {",
    to: "  if (false) {",
    targets: ["src/duties/dependa/authority.contract.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A dependa rehearsal pushes a branch and opens the pull request it was only meant to describe.",
  },
  {
    name: "skip idempotency check",
    file: "src/duties/review/publish.ts",
    from: "      : existing.payload?.startsWith(renderFingerprintMarker(pub, payload)) === true",
    to: "      : false",
    targets: ["src/duties/review/publish.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A rerun replaces its own comment instead of recognising it.",
  },
  {
    name: "skip idempotency outside review",
    file: "src/duties/duplicate/publish.ts",
    from: 'existing === null ? "posted" : existing.fingerprint === payload ? "unchanged" : "replaced";',
    to: 'existing === null ? "posted" : "replaced";',
    targets: ["src/duties/duplicate/publish.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "An unchanged verdict is rewritten every run, editing the thread and firing its events for nothing.",
  },
  {
    name: "skip the shared unchanged check",
    file: "src/core/publish.ts",
    from: 'if (current === body) return { action: "unchanged" };',
    to: "",
    targets: ["src/core/publish.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Every duty that publishes through core rewrites an identical body on every run.",
  },
  {
    name: "duplicate comment on an uncertain lookup",
    file: "src/duties/duplicate/publish.ts",
    from: "  if (existing === null && uncertain) {",
    to: "  if (false) {",
    targets: ["src/duties/duplicate/publish.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A truncated search posts a second comment beside the one it could not see.",
  },

  // ── model output and evidence ───────────────────────────────────────────
  {
    name: "accept malformed model output as success",
    file: "src/duties/review/verdict.ts",
    from: "if (!file.lines.has(line)) return null;",
    to: "if (false) return null;",
    targets: ["src/duties/review/verdict.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A finding naming a line the diff never proved is admitted.",
  },
  {
    name: "skip evidence verification",
    file: "src/duties/review/providers.ts",
    from: "if (!proven.includes(claim) && !claim.includes(proven)) return null;",
    to: "if (false) return null;",
    targets: ["src/duties/review/providers.test.ts", "src/duties/review/verify.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A model's claim is verified without diff-proven text.",
  },
  // ── added after Round 1 integration: seams the other leads earned ────────
  //
  // Each row below was proposed by the task lead who owns the seam, having
  // watched it go red against their own new tests, and then re-verified here
  // against the integrated tree rather than taken on trust.
  {
    name: "grounded model ends the rotation instead of being skipped",
    file: "src/core/provider.ts",
    from: "      failures.push(weatherFailure(model));\n      continue;",
    to: "      failures.push(weatherFailure(model));\n      break;",
    targets: ["src/core/provider.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "One model grounded earlier in the run ends the roster for every model behind it.",
  },
  {
    name: "403 no longer classified as auth",
    file: "src/core/provider.ts",
    from: "if (status === 401 || status === 403)",
    to: "if (status === 401)",
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A forbidden key falls through to protocol and rotates quietly instead of failing red.",
  },
  {
    name: "panel failure never reckoned against weather",
    file: "src/core/judge.ts",
    from: "    reckon(counted, weather);\n    failures.push(counted);",
    to: "    failures.push(counted);",
    targets: ["src/core/judge.contract.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "A panel's own loop stops enforcing D12: a rate-limited model is asked again by the next seat.",
  },
  {
    name: "panel seat re-asks a model an earlier seat spent",
    file: "src/core/judge.ts",
    from: "    const order = chain.filter((model) => !spent.has(model));",
    to: "    const order = [...chain];",
    targets: ["src/core/judge.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "Three seats configured, one model consulted three times, reported as three votes.",
  },
  {
    name: "ignore dry-run in harmonise",
    file: "src/duties/harmonise/publish.ts",
    from: "  if (dryRun) {",
    to: "  if (false as boolean) {",
    targets: ["src/duties/harmonise/publish.contract.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A harmonise rehearsal pushes a branch and opens the pull request it was only meant to describe.",
  },
  {
    name: "remediation reads a human comment as its own envelope",
    file: "src/duties/remediation/envelope.ts",
    from: "    if (!isBotAuthor(comment.user)) continue;",
    to: "",
    targets: ["src/duties/remediation/envelope.adversarial.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A maintainer's comment is parsed as this duty's own state, so anyone can write the envelope.",
  },
  {
    name: "remediation proposal points at a path the finding never named",
    file: "src/duties/remediation/proposal.ts",
    from: "    path: finding.path,",
    to: '    path: finding.body.split(":")[0] ?? finding.path,',
    targets: ["src/duties/remediation/proposal.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "The proposal's path is read out of model prose instead of the diff-anchored finding.",
  },
  {
    name: "409 conflict aborts instead of re-reading the sha",
    file: "src/duties/dependa/publish.ts",
    from: "    if (!isConflict(error)) throw error;",
    to: "    throw error;",
    targets: ["src/duties/dependa/publish.test.ts"],
    stage: "full",
    owner: "TL2",
    note: "A stale-sha conflict fails the run rather than re-reading once, which is what it is for.",
  },

  // ── authority, configuration and state (TL3's seams) ─────────────────────
  {
    name: "a declared-but-empty capabilities block grants the default",
    file: "src/core/warrant.ts",
    from: "      return declared ? [] : fallback;",
    to: "      return fallback;",
    targets: ["src/core/warrant.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "Writing `capabilities:` with nothing under it grants everything instead of nothing.",
  },
  {
    name: "an undeclared duty is never reported unnamed",
    file: "src/core/warrant.ts",
    from: "    unnamed: (duty) => declared && !capabilities.has(duty)",
    to: "    unnamed: () => false",
    targets: ["src/core/warrant.test.ts"],
    stage: "full",
    owner: "TL3",
    note: "A duty the warrant never named runs on defaults with nothing saying so.",
  },
  {
    name: "capability names matched case-insensitively",
    file: "src/core/warrant.ts",
    from: "      const capability = CAPABILITIES.find((known) => known === entry);",
    to: "      const capability = CAPABILITIES.find((known) => known === entry.toLowerCase());",
    targets: ["src/core/warrant.contract.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "The authority file's grammar quietly widens: `Close` grants `close`.",
  },
  {
    name: "the no-warrant authority grants every capability",
    file: "src/core/warrant.ts",
    from: "      granted: (_duty, fallback) => fallback,",
    to: "      granted: () => CAPABILITIES,",
    targets: ["src/core/warrant.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A repository with no warrant at all is granted everything rather than the caller's default.",
  },
  {
    name: "a NaN confidence passes the floor",
    file: "src/core/enforce.ts",
    from: "    if (!Number.isFinite(confidence) || confidence < labelFloor) {",
    to: "    if (confidence < labelFloor) {",
    targets: ["src/core/enforce.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A model answering a non-number for confidence clears every floor, because NaN < x is false.",
  },
  {
    name: "an exclusive label is applied beside its opposite",
    file: "src/core/enforce.ts",
    from: "    const human = entry.exclusiveWith.find((other) => already.has(other));",
    to: "    const human = undefined;",
    targets: ["src/core/enforce.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "`exclusiveWith` stops excluding, so a thread carries two labels the warrant said cannot co-exist.",
  },
  {
    name: "ignore dry-run in the shared state branch",
    file: "src/core/state-branch.ts",
    from: "  if (files.length === 0) return null;\n\n  if (dryRun) {",
    to: "  if (files.length === 0) return null;\n\n  if (false as boolean) {",
    targets: ["src/core/state-branch.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "Every duty that writes state through this helper writes it on a dry run.",
  },
  {
    name: "state branch opens a second pull request",
    file: "src/core/state-branch.ts",
    from: "  const existingPr = existing[0];",
    to: "  const existingPr = undefined;",
    targets: ["src/core/state-branch.test.ts", "src/core/state.idempotency.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "Every run opens another pull request on the same branch instead of updating the one already open. One anchor now, in the extracted `openOrUpdatePr`, so this gates `publishState` AND `publishStatePr` — it used to carry a thirteen-line run just to pick one of two identical copies, and proved nothing about the other.",
  },
  {
    name: "an unknown outcome is read as no outcome",
    file: "src/core/memory.ts",
    from: '  if (rawOutcome !== undefined && rawOutcome !== null && rawOutcome !== "overruled") return null;',
    to: "",
    targets: ["src/core/state.idempotency.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A future outcome kind this build cannot read is served as an ordinary worked example.",
  },
  {
    name: "a correction line is written unescaped",
    file: "src/core/memory.ts",
    from: "  return JSON.stringify({",
    to: "  return unescapedLine({",
    targets: ["src/core/memory.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "The store's one line per record stops being JSON, so a title with a newline splits the record.",
  },
  {
    name: "doctor reports a capability the duty's ladder discards",
    file: "src/doctor/diagnose.ts",
    from: "  const granted = grantedRaw.filter((c) => ladder.includes(c));",
    to: "  const granted = grantedRaw;",
    targets: ["src/doctor/diagnose.test.ts"],
    stage: "full",
    owner: "TL3",
    note: "The report claims a duty has a capability its own ladder filters back out at runtime.",
  },

  // ── the GitHub boundary and review evidence (TL4's seams) ────────────────
  {
    name: "write against an uncertain thread listing",
    file: "src/duties/review/threads.ts",
    from: "  if (uncertain) return { created: 0, updated: 0, fallback: [], uncertain };\n  const plan = planThreads(reconciled, standing, threads);\n  const fallback: string[] = [];",
    to: "  if (false) return { created: 0, updated: 0, fallback: [], uncertain };\n  const plan = planThreads(reconciled, standing, threads);\n  const fallback: string[] = [];",
    targets: ["src/duties/review/threads.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A listing that ended at a full page finding nothing is written against, which is how a duplicate thread is made.",
  },
  {
    name: "a thread is matched to a finding on another line",
    file: "src/duties/review/threads.ts",
    from: "        thread.line === entry.finding.line &&",
    to: "        true &&",
    targets: ["src/duties/review/threads.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "An existing thread is updated with a finding about a different line of the same file.",
  },
  {
    name: "422 anchoring failure inverted",
    file: "src/duties/review/threads.ts",
    from: "?.status === 422;",
    to: "?.status !== 422;",
    targets: ["src/duties/review/threads.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Every error but 422 is swallowed into the fallback list, and the one that should be is thrown.",
  },
  {
    name: "empty proven text verifies every claim",
    file: "src/duties/review/providers.ts",
    from: "  if (proven.length === 0) return null;",
    to: "",
    targets: ["src/duties/review/evidence.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: 'THE evidence boundary: with no proven text, `claim.includes("")` is true and every finding verifies.',
  },
  {
    name: "zero-weight evidence marks a finding verified",
    file: "src/duties/review/evidence.ts",
    from: "  return evidence.some((entry) => entry.weight >= 1)",
    to: "  return evidence.some((entry) => entry.weight >= 0)",
    targets: ["src/duties/review/evidence.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Evidence that proves nothing still stamps a finding verified.",
  },
  {
    name: "evidence proven against the wrong file",
    file: "src/duties/review/verify.ts",
    from: "      const file = shown.get(finding.path);",
    to: "      const file = request.shown[0];",
    targets: ["src/duties/review/evidence.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A finding's snippet is checked against whichever file came first in the diff, not its own.",
  },
  {
    name: "an empty blocked phrase matches everything",
    file: "src/duties/review/rules.ts",
    from: "      if (blocked.phrase.length === 0) continue;",
    to: "",
    targets: ["src/duties/review/rules.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A rule file with a blank phrase in it blocks every finding there is.",
  },
  {
    name: "a missing rules file fails the run",
    file: "src/duties/review/rules.ts",
    from: "    if (isMissingFile(error)) return emptyRules();",
    to: "    if (false) return emptyRules();",
    targets: ["src/duties/review/rules.adversarial.test.ts"],
    stage: "full",
    owner: "TL4",
    note: "A repository that never wrote a rules file cannot run review at all.",
  },
  {
    name: "GitHub rate limits no longer capacity",
    file: "src/core/forge.ts",
    from: "    if (status === 429 ||",
    to: "    if (status === 430 ||",
    targets: ["src/core/forge.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A 429 is reported as a configuration error, so weather ends the run red.",
  },
  {
    name: "a 404 no longer means not-there",
    file: "src/core/forge.ts",
    from: "error.status === 404;",
    to: "error.status === 410;",
    targets: ["src/core/forge.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A genuinely absent file throws instead of reading as the cold start it is.",
  },
  {
    name: "a truncated atlas is reported as an empty one",
    file: "src/core/atlas.ts",
    from: "      if (isCapacityError(error)) return { packages, truncated: true };",
    to: "      if (isCapacityError(error)) return EMPTY_ATLAS;",
    targets: ["src/core/atlas.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "A partial walk loses both the packages it did read and the fact that it was partial.",
  },
  {
    name: "a tampered envelope checksum is accepted",
    file: "src/duties/review/publish.ts",
    from: "envelopeChecksum(previous) !== map.checksum",
    to: "false",
    targets: ["src/duties/review/publish.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "An envelope edited by hand is trusted as this duty's own previous state.",
  },

  // A1 landed: GitHub documents BOTH primary and secondary rate limits as
  // answering "403 or 429", so a 403 whose headers prove a rate limit is now
  // capacity and a bare 403 is still configuration. Both directions are
  // mutated, because they fail differently and are caught in different places
  // — over-broadening turns a permission refusal green, under-broadening
  // reverts every consumer to red-on-rate-limit, and only the second needed a
  // call-site pin built for it.
  {
    name: "a rate-limit 403 read as configuration",
    file: "src/core/forge.ts",
    from: "    if (status === 403 && saysRateLimited(error)) return true;",
    to: "",
    targets: [
      "src/core/forge.test.ts",
      "src/core/state-branch.test.ts",
      "src/doctor/diagnose.test.ts",
    ],
    stage: "fast",
    owner: "TL4",
    note: "A secondary rate limit GitHub sent as 403 rather than 429 fails the run red instead of rotating.",
  },
  {
    name: "every 403 read as capacity",
    file: "src/core/forge.ts",
    from: "    if (status === 403 && saysRateLimited(error)) return true;",
    to: "    if (status === 403) return true;",
    targets: [
      "src/core/forge.test.ts",
      "src/core/forge.adversarial.test.ts",
      "src/core/state.idempotency.test.ts",
    ],
    stage: "fast",
    owner: "TL4",
    note: "A genuine permission refusal is laundered into weather and the run reports green.",
  },
  // ── entry points: the authority gates the bundles actually run ──────────
  //
  // Slow — each spawns `tools/build.mjs` and then a child process — hence
  // `"full"`. Every one of these is the last check standing between a run and
  // a repository mutation, and until the bundle-driven suites landed there was
  // nothing anywhere that would have noticed them being opened.
  {
    name: "dependa publishes without permission or dry-run",
    file: "src/duties/dependa/main.ts",
    from: "    const mayPublish = canEdit && canOpenPr && !settings.dryRun;",
    to: "    const mayPublish = true;",
    targets: ["src/duties/dependa/main.integration.test.ts"],
    rebuilds: "dependa",
    stage: "full",
    owner: "TL2",
    note: "The whole publish gate opens: no `edit-file`, no `open-pr`, and a dry run all publish anyway.",
  },
  {
    name: "harmonise publishes without permission",
    file: "src/duties/harmonise/main.ts",
    from: '  const canPublish =\n    settings.permitted.includes("edit-file") && settings.permitted.includes("open-pr");',
    to: "  const canPublish = true;",
    targets: ["src/duties/harmonise/main.integration.test.ts"],
    rebuilds: "harmonise",
    stage: "full",
    owner: "TL2",
    note: "A warrant granting neither `edit-file` nor `open-pr` gets a branch and a pull request anyway.",
  },
  {
    name: "lifecycle acts without the capability the step requires",
    file: "src/duties/lifecycle/main.ts",
    from: "  return { ok: missing.length === 0, missing };",
    to: "  return { ok: true, missing };",
    targets: ["src/duties/lifecycle/main.integration.test.ts"],
    rebuilds: "lifecycle",
    stage: "full",
    owner: "TL2",
    note: "Every step reports its capabilities satisfied, so an ungranted close or label happens anyway.",
  },
  {
    name: "triage mints labels without the label capability",
    file: "src/duties/triage/main.ts",
    from: '  if (!permitted.includes("label")) {',
    to: "  if (false) {",
    targets: ["src/duties/triage/main.integration.test.ts"],
    rebuilds: "triage",
    stage: "full",
    owner: "TL2",
    note: "A `create: true` taxonomy entry mints a repository label on a run never granted `label`.",
  },
  // ── every capability gate an entry point carries ────────────────────────
  //
  // The four rows above this block were the first entry-point mutations, added
  // after two auditors flipped `dependa`'s and `harmonise`'s publish gates open
  // and every gate in the repository stayed green. These seven finish the set:
  // eleven capability gates, each one the last check between a run and a
  // repository mutation, none of them observable any other way. The argument
  // for gating all of them rather than a sample is in this file's header,
  // under "Why a table and not a sample".
  {
    name: "dependa delivers an injection fence with no sentence saying what it is",
    file: "src/duties/dependa/main.ts",
    from: '            enclosed?.rule ?? "",',
    to: '            "",',
    targets: ["src/duties/dependa/main.integration.test.ts"],
    rebuilds: "dependa",
    stage: "full",
    owner: "TL2",
    note: "Enclosed third-party prose reaches the model fenced but unexplained, which is the fence doing nothing.",
  },
  {
    name: "harmonise writes a state branch without permission",
    file: "src/duties/harmonise/main.ts",
    from: '          const canWriteBranch =\n            settings.permitted.includes("edit-file") && settings.permitted.includes("open-pr");',
    to: "          const canWriteBranch = true;",
    targets: ["src/duties/harmonise/main.integration.test.ts"],
    rebuilds: "harmonise",
    stage: "full",
    owner: "TL2",
    note: "`state-branch` is written and a pull request opened on a warrant granting neither capability.",
  },
  {
    name: "triage proposes a warrant edit without the propose capability",
    file: "src/duties/triage/main.ts",
    from: '  if (!permitted.includes("propose")) return null;',
    to: "",
    targets: ["src/duties/triage/main.integration.test.ts"],
    rebuilds: "triage",
    stage: "full",
    owner: "TL2",
    note: "The row with the most teeth in the table: downstream this opens a pull request editing `.github/reeve.yml`, the warrant itself.",
  },
  {
    name: "triage records to a branch without open-pr (sweep)",
    file: "src/duties/triage/main.ts",
    from: '    canRecordToBranch = recording && permitted.includes("open-pr");',
    to: "    canRecordToBranch = recording;",
    targets: ["src/duties/triage/main.integration.test.ts"],
    rebuilds: "triage",
    stage: "full",
    owner: "TL2",
    note: "A sweep commits corrections to a state branch nobody was asked to review.",
  },
  {
    name: "triage records to a branch without open-pr (single thread)",
    file: "src/duties/triage/main.ts",
    from: '            canRecordToBranch = recordGrantedByRun(permitted) && permitted.includes("open-pr");',
    to: "            canRecordToBranch = recordGrantedByRun(permitted);",
    targets: ["src/duties/triage/main.integration.test.ts"],
    rebuilds: "triage",
    stage: "full",
    owner: "TL2",
    note: "The same rule written out a second time for the single-thread path — a rule copied is a rule that drifts, so it is gated twice.",
  },
  {
    name: "lifecycle unstales a label without the label capability",
    file: "src/duties/lifecycle/main.ts",
    from: '  if (outcome.permitted.includes("label")) {',
    to: "  if (true as boolean) {",
    targets: ["src/duties/lifecycle/main.integration.test.ts"],
    rebuilds: "lifecycle",
    stage: "full",
    owner: "TL2",
    note: "Labels are removed from threads on a run the warrant never granted `label`.",
  },
  {
    name: "remediation proposes without the propose capability",
    file: "src/duties/remediation/main.ts",
    from: '  if (!permitted.includes("propose")) {',
    to: "  if (false as boolean) {",
    targets: ["src/duties/remediation/main.integration.test.ts"],
    rebuilds: "remediation",
    stage: "full",
    owner: "TL2",
    note: "A warrant whose `duties:` block never names `remediation` gets proposals anyway.",
  },
  {
    name: "untrusted label prose decides which proposals survive",
    file: "src/duties/triage/propose.ts",
    from: "    label.paths.some((p) => p === pkg.path || pkg.path.startsWith(`${p}/`)),",
    to: '    label.paths.some((p) => p === pkg.path || pkg.path.startsWith(`${p}/`)) ||\n      (label.description ?? "").includes(pkg.path),',
    targets: ["src/duties/triage/propose.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A label's free-text description is read as if it were `paths:`, so prose anyone can edit silences a proposal.",
  },
  {
    name: "the uncertain signal is never raised (producer)",
    file: "src/duties/review/threads.ts",
    from: "  return { threads, uncertain: lastFull };",
    to: "  return { threads, uncertain: false };",
    targets: ["src/duties/review/threads.test.ts", "src/duties/review/threads.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "The load-bearing half: the consumer's withholding guard is already pinned, but nothing proved the signal it reads is ever raised.",
  },
  {
    name: "the uncertain producer narrows on what it found",
    file: "src/duties/review/threads.ts",
    from: "uncertain: lastFull };",
    to: "uncertain: threads.length === 0 && lastFull };",
    targets: ["src/duties/review/threads.test.ts", "src/duties/review/threads.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "The regression this expression was adjudicated out of: finding any owned thread suppresses the walk\u2019s uncertainty, and every finding whose thread sits past the ceiling is created again on every run.",
  },
  // ── Round 2: the seams this round's fixes created ───────────────────────
  //
  // Each names a defect this round found and fixed, mutated back to the shape
  // it had. A row here is the only evidence that the test committed beside the
  // fix actually fails when the behaviour returns — coverage says the line
  // ran, and only this says the suite noticed.
  {
    name: "the screen strips a comment without leaving a gap",
    file: "src/core/screen.ts",
    from: "out += `${body.slice(read, opener)}\\n`;",
    to: "out += body.slice(read, opener);",
    targets: ["src/core/screen.scan.test.ts", "src/core/screen.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A template's instructions are removed by joining the words either side of them, so two fields a reporter left blank read as one authored sentence.",
  },
  {
    name: "the screen's comment scan finds no closer at all",
    file: "src/core/screen.ts",
    from: "opener + OPENER.length > lastCloser ? -1 : body.indexOf(CLOSER, opener + OPENER.length);",
    to: "-1;",
    targets: ["src/core/screen.scan.test.ts", "src/core/screen.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "The bound that makes the scan linear is also what finds a closer: without it nothing is stripped and every template's own words count as the reporter's.",
  },
  {
    name: "an error field carrying nothing condemns the answer beside it",
    file: "src/core/provider.ts",
    from: "  if (!carries) return null;",
    to: "",
    targets: ["src/core/provider.failure.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A gateway that stamps an empty error object on every response makes every model fail with `protocol`, so a working provider ends every run red.",
  },
  {
    name: "an unreadable own login matches an actorless event",
    file: "src/duties/lifecycle/clock.ts",
    from: "  return ownLogin.length > 0 && login === ownLogin;",
    to: "  return login === ownLogin;",
    targets: ["src/duties/lifecycle/clock.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "Two empty strings compare equal, so a run that could not read its own login removes labels it never applied and reads an actorless comment as its own step firing.",
  },
  {
    name: "the newest version is chosen with the runner's locale",
    file: "src/duties/dependa/datasources/types.ts",
    from: 'b.version.localeCompare(a.version, "en-US", { numeric: true })',
    to: "b.version.localeCompare(a.version, undefined, { numeric: true })",
    targets: ["src/duties/dependa/datasources/ordering.determinism.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "`undefined` is whatever `LC_ALL` says on the runner, and this order IS the version proposed — same registry, same commit, a different pull request per locale.",
  },
  {
    name: "a padded version spelling wins the tie",
    file: "src/duties/dependa/datasources/types.ts",
    from: "  if (a.version.length !== b.version.length) return a.version.length - b.version.length;",
    to: "",
    targets: ["src/duties/dependa/datasources/ordering.determinism.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "The collator calls `1.0` and `1.00` equal, so without the canonical-spelling rule a repository pinned at `1.0` is sent a pull request moving it to `1.00`.",
  },
  {
    name: "superseded pull requests are matched on the unsanitised group id",
    file: "src/duties/dependa/publish.ts",
    from: "  const activeBranchSegments = new Set([...activeGroupIds].map(sanitizeBranchSegment));",
    to: "  const activeBranchSegments = new Set(activeGroupIds);",
    targets: ["src/duties/dependa/publish.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A branch name holds the sanitised id, so no scoped package ever matches: the run opens a pull request and closes it as superseded, and D3 then refuses to recreate it for ever.",
  },
  // ── the three seams the dogfood round found ─────────────────────────────
  //
  // Each of these was silent in a different way. The peer-suffix strip was a
  // regex that matched nothing and therefore did nothing; the identity read
  // was an exception nobody caught; the observe-only fallback is a single
  // assignment whose absence looks exactly like the code without it. None
  // would be noticed by reading the diff.
  {
    name: "nested pnpm peer suffix left on the resolved version",
    file: "src/duties/dependa/managers/npm.ts",
    from: "  return open === -1 ? raw : raw.slice(0, open);",
    to: "  return raw;",
    targets: ["src/duties/dependa/managers/npm.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "`currentVersion` comes out as `10.0.1(eslint@10.8.1(jiti@2.6.1))` rather than `10.0.1`, so `classifyUpdate` refuses it and every peer-resolved dependency in a pnpm v9 repository is dropped from maintenance.",
  },
  {
    name: "a refused identity read kills the lifecycle run",
    file: "src/duties/lifecycle/timeline.ts",
    from: '  } catch {\n    return "";\n  }',
    to: "  } catch (error) {\n    throw error;\n  }",
    targets: ["src/duties/lifecycle/timeline.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "`GET /user` answers 403 for every installation token, so the duty dies before its first thread in every repository running on the default `GITHUB_TOKEN`.",
  },
  {
    name: "lifecycle writes without an identity to attribute the writes to",
    file: "src/duties/lifecycle/main.ts",
    from: "      settings = { ...settings, dryRun: true };",
    to: "      settings = { ...settings };",
    targets: ["src/duties/lifecycle/main.integration.test.ts"],
    rebuilds: "lifecycle",
    stage: "full",
    owner: "TL2",
    note: "A run that cannot read its own login labels, says and closes anyway — and since no marker it posts is recognisable as its own next run, it says the same thing again every run after that.",
  },
  // ── the architecture seam, and the two surfaces that carry its findings ──
  //
  // These three files are the ones an external architecture tool plugs into
  // (`ArchEvidence` in `architecture.ts`, and the finding lifecycle and the
  // code-scanning upload that carry whatever it produces). Every row below
  // names a regression that leaves a green run and a well-formed comment
  // behind it: a fabricated finding, a dropped one, an alert that never
  // closes, or prose that reaches a rendered surface unescorted.
  {
    name: "an architecture rule fires in both directions",
    file: "src/duties/review/architecture.ts",
    from: "if (!fromOk || !toOk) continue;",
    to: "if (!fromOk && !toOk) continue;",
    targets: ["src/duties/review/architecture.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Direction stops being part of the rule: a `domain \u2192 infrastructure` rule fires on the infrastructure\u2192domain import too, so the reviewer is told the dependency they were told to write is forbidden.",
  },
  {
    name: "a forged import inside a string literal becomes a real edge",
    file: "src/duties/review/architecture.ts",
    from: "if (opaque.some((range) => candidate.index >= range.start && candidate.index < range.end)) {",
    to: "if (opaque.some((range) => candidate.index >= range.start && candidate.index > range.end)) {",
    targets: ["src/duties/review/architecture.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: 'The injection surface the module doc names: a contributor writes `import x from "../infra/db"` inside a comment or a dependency-injection string and the run publishes a deterministic finding about an import that does not exist.',
  },
  {
    name: "the architecture finding cap drops violations in silence",
    file: "src/duties/review/architecture.ts",
    from: "  if (capped) {",
    to: "  if (!capped) {",
    targets: ["src/duties/review/architecture.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "D5 inverted at the cap: the run that DID truncate says nothing, and the run that reported everything warns that it did not. A reviewer reading a capped review cannot tell it is partial.",
  },
  {
    name: "a critical architecture rule reports as info",
    file: "src/duties/review/architecture.ts",
    from: 'severity: rule?.severity ?? "warning",',
    to: 'severity: "info",',
    targets: ["src/duties/review/architecture.test.ts"],
    stage: "full",
    owner: "TL4",
    note: "The rule's declared severity is discarded, so the finding a maintainer marked critical arrives as a note \u2014 below every floor that decides whether the review speaks at all.",
  },
  {
    name: "a finding resolves on model omission alone",
    file: "src/duties/review/findings.ts",
    from: "    if (doesNotStand(old)) {",
    to: "    if (true) {",
    targets: ["src/duties/review/findings.test.ts", "src/duties/review/findings.lifecycle.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "The churn the reconcile doc spends a paragraph forbidding: a claim the model simply did not re-cite is called resolved, so identical synchronize events walk the same finding through created \u2192 resolved \u2192 reopened with zero code moved.",
  },
  {
    name: "a disposition carries across files",
    file: "src/duties/review/findings.ts",
    from: "return a.ruleId === b.ruleId && a.path === b.path;",
    to: "return a.ruleId === b.ruleId;",
    targets: ["src/duties/review/findings.test.ts", "src/duties/review/disposition.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Intention loses the file, so a `wont-fix` a maintainer granted one finding silences the same rule everywhere in the pull request \u2014 an accepted risk in one file becomes an accepted risk in every file.",
  },
  {
    name: "a resolved finding stays in the SARIF upload",
    file: "src/duties/review/sarif.ts",
    from: '.filter((entry) => entry.status !== "resolved")',
    to: ".filter(() => true)",
    targets: ["src/duties/review/sarif.test.ts", "src/duties/review/sarif.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "Absence IS the resolved rung here \u2014 code scanning closes an alert missing from the newest upload. Keep the resolved finding in and the alert never closes, so the fixed defect stays red forever with no second state machine to blame.",
  },
  {
    name: "model prose reaches code scanning unsanitised",
    file: "src/duties/review/sarif.ts",
    from: "    const prose = sanitize(finding.body).trim();",
    to: "    const prose = finding.body.trim();",
    targets: ["src/duties/review/sarif.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "The SARIF message is rendered in GitHub's own UI, so it is one more surface an injected diff would love to reach \u2014 mentions, links and directives ride the model's body straight into it.",
  },
  {
    name: "the message's fallback rung ships the model's rule id raw",
    file: "src/duties/review/sarif.ts",
    from: "    const named = sanitize(finding.ruleName).trim();",
    to: "    const named = finding.ruleName.trim();",
    targets: ["src/duties/review/sarif.adversarial.test.ts"],
    stage: "fast",
    owner: "TL4",
    note: "`ruleName` IS model prose whenever the claimed rule id names no declared rule, so a model that answers with a mention for a rule id and an empty body reaches the rendered alert through the fallback \u2014 past the sanitize the body rung applies.",
  },
];
// ── argv ────────────────────────────────────────────────────────────────────

/** `--only <substring>`, `--stage <fast|full>`, `--list`. Nothing else is accepted. */
function parseArgs(argv) {
  const options = { only: null, stage: "full", list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      options.list = true;
    } else if (arg === "--only") {
      options.only = argv[(i += 1)];
      if (options.only === undefined)
        throw new Error("--only needs a substring of a mutation name");
    } else if (arg === "--stage") {
      options.stage = argv[(i += 1)];
      if (options.stage !== "fast" && options.stage !== "full") {
        throw new Error(`--stage takes "fast" or "full", got ${String(options.stage)}`);
      }
    } else {
      throw new Error(`unrecognised argument \`${arg}\``);
    }
  }
  return options;
}

/** Which mutations this invocation runs. `fast` is a subset of `full`, never a different table. */
function selected(options) {
  return MUTATIONS.filter(
    (mutation) =>
      (options.stage === "full" || mutation.stage === "fast") &&
      (options.only === null || mutation.name.includes(options.only)),
  );
}

// ── restoration ─────────────────────────────────────────────────────────────

/**
 * The one source file currently renamed out of the way, or null.
 *
 * Module-level rather than a local, because the handlers below run outside the
 * loop that set it. A harness that leaves a source file missing is worse than a
 * harness that reports nothing.
 */
let inFlight = [];

/**
 * Synchronous on purpose: an `exit` handler cannot await, and this must run there.
 *
 * A list rather than one pair, because a mutation on an entry point stashes two
 * files. The mutated source is the point of the exercise; the **built bundle**
 * is the collateral. A bundle-driven suite rebuilds `<duty>/dist/index.js` from
 * whatever `main.ts` says at the time, so restoring only the source would leave
 * a mutated bundle sitting in the working tree — committed output carrying an
 * edit nobody wrote, which `git status` would report as ordinary build drift.
 * Both go back, in reverse order, and each one is attempted even if an earlier
 * one throws.
 */
function restoreSync() {
  const pending = inFlight;
  inFlight = [];
  for (const { original, srcPath } of pending.reverse()) {
    try {
      renameSync(original, srcPath);
    } catch {
      console.error(`\nCOULD NOT RESTORE ${srcPath} — its original is at ${original}.`);
    }
  }
}

process.on("exit", restoreSync);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restoreSync();
    process.exit(130);
  });
}

/** Whether a path exists, asked without throwing. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put back whatever a crashed earlier run left renamed away, before the scratch
 * directory is cleared.
 *
 * The old harness cleared `.tmp/mutation/` first thing. A run killed between
 * the rename and its `finally` leaves the *only* copy of a source file in that
 * directory, so clearing it first deleted the file outright. Recovery reads the
 * mutation table for the mapping — the scratch name is derived from the
 * mutation name — and restores any source file that is currently missing.
 */
async function recover() {
  if (!(await exists(SCRATCH))) return;
  const stashed = new Set(await readdir(SCRATCH));
  for (const mutation of MUTATIONS) {
    for (const { path, stash } of stashedFor(mutation)) {
      if (!stashed.has(stash)) continue;
      if (await exists(join(ROOT, path))) continue;
      await rename(join(SCRATCH, stash), join(ROOT, path));
      console.error(`recovered ${path} from a previous crashed run.`);
    }
  }
}

/** The slug a mutation's stashed files are named after. */
function slug(mutation) {
  return mutation.name.replace(/[^a-z0-9]+/gi, "-");
}

/**
 * Every file this mutation moves aside, and the scratch name each is kept under.
 *
 * One entry for an ordinary row. Two for a row on an entry point, whose target
 * suite rebuilds the duty's committed bundle from the mutated source — see
 * `restoreSync`.
 */
function stashedFor(mutation) {
  const files = [{ path: mutation.file, stash: `orig-${slug(mutation)}.ts` }];
  if (mutation.rebuilds !== undefined) {
    files.push({
      path: `${mutation.rebuilds}/dist/index.js`,
      stash: `bundle-${slug(mutation)}.js`,
    });
  }
  return files;
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Whether every mutation's `from` still names exactly one place in its file.
 *
 * Both failure directions are checked, and both matter. Zero matches means the
 * edit never applied and the row proved nothing — the old harness threw from
 * inside the loop for this, which aborted every later mutation and reported a
 * stack trace instead of a board. More than one match is worse and was not
 * checked at all: `String.replace` with a string pattern rewrites only the
 * first occurrence, so an ambiguous `from` quietly mutates a seam nobody chose
 * and calls whatever the targets said about it the answer.
 */
async function preflight(mutations = MUTATIONS) {
  const stale = [];
  for (const mutation of mutations) {
    const path = join(ROOT, mutation.file);
    if (!(await exists(path))) {
      stale.push({ mutation, why: `\`${mutation.file}\` does not exist` });
      continue;
    }
    const why = classifyRow(mutation, await readFile(path, "utf8"));
    if (why !== null) stale.push({ mutation, why });
  }
  return stale;
}

/**
 * The verdict on one row against one file's text, or null when the row is fine.
 *
 * Split out from the reading above on purpose, and for the reason
 * `scripts/check-docs-links.mjs` gives for the same split: the facts come off
 * the filesystem, the judgement is a pure function of them, so the tests need
 * no filesystem and no mocking library. Every branch below fires only when
 * something has already gone wrong, which is precisely the code that rots
 * unwatched — see `tools/mutation.test.mjs`.
 */
export function classifyRow(mutation, text) {
  const count = occurrences(text, mutation.from);
  if (count === 0) return `no match for \`${excerpt(mutation.from)}\``;
  if (count > 1) {
    return `\`${excerpt(mutation.from)}\` matches ${String(count)} places — the edit is ambiguous`;
  }
  const reason = commentOnlyAnchor(mutation, text);
  if (reason !== null) return reason;
  return null;
}

/**
 * Whether a `from` matches the seam it names only because a comment line says so.
 *
 * A seam is a run of code, not the words beside it. A `from` whose matched
 * context includes a comment line — and where the non-comment lines of the
 * `from` alone match more than once — is disambiguated only by that comment:
 * the code it gates exists identically in another copy of the seam, and
 * `String.replace` would mutate whichever copy comes first while the copy whose
 * invariant the row claims to gate goes ungated. That is STALE in the row's
 * own terms — a gate that stopped existing — so it fails the run exactly as
 * loudly, and the message points at the repair: anchor the `from` on a token
 * that belongs to the seam's code, not its commentary.
 */
export function commentOnlyAnchor(mutation, text) {
  const lines = mutation.from.split("\n");
  const comment = lines.find((line) => /^\s*(\/\/|#)/.test(line));
  if (comment === undefined) return null;
  const codeLines = lines.filter((line) => !/^\s*(\/\/|#)/.test(line));
  if (codeLines.length === 0) return null;
  if (occurrences(text, codeLines.join("\n")) > 1) {
    return (
      `\`${excerpt(mutation.from)}\` is anchored only on its comment line ` +
      `(\`${excerpt(comment)}\`) — its code exists identically elsewhere, so the edit would ` +
      `mutate a copy nobody chose. Re-anchor the \`from\` on a seam-unique non-comment token.`
    );
  }
  return null;
}

/**
 * Why this table may not be run, or null when it may.
 *
 * Checked before anything else, because every other verdict this harness
 * reports is a statement about the table's contents and means nothing if the
 * table has been emptied.
 */
export function checkTable(mutations, floor = TABLE_FLOOR) {
  if (mutations.length === 0) {
    return "the mutation table is empty — there is nothing to gate, so this is a failure and not a pass.";
  }
  if (mutations.length < floor) {
    return (
      `the mutation table holds ${String(mutations.length)} rows and the recorded floor is ` +
      `${String(floor)}. Rows were removed. A row is only ever retired by re-pointing it at ` +
      `the seam the code moved to; if one genuinely no longer names real code, say so in the ` +
      `commit and lower TABLE_FLOOR deliberately.`
    );
  }
  return null;
}

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function excerpt(text) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 64 ? `${one.slice(0, 64)}…` : one;
}

/**
 * Write the mutated copy, and refuse to run against an unmutated one.
 *
 * `preflight` already proved the match exists, but it proved it against the
 * file as it was some milliseconds earlier. The check below closes that
 * window rather than reasoning about it: a `replace` that changed nothing
 * would leave the original in place and report whatever the untouched suite
 * said as the mutation's verdict — a KILLED row that gates nothing, which is
 * the one outcome worse than a survivor.
 */
async function apply(original, srcPath, mutation) {
  const text = await readFile(original, "utf8");
  const mutated = text.replace(mutation.from, mutation.to);
  if (mutated === text) {
    throw new Error(
      `${mutation.name}: applying the edit to ${mutation.file} changed nothing — ` +
        `the file moved under the run between the preflight and the write.`,
    );
  }
  await writeFile(srcPath, mutated);
}

/**
 * The exit code of one `targets` set against the pristine tree, cached.
 *
 * Filled by the causality check in the run loop: rows that share a target set
 * (and several do — `threads.adversarial.test.ts` sits in five rows' targets)
 * would otherwise re-run the same suite once per row.
 */
const baselineCache = new Map();

async function pristineStatus(targets, cache) {
  const key = targets.join("\n");
  if (cache.has(key)) return cache.get(key);
  const result = spawnSync(VITEST, ["run", "--no-coverage", ...targets], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // A signal-killed run has `status === null`: that is not a pass and not a
  // failure, it is an environment problem, and `undefined` says so — the loop
  // throws on it rather than silently downgrading a KILLED row.
  cache.set(key, result.status === null ? undefined : result.status);
  return cache.get(key);
}

/**
 * Whether a mutated run proves the mutation.
 *
 * The suite's exit codes against the mutated and the pristine file, compared:
 * a nonzero exit under mutation is only evidence if the pristine run of the
 * same targets passes. Several rows share `targets`, so without this an
 * unrelated failure in a shared file would be reported KILLED for a seam the
 * mutation never touched — a gate handed green for an invariant it never gated.
 */
export function verdict(mutatedStatus, pristineStatus) {
  // A missing mutated status (`null` from a signal-killed spawn, or the
  // `undefined` sentinel) means the run never completed and proves nothing;
  // it must never read as KILLED, let alone with the pristine run converting
  // a crash into evidence. The run loop throws on the truly fatal case; this
  // makes the pure function safe for any caller.
  if (typeof mutatedStatus !== "number") return { killed: false, cause: "run did not complete" };
  if (mutatedStatus === 0) return { killed: false };
  if (typeof pristineStatus !== "number" || pristineStatus !== 0) {
    return { killed: false, cause: "pristine failure" };
  }
  return { killed: true };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  // Before `--list`, before the scratch directory, before anything: a table
  // that has been emptied or shrunk cannot report a meaningful verdict, and the
  // verdict it would report is `pass`.
  const tableProblem = checkTable(MUTATIONS);
  if (tableProblem !== null) {
    console.error(`REFUSING TO RUN: ${tableProblem}`);
    process.exit(1);
  }

  if (options.list) {
    for (const mutation of MUTATIONS) {
      console.log(`${mutation.stage.padEnd(5)} ${mutation.owner}  ${mutation.name}`);
    }
    return;
  }

  await recover();
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  // The whole table, never the selection: a `from` string that has drifted is a
  // gate that stopped existing, and `--only` must not be able to hide one.
  const stale = await preflight();

  const chosen = selected(options).filter(
    (mutation) => !stale.some((entry) => entry.mutation === mutation),
  );
  if (options.only !== null && chosen.length === 0 && stale.length === 0) {
    throw new Error(`--only ${options.only} matched no mutation`);
  }

  const rows = [];
  for (const mutation of chosen) {
    const [source, ...collateral] = stashedFor(mutation);
    const srcPath = join(ROOT, source.path);
    const original = join(SCRATCH, source.stash);
    await rename(srcPath, original);
    inFlight = [{ original, srcPath }];
    // A bundle the target suite is about to rebuild is copied aside, not moved:
    // the build would recreate it either way, but a missing outfile turns a
    // rebuild failure into a confusing "no such file" from the spawned child
    // rather than the build error that actually happened.
    for (const { path, stash } of collateral) {
      const from = join(ROOT, path);
      if (!(await exists(from))) continue;
      const to = join(SCRATCH, stash);
      await copyFile(from, to);
      inFlight.push({ original: to, srcPath: from });
    }
    try {
      await apply(original, srcPath, mutation);
      const result = spawnSync(VITEST, ["run", "--no-coverage", ...mutation.targets], {
        cwd: ROOT,
        encoding: "utf8",
      });
      // A signal-killed run has `status === null` — the tests never finished,
      // so any verdict would be fabricated. `?? 1` would coerce that into a
      // failure and — when the pristine run passes — a KILLED row for a
      // mutation whose invariants were never exercised, which is TESTGATE-01
      // in a new coat. Fail loudly instead, mirroring the pristine side.
      if (result.status === null) {
        throw new Error(
          `${mutation.name}: the mutated run of ${mutation.file}'s targets was killed by a signal ` +
            `(exit code null, not a test failure) — no verdict is possible.`,
        );
      }
      const mutatedStatus = result.status;
      let outcome = verdict(mutatedStatus, 0);
      if (!outcome.killed) {
        // The suite passed with the mutation in place, so the mutation is the
        // one thing that could have broken it — the verdict is unambiguous.
        rows.push({ mutation, ...outcome });
        console.log(`SURVIVED  ${mutation.name}`);
        continue;
      }

      // The suite failed with the mutation in place — but several rows share
      // `targets`, so a nonzero exit alone does not say the mutation caused
      // it. Re-run the same targets against the PRISTINE file; only a failure
      // that the pristine run passes counts as KILLED. A failure present in
      // both is evidence against the mutation, not for it, and reporting it
      // KILLED would hand the gate green for an invariant the mutation never
      // touched. The pristine run is cached per target-set, so rows sharing a
      // file run it once, not once each. The mutated source must be restored
      // first: comparing the mutated run against itself would make every
      // genuinely-killed row read as "already failing without the mutation".
      restoreSync();
      const pristine = await pristineStatus(mutation.targets, baselineCache);
      if (pristine === undefined) {
        throw new Error(
          `${mutation.name}: the pristine run of ${mutation.file}'s targets failed to complete ` +
            `(killed by a signal, not a test failure) — the mutated run cannot be judged against it.`,
        );
      }
      outcome = verdict(mutatedStatus, pristine);
      rows.push({ mutation, ...outcome });
      console.log(
        outcome.killed
          ? `KILLED  ${mutation.name}`
          : `SURVIVED  ${mutation.name} (baseline already failing)`,
      );
    } finally {
      restoreSync();
    }
  }

  await rm(SCRATCH, { recursive: true, force: true });

  const survivors = rows.filter((row) => !row.killed);
  console.log(`\nMutation results (stage: ${options.stage}):`);
  console.log(`KILLED   ${String(rows.length - survivors.length)}`);
  console.log(`SURVIVED ${String(survivors.length)}`);
  console.log(`STALE    ${String(stale.length)}`);
  for (const row of rows) {
    console.log(`  ${row.killed ? "✓" : "✗"}  ${row.mutation.name}`);
  }

  for (const entry of stale) {
    console.error(
      `\nSTALE  ${entry.mutation.name}\n  ${entry.mutation.file}: ${entry.why}\n` +
        `  This mutation did not run, so nothing it claims to gate was checked. ` +
        `Re-point it at the seam the code moved to, or delete the row and say why.`,
    );
  }

  for (const row of survivors) {
    const cause =
      row.cause === "pristine failure"
        ? `${row.mutation.targets.join(", ")} already fail without the mutation — ` +
          "nothing proves the mutation was responsible, so it is not reported KILLED."
        : `${row.mutation.targets.join(", ")} pass with ${row.mutation.file} mutated.`;
    console.error(
      `\nSURVIVED  ${row.mutation.name} (${row.mutation.owner})\n  ${row.mutation.note}\n  ${cause}`,
    );
  }

  if (survivors.length > 0 || stale.length > 0) {
    console.error(
      "\nA critical mutation survived or went stale. Either the tests it targets do not " +
        "assert what the mutation breaks, or the mutation no longer names real code.",
    );
    process.exit(1);
  }
}

// Run only when this file is the program, never when a test imports it — the
// same guard `eval/runner.ts` lacks, which is why its own `DUTIES` list has to
// be read as text rather than imported.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    restoreSync();
    console.error(error);
    process.exit(1);
  });
}
