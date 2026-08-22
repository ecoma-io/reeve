# Self-dogfood

_How Reeve runs on itself, and how the feedback loop works. Prerequisites: [The authority model](../concepts/authority-model.md), [The warrant](warrant.md)._

Reeve is dogfooded: its duties run against this repository's own
issues, pull requests, and dependencies. `triage`, `translate` and `review` act
on real threads — `review` answers every pull request here with a real summary
comment and real inline threads; `duplicate` and `respond` run in report-only
mode, writing verdicts to job summaries and touching nothing; `lifecycle`
observes in dry-run; and `dependa` acts on its grant — committing manifest
updates and opening draft PRs alongside Renovate, whose comparison run still
measures it weekly. `harmonise` is configured to watch `README.md`,
whose sync to Vietnamese/Chinese is pending the bootstrap of its first
translations — see [the harmonise reference](../reference/duties/harmonise.md#bootstrap).
This is not self-modification; it is **proving the execution path**. A duty
that labels a stranger's issue and a duty that labels its own follow the same
code, the same warrant, and the same guardrails.

## What dogfood means here

Self-dogfood in Reeve is not a tool that writes its own prompts, adjusts its
own taxonomy, or approves its own pull requests. It is this repository's
`.github/reeve.yml` and the workflow file that points `uses:` at the leaf
actions — the same files any other repository would write, reviewed the same
way any other repository would review them.

The warrant constrains dogfood exactly as it constrains any consumer: the
warrant is the whole authority — what the `duties:` block does not grant is
never done — and `gateClose` refuses a duplicate close that a human reversed,
whether the thread belongs to this repository or to someone else's.

## The workflow

Every duty is dogfooded by one workflow —
`.github/workflows/reeve.yml` —
whose one config table answers, in a glance, which repository, which duty,
which event, which mode and which result a run produced:

| Duty      | Event                                         | Mode       | Status                    |
| --------- | --------------------------------------------- | ---------- | ------------------------- |
| triage    | `opened`, `labeled`, `unlabeled`, `reopened`  | controlled | Active                    |
| translate | issue `opened`/`edited`, PR `opened`/`edited` | propose    | Active                    |
| duplicate | `opened`                                      | observe    | Report-only               |
| respond   | `opened`                                      | observe    | Report-only               |
| lifecycle | daily schedule                                | observe    | Observing                 |
| harmonise | `push` (README.md)                            | propose    | Active                    |
| review    | PR `opened`/`ready_for_review`/`synchronize`  | controlled | Active                    |
| dependa   | Wednesday (drafting), Thursday (conformance)  | controlled | Active (Thursday shadows) |
| sweep     | Monday schedule                               | propose    | Active                    |

The three modes are what a job may write, and the boundary between them is a
deliberate act, never a default — see the workflow header for the full
definitions. `observe` is write-safe by construction (`duplicate`, `respond`,
`lifecycle` and the Thursday `dependa` conformance row run `dry-run: true`);
`propose` (translate, harmonise) withholds nothing and lets the warrant decide;
`controlled` (triage, review, and the Wednesday `dependa` drafting row) writes
what the warrant grants. A manual `workflow_dispatch` defaults to observation
and needs `dry-run: false` to act — write authority is never granted by
accident.

`review` and `dependa` both arrived at `controlled`; neither started there.
Each ran report-only first, and each was moved in one deliberate commit that
wrote the warrant grant and opened the matching job's write path together —
#114 for `review`, #125 for `dependa`. A mode is where a duty ends up, never
where it begins.

Every job runs the real public leaf action — `uses: ecoma-io/reeve/<duty>@main`
— so the committed `dist/` bundle CI proves matches `src/` is what is exercised,
not a test-only shortcut around the architecture.

## The feedback loop

### Corrections (S1)

When a maintainer changes a label that Reeve applied — adding `enhancement`
where Reeve proposed `bug`, or removing a label entirely — the `record`
capability writes that decision to `.reeve/corrections/` as an NDJSON entry.
Subsequent runs read the nearest few corrections and deliver them to the
model as examples of decisions this project has already made. That is how
a taxonomy's edges get learned without anybody rewriting the taxonomy.

The `record` capability is granted by the warrant alone: `triage: [label,
record]` in `.github/reeve.yml` is what lets a label change be written to
`.reeve/corrections/`. There is no second permission to set — the warrant is
the whole authority, and removing `record` from it turns recording off.

### Reversals (S3)

When a maintainer reopens a thread that Reeve closed as a duplicate, `record`
writes a reversal with `outcome: "overruled"` and the `duplicateOf` number.
The hard gate — `gateClose` — reads the corrections store before any
duplicate-close and refuses if a matching reversal exists. This gate operates
independently of memory recall; it holds even when `memory.recall: 0`.

An author reopening their own thread is **surfaced** — a notice appears in
the run log — but never **recorded** as a reversal, because the author's
disagreement is not a maintainer's decision. A maintainer who agrees can
still relabel, which is recorded.

### `record` is governance, not intelligence

The three actions `record` fires on — `labeled`, `unlabeled`, `reopened` —
are human actions that need no model. The triage workflow runs these steps
even when no provider is configured, because recording a correction or a
reversal is a governance operation, not an intelligence one.

## Memory and self-training

Memory recall reads `.reeve/corrections/` from the local checkout and
delivers the nearest few entries to the model as context. The warrant's
`memory: { recall: 4 }` controls how many.

Reeve cannot train on its own historical output. Two mechanisms prevent it:

1. **Bot exclusion.** A `labeled` event whose actor is a bot is never
   imported as a correction during a sweep, and a label whose most recent
   `labeled` event was a bot is not enriched with `outcome: "overruled"`
   when removed by a human.
2. **The sweep guard.** A sweep composing `record` with `sweep` imports
   standing labels as history, but skips any label whose most recent
   `labeled` event was a bot — so months of Reeve's own past output cannot
   be imported back in as though a maintainer had decided it.

## Fail-closed read paths

Every read path in the outcome module that checks GitHub's API fails closed
on error:

| Function              | Safe value | What happens instead                      |
| --------------------- | ---------- | ----------------------------------------- |
| `removedByAutomation` | `false`    | S2 correction without enrichment          |
| `attributedClose`     | `null`     | Reopen falls through to ordinary triage   |
| `isTrustedReopener`   | `false`    | Reopen not recorded as reversal           |
| `gateClose`           | `refuse`   | Close refused rather than risk a reversal |

An unreadable answer is never converted into authority.

## How to inspect a dogfood run

- **Job summary** — every run writes a summary to `$GITHUB_STEP_SUMMARY`
  with the verdict, the proposed labels, the applied labels, and what was
  refused and why.
- **Outputs** — the action's outputs (`labels`, `proposed`, `confidence`,
  `recorded`, `screened-out`) are visible in the workflow run's context.
- **Markers** — a close made by the duplicate duty carries an HTML comment
  marker (`<!-- reeve:triage:closed duplicate-of=123 -->`) that `attributedClose`
  reads on a reopen.
- **Corrections** — `.reeve/corrections/` is committed to the repository
  and visible in diffs, like any other file.

## How to enable or disable dogfood

| Action                    | How                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- |
| Disable a duty            | Remove or disable its job in `.github/workflows/reeve.yml`.                  |
| Narrow what a duty may do | Remove a capability from the `duties:` block in the warrant.                 |
| Turn off recording        | Remove `record` from the `duties:` block in the warrant.                     |
| Turn off everything       | Remove the duty from the `duties:` block, or omit the block entirely.        |
| Observe before acting     | Set `dry-run: true` — the pipeline runs, nothing is written.                 |
| Remove a past correction  | Delete or edit the NDJSON file in `.reeve/corrections/` like any other file. |

## Classifying a dogfood failure

Dogfood failures are evidence, and the first question to answer is what kind
of evidence. Every failure from the unified workflow lands in a job summary
that names repository, duty, event, mode and outcome; what follows is the
classification, and it is exactly one of four:

1. **Bug → regression fixture.** The duty did not do what its own
   documentation says it does — a wrong label, a republished block, a
   comparison that classified a real discrepancy as a match. Reproduce the
   failure with a minimal fixture under `eval/fixtures/<duty>/`, and carry the
   fix in the same change.
2. **Intent update.** The run exposed a decision this project had not made —
   a threshold to raise, a guardrail to add, a mode to switch from observe to
   propose once the backlog says the false-positive rate is acceptable.
   Changing the workflow file or the warrant is the fix.
3. **Doc correction.** The page said what the code does not do. Fix the page;
   the CI doc-links and anchor guards keep the correction honest.
4. **Explicitly-accepted limitation.** A measured, documented gap that is a
   deliberate trade — dependa's `INTENTIONAL_DIFFERENCE` classifications are
   this, and so is a free tier's `Weather` ending a sweep yellow with
   `remaining` honest. The limitation must be written down before it can be
   accepted; an undocumented failure is none of these four and stays open.

The classification is recorded in the issue or pull request that names the
failure — a job summary is evidence, not a decision, and the decision is the
maintainer act that places it in one of the four buckets above.

---

**Related:** [The authority model](../concepts/authority-model.md) · [The warrant](warrant.md) · [The warrant format reference](../reference/warrant-format.md) · [Duties and the core](../concepts/duties-and-the-core.md)
