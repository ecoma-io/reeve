# Coverage baseline

_What the suite measures after Round 1, what it does not, and where the remaining gaps are. Internal companion to the failure matrix and the mutation report; not a user-facing guide._

Every claim here is a number a command produced or a line the source carries. The commands, run from the repository root:

```sh
pnpm test                # vitest run --coverage
node tools/mutation.mjs  # the mutation table
```

The percentages are `@vitest/coverage-v8` over `src/**/*.ts`, minus the excluded entry points named below. Per-file uncovered ranges are read out of `coverage/lcov.info` from the same run, not out of the truncated `text` reporter column.

## Where it landed

Round 1 raised the floor to 90 on all four metrics and then wrote the tests to meet it. Measured on the integrated tree, 187 test files and 4850 tests all passing:

| Metric     | `0fa21e6` baseline | Round 1 | Change | Hit / total | Headroom above the 90 floor |
| ---------- | -----------------: | ------: | -----: | ----------: | --------------------------: |
| Statements |              88.73 |   96.51 |  +7.78 | 8752 / 9068 |              590 statements |
| Branches   |              81.42 |   91.03 |  +9.61 | 6394 / 7024 |             **72 branches** |
| Functions  |              94.05 |   98.48 |  +4.43 | 1432 / 1454 |               123 functions |
| Lines      |              89.84 |   97.59 |  +7.75 | 7713 / 7903 |                   600 lines |

**The gate passes and the run exits 0.** The branch floor was 596 branches short at `0fa21e6`; it is now 72 branches clear of the floor.

### 72 branches is thin, and that is the floor working

Branch coverage sits 1.03 points above its floor. The other three sit between 6 and 8.5 points above theirs. In absolute terms 72 branches is roughly one mid-sized module arriving with no tests — `src/duties/dependa/publish.ts` alone still carries 33 uncovered branches, and `src/duties/triage/propose.ts` carries 74.

That is not a warning that the number is fragile. It is the floor doing exactly what `vitest.config.ts`'s comment says it is for: "a pull request that adds a module and no tests for it goes red rather than diluting the number quietly." A 1-point margin means that failure is caught on the pull request that causes it rather than four modules later. Two consequences follow, and both are deliberate:

- **A pull request that adds a substantial module will need tests in the same pull request.** That is the intended cost, not an accident of where the number happened to land.
- **The fix when it goes red is the test, never the threshold.** The floor never goes down — see the rules below.

The one thing to watch is the shape of what closes the gap, not the size of it. Branch coverage is the metric most easily bought with a test that enters a branch and asserts nothing; see [What this document does not measure](#what-this-document-does-not-measure).

## The floor

`vitest.config.ts` carries `statements: 90, branches: 90, functions: 90, lines: 90`.

**Provenance: a product decision taken in the Round 1 hardening pass, not a number derived from the measurement.** It was raised from `80/80/80/80` against a baseline of 88.73 / 81.42 / 94.05 / 89.84, which means three of the four metrics were _below_ the floor at the moment it was written. That was the point — the number names where the repository has decided to be, and the tests were written to meet it rather than the number lowered to meet the tests.

Three rules travel with it:

1. **It never goes down.** A red threshold is a missing test, and the fix is the test.
2. **`exclude` never grows to hide uncovered code.** An exclusion removes a file from the denominator, which raises the percentage while covering nothing. It is the one edit that can make this gate lie.
3. **It is not sufficient on its own.** A line can be executed by a test that asserts nothing. The paired gate is `tools/mutation.mjs`.

## The exclusions, restated

`vitest.config.ts` excludes exactly three globs. Each is restated with the reason it is not a way of hiding code:

| Glob                   | Why it is excluded                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`          | Calls `run()` at import time. Importing it to measure it would execute the action inside the test worker.                                                                                                                                                                                    |
| `src/duties/*/main.ts` | Same shape, one per duty. Covered instead by driving the built bundles (`src/duties/*/main.integration.test.ts`), which is what a runner does — and which is why that coverage does not appear in these numbers: the bundle runs in a separate process the v8 provider is not instrumenting. |
| `src/doctor/run.ts`    | Does not self-call at import, but calls `core.setOutput` / `core.setFailed` for real, mutating the worker's own `process.exitCode` and writing workflow commands to stdout rather than returning a value a test can assert on.                                                               |

The list is defensible as it stands; the point of restating it is that **it must not grow**. A new exclusion is a coverage number that went up without a test being written.

There is a second, unwritten exclusion worth naming: the `include` glob is `src/**/*.ts`, so `eval/**`, `dogfood/**`, `scripts/**` and `tools/**` are outside the measurement entirely. `eval/` has its own suite (`pnpm test:contract`, `eval/contract/vitest.config.ts`) and `scripts/` has `pnpm test:docs-links`; `tools/` — including the mutation harness itself — has neither.

## Per directory

Statements / branches, before and after:

| Directory                            | Stmts `0fa21e6` | Stmts now | Branch `0fa21e6` | Branch now | Uncovered branches |
| ------------------------------------ | --------------: | --------: | ---------------: | ---------: | -----------------: |
| `src/core`                           |           96.10 |     99.37 |            91.81 |      97.03 |                 51 |
| `src/doctor`                         |           97.94 |    100.00 |            83.33 |      91.66 |                  8 |
| `src/duties/dependa`                 |           87.16 |     92.36 |            82.08 |      86.61 |                 87 |
| `src/duties/dependa/conformance`     |           97.91 |     97.91 |            85.10 |      85.10 |                 35 |
| **`src/duties/dependa/datasources`** |       **36.00** | **92.95** |        **28.60** |  **86.32** |             **58** |
| `src/duties/dependa/managers`        |           84.47 |     91.02 |            72.20 |      82.23 |                 92 |
| `src/duties/duplicate`               |           99.10 |     99.10 |            95.78 |      95.78 |                  8 |
| `src/duties/harmonise`               |           87.38 |     95.42 |            75.56 |      84.55 |                 55 |
| `src/duties/lifecycle`               |           94.69 |     94.69 |            90.37 |      90.37 |                 23 |
| `src/duties/remediation`             |           86.30 |     97.26 |            78.66 |      90.66 |                  7 |
| `src/duties/respond`                 |           96.75 |     96.75 |            91.80 |      91.80 |                 10 |
| `src/duties/review`                  |           88.32 |     97.66 |            80.61 |      93.71 |                 99 |
| `src/duties/translate`               |           99.44 |     99.44 |            95.17 |      95.17 |                 11 |
| `src/duties/triage`                  |           94.59 |     94.59 |            84.46 |      84.99 |                 86 |

### The datasources question, answered and closed

The Round 1 audit found `src/duties/dependa/datasources` at 36.00 / 28.60 and had to decide whether that was a real behavioral gap or an intentional live-only layer. The verdict was **a real gap**, on four pieces of evidence: two of the six datasources already had offline fetch-mocking tests (`docker-registry.test.ts`, `github-tags.test.ts`); the three worst — `crates.ts`, `go-proxy.ts`, `npm.ts` — had no test file at all and were imported only by the excluded `src/duties/dependa/main.ts`; no document declared a live-only intent; and `CONTRIBUTING.md:96` states the opposite rule for the whole repository ("Nothing in the suite reaches a model … deterministic, offline, and safe to run on a fork's pull request").

That verdict has been acted on. `crates.test.ts`, `go-proxy.test.ts` and `npm.test.ts` now exist, and the directory reads **92.95 / 86.32** — 302 uncovered branches down to 58. It was also, by a wide margin, the single largest contributor to clearing the branch floor.

## What is still uncovered

Ranked by uncovered branches. Classification key: **(a)** genuinely untested behavior · **(b)** defensive or unreachable · **(c)** reachable only via an excluded entry point · **(d)** dead code.

| Uncovered | File                                                | Branch % | Classification                                                                                                                                                                                                            | Owner | Prio |
| --------: | --------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---: |
|        74 | `src/duties/triage/propose.ts`                      |    68.10 | **(a)** — the warrant-taxonomy proposal body renderer (`:686-728`) and the `### propose` summary block (`:883-906`) including its dry-run and unchanged arms. Authority-adjacent, and the largest single remaining block. | TL2   |   P1 |
|        35 | `src/duties/dependa/conformance/compare.ts`         |    85.10 | **(a)** — comparison branches at `:77,325,374,571`. Untouched by Round 1.                                                                                                                                                 | TL2   |   P2 |
|        35 | `src/duties/dependa/datasources/docker-registry.ts` |    72.66 | **(a)** — the one datasource whose Round 1 gain came from a pre-existing test rather than a new one; pagination and v2-registry arms remain.                                                                              | TL2   |   P2 |
|        33 | `src/duties/dependa/publish.ts`                     |    69.72 | **(a)** — GitHub mutation. `commitFile`'s 409-conflict re-read-and-retry (`:600-643`) is now mutation-gated but still thin on direct cases.                                                                               | TL2   |   P1 |
|        32 | `src/duties/dependa/managers/cargo.ts`              |    77.94 | **(a)** — manifest parsing, `:321-332`.                                                                                                                                                                                   | TL2   |   P2 |
|        29 | `src/duties/dependa/managers/npm.ts`                |    83.24 | **(a)** — the remainder of `parsePnpmLockYaml`, plus the lockfile name-confusion boundary named in the mutation report's equivalent-mutants section.                                                                      | TL2   |   P1 |
|        19 | `src/duties/dependa/semver.ts`                      |    90.95 | **(a)** — property-tested already; the remainder is long-tail range syntax.                                                                                                                                               | TL2   |   P3 |
|        19 | `src/duties/review/testmap.ts`                      |    88.76 | **(a)** — `:239,252,273`.                                                                                                                                                                                                 | TL4   |   P3 |
|        18 | `src/core/atlas.ts`                                 |    87.84 | **(a)** — the remaining `isCapacityError` degradation arms; the truncation arm is now mutation-gated.                                                                                                                     | TL4   |   P2 |
|        18 | `src/duties/dependa/policy.ts`                      |    80.65 | **(a)** — `:349-366,387,412`.                                                                                                                                                                                             | TL2   |   P2 |
|        16 | `src/duties/lifecycle/clock.ts`                     |    89.33 | **(a)** — untouched by Round 1.                                                                                                                                                                                           | TL2   |   P2 |
|        15 | `src/core/warrant.ts`                               |    97.17 | **(a)** — long tail of the configuration grammar. `readSay`'s refusals, a P0 at `0fa21e6`, are now covered.                                                                                                               | TL3   |   P3 |

Two whole-directory observations:

- **`src/duties/dependa` is where the remaining debt lives.** Its subtrees hold 272 of the 630 uncovered branches — 43% — spread across conformance, managers, datasources and publish. Nothing there is unreachable; it is the largest surface with the least test-writing attention.
- **`src/duties/triage` barely moved** (84.46 → 84.99) and `propose.ts` alone is 74 branches. It is the biggest single win still available.

## Is the floor safe from here

Against the 72-branch headroom, the practical question is what a future pull request costs.

- A pull request adding a module of roughly 70 branches with no tests takes the suite red. That is the design.
- A pull request adding tests anywhere in the table above buys headroom back cheaply: `propose.ts` alone is worth 74 branches, which would double the margin.
- INFERRED, from the classification above rather than an exhaustive audit: essentially none of the 630 remaining uncovered branches is classified (b), (c) or (d). Round 1 absorbed the reachable-only-via-entry-point cases and the genuinely defensive tail is small. So the margin is recoverable by ordinary test-writing rather than by argument about what counts.

## What this document does not measure

Coverage says a line ran. It does not say anything failed when the line's behavior changed — a test that calls a function and asserts nothing covers it perfectly. That is the question `tools/mutation.mjs` asks, and [the mutation report](mutation-report.md) is where it is answered: 54 mutations, 54 killed, 0 survived, 0 stale.

The two belong together, and Round 1 produced the worked example of why. The coverage floor caught modules that arrived with no tests. The mutation table caught something coverage cannot see at all: a legitimate fix in `src/duties/review/threads.ts` moved a seam and silently disarmed a gate in the mutation table, which the preflight reported as `STALE` rather than passing over. Coverage was 97% in that file throughout.

The specific failure mode to watch now that branches sit 1 point above the floor is coverage bought with assertion-free tests. A branch newly reached by a test that only calls it moves the number without moving the guarantee. The mutation table is the detector: a mutation that starts SURVIVING in a directory whose coverage just went up is exactly that. `docs/internal/ci-gates.md` carries the criteria for telling the two apart in this codebase's own idiom.
