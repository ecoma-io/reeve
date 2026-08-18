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

At `0fa21e6`, against the suite as it stands: **23 mutations, 22 KILLED, 1 SURVIVED, 0 STALE**, in 27–36 seconds of wall clock on a four-core box.

The one survivor:

| Mutation                              | Seam                              | Classification   | Owner |
| ------------------------------------- | --------------------------------- | ---------------- | ----- |
| cheap screen roster skipped in a duty | `src/duties/triage/record.ts:177` | **missing test** | TL2   |

### The survivor, in full

`src/duties/triage/record.ts:177-178` chooses which roster pays for the pivot translation:

```
const pivotModels = settings.screenModels.length > 0 ? settings.screenModels : settings.models;
```

Replacing that with `settings.models` — so a configured `screen-models` is ignored and the duty spends its deliverable roster on a pivot nobody reads — changes nothing any test observes.

It is **missing test**, not weak test and not intentionally unobservable, and the evidence is specific:

- `src/duties/triage/record.test.ts:242` builds every `Settings` through one `settingsOf` helper that hardcodes `screenModels: []`. With an empty cheap roster the ternary always takes its second arm, so the mutated and unmutated code are the same code under every case in the file. There is no assertion to strengthen; there is no case that configures the input at all.
- `src/duties/triage/roster.contract.test.ts:83-113` is the contract test for `screen-models` and it explicitly declines to cover this. Its own comment at `:103` names the expression — "the caller's own `screenModels.length > 0 ? screenModels : models`" — and then tests the _picker_ it feeds rather than the choice itself.
- `src/duties/triage/main.integration.test.ts:1029-1055` does set `screen-models: cheap-model`, but against the spam screen (`src/duties/triage/main.ts:911,924`), not the pivot stage in `record.ts`.

The identical expression in `src/core/recall.ts:198` **is** pinned — `src/core/recall.test.ts`'s "spends the cheap roster when one is configured" kills the same mutation there. So this is one of three call sites (`recall.ts:198`, `record.ts:177`, `respond/main.ts:396`) where the same rule is written out by hand, and exactly one of them is tested. That is the finding, and it is worth more than the branch: a rule copied three times and asserted once is a rule that will drift.

**Owner: TL2.** The test that closes it is one case in `record.test.ts` passing a non-empty `screenModels` and asserting `stages.pivot` was asked the cheap id.

## The table

23 rows. `stage` is `fast` or `full` and is a real field in `tools/mutation.mjs`, not a label — see [ci-gates.md](ci-gates.md) for what it drives.

|   # | Mutation                                              | Seam                                       | Stage | Owner | Verdict      |
| --: | ----------------------------------------------------- | ------------------------------------------ | ----- | ----- | ------------ |
|   1 | roster uses `models[0]` instead of rotating           | `src/core/provider.ts`                     | fast  | TL2   | KILLED       |
|   2 | fallback skipped after first model failure            | `src/core/provider.ts`                     | fast  | TL2   | KILLED       |
|   3 | return success on provider failure                    | `src/core/provider.ts`                     | fast  | TL2   | KILLED       |
|   4 | **auth failure classified as capacity weather**       | `src/core/provider.ts` `classifyStatus`    | fast  | TL2   | KILLED       |
|   5 | **starvation reported as protocol exhaustion**        | `src/core/provider.ts` `protocolExhausted` | fast  | TL2   | KILLED       |
|   6 | **judge seat consumes only its first model**          | `src/core/judge.ts:214`                    | full  | TL2   | KILLED       |
|   7 | **a duty stage always starts at `models[0]`**         | `src/duties/translate/draft.ts:160`        | full  | TL2   | KILLED       |
|   8 | **cheap screen roster skipped for the expensive one** | `src/core/recall.ts:198`                   | full  | TL3   | KILLED       |
|   9 | **cheap screen roster skipped in a duty**             | `src/duties/triage/record.ts:177`          | full  | TL2   | **SURVIVED** |
|  10 | bypass the authority check                            | `src/core/enforce.ts`                      | fast  | TL3   | KILLED       |
|  11 | skip the confidence floor                             | `src/core/enforce.ts`                      | fast  | TL3   | KILLED       |
|  12 | **bypass warrant key validation**                     | `src/core/warrant.ts:1913`                 | fast  | TL3   | KILLED       |
|  13 | **accept an empty model roster**                      | `src/core/inputs.ts:146`                   | full  | TL3   | KILLED       |
|  14 | **every GitHub failure read as not-there**            | `src/core/forge.ts:864`                    | fast  | TL4   | KILLED       |
|  15 | **undecodable contents file read as a cold start**    | `src/core/forge.ts:1011`                   | fast  | TL4   | KILLED       |
|  16 | ignore dry-run                                        | `src/duties/review/threads.ts`             | fast  | TL4   | KILLED       |
|  17 | **ignore dry-run outside review**                     | `src/duties/dependa/publish.ts:202`        | fast  | TL2   | KILLED       |
|  18 | skip idempotency check                                | `src/duties/review/publish.ts`             | fast  | TL4   | KILLED       |
|  19 | **skip idempotency outside review**                   | `src/duties/duplicate/publish.ts:285`      | fast  | TL2   | KILLED       |
|  20 | **skip the shared unchanged check**                   | `src/core/publish.ts:79`                   | fast  | TL4   | KILLED       |
|  21 | **duplicate comment on an uncertain lookup**          | `src/duties/duplicate/publish.ts:280`      | fast  | TL2   | KILLED       |
|  22 | accept malformed model output as success              | `src/duties/review/verdict.ts`             | fast  | TL4   | KILLED       |
|  23 | skip evidence verification                            | `src/duties/review/providers.ts`           | fast  | TL4   | KILLED       |

Rows in bold are new in the Round 1 hardening pass. The table before it was nine rows over three files — `src/core/provider.ts`, `src/core/enforce.ts` and `src/duties/review/{threads,publish,verdict,providers}.ts` — which meant configuration parsing, the GitHub boundary, duplicate side effects, dry-run outside review, idempotency outside review, and the whole auth/capacity/protocol colour scheme were ungated.

### What each new row is actually about

- **4 — auth as capacity.** `classifyStatus` (`src/core/provider.ts:624`) is where D12 is read off the wire. Turning `401/403 → "auth"` into `→ "capacity"` inverts the doctrine: a refused key stops failing the run red and starts rotating quietly, and the job finishes green having asked nothing.
- **5 — starvation as protocol exhaustion.** `protocolExhausted` (`:828`) requires _every_ failure to be `"protocol"`. Relaxing `.every` to `.some` makes a rate-limited roster with one bad answer in it report a configuration error instead of weather — the same green/red inversion in the other direction.
- **6 — the judge panel.** `src/core/judge.ts:214` is a hand-rolled roster loop that deliberately is not `rotateModels` (its own comment at `:198` explains why: a seat stops on a usable _vote_, not a usable _completion_). A second implementation of a rule is a second place it can break, so it gets its own mutation.
- **7 — a duty stage on `models[0]`.** `src/duties/translate/draft.ts:160` computes `draft % live.length` so draft N starts at model N. Pinning it to `0` makes N drafts one model's opinion N times, which is a scoring stage that has stopped comparing anything.
- **12 — configuration validation.** `rejectUnknownKeys` (`src/core/warrant.ts:1907-1917`) is the single chokepoint every warrant block calls. Neutering it means a typo'd key is accepted and a rule the maintainer wrote silently does nothing — the quietest possible configuration failure.
- **14/15 — the GitHub boundary.** `isMissing` broadened to any error launders a 500 or a 403 into "not there yet". `readContentsFile`'s `throw new UnreadableContentsFile(path)` (`:1011`) turned into `return null` does the specific damage its own doc comment warns about: a shard too large for the Contents API to inline is read as a cold start, and the next write overwrites its history.
- **17 — dry-run outside review.** Dry-run placement differs per duty by design, so review's row does not speak for the others. `src/duties/dependa/publish.ts:202` is the non-review case: neutering it makes a rehearsal push a branch and open a pull request.
- **19/20/21 — idempotency and duplicate side effects.** Three distinct regressions: a duplicate verdict rewritten every run (`duplicate/publish.ts:285`), every core-published body rewritten every run (`core/publish.ts:79`), and — the one that actually creates a second artefact — a truncated comment search posting a second comment beside the one it could not see (`duplicate/publish.ts:280`).

## Are these gates real

A mutation that is killed by a test which happens to break for an unrelated reason proves nothing about the invariant it names. Each new row was therefore run individually with `--reporter=verbose` and the failing case names read. Every one is killed by a test whose _name states the invariant_:

| Mutation                              | Killed by                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| auth as capacity                      | `provider.test.ts > classifying a failure's kind > classifies HTTP 401 as 401`                                      |
| starvation as protocol exhaustion     | `provider.test.ts > weather > does not report protocolExhausted when at least one failure is capacity`              |
| judge seat                            | `judge.test.ts > falls back when the seat's first model could not be reached`                                       |
| duty stage on `models[0]`             | `translate/draft.test.ts > starts each draft at a different model`                                                  |
| cheap roster (recall)                 | `recall.test.ts > spends the cheap roster when one is configured`                                                   |
| warrant key validation                | `warrant.test.ts > refuses an unrecognized key on the lifecycle: block itself` (+4 more)                            |
| empty model roster                    | `inputs.test.ts > refuses a models input that names no model`                                                       |
| every GitHub failure as not-there     | `forge.test.ts > isMissing > is true only for a 404` (+2 more)                                                      |
| undecodable contents file             | `forge.test.ts > throws, rather than reading it as a cold start, for a shard too large for the API to inline`       |
| dry-run outside review                | `dependa/authority.contract.test.ts > B3 > reports draft and touches no mutation while the run is a dry run`        |
| idempotency outside review            | `duplicate/publish.test.ts > leaves an unchanged proposal alone rather than re-posting it`                          |
| shared unchanged check                | `core/publish.test.ts > leaves a body that already says this alone`                                                 |
| duplicate comment on uncertain lookup | `duplicate/publish.test.ts > withholds the comment on a full page carrying no marker, rather than risk a duplicate` |

No row is carried by an incidental failure. The one that came closest to being a false gate was **dry-run outside review**: its first target was `src/duties/dependa/publish.test.ts`, where all nine `publishGroup` calls pass `dryRun: false` and the mutation would have SURVIVED. The real assertion lives in `src/duties/dependa/authority.contract.test.ts:104-123`, and retargeting there is what makes the row mean something. A mutation pointed at a test file that cannot observe it is a survivor waiting to be mislabelled as a coverage problem.

## Harness defects found and fixed

Three, in `tools/mutation.mjs`. The first was a data-loss bug.

1. **A crashed run could destroy a source file.** The harness renames `src/foo.ts` into `.tmp/mutation/orig-*.ts`, writes the mutated copy, and restores in a `finally`. A run killed between the rename and the `finally` — Ctrl-C, an OOM, a cancelled CI job — leaves the _only_ copy of the source in `.tmp/mutation/`. The next run's first act was `rm(SCRATCH, { recursive: true, force: true })`. It deleted it. There is now a `recover()` pass that runs before the clear and puts back any source file that is missing, plus `exit`/`SIGINT`/`SIGTERM`/`SIGHUP` handlers that restore synchronously.
2. **A stale mutation aborted the board instead of reporting.** `apply()` threw from inside the loop when its `from` string no longer matched, so one drifted string meant every later mutation silently never ran and the output was a stack trace. Staleness is now a preflight over the **whole** table — checked on every invocation regardless of `--only` or `--stage`, because a gate that stopped applying is exactly the thing a narrowed run must not be able to hide — and it is reported as a third verdict that fails the run by name.
3. **An ambiguous `from` was not checked at all.** `String.prototype.replace` with a string pattern rewrites only the first occurrence, so a `from` matching two places would quietly mutate a seam nobody chose and report whatever the targets said about it. The preflight now requires exactly one occurrence and reports `matches N places — the edit is ambiguous` otherwise.

Both staleness directions were verified by deliberately breaking a row and observing the failure: a zero-match `from` and an ambiguous one, each reported by mutation name with a non-zero exit, and both reverted.

## Rules the table is written to

- **The tersest edit that expresses the regression.** A mutation that changes three things proves nothing about which of the three the suite caught.
- **`targets` is the narrowest test set that _should_ notice** — not the set that happens to fail. Widening targets to turn a survivor green is how a mutation table becomes decoration.
- **`from` is prose-like code that is unlikely to churn.** A `from` matching a line of punctuation goes stale on the next reformat.
- **A survivor is never deleted to make the board green.** It is a finding with an owner. If a mutated seam is genuinely equivalent code, that is written down with the reasoning, not removed.
- **An entry point is not a seam.** `src/duties/*/main.ts` is excluded from coverage and driven through built bundles, so a mutation there is a rebuild-and-integration concern rather than a unit one.

## What is still ungated

Named so the next pass does not have to rediscover it:

- **`src/duties/harmonise/publish.ts`.** No mutation, because there is nothing to kill one with: `publishSync` has no unit test at all (see the coverage baseline). A dry-run or idempotency mutation there would SURVIVE for the same reason coverage reads 13% — it would report a missing test file as a mutation finding, which is the coverage document's job.
- **`src/duties/dependa/datasources/*`.** Same reason. The D12 status classifications (404/429/5xx/401) are the natural mutation targets and three of the six files have no test to run against.
- **`src/core/enclose.ts` and `src/core/sanitize.ts`.** Both at 100% coverage, both security-relevant, neither mutated. Coverage says they are exercised; nothing yet says an assertion would fail if the defanging stopped.
- **`tools/mutation.mjs` itself.** Outside the coverage `include` glob and untested. Its preflight was verified by hand rather than by a test.

Once the Round 1 test work merges, one row is expected to flip: **cheap screen roster skipped in a duty** should become KILLED if TL2 adds the `record.test.ts` case named above. Nothing else in the table should change verdict — every other row is already killed by an existing assertion, so new tests can only add redundancy. New rows are a different matter: `harmonise/publish.ts` and the datasources become mutable the moment they have unit tests, and both should get rows in the next pass.
