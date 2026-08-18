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
 *   - KILLED   — at least one case failed under the mutated file. The suite
 *                holds the invariant.
 *   - SURVIVED — every case passed. The invariant is not actually asserted,
 *                which is a gap the mutation table must own.
 *   - STALE    — the `from` string no longer appears exactly once in the file
 *                it names. The mutation was never applied, so it proved
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
 *   node tools/mutation.mjs --stage fast     the critical subset CI runs per pull request
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
 */
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
 * check this repository ranks first in `docs/internal/ci-gates.md` reporting
 * success because it had been asked to check nothing. That is the same class of
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
const TABLE_FLOOR = 54;

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
 * live in, and to the existing tests that made it a KILLED row. A mutation on
 * an entry point (`src/duties/{duty}/main.ts`) is deliberately not here: those are
 * excluded from coverage and driven via built bundles, so a mutation there is a
 * rebuild-and-integration concern, not a unit seam.
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
    name: "starvation reported as protocol exhaustion",
    file: "src/core/provider.ts",
    from: 'failures.every((f) => f.kind === "protocol")',
    to: 'failures.some((f) => f.kind === "protocol")',
    targets: ["src/core/provider.test.ts"],
    stage: "fast",
    owner: "TL2",
    note: "A rate-limited roster with one bad answer in it is reported as a configuration error.",
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
    from: "    const existingPr = existing[0];\n    if (existingPr !== undefined) {\n      // Update existing PR",
    to: "    const existingPr = undefined;\n    if (existingPr !== undefined) {\n      // Update existing PR",
    targets: ["src/core/state-branch.test.ts"],
    stage: "fast",
    owner: "TL3",
    note: "A rerun opens a fresh pull request beside the one it already has open.",
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
    from: "  // comment plus an uncertain search → `withheld`).\n  if (uncertain) return { created: 0, updated: 0, fallback: [], uncertain };",
    to: "  // comment plus an uncertain search → `withheld`).",
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

  // A1 is undecided: GitHub documents BOTH primary and secondary rate limits as
  // answering "403 or 429", so `isCapacityError` treating 403 as configuration
  // rather than capacity is a real question and not yet a settled answer. The
  // row below is written out rather than guessed at — it asserts the capacity
  // reading, which is one of the two candidate behaviours — and stays commented
  // out until the decision lands, so nothing here pins a behaviour the
  // repository has not chosen.
  //
  // {
  //   name: "GitHub 403 not treated as capacity",
  //   file: "src/core/forge.ts",
  //   from: "    if (status === 429 ||",
  //   to: "    if (status === 403 || status === 429 ||",
  //   targets: ["src/core/forge.test.ts"],
  //   stage: "fast",
  //   owner: "TL4",
  //   note: "Awaiting the A1 decision — see docs/internal/mutation-report.md.",
  // },
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
let inFlight = null;

/** Synchronous on purpose: an `exit` handler cannot await, and this must run there. */
function restoreSync() {
  if (inFlight === null) return;
  const { original, srcPath } = inFlight;
  inFlight = null;
  try {
    renameSync(original, srcPath);
  } catch {
    console.error(`\nCOULD NOT RESTORE ${srcPath} — its original is at ${original}.`);
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
    const name = scratchName(mutation);
    if (!stashed.has(name)) continue;
    const srcPath = join(ROOT, mutation.file);
    if (await exists(srcPath)) continue;
    await rename(join(SCRATCH, name), srcPath);
    console.error(`recovered ${mutation.file} from a previous crashed run.`);
  }
}

/** The scratch filename one mutation stashes its original under. */
function scratchName(mutation) {
  return `orig-${mutation.name.replace(/[^a-z0-9]+/gi, "-")}.ts`;
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
    const srcPath = join(ROOT, mutation.file);
    const original = join(SCRATCH, scratchName(mutation));
    await rename(srcPath, original);
    inFlight = { original, srcPath };
    try {
      await apply(original, srcPath, mutation);
      const result = spawnSync(VITEST, ["run", "--no-coverage", ...mutation.targets], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const killed = result.status !== 0;
      rows.push({ mutation, killed });
      console.log(`${killed ? "KILLED  " : "SURVIVED"}  ${mutation.name}`);
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
    console.error(
      `\nSURVIVED  ${row.mutation.name} (${row.mutation.owner})\n  ${row.mutation.note}\n` +
        `  ${row.mutation.targets.join(", ")} pass with ${row.mutation.file} mutated.`,
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
