# Mutation report

_What the suite catches when the code changes underneath it, mutation by mutation. Internal companion to the coverage baseline; not a user-facing guide._

Coverage says a line ran. It does not say anything failed when that line's behavior changed — a test that calls a function and asserts nothing covers it perfectly and guarantees nothing. The mutation table is the stricter question, and it is the reason this document exists beside [the coverage baseline](coverage-baseline.md).

The harness is `tools/mutation.mjs`. It takes a table of named regressions, applies each to a copy of the source file it names, runs the narrowest set of vitest cases that ought to notice, and reports one of three verdicts:

- **KILLED** — at least one case failed. The suite holds the invariant.
- **SURVIVED** — every case passed. The invariant is not asserted, and the row is a finding owned by a task lead.
- **STALE** — the mutation's `from` string does not appear exactly once in its file, so the edit never applied. Nothing it claims to gate was checked.

```sh
pnpm test:mutation           # the whole table
pnpm test:mutation:fast      # the critical subset, for the local pre-push loop
node tools/mutation.mjs --only "dry-run"   # one mutation, by substring of its name
node tools/mutation.mjs --list             # stage, owner and name, no runs
```

## The result

Against the integrated Round 1 tree: **54 mutations, 54 KILLED, 0 SURVIVED, 0 STALE**, in about ninety seconds of wall clock on a four-core box. `node tools/mutation.mjs` exits 0.

The table was 9 rows before this round and 23 after the first pass. The 31 rows added at integration were each proposed by the task lead who owns the seam, having watched it go red against their own new tests — and each was re-verified here rather than taken on trust. That re-verification was not a formality; see [What the second pass caught](#what-the-second-pass-caught).

The first pass's one survivor — the cheap-roster ternary at `src/duties/triage/record.ts:177`, which `record.test.ts` could not observe because its single `settingsOf` helper hardcoded `screenModels: []` — is now KILLED. It is the worked example of the table doing its job: a gap found by mutation, owned by a named lead, closed by a test, and confirmed closed by the same row that found it.

## The STALE incident — why the preflight exists

On the integrated tree the table came back **22 KILLED · 0 SURVIVED · 1 STALE**, and the stale row is the whole argument for that verdict existing.

The row was `ignore dry-run`, whose `from` string named four consecutive lines of `src/duties/review/threads.ts`. Two entirely legitimate changes moved that seam: TL4's D1 fix inserted an `if (uncertain) return …` withholding guard between the listing call and the plan, and a later cleanup removed an inert `?? owned.find(…)` clause. Neither touched dry-run. Neither was wrong. Both were reviewed and both were improvements.

Under the harness as it shipped before this round, that would have been silent. The old code threw from inside the mutation loop when a `from` did not match, which aborted the run and printed a stack trace instead of a board — so the operator's experience would have been "the mutation job is broken", not "a gate stopped existing", and the most likely response is to delete or skip the row. Under the harness as it is now, the run completes, every other row still reports, and the failure is a named verdict: `STALE ignore dry-run — src/duties/review/threads.ts: no match for …`, exit 1.

**A fix in one file silently disarming a gate in another is the exact failure mode the preflight was built for, and it fired for real on its first contact with other people's work.** The row is now re-pointed at `dryRunThreads`' own return, which is where the dry-run decision lives after the D1 fix, and it KILLS.

The generalisable lesson is in the choice of `from` string. The stale row matched four lines of _sequence_ — this call, then that call, then this return — which is the part of a function most likely to change for reasons that have nothing to do with the invariant. The re-pointed row matches the return shape unique to the rehearsal function. Match what the seam _is_, not the order things happen around it.

## What the second pass caught

Eleven of the thirty-one rows the leads proposed came back SURVIVED on their first run here. **All eleven were real mutations against real assertions; every one of them was my error, not theirs.** Their tests live in the new `*.adversarial.test.ts` and `*.contract.test.ts` files the round added, and I had pointed each row's `targets` at the pre-existing `*.test.ts` beside it. Retargeted at the file that actually asserts the invariant, all eleven KILL.

This is worth writing down because it is the mirror image of the failure the "are these gates real" section below guards against, and it is less obvious:

- **`targets` too wide** produces a **false gate** — a row reported KILLED because something unrelated broke, proving nothing about the invariant.
- **`targets` too narrow** produces a **false survivor** — a row reported SURVIVED against a suite that does assert the invariant, which sends a lead to write a test that already exists.

Both are silent. The only defence against either is to run the row and read _which named case_ failed, which is what was done for every row in this table.

## The table

54 rows. `stage` is `fast` or `full` and is a real field in `tools/mutation.mjs`, not a label — see [ci-gates.md](ci-gates.md) for what it drives.

|   # | Mutation                                                      | Seam                                 | Stage | Owner |
| --: | ------------------------------------------------------------- | ------------------------------------ | ----- | ----- |
|   1 | roster uses models\[0] instead of rotating                    | `src/core/provider.ts`               | fast  | TL2   |
|   2 | fallback skipped after first model failure                    | `src/core/provider.ts`               | fast  | TL2   |
|   3 | return success on provider failure                            | `src/core/provider.ts`               | fast  | TL2   |
|   4 | auth failure classified as capacity weather                   | `src/core/provider.ts`               | fast  | TL2   |
|   5 | starvation reported as protocol exhaustion                    | `src/core/provider.ts`               | fast  | TL2   |
|   6 | judge seat consumes only its first model                      | `src/core/judge.ts`                  | full  | TL2   |
|   7 | duty stage always starts at models\[0]                        | `src/duties/translate/draft.ts`      | full  | TL2   |
|   8 | cheap screen roster skipped for the expensive one             | `src/core/recall.ts`                 | full  | TL3   |
|   9 | cheap screen roster skipped in a duty                         | `src/duties/triage/record.ts`        | full  | TL2   |
|  10 | bypass the authority check                                    | `src/core/enforce.ts`                | fast  | TL3   |
|  11 | skip the confidence floor                                     | `src/core/enforce.ts`                | fast  | TL3   |
|  12 | bypass warrant key validation                                 | `src/core/warrant.ts`                | fast  | TL3   |
|  13 | accept an empty model roster                                  | `src/core/inputs.ts`                 | full  | TL3   |
|  14 | every GitHub failure read as not-there                        | `src/core/forge.ts`                  | fast  | TL4   |
|  15 | undecodable contents file read as a cold start                | `src/core/forge.ts`                  | fast  | TL4   |
|  16 | ignore dry-run                                                | `src/duties/review/threads.ts`       | fast  | TL4   |
|  17 | ignore dry-run outside review                                 | `src/duties/dependa/publish.ts`      | fast  | TL2   |
|  18 | skip idempotency check                                        | `src/duties/review/publish.ts`       | fast  | TL4   |
|  19 | skip idempotency outside review                               | `src/duties/duplicate/publish.ts`    | fast  | TL2   |
|  20 | skip the shared unchanged check                               | `src/core/publish.ts`                | fast  | TL4   |
|  21 | duplicate comment on an uncertain lookup                      | `src/duties/duplicate/publish.ts`    | fast  | TL2   |
|  22 | accept malformed model output as success                      | `src/duties/review/verdict.ts`       | fast  | TL4   |
|  23 | skip evidence verification                                    | `src/duties/review/providers.ts`     | fast  | TL4   |
|  24 | grounded model ends the rotation instead of being skipped     | `src/core/provider.ts`               | full  | TL2   |
|  25 | 403 no longer classified as auth                              | `src/core/provider.ts`               | fast  | TL2   |
|  26 | panel failure never reckoned against weather                  | `src/core/judge.ts`                  | full  | TL2   |
|  27 | panel seat re-asks a model an earlier seat spent              | `src/core/judge.ts`                  | full  | TL2   |
|  28 | ignore dry-run in harmonise                                   | `src/duties/harmonise/publish.ts`    | fast  | TL2   |
|  29 | remediation reads a human comment as its own envelope         | `src/duties/remediation/envelope.ts` | fast  | TL2   |
|  30 | remediation proposal points at a path the finding never named | `src/duties/remediation/proposal.ts` | fast  | TL2   |
|  31 | 409 conflict aborts instead of re-reading the sha             | `src/duties/dependa/publish.ts`      | full  | TL2   |
|  32 | a declared-but-empty capabilities block grants the default    | `src/core/warrant.ts`                | fast  | TL3   |
|  33 | an undeclared duty is never reported unnamed                  | `src/core/warrant.ts`                | full  | TL3   |
|  34 | capability names matched case-insensitively                   | `src/core/warrant.ts`                | fast  | TL3   |
|  35 | the no-warrant authority grants every capability              | `src/core/warrant.ts`                | fast  | TL3   |
|  36 | a NaN confidence passes the floor                             | `src/core/enforce.ts`                | fast  | TL3   |
|  37 | an exclusive label is applied beside its opposite             | `src/core/enforce.ts`                | fast  | TL3   |
|  38 | ignore dry-run in the shared state branch                     | `src/core/state-branch.ts`           | fast  | TL3   |
|  39 | state branch opens a second pull request                      | `src/core/state-branch.ts`           | fast  | TL3   |
|  40 | an unknown outcome is read as no outcome                      | `src/core/memory.ts`                 | fast  | TL3   |
|  41 | a correction line is written unescaped                        | `src/core/memory.ts`                 | fast  | TL3   |
|  42 | doctor reports a capability the duty's ladder discards        | `src/doctor/diagnose.ts`             | full  | TL3   |
|  43 | write against an uncertain thread listing                     | `src/duties/review/threads.ts`       | fast  | TL4   |
|  44 | a thread is matched to a finding on another line              | `src/duties/review/threads.ts`       | fast  | TL4   |
|  45 | 422 anchoring failure inverted                                | `src/duties/review/threads.ts`       | fast  | TL4   |
|  46 | empty proven text verifies every claim                        | `src/duties/review/providers.ts`     | fast  | TL4   |
|  47 | zero-weight evidence marks a finding verified                 | `src/duties/review/evidence.ts`      | fast  | TL4   |
|  48 | evidence proven against the wrong file                        | `src/duties/review/verify.ts`        | fast  | TL4   |
|  49 | an empty blocked phrase matches everything                    | `src/duties/review/rules.ts`         | fast  | TL4   |
|  50 | a missing rules file fails the run                            | `src/duties/review/rules.ts`         | full  | TL4   |
|  51 | GitHub rate limits no longer capacity                         | `src/core/forge.ts`                  | fast  | TL4   |
|  52 | a 404 no longer means not-there                               | `src/core/forge.ts`                  | fast  | TL4   |
|  53 | a truncated atlas is reported as an empty one                 | `src/core/atlas.ts`                  | fast  | TL4   |
|  54 | a tampered envelope checksum is accepted                      | `src/duties/review/publish.ts`       | fast  | TL4   |

### What the harder rows are actually about

- **4/25 — the auth/capacity colour scheme.** `classifyStatus` (`src/core/provider.ts:625`) is where D12 is read off the wire. Row 4 turns all of `401/403 → "auth"` into `"capacity"`, so a refused key rotates quietly and the job finishes green having asked nothing; row 25 is the narrower slip of dropping only 403, which is the one a careless edit actually produces.
- **26/27 — the panel's second implementation of the roster rule.** `src/core/judge.ts` deliberately does not call `rotateModels` (its own comment explains that a seat stops on a usable _vote_, not a usable _completion_). A second implementation of a rule is a second place it can break, so it gets its own rows: one for dropping `reckon`, so a rate-limited model is asked again by the next seat, and one for dropping the spent-model filter, so three seats become one model consulted three times and reported as three votes.
- **35/36 — the two capability defaults.** `capabilities:` written with nothing under it must grant nothing, and a repository with no warrant at all must fall back to the caller's default rather than to everything. Both are one-token edits and both are total authority bypasses.
- **43 — the empty proven string.** `src/duties/review/providers.ts:26` is the guard the entire evidence boundary rests on: without it `claim.includes("")` is true for every claim, so every finding verifies against nothing. It is one line and it is the single highest-value row in the table.
- **50/51 — the GitHub error classifiers.** `isCapacityError` no longer seeing 429 turns weather into a red run; `isMissing` no longer seeing 404 turns an absent file into a thrown error rather than the cold start it is. Both are the boundary where the platform's transient moods are told apart from this repository's own mistakes.
- **52 — the truncated atlas.** Returning `EMPTY_ATLAS` instead of `{ packages, truncated: true }` loses both the packages the walk did read and the fact that it was partial — a silent narrowing of what a monorepo run considers to exist.

## Are these gates real

A mutation killed by a test which happens to break for an unrelated reason proves nothing about the invariant it names. So every row was run individually with `--reporter=verbose` and the failing case names read. Every one is killed by a test whose _name states the invariant_ — a sample, chosen from the rows where an incidental kill was most plausible:

| Mutation                                              | Killed by                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| empty proven text verifies every claim                | `evidence.adversarial.test.ts > g06_an_absent_line_proves_nothing_even_though_every_claim_contains_the_empty_string` |
| evidence proven against the wrong file                | `evidence.adversarial.test.ts > g13_a_claim_about_one_file_is_never_proved_by_another_files_line`                    |
| write against an uncertain thread listing             | `threads.adversarial.test.ts > uncertain_listing_withholds_thread_writes_instead_of_duplicating`                     |
| a thread is matched to a finding on another line      | `threads.adversarial.test.ts > rerun_updates_its_own_thread_instead_of_duplicating`                                  |
| panel failure never reckoned against weather          | `judge.contract.test.ts > grounds_a_capacity_failed_judge_so_a_later_seat_never_asks_it`                             |
| ignore dry-run in harmonise                           | `publish.contract.test.ts > creates_no_branch_commits_no_file_and_opens_no_pull_request`                             |
| remediation reads a human comment as its own envelope | `envelope.adversarial.test.ts > refuses_a_perfectly_valid_envelope_from_a_human_author`                              |
| capability names matched case-insensitively           | `warrant.contract.test.ts > a capability is matched after String.trim(), and after nothing else`                     |
| an unknown outcome is read as no outcome              | `state.idempotency.test.ts > a line that is not a correction is refused whole, never half-read`                      |
| an empty blocked phrase matches everything            | `rules.adversarial.test.ts > malicious_rule_pack_cannot_flood_every_line_with_an_empty_blocked_phrase`               |
| a missing rules file fails the run                    | `rules.adversarial.test.ts > a_missing_rules_file_is_the_cold_start_without_a_warning`                               |
| every GitHub failure read as not-there                | `forge.test.ts > isMissing > is true only for a 404`                                                                 |
| undecodable contents file                             | `forge.test.ts > throws, rather than reading it as a cold start, for a shard too large for the API to inline`        |

No row is carried by an incidental failure. The one that came closest to being a false gate was **dry-run outside review**: its first target was `src/duties/dependa/publish.test.ts`, where all nine `publishGroup` calls pass `dryRun: false` and the mutation SURVIVES. The real assertion lives in `src/duties/dependa/authority.contract.test.ts`, and retargeting there is what makes the row mean something.

## Equivalent mutants

A mutation whose edit produces code that cannot behave differently is not a gap. It is recorded here rather than deleted, so that a future reader finds a decision instead of an absence.

### `managers/npm.ts` — the pnpm parenthetical strip

`src/duties/dependa/managers/npm.ts:293` strips pnpm's trailing annotations before splitting a `packages:` key into a name and a version:

```
trimmedLine.replace(/(?:\([^)]*\))+(?=:$)/, "")
```

TL2 proposed and could not kill a mutation making that strip global and unanchored — `/(?:\([^)]*\))+/g` — reporting that no realistic pnpm key distinguishes the two, because peer and patch suffixes are always terminal and npm package names cannot contain parentheses.

**Verdict: the mutant is NOT equivalent, but it should still not be gated here.** Both halves of that are worth stating.

It is not equivalent, and the distinguishing input is one line:

| Input                                | anchored (current)          | global (mutated)         |
| ------------------------------------ | --------------------------- | ------------------------ |
| `  /react-dom@18.2.0(react@18.2.0):` | `react-dom` → `18.2.0`      | same                     |
| `  /a@1.0.0(b@1)(c@2):`              | `a` → `1.0.0`               | same                     |
| `  /left-pad@1.3.0(patched):`        | `left-pad` → `1.3.0`        | same                     |
| **`  /(x)lodash@4.17.21:`**          | **`(x)lodash` → `4.17.21`** | **`lodash` → `4.17.21`** |

TL2's premise is correct about _well-formed_ input and that is where the reasoning stops one step short. A `pnpm-lock.yaml` is not well-formed by construction — it is a file committed to the repository under review, which is to say attacker-influenceable content fed to a hand-rolled parser. Under the mutated regex a crafted key `/(x)lodash@4.17.21:` is read as the real package `lodash`, injecting a "current version" the project never had; under the code as written it is read as `(x)lodash`, matches no manifest dependency, and is inert. So the current behaviour is the safer of the two, and the mutation degrades it. This is a name-confusion vector, not a synthetic curiosity, and this repository already tests exactly this shape elsewhere — `rules.adversarial.test.ts`'s "malicious rule pack cannot flood every line with an empty blocked phrase" is the same hostile-input case against a different parser.

It should nonetheless not be gated by this row, for a narrower reason than "no fixture exists":

1. **The row would pin the shape of a regular expression, not a behaviour.** Its `from` would be a dense character class, which is the least stable kind of `from` there is — see the STALE incident above for what that costs. A legitimate parser fix would take it stale, and the next reader would re-point it at whatever the regex became without re-deriving what it was for.
2. **The parenthetical strip is not the boundary.** If lockfile name confusion matters — and the table above says it might — the assertion belongs where a parsed name is matched against a manifest dependency, which is the point at which a confused name becomes a wrong proposal. A test there survives any parser rewrite; a test on the regex does not.
3. **The blast radius is bounded and human-visible.** dependa's output is a pull request body naming the from- and to-versions, reviewed before merge.

**Recommendation, owned by TL2, not done here (`src/**` is not this document's to change): one adversarial case asserting that a `packages:` key whose name contains a parenthetical never resolves onto a manifest dependency of a different name.** Once that exists, this row can be added against the matching seam rather than against the regex, and it will be a behaviour gate instead of a shape gate.

I disagree with the framing that a fixture here would have been padding — it would have been an adversarial-input test of the kind this round wrote thirty-six new files of. I agree with the conclusion not to add this row, on the grounds above.

## Deliberately not yet gated: A1

`src/core/forge.ts:889`'s `isCapacityError` does not classify a GitHub 403 as capacity, so a 403 fails the run as configuration. Whether that is right is undecided and awaiting the user.

The reason it is genuinely open rather than an oversight: GitHub documents **both** primary and secondary rate limits as answering "403 or 429", so the same underlying condition — this run has asked for too much, come back later — can arrive under either status, while a 403 also carries the entirely different meaning of "this token may not do that". A classifier cannot tell them apart from the status alone.

A row asserting the capacity reading is written out in `tools/mutation.mjs` and **left commented out**, so nothing here pins a behaviour the repository has not chosen. It lands the moment A1 is decided, in whichever direction.

## The gate that reported success when asked to check nothing

A fresh adversarial auditor emptied the `MUTATIONS` array and ran the harness. It printed `KILLED 0 · SURVIVED 0 · STALE 0` and **exited 0**.

That is the most important finding in this document, because it is the same failure the whole table exists to detect, committed by the detector. A gate whose contents can be deleted is not a gate, and the deletion looks like an improvement while it happens: the board is clean, the job is green, and every number a reader would check is the number they wanted to see. It is precisely the shape of a coverage `exclude` that grows — the measurement improves because the denominator moved.

`tools/mutation.mjs` now records `TABLE_FLOOR`, the row count the table may not fall below. An empty table is refused outright; a shrunken one is refused by name, and the refusal says what the correct fix is, because a refusal that does not name the right repair invites the wrong one — which here is lowering the floor until the run goes green:

```
REFUSING TO RUN: the mutation table holds 12 rows and the recorded floor is 54. Rows were
removed. A row is only ever retired by re-pointing it at the seam the code moved to; if one
genuinely no longer names real code, say so in the commit and lower TABLE_FLOOR deliberately.
```

The floor never goes down, for exactly the reason `vitest.config.ts`'s thresholds never go down. It cannot stop somebody editing the constant and the table in the same commit, and nothing in a self-checking script could; what it does is make that a deliberate, reviewable act rather than a silent one. [ci-gates.md](ci-gates.md#what-guards-the-guards) states that limit rather than implying a guarantee.

### And the harness now has tests

`tools/` had none — `scripts/` does, so the omission was the exception rather than the convention. `tools/mutation.test.mjs` and `tools/coverage-config.test.mjs` run under `node --test` via `pnpm test:tools`, which the CI mutation job runs ahead of the table itself.

The argument for testing a test harness is narrower than it first sounds, and it is not "prove that mutation testing works" — the evidence for that is the board. It is this: **every branch worth testing here runs only when something has already gone wrong.** The empty-table refusal, the below-floor refusal, the zero-match `from`, the ambiguous `from` — none of them executes during a passing run. Code that only runs in emergencies is exactly the code that rots unnoticed, and verifying it by hand once, as was done when it was written, does not re-verify it after the next edit. The STALE detection has now caught one real regression; nothing was re-proving that it still could.

Following `scripts/check-docs-links.mjs`'s own stated split, the judgement is separated from the I/O — `classifyRow(mutation, text)` and `checkTable(mutations, floor)` are pure — so the tests need no filesystem and no mocking library. The module's self-invocation is guarded so importing it does not run the table.

## Harness defects found and fixed

Five, in `tools/mutation.mjs`. The first was a data-loss bug and the last was found by an adversarial auditor rather than by me.

1. **A crashed run could destroy a source file.** The harness renames `src/foo.ts` into `.tmp/mutation/orig-*.ts`, writes the mutated copy, and restores in a `finally`. A run killed between the rename and the `finally` — Ctrl-C, an OOM, a cancelled CI job — leaves the _only_ copy of the source in `.tmp/mutation/`. The next run's first act was `rm(SCRATCH, { recursive: true, force: true })`. It deleted it. There is now a `recover()` pass that runs before the clear and puts back any source file that is missing, plus `exit`/`SIGINT`/`SIGTERM`/`SIGHUP` handlers that restore synchronously.
2. **A stale mutation aborted the board instead of reporting.** See [the STALE incident](#the-stale-incident--why-the-preflight-exists).
3. **An ambiguous `from` was not checked at all.** `String.prototype.replace` with a string pattern rewrites only the first occurrence, so a `from` matching two places would quietly mutate a seam nobody chose and report whatever the targets said about it. The preflight now requires exactly one occurrence and reports `matches N places — the edit is ambiguous` otherwise. This is not hypothetical at 54 rows: `if (dryRun) {` occurs twice in `src/core/state-branch.ts`, `const existingPr = existing[0];` occurs twice in the same file, `const plan = planThreads(reconciled, standing, threads);` occurs twice in `threads.ts`, and `if (uncertain) return { created: 0, … };` occurs twice. Every one of those rows had to carry disambiguating context, and the preflight is what said so.
4. **The table could be emptied and the gate would pass.** See [the section above](#the-gate-that-reported-success-when-asked-to-check-nothing).
5. **A preflight/apply race.** `preflight` proves the match against the file as it was some milliseconds earlier; `apply` now refuses to run if its `replace` changed nothing, because a no-op edit would report the untouched suite's verdict as the mutation's.

Both staleness directions were verified by deliberately breaking a row and observing the failure — a zero-match `from` and an ambiguous one, each reported by mutation name with a non-zero exit, then reverted. The recovery path was verified by stranding a real source file in the scratch directory and confirming the next run put it back byte for byte.

## Rules the table is written to

- **The tersest edit that expresses the regression.** A mutation that changes three things proves nothing about which of the three the suite caught.
- **`targets` is the narrowest test set that _should_ notice** — not the set that happens to fail, and not the file that merely sits beside the source. Too wide is a false gate; too narrow is a false survivor. Both are silent, and reading which named case failed is the only defence against either.
- **`from` is prose-like code that is unlikely to churn, and it matches what the seam _is_ rather than the order things happen around it.** A `from` spanning several statements in sequence goes stale the first time someone legitimately inserts a line.
- **A survivor is never deleted to make the board green.** It is a finding with an owner. If a mutated seam is genuinely equivalent code, that is written down with the reasoning, not removed — see [Equivalent mutants](#equivalent-mutants).
- **An entry point is not a seam.** `src/duties/*/main.ts` is excluded from coverage and driven through built bundles, so a mutation there is a rebuild-and-integration concern rather than a unit one.

## What is still ungated

Named so the next pass does not have to rediscover it:

- **`src/duties/dependa/datasources/*` beyond the three files that gained tests this round.** `crates.ts`, `go-proxy.ts` and `npm.ts` now have offline suites; their D12 status classifications (404 → `not-found`, 429/5xx → `temporarily-unavailable`, 401/403 → `auth-refused`) are the natural next rows and none is mutated yet.
- **The lockfile name-confusion boundary in `dependa/managers/npm.ts`** — see [Equivalent mutants](#equivalent-mutants).
- **`src/core/enclose.ts` and `src/core/sanitize.ts`.** Both at high coverage, both security-relevant, neither mutated. Coverage says they are exercised; nothing yet says an assertion would fail if the defanging stopped.
- **The I/O half of `tools/mutation.mjs`.** The refusal paths are now tested (`pnpm test:tools`), but the crash-recovery pass that restores a source file stranded by a killed run, and the signal handlers that restore on Ctrl-C, were verified by hand once and nothing re-verifies them. They are the paths whose failure mode is a missing source file, so they are worth a test the next time this file is opened.
