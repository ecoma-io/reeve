# Self-dogfood

_How Reeve runs on itself, and how the feedback loop works. Prerequisites: [The authority model](concepts/authority-model.md), [The warrant](guides/warrant.md)._

Reeve is dogfooded: four of its five duties run against this repository's own
issues and pull requests, and the fifth — `lifecycle` — runs in dry-run. This
is not self-modification; it is **proving the execution path**. A duty that
labels a stranger's issue and a duty that labels its own follow the same code,
the same warrant, and the same guardrails.

## What dogfood means here

Self-dogfood in Reeve is not a tool that writes its own prompts, adjusts its
own taxonomy, or approves its own pull requests. It is this repository's
`.github/reeve.yml` and the workflow files that point `uses:` at the working
tree — the same files any other repository would write, reviewed the same way
any other repository would review them.

The warrant constrains dogfood exactly as it constrains any consumer: the
narrower of the warrant and the workflow's `apply` always wins, a label the
warrant does not name is never applied, and `gateClose` refuses a duplicate
close that a human reversed — whether the thread belongs to this repository
or to someone else's.

## The five workflows

| Duty      | Workflow                                      | Trigger                                      | `apply`                    | Status      |
| --------- | --------------------------------------------- | -------------------------------------------- | -------------------------- | ----------- |
| triage    | `.github/workflows/reeve-triage-issue.yml`    | `opened`, `labeled`, `unlabeled`, `reopened` | `label, record`            | Active      |
| translate | `.github/workflows/reeve-translate-issue.yml` | `opened`, `edited`                           | `edit-body`                | Active      |
| duplicate | `.github/workflows/reeve-duplicate-issue.yml` | `opened`                                     | `none`                     | Report-only |
| respond   | `.github/workflows/reeve-respond-issue.yml`   | `opened`                                     | `none`                     | Report-only |
| lifecycle | `.github/workflows/reeve-lifecycle-issue.yml` | schedule, `workflow_dispatch`                | `label, comment` (dry-run) | Observing   |

`duplicate` and `respond` write their verdicts to the job summary without
touching a thread — the same path any consumer would walk when `apply: none`
is set. `lifecycle` starts in `dry-run: true`, so a maintainer can observe
what the policy would do before allowing it to act.

## The feedback loop

### Corrections (S1)

When a maintainer changes a label that Reeve applied — adding `enhancement`
where Reeve proposed `bug`, or removing a label entirely — the `record`
capability writes that decision to `.reeve/corrections/` as an NDJSON entry.
Subsequent runs read the nearest few corrections and deliver them to the
model as examples of decisions this project has already made. That is how
a taxonomy's edges get learned without anybody rewriting the taxonomy.

The `record` capability needs both halves of the double-gate: the warrant
must grant it, and the workflow's `apply` must name it. This repository
grants `triage: [label, record]` in the warrant and sets `apply: "label,
record"` in the workflow.

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
| Disable a duty            | Remove or disable its workflow file.                                         |
| Narrow what a duty may do | Remove a capability from the warrant, or remove it from `apply`.             |
| Turn off recording        | Remove `record` from either the warrant or `apply` (one half is enough).     |
| Turn off everything       | Set `apply: none` in the workflow.                                           |
| Observe before acting     | Set `dry-run: true` — the pipeline runs, nothing is written.                 |
| Remove a past correction  | Delete or edit the NDJSON file in `.reeve/corrections/` like any other file. |

---

**Related:** [The authority model](concepts/authority-model.md) · [The warrant](guides/warrant.md) · [The warrant format reference](reference/warrant-format.md) · [Duties and the core](concepts/duties-and-the-core.md)
