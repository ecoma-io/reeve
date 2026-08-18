# CI quality gates

_Which gates run, what each one actually proves, and which of them a real regression could walk past. Internal companion to the coverage baseline and the mutation report; not a user-facing guide._

The success criterion this document is written against is not "90% was reached". It is:

> **every covered branch has an assertion that would fail on a real regression.**

Those are different claims and only one of them is worth having. A line can be executed by a test that asserts nothing; a branch can be entered by a fixture that makes it unobservable. Coverage measures that code ran. It is the mutation table that measures whether the suite would go red when the behavior changes, and that is why the ranking below puts it first.

## The gates, ranked by what they prove

| Rank | Gate                                                      | What it proves                                                                                                               | What it cannot prove                                                                                | Cost                        | Status                              |
| ---: | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------- |
|    1 | `pnpm test:mutation`                                      | For each named regression, **the suite fails**. This is the only metric here that measures protection rather than execution. | Only the 23 seams the table names. Silent about everything not in it.                               | 27–36 s harness, ~2 min job | **mandatory (new this round)**      |
|    2 | `pnpm test` + coverage floor                              | The suite passes, and no module arrived with no tests at all.                                                                | That any of it asserts anything. A directory can go from 60% to 95% on tests that only call things. | ~3–4 min                    | mandatory (floor raised this round) |
|    3 | `pnpm test:contract`                                      | The post-1.0 duties contract and the fail-closed exit-code gate hold across every outcome branch.                            | Anything inside a duty.                                                                             | ~1–2 min                    | mandatory (already wired)           |
|    4 | `pnpm eval all`                                           | A fixture run exits 0 only when every outcome was a finding and none failed or skipped.                                      | Behavior no fixture covers.                                                                         | ~1–2 min                    | mandatory (already wired)           |
|    5 | `pnpm typecheck`                                          | esbuild strips types without checking them; this is the only place a type error is caught.                                   | Runtime behavior.                                                                                   | ~30 s                       | mandatory                           |
|    6 | `pnpm lint`                                               | Type-aware; catches a floating promise, an unsafe `any` spread, a `console.log` of a secret.                                 | Behavior.                                                                                           | ~1 min                      | mandatory                           |
|    7 | bundle-staleness check                                    | The committed `dist/` matches `src/` — the single most common way an action repository ships a fix that does nothing.        | That the bundle is correct, only that it is current.                                                | ~1 min                      | mandatory                           |
|    8 | `format:check`, `commitlint`, docs-link and anchor guards | Hygiene the reader sees.                                                                                                     | Behavior.                                                                                           | seconds                     | mandatory                           |

**The ranking is the recommendation.** Rank 1 outranks rank 2 because rank 2 can be satisfied without asserting anything and rank 1 cannot. The coverage floor is a **necessary but not sufficient** gate: it is a floor against arrival — a module that shows up with no tests goes red — and nothing more. Treating it as the measure of test quality is the specific failure this document exists to prevent.

## The gap this round closed

Before this round, **`pnpm test:mutation` ran nowhere.** It was not in `.github/workflows/ci.yml` and not in `lefthook.yml`. It was a `package.json` script that a contributor would have had to know about and choose to run; `CONTRIBUTING.md`'s command table (`:62-71`) does not list it, and tells contributors to run "all of the first six" — which are lint, typecheck, test, build, format and format:check. The single most informative gate in the repository was, in practice, never executed.

That is now fixed, and the fix has a shape worth understanding. `ci.yml`'s `ci-gate` job is the one required check name, and it gates on `needs`. Its own comment says why: "add a job to `needs` and the gate tightens without anyone editing repository settings — and forgetting to add it is the only way to widen what green means, which is visible in this file." So adding a `mutation` job without adding it to `needs` would have added a check that reports and gates nothing. Both edits were made:

- a new `mutation` job (`ci.yml:165-189`) running `pnpm test:mutation`;
- `ci-gate`'s `needs: [verify]` → `needs: [verify, mutation]` (`ci.yml:198`).

It is a separate job rather than a step inside `Verify` for one reason that is not about speed: **the harness renames source files while it runs.** `tools/mutation.mjs` moves a file aside, writes a mutated copy, runs vitest against it, and puts it back. Anything else reading `src/` in the same checkout at that moment reads a file that is briefly not there. A separate runner is the only isolation that is actually isolation. The two secondary reasons are that it runs in parallel with `Verify` so the pipeline's wall clock does not move, and that "a mutation survived" gets its own check name rather than hiding inside a test log.

## The staged plan, and why it is not staged yet

The brief for this round asked for a staged strategy so that expensive mutation testing does not run on every trivial change. **It was measured and it is not expensive.**

| Measurement               | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| Full mutation table       | 23 mutations, **27–36 s** wall clock across repeated runs, four cores |
| `--stage fast` subset     | 18 mutations, **~29 s** — within a fifth of the full table            |
| `pnpm test` with coverage | 3622 tests, **~200 s** wall clock on the same box                     |

The whole mutation table costs under a fifth of what the test suite already costs, and it runs in parallel with it, so the pipeline's wall clock does not move at all. Staging it would save about seven seconds — the fast subset is not meaningfully cheaper than the full one, because most of both runs is vitest process startup rather than the mutations themselves. Seven seconds is complexity bought for nothing, and a gate that only runs on the merge queue is a gate whose regression reaches `main` in every pull request that is not queued.

**So the recommendation is: the full table, on every event — `pull_request`, `merge_group`, `push: main` and `workflow_dispatch` — which is what is wired.**

The staging capability exists anyway, because the table will grow. `tools/mutation.mjs` carries a real `stage` field per row and honours `--stage fast`:

- **`fast` (18 rows)** — the invariants whose violation is _silent in production_: a write that repeats or duplicates, an authority check that does not check, a red run reported green, evidence admitted unverified, a dry run that writes. Nobody notices these from a log; they are noticed from a corrupted store or a wrongly-labelled issue weeks later.
- **`full` adds 5 rows** — the invariants whose violation is _loud on the first run_: a roster that stops rotating shows up as one model id in the log; a duty that spends the expensive roster on a pivot shows up on the bill; an empty roster accepted shows up as a run that asked nothing. Still real regressions, still gated, just self-announcing.

`pnpm test:mutation:fast` is the local pre-push loop, and `node tools/mutation.mjs --only "<substring>"` runs a single row while iterating on the seam it names.

**The concrete flip condition, so a future maintainer does not have to re-derive it:** when the `mutation` job's own wall clock exceeds roughly a quarter of the `Verify` job's — call it 90 seconds of harness time, which at the current marginal cost of roughly 1.3 s per row is somewhere near 60 rows — change the job's single run step to:

```yaml
- run: pnpm test:mutation:fast
  if: github.event_name == 'pull_request'
- run: pnpm test:mutation
  if: github.event_name != 'pull_request'
```

That keeps `merge_group` and `push: main` on the full table, which is what actually gates `main`, and puts pull requests on the critical subset. Do not flip it before then; the saving is smaller than the cost of two people wondering which stage ran.

## The coverage floor

`vitest.config.ts` is set to **90 / 90 / 90 / 90**.

**Provenance: a product decision taken in this round by the user, not a number derived from the baseline.** The measured baseline at `0fa21e6` was statements 88.73 · branches 81.42 · functions 94.05 · lines 89.84, so three of the four were below the floor when it was written. That is the intent — the floor names where the repository has decided to be, and the tests are written to meet it. The full arithmetic and the classification of what stands between the two is in [the coverage baseline](coverage-baseline.md).

Three rules travel with it and they are the reason the number means anything:

1. **It never goes down.** A red threshold is a missing test, and the fix is the test.
2. **`exclude` never grows to hide uncovered code.** An exclusion removes a file from the denominator, which raises the percentage while covering nothing. It is the one edit that can make this gate lie. The three existing entries are restated with their justifications in the coverage baseline.
3. **It is not sufficient on its own.** See the next section.

## Guarding against coverage bought cheaply

Raising a branch floor from 81% to 90% creates a specific incentive: 596 branches have to be entered, and the cheapest way to enter a branch is a test that calls the function and asserts nothing. That test moves the number and moves no guarantee. Two proposals, both cheap, ordered by value.

### Proposal A — a mutation row is required for every module on the critical list (cost: review time only)

The mutation job already enforces the strong form of this for the 23 seams it names: a PR that adds tests in `src/core/provider.ts`'s area cannot make its rows survive, because a survivor fails CI. The gap is **modules with no rows at all**, where coverage can climb freely with nothing checking that it means anything. Today that is precisely where the largest coverage debt sits — `src/duties/harmonise/publish.ts` at 13% branches and `src/duties/dependa/datasources/*` at 28% — and both are modules that write to GitHub or classify an external failure.

The rule: **a module on the critical list (authority, model orchestration and fallback, configuration parsing, state, GitHub mutation, finding lifecycle, review evidence) that gains substantial coverage in a pull request must also gain a mutation row in the same pull request.** Cost: a line in `CONTRIBUTING.md` and a reviewer remembering it. No new tooling. This is the highest-value proposal here because it converts "we covered it" into "we can prove we would notice".

The corollary, which needs no rule because the harness enforces it: a row cannot be added and left SURVIVED — that fails CI — and it cannot be quietly retired either, because a `from` string that no longer matches is reported as STALE rather than skipped.

### Proposal B — an advisory assertion-density check (cost: ~40 lines of dependency-free Node, under a second)

A mechanical detector for the crudest padding: for every `*.test.ts` a pull request adds or changes, parse for `it(` / `test(` blocks and report any block containing no `expect(`. In this codebase a test with no `expect` is essentially always padding — the suite's own idiom is dense assertion, including negative assertions (`expect(thread.write).not.toHaveBeenCalled()`), and a genuine "does not throw" smoke test is rare enough to carry a one-line waiver comment.

Recommended as **advisory, not blocking**: printed in the job summary, not wired into `ci-gate`'s `needs`. A blocking heuristic on test _style_ will eventually be wrong about a legitimate test, and the cost of that is contributors learning to route around the gate. Advisory output that a reviewer reads costs nothing and catches the case that matters.

### Not recommended — a coverage-delta / mutation-delta ratio

It is tempting to flag a pull request that raises branch coverage by more than N points without killing a new mutation. It is also noise: a pull request that adds a well-tested new module legitimately raises coverage a lot and adds no mutation row, and one that fixes a typo can do the reverse. The signal-to-cost is poor and the failure mode is a gate people learn to ignore. Proposal A gets the same outcome by asking a human the right question.

## How to tell a protective test from a padding test, in this repository's idiom

Written down here because the judgement has to be made at integration, against test files that do not exist yet. These criteria are read off the tests that actually killed mutations in this repository, not off general advice.

**Signs a test protects behavior:**

- **The `it` string is a claim about behavior, not a name of a function.** The tests that killed mutations this round are called "refuses an unrecognized key on the `lifecycle:` block itself", "leaves a body that already says this alone", "starts each draft at a different model", "throws, rather than reading it as a cold start, for a shard too large for the API to inline". Each one is a sentence you could disprove.
- **It asserts a value, not a shape.** `expect(result).toEqual({ status: "auth-refused", reason: expect.stringContaining("read access") })` is a claim. `expect(result).toBeDefined()` is not.
- **It asserts the absent side effect.** This repository's strongest tests are half negative: `expect(thread.write).not.toHaveBeenCalled()`, `expect(mutation, "must not be called on a dry run").not.toHaveBeenCalled()`. Dry-run, idempotency and withheld-write regressions are only visible this way, and a test suite with no negative assertions cannot catch any of them.
- **Its fixture can actually reach the branch.** This is the subtle one and it is the exact shape of this round's single surviving mutation: `src/duties/triage/record.test.ts:242` hardcodes `screenModels: []` in the one helper every case builds settings through, so the ternary at `src/duties/triage/record.ts:177` can never take its first arm. Every case in the file passes with the branch removed. Coverage counts it; nothing observes it.
- **It drives the seam through the boundary its caller uses**, with a stub for the far side — a fake octokit, a mocked `globalThis.fetch`, a `rotateModels` stub whose behaviour is documented as "the rotation's contract and nothing else" (`src/duties/translate/draft.test.ts:13-21`).

**Signs a test is padding:**

- The only assertion is `toBeDefined`, `toBeTruthy`, `not.toThrow`, or a bare `toHaveBeenCalled()` with no argument check.
- The `it` string names a function or a line ("covers the error path", "readSay works").
- A snapshot with no reviewed content.
- The test constructs a fixture in which the branch under test is unreachable — see above.
- Coverage in the directory moved and no mutation row in that directory changed verdict. This is the mechanical version of the question, and it is why the mutation job's output should be read alongside the coverage delta rather than after it.

**The decisive test, and it is the same question the harness asks:** would this test fail if the condition it is meant to cover were inverted? If nobody can answer that without running it, the answer is to add the row and find out.

## Where the remaining exposure is

Named so it is a decision rather than an oversight:

- **`tools/mutation.mjs` is outside the coverage `include` glob and has no tests.** The gate ranked first in this document is itself ungated. Its preflight was verified by hand — a zero-match `from` and an ambiguous one, each deliberately introduced, observed failing by name, and reverted — but nothing re-verifies that on every change. Mitigating: the harness fails loudly rather than silently on its own defects, which is the property that matters most, and a STALE row now fails the run instead of aborting the board.
- **`CONTRIBUTING.md:62-71`'s command table lists neither `test:contract` nor `test:mutation`,** and its "run all of the first six before you push" names six commands that do not include either. A gate contributors do not know about is a gate that only fires in CI, which is the slowest and most expensive place to learn about it. Recommended: add both rows and add `test:mutation:fast` to the pre-push list. Not done here — `CONTRIBUTING.md` was outside this round's file ownership.
- **`lefthook.yml` runs commitlint, prettier, eslint and the doc-link guard, and nothing else, deliberately** — its own comment explains that anything depending on _what_ changed stays in CI, because "a hook slow enough to notice is a hook contributors learn to skip with `--no-verify`". That reasoning holds and no test gate should move into it. `pnpm test:mutation:fast` at ~29 s is on the wrong side of that line for a pre-commit hook; it belongs in the documented pre-push routine, run by a human.
