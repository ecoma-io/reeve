# Test architecture

_A factual map of the suite as it exists, not as it is described. Every claim is grounded in `file:line` and was checked against the source on this branch. Where an existing internal document disagrees with the code, the disagreement is recorded here rather than repeated. Companion to `gap-matrix.md`, which is the actionable half; this file is the descriptive half._

Measured counts: **145** production `.ts` files under `src/`, **151** test files under `src/`, **5** under `eval/contract/`, **2** `*.test.mjs` under `scripts/`. (145 + 151 = 296, which is where the "~296 TS files" figure comes from — it counts tests.)

## 1. Test taxonomy actually in use

Two naming systems are in play, and only one of them is a suffix convention.

**By filename suffix** — what `vitest.config.ts:8` discovers, and what a directory listing shows. Counts are files under `src/`:

| Suffix                  | Count | What the tier is for                                                                                                                   | Canonical example                                                                                     |
| ----------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `*.test.ts` (plain)     |   124 | In-process unit test. Imports the module directly, stubs at the port (a `Provider`, an `Api` object literal), asserts returned values. | `src/core/enclose.test.ts`                                                                            |
| `*.integration.test.ts` |    18 | Two genuinely different tiers sharing one suffix — see §2.                                                                             | `src/duties/triage/main.integration.test.ts:1-22`                                                     |
| `*.contract.test.ts`    |     5 | Pins a named doctrine invariant through the real production functions, with the invariant's identifier in the `describe` string.       | `src/duties/triage/roster.contract.test.ts:50` — `describe("A1 — the roster is an ordered rotation")` |
| `*.adversarial.test.ts` |     2 | Hostile input against a safety gate: traversal, injection, corruption, boundary values.                                                | `src/duties/dependa/validation.adversarial.test.ts:1-14`                                              |
| `*.property.test.ts`    |     1 | `fast-check` generators over algebraic invariants.                                                                                     | `src/duties/dependa/semver.property.test.ts:1-18`                                                     |
| `*.security.test.ts`    |     1 | One module's guard rails gathered in one file so they are reviewed together.                                                           | `src/duties/review/context.security.test.ts:2-7`                                                      |

**By stated property, with no suffix at all.** Two files carry a whole tier under an ordinary `*.test.ts` name, and a reader scanning suffixes misses them:

- `src/core/governance-stability.test.ts:1-16` — model-agnostic determinism of the enforcement layer. Its doc comment states the split: `enforce.test.ts` proves `bug` is refused when the warrant does not name it; this file proves nothing _outside_ the warrant can change that answer.
- `src/duties/triage/failure-safety.test.ts:1-22` — read-path fail-closed invariants, with a function → safe value → meaning truth table in the doc comment.

INFERRED: the suffix set is convention, not mechanism. Nothing in `vitest.config.ts`, `eslint.config.mjs` or CI treats `.adversarial`/`.property`/`.security` differently from `.test.ts`, and the `*.integration.test.ts` entry in the root include glob (`vitest.config.ts:8`) is redundant — `src/**/*.test.ts` already matches it.

## 2. The two meanings of `*.integration.test.ts`

Confusing these is how a reader over-estimates coverage of the entry points.

**(a) Bundle-driven, out of process — 7 files.** `duplicate`, `lifecycle`, `remediation`, `respond`, `review`, `translate`, `triage`. The seam is documented identically in each (`src/duties/triage/main.integration.test.ts:1-22`, `src/duties/remediation/main.integration.test.ts:1-23`):

- the duty's real bundle is rebuilt in `beforeAll` — `triage/main.integration.test.ts:65-70`: "CI runs `pnpm test` before `pnpm build`, so a case driving the committed bundle would be driving whatever was committed last";
- then spawned with `INPUT_*` in the environment, with `GITHUB_OUTPUT` read back afterwards;
- GitHub is a local `node:http` server, reached because `@actions/github` reads `GITHUB_API_URL`;
- the provider is that same local server, reached through the `base-url` input;
- nothing touches a network.

This is the only tier that can prove a negative about a whole duty. `remediation/main.integration.test.ts:12-17` names its route table "the load-bearing assertion": the stub exposes no write route, so an attempted mutation would 404 and fail the run.

**(b) In-process, un-mocking one collaborator — 10 files.** `core/detect`, `core/forge`, `core/provider`, `core/sanitize`, `translate/{draft,judge,publish,score}`, `harmonise/draft`, and `harmonise/main`. These exist because the unit sibling mocks a collaborator away — see §6.

**`src/duties/harmonise/main.integration.test.ts` is in neither tier.** Despite its name and its opening sentence ("driven the way a runner drives it"), it imports nothing from `src/` (`harmonise/main.integration.test.ts:11-15`) and spawns no bundle. It is a static consistency check: every `action.yml` input is read somewhere in the source text, every declared output is written somewhere, `.env.example` stays in sync (`harmonise/main.integration.test.ts:81-118`). Six other duties run the same checks _in addition to_ a bundle spawn; harmonise runs only the checks. `dependa` has no `main.integration.test.ts` at all. See gap-matrix `G-02`, `G-03`.

## 3. Commands, and what each actually covers

| Command                                              | Definition                              | What it runs                                                                                                              | Automated?                                                                                                  |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | `package.json:49`                       | `vitest run --coverage` over `src/**/*.test.ts` and `src/**/*.integration.test.ts` only — never `eval/`, never `scripts/` | yes, `ci.yml:83`                                                                                            |
| `pnpm test:contract`                                 | `package.json:50`                       | the 5 files under `eval/contract/` via `eval/contract/vitest.config.ts`                                                   | yes, `ci.yml:89`                                                                                            |
| `pnpm eval all`                                      | `package.json:55`, `eval/runner.ts`     | every duty's bundle over `eval/fixtures/<duty>/`, provider fully stubbed (`eval/runner.ts:171-172`, key `sk-stub-key`)    | yes, `ci.yml:96`                                                                                            |
| `pnpm test:mutation`                                 | `package.json:51`, `tools/mutation.mjs` | 9 named mutations, each applied to a copy and checked against a named test target                                         | **no — in no automated gate**; absent from `.github/**` and `lefthook.yml`                                  |
| `pnpm test:docs-links`                               | `package.json:47`                       | `node --test scripts/**/*.test.mjs` — 2 files                                                                             | **no** — CI runs `pnpm check-docs-links` (`ci.yml:118`), never its tests                                    |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | `package.json:44`, `:45`, `:48`         | `tsc --noEmit`; `eslint . --max-warnings 0`; prettier                                                                     | yes, `ci.yml:82`, `:80`, `:74` — `format:check` is deliberately skipped in the merge queue (`ci.yml:66-74`) |
| `node --experimental-strip-types eval/live.ts`       | `eval/live.ts:1-27`                     | the same fixtures against a **real** provider, keyed from `REEVE_EVAL_*`; GitHub stays stubbed                            | no, by design — the key is never committed                                                                  |
| `pnpm try`                                           | `package.json:54`, `tools/try.mjs`      | local single-duty run; the `.env` keys `harmonise/main.integration.test.ts:88` asserts exist                              | no                                                                                                          |

Two CI shapes are worth naming because they are deliberate and load-bearing:

- **`ci-gate` is an allow-list, not a deny-list** (`ci.yml:143-183`). Its comment records the incident that forced the inversion — run 31118985640 attempt 1, where a deny-list guard let a red pipeline report green because `needs.*.result` carried a state the guard did not enumerate. The gate now fails on anything that is not literally `success`, including an empty result set.
- **The bundle-staleness gate** (`ci.yml:128-141`): `pnpm build`, then `git status --porcelain` must be empty. A source change nobody rebuilt fails here rather than shipping the old behaviour from the committed `dist/`.

## 4. Coverage configuration and its exclusions

`vitest.config.ts:10-38`. Provider `v8`; `include: ["src/**/*.ts"]`; thresholds 80% on statements, branches, functions, lines. The threshold's own comment (`vitest.config.ts:33-34`) states its purpose: "A floor, not a target. It exists so a pull request that adds a module and no tests for it goes red rather than diluting the number quietly."

Three exclusions, each with a stated reason (`vitest.config.ts:13-27`), each verified:

| Exclusion              | Stated reason                                                                                                                                           | Verified                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`          | calls `run()` at import, so importing it to measure would execute the action                                                                            | yes — `src/main.ts` ends `await run();`                                                                                                                                 |
| `src/duties/*/main.ts` | same                                                                                                                                                    | yes for all nine. Eight end `await run();`. `src/duties/dependa/main.ts:1098` ends `void run();` — floating, not awaited, and it **is** imported by a test. See `G-01`. |
| `src/doctor/run.ts`    | does not self-invoke, but calls `core.setOutput`/`setFailed` for real, mutating the worker's `process.exitCode` and writing workflow commands to stdout | yes — `src/doctor/run.test.ts:1-13` imports it directly and mocks `@actions/core` (`run.test.ts:24`) precisely to contain that                                          |

The exclusion comment is honest about the substitution: entry points are "covered by driving the built bundles instead, which is what a runner does". That substitution **holds for seven duties**, is **a static file check for harmonise**, and is **absent for dependa** (§2).

`eval/contract/vitest.config.ts:19-29` is a separate config with `root` pinned to its own directory. Its comment explains why: the script invokes `vitest run --config <relative path>`, and a relative config path roots the run at the cwd, "silently widening discovery to the whole repository". `testTimeout` is 180 s there because each case rebuilds a duty bundle and drives fixtures.

## 5. Module → test index

Every production file under `src/`. **NO DIRECT TEST** means no file exists at the same path with any of the six recognised suffixes. It does not always mean unexercised — transitive coverage is noted below the table.

| Module                                                | Lines | Direct tests                                                            |
| ----------------------------------------------------- | ----: | ----------------------------------------------------------------------- |
| `src/core/atlas.ts`                                   |   513 | `atlas.test.ts`                                                         |
| `src/core/chrome.ts`                                  |   700 | `chrome.test.ts`                                                        |
| `src/core/derive.ts`                                  |   120 | `derive.test.ts`                                                        |
| `src/core/detect.ts`                                  |   295 | `detect.test.ts` `detect.integration.test.ts` `detect.contract.test.ts` |
| `src/core/enclose.ts`                                 |   114 | `enclose.test.ts`                                                       |
| `src/core/enforce.ts`                                 |   197 | `enforce.test.ts`                                                       |
| `src/core/forge.ts`                                   |  1200 | `forge.test.ts` `forge.integration.test.ts`                             |
| `src/core/inputs.ts`                                  |   482 | `inputs.test.ts`                                                        |
| `src/core/judge.ts`                                   |   315 | `judge.test.ts`                                                         |
| `src/core/languages.ts`                               |   153 | `languages.test.ts`                                                     |
| `src/core/list.ts`                                    |    22 | `list.test.ts`                                                          |
| `src/core/markdown.ts`                                |   275 | `markdown.test.ts`                                                      |
| `src/core/marker.ts`                                  |   309 | `marker.test.ts`                                                        |
| `src/core/memory.ts`                                  |   653 | `memory.test.ts`                                                        |
| `src/core/meter.ts`                                   |   189 | `meter.test.ts`                                                         |
| `src/core/pivot.ts`                                   |   173 | `pivot.test.ts`                                                         |
| `src/core/provider.ts`                                |   986 | `provider.test.ts` `provider.integration.test.ts`                       |
| `src/core/publish.ts`                                 |   109 | `publish.test.ts`                                                       |
| `src/core/recall.ts`                                  |   317 | `recall.test.ts`                                                        |
| `src/core/sanitize.ts`                                |   225 | `sanitize.test.ts` `sanitize.integration.test.ts`                       |
| `src/core/score.ts`                                   |    94 | **NO DIRECT TEST**                                                      |
| `src/core/screen.ts`                                  |   161 | `screen.test.ts`                                                        |
| `src/core/script.ts`                                  |    90 | `script.test.ts`                                                        |
| `src/core/spam.ts`                                    |   127 | `spam.test.ts`                                                          |
| `src/core/state-branch.ts`                            |   384 | `state-branch.test.ts`                                                  |
| `src/core/summary.ts`                                 |   305 | `summary.test.ts` `summary.contract.test.ts`                            |
| `src/core/sweep.ts`                                   |   173 | `sweep.test.ts`                                                         |
| `src/core/warrant.ts`                                 |  1987 | `warrant.test.ts`                                                       |
| `src/doctor/diagnose.ts`                              |   640 | `diagnose.test.ts`                                                      |
| `src/doctor/profile.ts`                               |    74 | `profile.test.ts`                                                       |
| `src/doctor/run.ts`                                   |   108 | `run.test.ts`                                                           |
| `src/doctor/summary.ts`                               |    83 | `summary.test.ts`                                                       |
| `src/duties/dependa/budget.ts`                        |    35 | `budget.test.ts`                                                        |
| `src/duties/dependa/capabilities.ts`                  |    28 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/conformance/compare.ts`           |   727 | `compare.test.ts`                                                       |
| `src/duties/dependa/conformance/types.ts`             |   272 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/datasources/crates.ts`            |   206 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/datasources/docker-registry.ts`   |   433 | `docker-registry.test.ts`                                               |
| `src/duties/dependa/datasources/github-tags.ts`       |   219 | `github-tags.test.ts`                                                   |
| `src/duties/dependa/datasources/go-proxy.ts`          |   224 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/datasources/npm.ts`               |   285 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/datasources/registry.ts`          |    50 | `registry.test.ts`                                                      |
| `src/duties/dependa/datasources/security-advisory.ts` |   244 | `security-advisory.test.ts`                                             |
| `src/duties/dependa/datasources/types.ts`             |    46 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/evidence.ts`                      |   223 | `evidence.test.ts`                                                      |
| `src/duties/dependa/inputs.ts`                        |    99 | `inputs.test.ts`                                                        |
| `src/duties/dependa/main.ts`                          |  1098 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/managers/cargo.ts`                |   540 | `cargo.test.ts`                                                         |
| `src/duties/dependa/managers/docker.ts`               |   298 | `docker.test.ts`                                                        |
| `src/duties/dependa/managers/github-actions.ts`       |   229 | `github-actions.test.ts`                                                |
| `src/duties/dependa/managers/go.ts`                   |   246 | `go.test.ts`                                                            |
| `src/duties/dependa/managers/npm.ts`                  |   549 | `npm.test.ts`                                                           |
| `src/duties/dependa/managers/registry.ts`             |   136 | `registry.test.ts`                                                      |
| `src/duties/dependa/managers/types.ts`                |    95 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/model.ts`                         |   479 | **NO DIRECT TEST**                                                      |
| `src/duties/dependa/policy.ts`                        |   414 | `policy.test.ts`                                                        |
| `src/duties/dependa/publish.ts`                       |   708 | `publish.test.ts`                                                       |
| `src/duties/dependa/risk.ts`                          |   219 | `risk.test.ts`                                                          |
| `src/duties/dependa/semver.ts`                        |   432 | `semver.test.ts` `semver.property.test.ts`                              |
| `src/duties/dependa/summary.ts`                       |    79 | `summary.test.ts`                                                       |
| `src/duties/dependa/validation.ts`                    |   299 | `validation.test.ts` `validation.adversarial.test.ts`                   |
| `src/duties/duplicate/capabilities.ts`                |    33 | **NO DIRECT TEST**                                                      |
| `src/duties/duplicate/corpus.ts`                      |   189 | `corpus.test.ts`                                                        |
| `src/duties/duplicate/main.ts`                        |   813 | `main.integration.test.ts`                                              |
| `src/duties/duplicate/outputs.ts`                     |   104 | `outputs.test.ts`                                                       |
| `src/duties/duplicate/proposal.ts`                    |   141 | `proposal.test.ts`                                                      |
| `src/duties/duplicate/publish.ts`                     |   412 | `publish.test.ts`                                                       |
| `src/duties/duplicate/rank.ts`                        |    83 | `rank.test.ts`                                                          |
| `src/duties/duplicate/summary.ts`                     |   316 | `summary.test.ts`                                                       |
| `src/duties/duplicate/verdict.ts`                     |   261 | `verdict.test.ts`                                                       |
| `src/duties/harmonise/budget.ts`                      |    58 | `budget.test.ts`                                                        |
| `src/duties/harmonise/capabilities.ts`                |    33 | `capabilities.test.ts`                                                  |
| `src/duties/harmonise/classify.ts`                    |   195 | `classify.test.ts`                                                      |
| `src/duties/harmonise/diff.ts`                        |    87 | `diff.test.ts`                                                          |
| `src/duties/harmonise/discover.ts`                    |   111 | `discover.test.ts`                                                      |
| `src/duties/harmonise/draft.ts`                       |   536 | `draft.test.ts` `draft.integration.test.ts`                             |
| `src/duties/harmonise/ignore.ts`                      |   201 | `ignore.test.ts`                                                        |
| `src/duties/harmonise/inputs.ts`                      |    16 | `inputs.test.ts`                                                        |
| `src/duties/harmonise/judge.ts`                       |   102 | `judge.test.ts`                                                         |
| `src/duties/harmonise/main.ts`                        |   896 | `main.test.ts` `main.integration.test.ts`                               |
| `src/duties/harmonise/provenance.ts`                  |   284 | `provenance.test.ts`                                                    |
| `src/duties/harmonise/publish.ts`                     |   285 | `publish.test.ts`                                                       |
| `src/duties/harmonise/score.ts`                       |   191 | `score.test.ts`                                                         |
| `src/duties/harmonise/summary.ts`                     |   100 | `summary.test.ts`                                                       |
| `src/duties/lifecycle/capabilities.ts`                |    22 | **NO DIRECT TEST**                                                      |
| `src/duties/lifecycle/clock.ts`                       |   448 | `clock.test.ts`                                                         |
| `src/duties/lifecycle/main.ts`                        |   615 | `main.integration.test.ts`                                              |
| `src/duties/lifecycle/message.ts`                     |    76 | `message.test.ts`                                                       |
| `src/duties/lifecycle/summary.ts`                     |   173 | `summary.test.ts`                                                       |
| `src/duties/lifecycle/timeline.ts`                    |   180 | `timeline.test.ts`                                                      |
| `src/duties/remediation/capabilities.ts`              |    33 | `capabilities.test.ts`                                                  |
| `src/duties/remediation/envelope.ts`                  |   186 | `envelope.test.ts`                                                      |
| `src/duties/remediation/main.ts`                      |   180 | `main.integration.test.ts`                                              |
| `src/duties/remediation/proposal.ts`                  |   166 | `proposal.test.ts`                                                      |
| `src/duties/remediation/report.ts`                    |    64 | `report.test.ts`                                                        |
| `src/duties/respond/capabilities.ts`                  |    37 | **NO DIRECT TEST**                                                      |
| `src/duties/respond/draft.ts`                         |   278 | `draft.test.ts`                                                         |
| `src/duties/respond/guidance.ts`                      |    75 | `guidance.test.ts`                                                      |
| `src/duties/respond/judge.ts`                         |    92 | `judge.test.ts`                                                         |
| `src/duties/respond/main.ts`                          |   680 | `main.integration.test.ts`                                              |
| `src/duties/respond/publish.ts`                       |   205 | `publish.test.ts`                                                       |
| `src/duties/respond/summary.ts`                       |   214 | `summary.test.ts`                                                       |
| `src/duties/review/architecture.ts`                   |   451 | `architecture.test.ts`                                                  |
| `src/duties/review/capabilities.ts`                   |    34 | **NO DIRECT TEST**                                                      |
| `src/duties/review/context.ts`                        |   660 | `context.test.ts` `context.security.test.ts`                            |
| `src/duties/review/disposition.ts`                    |   213 | `disposition.test.ts`                                                   |
| `src/duties/review/evidence.ts`                       |    74 | `evidence.test.ts`                                                      |
| `src/duties/review/findings.ts`                       |   446 | `findings.test.ts`                                                      |
| `src/duties/review/limits.ts`                         |    10 | `limits.test.ts`                                                        |
| `src/duties/review/main.ts`                           |  1042 | `main.integration.test.ts`                                              |
| `src/duties/review/packs.ts`                          |   249 | `packs.test.ts`                                                         |
| `src/duties/review/passes.ts`                         |   648 | `passes.test.ts`                                                        |
| `src/duties/review/pr.ts`                             |   364 | `pr.test.ts`                                                            |
| `src/duties/review/providers.ts`                      |    64 | `providers.test.ts`                                                     |
| `src/duties/review/publish.ts`                        |   636 | `publish.test.ts`                                                       |
| `src/duties/review/risk.ts`                           |   653 | `risk.test.ts`                                                          |
| `src/duties/review/rules.ts`                          |   763 | `rules.test.ts`                                                         |
| `src/duties/review/summary.ts`                        |   236 | `summary.test.ts`                                                       |
| `src/duties/review/testmap.ts`                        |   551 | `testmap.test.ts`                                                       |
| `src/duties/review/threads.ts`                        |   349 | `threads.test.ts`                                                       |
| `src/duties/review/verdict.ts`                        |   105 | `verdict.test.ts`                                                       |
| `src/duties/review/verify.ts`                         |    78 | `verify.test.ts`                                                        |
| `src/duties/translate/budget.ts`                      |    61 | `budget.test.ts`                                                        |
| `src/duties/translate/capabilities.ts`                |    31 | **NO DIRECT TEST**                                                      |
| `src/duties/translate/draft.ts`                       |   269 | `draft.test.ts` `draft.integration.test.ts`                             |
| `src/duties/translate/engine.ts`                      |   226 | `engine.test.ts`                                                        |
| `src/duties/translate/inputs.ts`                      |    87 | `inputs.test.ts`                                                        |
| `src/duties/translate/judge.ts`                       |   104 | `judge.test.ts` `judge.integration.test.ts`                             |
| `src/duties/translate/main.ts`                        |   602 | `main.integration.test.ts`                                              |
| `src/duties/translate/publish.ts`                     |   305 | `publish.test.ts` `publish.integration.test.ts`                         |
| `src/duties/translate/score.ts`                       |   344 | `score.test.ts` `score.integration.test.ts`                             |
| `src/duties/translate/summary.ts`                     |   291 | `summary.test.ts`                                                       |
| `src/duties/translate/text.ts`                        |   410 | `text.test.ts`                                                          |
| `src/duties/triage/capabilities.ts`                   |    40 | **NO DIRECT TEST**                                                      |
| `src/duties/triage/inputs.ts`                         |   131 | `inputs.test.ts`                                                        |
| `src/duties/triage/main.ts`                           |  1321 | `main.integration.test.ts`                                              |
| `src/duties/triage/outcome.ts`                        |   308 | `outcome.test.ts`                                                       |
| `src/duties/triage/outputs.ts`                        |   213 | `outputs.test.ts`                                                       |
| `src/duties/triage/propose.ts`                        |  1113 | `propose.test.ts`                                                       |
| `src/duties/triage/record.ts`                         |   512 | `record.test.ts`                                                        |
| `src/duties/triage/store.ts`                          |   407 | `store.test.ts`                                                         |
| `src/duties/triage/summary.ts`                        |   382 | `summary.test.ts`                                                       |
| `src/duties/triage/verdict.ts`                        |   255 | `verdict.test.ts`                                                       |
| `src/main.ts`                                         |   149 | `main.integration.test.ts`                                              |
| `src/refusal.ts`                                      |   145 | `refusal.test.ts`                                                       |

### Notes on the NO-DIRECT-TEST rows

- `src/duties/dependa/conformance/types.ts`, `datasources/types.ts`, `managers/types.ts` — type-only, zero runtime exports (`grep -c '^export \(function\|class\|const\)'` returns 0 for each). No direct test is correct.
- `src/duties/dependa/model.ts` — three runtime constants (`:27` `ECOSYSTEMS`, `:151` `UPDATE_TYPES`, `:469` `DEFAULT_DEPENDA_POLICY`). `DEFAULT_DEPENDA_POLICY` is exercised transitively and heavily by `src/duties/dependa/policy.test.ts:60-125`.
- `src/core/score.ts` — exercised transitively through `src/duties/translate/score.ts:23` and `src/duties/harmonise/score.ts:19`, and directly imported by `src/duties/translate/judge.test.ts:5`. No file asserts `shared()`/`overlap()` in isolation.
- The six `capabilities.ts` files with no direct test (`dependa`, `duplicate`, `lifecycle`, `respond`, `review`, `translate`, `triage`) hold **authority constants**, consumed by `src/doctor/diagnose.ts:55-88` and `:140-150`. `harmonise` and `remediation` do have one each (`harmonise/capabilities.test.ts`, `remediation/capabilities.test.ts`) — the asymmetry is not explained anywhere. See `A-04`.
- `src/duties/dependa/datasources/{crates,go-proxy,npm}.ts` have no direct test while their three siblings (`docker-registry`, `github-tags`, `security-advisory`) do. All six are network-response parsers with malformed-input paths. See `P-05`.
- `src/duties/dependa/main.ts` (1098 lines) is the largest untested file in the repository: no unit test, no bundle-driven test, and coverage-excluded. Only `cronFieldMatches`/`cronMatches` are reached, by `src/duties/dependa/cron.test.ts` — which imports the module and therefore executes the duty (`G-01`).

## 6. The seams that keep the suite deterministic

Named, because "mocked" is not one thing here.

| Seam                                | Where it is defined                                                                                              | What it replaces                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local HTTP stub server**          | `node:http` `createServer` inside each bundle-driven integration test, e.g. `triage/main.integration.test.ts:26` | Both GitHub and the model provider at once. `@actions/github` finds it via `GITHUB_API_URL`; the provider finds it via the `base-url` input.                               |
| **Rebuilt bundle**                  | `beforeAll` + `execFile` on `tools/build.mjs`, `triage/main.integration.test.ts:65-70`                           | Nothing — the artifact under test is real, deliberately rebuilt so a case cannot pass against a stale `dist/`.                                                             |
| **`INPUT_*` env + `GITHUB_OUTPUT`** | the `runAction` helper in each bundle-driven file                                                                | The runner's input/output protocol. This is why `readShared` is the one settings path tested for real (`core/inputs.test.ts`).                                             |
| **Object-literal `Provider`**       | e.g. `src/duties/harmonise/main.test.ts:23-32`, `roster.contract.test.ts:31-49`                                  | The HTTP provider. A `complete(model, messages)` returning a scripted `Completion`; unknown ids fail `protocol`. This is the standard unit seam for anything model-facing. |
| **Object-literal `Api`**            | e.g. `src/duties/dependa/authority.contract.test.ts:23`                                                          | Octokit. Route methods are `vi.fn()`s, so "was this mutation attempted" is assertable.                                                                                     |
| **`vi.mock("@actions/core")`**      | 20+ files, e.g. `src/duties/review/architecture.test.ts:15`                                                      | `core.warning`/`info`/`setFailed`/`setOutput`. Almost always with `importOriginal` spread so only the observed function is faked.                                          |
| **`fast-check`**                    | `dependa/semver.property.test.ts`, `dependa/validation.adversarial.test.ts:16`                                   | Hand-picked examples, for algebraic and hostile-input surfaces.                                                                                                            |
| **`eval/` stub harness**            | `eval/harness.ts`, `eval/drivers/*.ts`, `eval/runner.ts:171-172`                                                 | The provider entirely (`sk-stub-key`), plus GitHub routes per duty. This is what lets `pnpm eval all` run on a fork with no secrets.                                       |

`src/core/enclose.ts` deserves a line of its own: it is the determinism seam for prompt integrity. A nonce is drawn per call (`enclose.ts:92`) and the boundary rule is carried beside the block (`enclose.ts:98-111`), so a test can assert the exact fence rather than a regex over a prompt. `enclose.test.ts:46` ("leaves a forged closing tag unable to close the real one") is the assertion that makes the seam worth having.

## 7. Contract tests versus unit tests, here

A unit test in this repository asserts what one function returns. A contract test asserts that a **named doctrine invariant survives composition** — it drives the real production functions, in the order a run drives them, and names the invariant in the `describe` string so a reader can find the doctrine section it defends.

The five in `src/`:

| File                                                      | Invariants pinned                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/authority.contract.test.ts:41,80,122,137`       | B2 (unnamed duty in a written block is denied), B3/B4 (enforcement gates, never widens), D2 (malformed config fails deterministically), C3 (per-duty default languages)    |
| `src/duties/triage/roster.contract.test.ts:50,83,115,160` | A1 (ordered rotation, never index 0), A6 (`screen-models` cheap roster and its documented fallback), A6 (spam sift's empty-roster contract), A3/A5 (weather across stages) |
| `src/core/detect.contract.test.ts:46`                     | the language picker is a rotation, a first-model failure falls through, an exhausted roster yields `null` rather than a guess                                              |
| `src/core/summary.contract.test.ts:27`                    | A5 at the duty boundary — all-protocol goes red, all-capacity does not, mixed and partial do not                                                                           |
| `src/duties/dependa/authority.contract.test.ts:104`       | B3 — dry-run is a property of the publish gate, not a style of the report; the real run reaches the PR create                                                              |

Under `eval/contract/` the same idea is applied to the harness rather than to the product: `contract.test.ts:67-144` pins the post-1.0 `duties:` vocabulary against an independent expected-grant oracle; `exit-code.test.ts` and `exit-code.integration.test.ts:119-152` pin the fail-closed exit code including the "a duty with no fixtures is not passing" rule; `fixtures.test.ts:26-55` pins fixture discovery; `multilingual.test.ts:65-183` pins the language matrix and, critically, that a misidentified language is `failed` and never `skipped`.

## 8. How `eval/` and `dogfood/` relate to the suite

**`eval/`** is a third tier below the unit and bundle tiers: the same real bundles, driven over versioned fixtures, with a three-way outcome instead of pass/fail. `eval/README.md:1-27` defines it: `finding` (did the thing the fixture expected), `failed` (bundle errored), `skipped` (succeeded but deliberately did nothing — dry-run, warrant denial, screened out, below floor). The exit code is fail-closed: `0` only when every fixture is a `finding`; `1` when any failed **or skipped**, or when a duty has no fixtures at all; `2` for an unknown duty. "A duty the warrant no longer grants would read `skipped` everywhere — and that must not exit green."

84 fixture files across 9 duties. Most fixtures are a single `.expected.json`; `harmonise` and a few others carry real content files too. `eval/live.ts` is the same fixtures with only the completion endpoint made real, run by hand for accuracy numbers CI cannot measure.

**`dogfood/`** is not a test tier. `dogfood/README.md:1-33`: dependa runs in shadow mode against this repository — its warrant omits `dependa` from `duties:`, so no grant exists and it creates no branches, commits or PRs — and its observations are compared against Renovate's real PRs to produce a conformance dataset. The comparison logic that matters is not in `dogfood/`: `dogfood/conformance/` is CLI tooling excluded from eslint's project (`lefthook.yml`, the `dogfood/**` exclusion), while the canonical implementation lives at `src/duties/dependa/conformance/compare.ts` and is tested by `compare.test.ts` (887 lines). Ten `dogfood/fixtures/*` manifests feed it.

## 9. Where this map disagrees with existing internal docs

Verified against source; recorded, not fixed.

- `docs/internal/intent-matrix.md:33` cites `src/duties/harmonise/draft.ts:330` for the `models[0]` fallback label. The line is **327** (`:330` is a closing brace).
- `docs/internal/intent-matrix.md:99-100` (A4) cites `provider.test.ts` "1192 (grounded models never re-asked)". Line 1192 is a comment inside `it("seeds the weather with the extra rosters a duty names…")`, whose only assertion is `expect(weather.multiEndpoint).toBe(true)`. The evidence the row wants is at `provider.test.ts:737` ("skips a model already grounded this run, without calling it again"). Mis-attributed citation.
- `docs/internal/intent-matrix.md:583-587` (GAP 4) describes an untested `asEditor` / `session.interactive` pattern in `getSettings`. **None of those three identifiers exists anywhere under `src/`.** The row is stale and should be struck rather than owned.
- `docs/internal/intent-matrix.md:576-580` (GAP 3, lifecycle recursion guard) is still open and correctly stated: `isReeveProposalPr` is used at `lifecycle/main.ts:223` and `:450`, and the only test of it anywhere is `src/core/marker.test.ts:149-172`. `lifecycle/main.integration.test.ts` has no proposal-PR case.
- `docs/internal/intent-matrix.md:569-575` (GAP 1, `screen-models` detect fallback) is partly closed. `roster.contract.test.ts:97` pins the callee side and names `main.ts:911` in its title, but the fallback expression itself appears at **five** call sites — `triage/main.ts:911`, `triage/record.ts:177`, `:320`, `:447`, `respond/main.ts:396` — and no test drives any of them.
- All file paths cited in `intent-matrix.md` and `failure-matrix.md` resolve; spot-checked line anchors in `failure-matrix.md` (`provider.ts:624`, `:815`, `forge.ts:863`, `:947`, `warrant.ts:878`, `:907`, `review/threads.ts:270`, `review/verdict.ts:30`) are all accurate.

## 10. Measured suite health at the time of writing

- `node_modules/.bin/vitest run --coverage --testTimeout=180000`: **3622 passed, 0 failed, 151/151 files**, 116 s. Coverage: statements **88.74%** (7990/9003), branches **81.43%** (5650/6938), functions **94.05%** (1360/1446), lines **89.84%** (7053/7850) — all four above the configured 80% floor, all but functions below the 90% floor this round targets. Per-file branch debt and its classification are in `gap-matrix.md`.
- At the configured default timeout the same command fails one case: `src/duties/triage/main.integration.test.ts:1795` times out at 30 000 ms under the full parallel run, while the same file re-run alone passes 101/101 in 96 s. The timeout is `vi.setConfig({ testTimeout: 30_000 })` at the head of each bundle-driven file (e.g. `triage/main.integration.test.ts:36`) and it is load-dependent, not deterministic. See `gap-matrix.md` `P-08`.
- The suite emits `::error::Input required and not supplied: github-token` on every run and stays green: `src/duties/dependa/cron.test.ts:9` value-imports `./main.js`, whose last line is `void run();`. See `gap-matrix.md` `G-01`.
- `node tools/mutation.mjs`: **9 KILLED, 0 SURVIVED**. Every mutation in the table is caught. That is a statement about the table's size, not about the suite's strength — see `gap-matrix.md` §"Mutations to add".
