# Coverage baseline

_What the suite measures at `0fa21e6`, what it does not, and which of the gaps are behavior nobody tests rather than code nobody can reach. Internal companion to the failure matrix and the mutation report; not a user-facing guide._

Every claim here is a number a command produced or a line the source carries. The commands, run from the repository root:

```sh
pnpm test                # vitest run --coverage
node tools/mutation.mjs  # the mutation table
```

The percentages below are `@vitest/coverage-v8` over `src/**/*.ts`, minus the excluded entry points named further down. The per-file uncovered ranges are read out of `coverage/lcov.info` from the same run, not out of the truncated `text` reporter column.

## The baseline

At `0fa21e6`, 151 test files, 3622 tests, all passing:

| Metric     |     % | Hit / total | Uncovered |
| ---------- | ----: | ----------: | --------: |
| Statements | 88.73 | 7989 / 9003 |      1014 |
| Branches   | 81.42 | 5649 / 6938 |      1289 |
| Functions  | 94.05 | 1360 / 1446 |        86 |
| Lines      | 89.84 | 7053 / 7850 |       797 |

Independently re-measured in the Round 1 worktree, 151 files and 3622 tests all passing: 88.72 / 81.40 / 94.05 / 89.84. The two runs differ by at most 0.02 points and one statement, which is measurement noise rather than a missing test. Worth knowing for anyone reproducing it on a small box: `src/duties/triage/main.integration.test.ts` (the numbered-sibling cap case) pins its own 30-second budget at `:36` via `vi.setConfig`, which a contended four-core runner exceeds — `--maxWorkers=3` is enough to make it deterministic and does not change any coverage figure.

## The floor

`vitest.config.ts` now carries `statements: 90, branches: 90, functions: 90, lines: 90`.

**Provenance: this is a product decision taken in the Round 1 hardening pass, not a number derived from the measurement.** It was raised from `80/80/80/80` against the baseline in the table above, which means three of the four metrics were _below_ the floor at the moment it was written. That is deliberate — the number names where the repository has decided to be, and the tests are written to meet it. The rules that travel with it are in `vitest.config.ts`'s own doc comment: the floor never goes down, and `exclude` never grows to hide uncovered code.

What the floor costs, in units nobody can argue with:

| Metric     | Baseline | Floor | Must additionally cover |
| ---------- | -------: | ----: | ----------------------: |
| Statements |    88.73 |    90 |          114 statements |
| Branches   |    81.42 |    90 |        **596 branches** |
| Functions  |    94.05 |    90 |    already above, by 58 |
| Lines      |    89.84 |    90 |                12 lines |

Branches is the binding constraint and the only one that is not close. 596 of the 1289 currently-uncovered branches — 46% of everything the suite does not reach — have to be reached. Whether that is achievable is the question the classification below exists to answer; the short version is in [Is 90% branches reachable](#is-90-branches-reachable).

## The exclusions, restated

`vitest.config.ts` excludes exactly three globs from coverage. An exclusion removes a file from the denominator, which raises the percentage while covering nothing, so each one is restated here with the reason it is not a way of hiding code:

| Glob                   | Why it is excluded                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main.ts`          | Calls `run()` at import time. Importing it to measure it would execute the action inside the test worker.                                                                                                                                                                                              |
| `src/duties/*/main.ts` | Same shape, one per duty. These are covered instead by driving the built bundles (`src/duties/*/main.integration.test.ts`), which is what a runner does — and which is why that coverage does not appear in these numbers: the bundle runs in a separate process the v8 provider is not instrumenting. |
| `src/doctor/run.ts`    | Does not self-call at import, but calls `core.setOutput` / `core.setFailed` for real, mutating the worker's own `process.exitCode` and writing workflow commands to stdout rather than returning a value a test can assert on.                                                                         |

The third is the one worth watching. Its stated reason — "calls `setFailed`/`setOutput` for real" — applies equally to every duty's settings-reading code, and `src/core/inputs.test.ts` documents the one exception the repository makes (`readShared`, driven through real environment variables). The list is defensible as it stands; the point of restating it is that **it must not grow**. A new exclusion is a coverage number that went up without a test being written.

There is a second, unwritten exclusion worth naming: the `include` glob is `src/**/*.ts`, so `eval/**`, `dogfood/**`, `scripts/**` and `tools/**` are outside the measurement entirely. `eval/` has its own suite (`pnpm test:contract`, 32 tests, `eval/contract/vitest.config.ts`) and `scripts/` has `pnpm test:docs-links`; `tools/` — including the mutation harness itself — has neither.

## Per directory

Statements / branches, from the same run:

| Directory                            |     Stmts |    Branch | Uncovered branches | Owner       |
| ------------------------------------ | --------: | --------: | -----------------: | ----------- |
| `src/core`                           |     96.10 |     91.81 |                140 | TL2/TL3/TL4 |
| `src/doctor`                         |     97.94 |     83.33 |                 16 | TL3         |
| `src/duties/dependa`                 |     87.16 |     82.08 |                105 | TL2         |
| `src/duties/dependa/conformance`     |     97.91 |     85.10 |                 35 | TL2         |
| **`src/duties/dependa/datasources`** | **36.00** | **28.60** |            **302** | **TL2**     |
| `src/duties/dependa/managers`        |     84.47 |     72.20 |                144 | TL2         |
| `src/duties/duplicate`               |     99.10 |     95.78 |                  8 | TL2         |
| `src/duties/harmonise`               |     87.38 |     75.56 |                 87 | TL2         |
| `src/duties/lifecycle`               |     94.69 |     90.37 |                 23 | TL2         |
| `src/duties/remediation`             |     86.30 |     78.66 |                 16 | TL2         |
| `src/duties/respond`                 |     96.75 |     91.80 |                 10 | TL2         |
| `src/duties/review`                  |     88.32 |     80.61 |                303 | TL4         |
| `src/duties/translate`               |     99.44 |     95.17 |                 11 | TL2         |
| `src/duties/triage`                  |     94.59 |     84.46 |                 89 | TL2         |

A directory percentage hides the shape of what is missing. `src/duties/review` at 80.61% and `src/duties/dependa/datasources` at 28.60% are within 1 branch of each other in absolute terms — 303 against 302 — but they are different problems: review is a large tree that is thoroughly tested with a few thin modules in it, and datasources is a small tree that is barely tested at all.

## The verdict on `dependa/datasources`

**302 uncovered branches, 28.60%. This is a real behavioral gap, not an intentional live-only layer.** The evidence, in the order it settles the question:

1. **Two of the six datasources already have offline tests, and they are fetch-mocking unit tests.** `src/duties/dependa/datasources/docker-registry.test.ts:1-6` says so in its own header — "Mocks global `fetch` to simulate Docker Hub API responses with pagination, v2 registry responses, and error conditions. No real network calls." `src/duties/dependa/datasources/github-tags.test.ts:14-18` does the same with a three-line `fetchMock(status)` helper and asserts the 403/429/404 classifications. The pattern exists, works, and is cheap.
2. **The three worst files have no test at all.** `crates.ts` (2.94% stmts, 0% branches, uncovered `24-202`), `go-proxy.ts` (2.81%, 0%, `26-220`) and `npm.ts` (2.10%, 0%, `28-281`) have no `.test.ts` beside them. Their only importer anywhere in the repository is `src/duties/dependa/main.ts:41-45`, an excluded entry point, which is what produces the ~3% floor: the module body is loaded, nothing inside it is ever called.
3. **Nothing declares a live-only intent.** `docs/reference/duties/dependa.md`, `docs/concepts/dependency-maintenance.md` and `docs/development/duties.md` are the three pages that discuss datasources; none of them says a datasource is exempt from unit testing, and `docs/reference/duties/dependa.md:63-64` says the opposite — "Each ecosystem adds one manager and one datasource. The interfaces are shared — only parsing and API details differ." A shared interface two implementations already test offline is not a live-only layer.
4. **`CONTRIBUTING.md:96-100` states the repository's own rule and it points the same way**: "Nothing in the suite reaches a model. The unit tests mock the provider and the integration tests drive the real bundle against a local HTTP stub, which is what makes them deterministic, offline, and safe to run on a fork's pull request." A network-fetching datasource with no stub is the one place that rule is not being followed.

So the classification for the whole block is **(a) genuinely untested behavior**, not (c) reachable-only-via-an-excluded-entry-point. The excluded entry point is why the number is 3% rather than 0%; it is not why the tests are missing. `createNpmDatasource()`, `createCratesDatasource()` and `createGoProxyDatasource()` are exported zero-argument factories returning an object with one `resolve(name)` method — the identical shape `docker-registry.test.ts` already drives.

Per file, with what a test would have to reach:

| File                   | Branches |     % | Uncovered | Classification | Priority |
| ---------------------- | -------- | ----: | --------: | -------------- | -------: |
| `npm.ts`               | 0 / 74   |     0 |        74 | (a) untested   |       P0 |
| `crates.ts`            | 0 / 50   |     0 |        50 | (a) untested   |       P0 |
| `docker-registry.ts`   | 78 / 128 | 60.94 |        50 | (a) untested   |       P1 |
| `go-proxy.ts`          | 0 / 48   |     0 |        48 | (a) untested   |       P0 |
| `github-tags.ts`       | 10 / 52  | 19.23 |        42 | (a) untested   |       P1 |
| `security-advisory.ts` | 31 / 69  | 44.93 |        38 | (a) untested   |       P1 |

The branches in question are the ones the failure matrix cares about: 404 → `not-found`, 429/5xx → `temporarily-unavailable`, 401/403 → `auth-refused`, a body that will not parse → `malformed-metadata`, and the per-registry shape handling around them (`src/duties/dependa/datasources/npm.ts:59-73` is four of them in fifteen lines). These are D12 classifications on the external boundary — exactly the class of behavior the mutation table exists to protect — and none of them is asserted.

**Owner: TL2. P0 for the three zero-coverage files.**

## Everything else, by size

Ranked by uncovered branches. Classification key: **(a)** genuinely untested behavior · **(b)** defensive or unreachable · **(c)** reachable only via an excluded entry point · **(d)** dead code.

| Uncovered | File                                        | Branch % | Classification of the dominant block                                                                                                                                                                                    | Owner | Prio |
| --------: | ------------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---: |
|        81 | `src/duties/dependa/managers/npm.ts`        |    53.18 | **(a)** — `parsePnpmLockYaml` (`:255-343`) is a hand-rolled pnpm-lockfile parser, pure, string-in map-out, and entirely unexercised. Highest branch density per line of test in the repository.                         | TL2   |   P1 |
|        74 | `src/duties/triage/propose.ts`              |    68.10 | **(a)** — the warrant-taxonomy proposal body renderer (`:686-728`) and the whole `### propose` summary block (`:883-906`), including its dry-run and unchanged arms. What a maintainer reads about an authority change. | TL2   |   P0 |
|        66 | `src/duties/review/rules.ts`                |    73.60 | **(a)** — rule parsing and selection, `:481-552` and `:661-761`. Finding lifecycle.                                                                                                                                     | TL4   |   P1 |
|        57 | `src/duties/dependa/publish.ts`             |    47.71 | **(a)** — GitHub mutation. `commitFile`'s 409-conflict re-read-and-retry (`:600-643`) is a real write path with no test, and the existing-PR fingerprint idempotency arm at `:426-446` is unreached.                    | TL2   |   P0 |
|        53 | `src/core/warrant.ts`                       |    90.00 | **(a)** — configuration grammar. `readSay` (`:1248-1268`) parses the multilingual `say:` form and every one of its refusals is unasserted. Pure, YAML-string in.                                                        | TL3   |   P0 |
|        39 | `src/duties/review/summary.ts`              |    50.00 | **(a)** — the review summary's rendering branches, `:120-193`. What a maintainer actually reads.                                                                                                                        | TL4   |   P1 |
|        35 | `src/core/atlas.ts`                         |    76.35 | **(a)** — the D12 degradation paths on the GitHub boundary: `:407-409` and `:425-426` are both `if (isCapacityError(error))` arms reachable from a stub that throws a 503.                                              | TL4   |   P1 |
|        35 | `src/duties/dependa/conformance/compare.ts` |    85.11 | **(a)** — comparison branches at `:77,325,374,571`.                                                                                                                                                                     | TL2   |   P2 |
|        33 | `src/duties/review/passes.ts`               |    65.98 | **(a)** — model orchestration. Per-pass roster selection and the unreadable-answer arm.                                                                                                                                 | TL4   |   P0 |
|        32 | `src/duties/dependa/managers/cargo.ts`      |    77.94 | **(a)** — manifest parsing, `:321-332`.                                                                                                                                                                                 | TL2   |   P2 |
|        31 | `src/duties/review/context.ts`              |    81.77 | **(a)** — `:318,326-346`, the context-assembly limits.                                                                                                                                                                  | TL4   |   P2 |
|        27 | `src/duties/review/risk.ts`                 |    80.00 | **(a)** — `:456-457,616-620`.                                                                                                                                                                                           | TL4   |   P2 |
|        26 | `src/duties/harmonise/publish.ts`           |    13.33 | **(a)** — see below. The single worst-covered non-datasource file, and it is a GitHub mutation path.                                                                                                                    | TL2   |   P0 |
|        20 | `src/duties/dependa/semver.ts`              |    90.48 | **(a)** — already property-tested (`semver.property.test.ts`); the remainder is long-tail range syntax.                                                                                                                 | TL2   |   P3 |
|        20 | `src/duties/review/publish.ts`              |    86.67 | **(a)** — `:577-585`.                                                                                                                                                                                                   | TL4   |   P2 |
|        18 | `src/core/forge.ts`                         |    89.78 | **(a)** — `:1170-1193`, plus a functions figure of 82.93% that says whole exported helpers are never called by a test.                                                                                                  | TL4   |   P1 |
|        16 | `src/doctor/diagnose.ts`                    |    80.49 | **(a)** — `:495-551` and `:621-639`, the diagnosis branches.                                                                                                                                                            | TL3   |   P2 |
|        16 | `src/duties/harmonise/draft.ts`             |    76.48 | **(a)** — `:288-291,318`.                                                                                                                                                                                               | TL2   |   P2 |
|        14 | `src/duties/remediation/envelope.ts`        |    67.45 | **(a)** — `:89-106`, the envelope's own bounds.                                                                                                                                                                         | TL2   |   P2 |

Three smaller items are worth naming individually because they look like a pattern rather than a gap:

- **`judge.ts` at exactly 100% statements / 50% branches in three duties** — `src/duties/harmonise/judge.ts:54`, `src/duties/respond/judge.ts:45`, `src/duties/translate/judge.ts:53`. One branch each, the same shape in all three, never taken. **(b)/(a) borderline**: it is one defaulting arm per file, cheap to pin and cheap to leave. P3.
- **`src/duties/lifecycle/timeline.ts:140-155`** — 83.33% statements but **50% functions**, meaning an exported function in that range is never called from a test at all. **(a)**, P2, TL2.
- **`src/duties/review/evidence.ts:64-71`** — 100% statements, 50% branches: the evidence-fingerprint sort comparator's tie-break arms (`a.kind.localeCompare(b.kind) || …`) are never reached, so nothing pins the ordering that fingerprint depends on. Review evidence is a priority area and an unstable fingerprint is an idempotency bug. **(a)**, P1, TL4.

### `harmonise/publish.ts` is the one that should not be 13%

`src/duties/harmonise/publish.test.ts:11` imports exactly two symbols: `buildPrBody` and `sanitizeBranchSegment`. Both are pure string functions. `publishSync` (`src/duties/harmonise/publish.ts:120-256`) — which resolves the default branch, creates or resets a branch, commits every locale file, and opens or updates the pull request — is imported by no test. Uncovered: `126,129-131,136,138,140-141,145,150,153-155,161-162,164,168-169,178-180,184-185,191-192,195,199,212-213,215,219,227-228,230-231,233,240-241,245,255-256`.

That includes `:140`, the `if (dryRun)` arm. The test file's own header says "the most consequential side effects (GitHub API calls) are gated behind the dry-run flag" — and the gate itself is untested. `src/duties/dependa/publish.ts` is the same duty shape and reaches 64% because it has a `publish.test.ts` driving a fake API plus an `authority.contract.test.ts` that pins the dry-run branch specifically. The gap is a missing test file, not a hard-to-reach seam. **P0, TL2.**

## Is 90% branches reachable

596 branches, from a pool of 1289 uncovered.

- The datasources block is **302** — 23% of the entire pool — and is classified (a) throughout, with a working offline pattern in two sibling files. Closing it is the single largest and cheapest move available.
- The next thirteen files in the table above hold **496** more, all classified (a).
- 302 + 496 = **798**, against a requirement of 596. Covering three quarters of that set clears the floor.

**Verdict: reachable, but only with the datasources block.** Without it, 596 of the remaining 987 uncovered branches — 60% — would have to be covered, and a meaningful share of those 987 are the last-arm defensive checks that get harder per branch as the number climbs. INFERRED, from sampling rather than an exhaustive audit of all 1289: the classification above covers the 19 largest files, which account for 693 of the 1289; the residual 596 are spread across ~90 files at fewer than 14 branches each, and that long tail is where the (b) defensive cases concentrate.

Two things follow, and both are decisions rather than work:

1. **If the integrated tree lands below 90% on any metric, it is a blocker, not a threshold to lower.** The floor is a decision; missing it is a missing test.
2. **Do not buy the last few points from the long tail.** The cheapest 300 branches in the tail are `if (x === undefined) return null` arms; the most valuable 300 are in `dependa/datasources`, `dependa/publish.ts`, `harmonise/publish.ts`, `triage/propose.ts` and `core/warrant.ts` — authority, configuration, and GitHub mutation. A run that hits 90% out of the tail has a better number and the same bugs.

## What this document does not measure

Coverage says a line ran. It does not say anything failed when the line's behavior changed — a test that calls a function and asserts nothing covers it perfectly. That is the question `tools/mutation.mjs` asks, and [the mutation report](mutation-report.md) is where it is answered. The two belong together: the coverage floor catches a module that arrived with no tests, and the mutation table catches a module that arrived with tests that do not assert.

The specific failure mode to watch for as coverage climbs from 81% to 90% is coverage bought with assertion-free tests. A branch newly reached by a test that only calls it moves the number without moving the guarantee. The mutation table is the detector: a mutation that starts SURVIVING in a directory whose coverage just went up is exactly that.
