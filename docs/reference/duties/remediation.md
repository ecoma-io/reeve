<!-- source of truth: remediation/action.yml -->

# `remediation`

_Full contract for the `remediation` duty — every input, every output, checked against `remediation/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

A review finds something. `remediation` is the separate duty that turns those
findings into deterministic remediation proposals — records published to the
job summary and the run's outputs, nothing written to the repository. It
proposes; it does not fix, and it does not open a pull request.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for, and what it will never become

The pipeline this repository is walking toward is
`review → finding → verification → remediation proposal → (optional patch) → tests → new review → fixing PR`. `remediation` is the third rung: it reads the findings a `review` run already reconciled — from the envelope on the review's own owned comment, which is the durable record of what review decided — and derives one proposal per actionable finding, deterministically, with no model in the loop.

**It is proposal-only, and this is not a soft claim.** This duty never writes
repository state. It does not edit a file, open a fixing pull request, write a
state branch, post a comment, or run a test suite. The run's auditable
deliverable is the `Proposals` table on the job summary and the
`proposed`/`proposals`/`note` outputs. A warrant that grants `edit-file` or
`open-pr` to `remediation` fails red, naming the capability: those are real,
later capabilities, and a silent inert grant must not read as authority —
see [Failure behavior](#failure-behavior).

**`review` stays the separate, non-coding abstraction.** A review never codes,
and nothing review-side can ever turn into a fixing agent: the separation is
structural, in both directions. `remediation` does not import `review`'s
shipped code — it re-declares the envelope shape it reads and pins it against
review's own encoder in tests — and `review`'s module graph contains zero
imports of `src/duties/remediation/`. The fixing pull request is the future
seam, documented in
[the 2.x roadmap](../../development/roadmap-2x.md), and it will ship as its
own grant behind the warrant exactly like every other mutation
([§9.1 of the north star](../../doctrine/north-star.md#91--does-reeve-modify-repository-state-only-within-explicit-authority)).

## When to use it

A repository whose `review` duty runs at all. `remediation` reads the review's
own envelope — there is nothing to derive without it — so a workflow points it
at the same pull request, after `review` has run. Run it in `dry-run: true`
first: the proposals are printed and the summary is written, nothing else
happens, and a maintainer can see what the deterministic derivation produces
before deciding whether it is worth wiring to a real run.

## Example (minimal workflow YAML)

```yaml
name: Remediate

on:
  pull_request:
    types: [ready-for-review, synchronize, opened]

permissions:
  contents: read
  pull-requests: read

jobs:
  remediate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/remediation@v0.6 <!-- roadmap ref -->
        with:
          number: ${{ github.event.pull_request.number }}
```

That alone proposes nothing: the duty reads the warrant, and a
`.github/reeve.yml` that does not grant `remediation: [propose]` leaves the
proposals on the job summary and the repository untouched. Grant `propose` once
you trust it.

## Required permissions

**Token:** `pull-requests: read`. This duty reads exactly one comment — the
review's own owned comment on the named pull request — and writes nothing. Do
not over-grant the token: `contents: write` and `pull-requests: write` are the
scopes a future fixing-PR duty would need, and this one must not be given them
out of symmetry with a duty that will never use them.

**Warrant grant:** like `review`, `remediation` is granted nothing by default,
and the `duties:` block in the warrant is the whole authority:

```yaml
# .github/reeve.yml
duties:
  remediation: [propose]
```

Leave the block silent about `remediation` and the run decides, reports on the
job summary, and proposes nothing — a real answer, not a misconfiguration, and
the job summary says so. `propose` is the only capability this duty has; any
other grant (`comment`, `close`, `edit-file`, `open-pr`, …) is either inert
here or — for `edit-file` and `open-pr` — refused red.

## Required inputs

None. Every input has a default; `number` falls back to the pull request that
triggered the workflow, and an event that carries no pull request fails red
naming the event.

## Configuration

Every input `remediation/action.yml` declares.

| Input          | Required | Default               | What it does                                                                                                                                                                          |
| -------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token` | no       | `${{ github.token }}` | Token used to read the pull request's comments. `pull-requests: read` is enough; the warrant decides whether proposals are derived at all.                                            |
| `number`       | no       | _(empty)_             | The pull request to derive proposals for. Defaults to the one that triggered the workflow. An event that carries no pull request fails red naming the event.                          |
| `warrant`      | no       | `.github/reeve.yml`   | Where the permissions live. `propose` is granted here, under `duties:`. A missing file grants `remediation` nothing, same as one that is silent about it.                             |
| `dry-run`      | no       | `false`               | Write every output and the summary, and write nothing anywhere else. There is nothing else to write — dry-run exists so a run can be observed before a future fixing step is granted. |

## Outputs

Every output `remediation/action.yml` declares.

| Output      | Value                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposed`  | `true` when at least one proposal was derived this run. `false` on every other path — the warrant denied the duty, no review envelope was found, or every finding was not actionable.                    |
| `proposals` | How many proposal records this run derived. Matches the rows of the summary's `Proposals` table.                                                                                                         |
| `note`      | Why this run stopped before proposing, when it did — the warrant's `duties:` block never named `remediation`, or no review envelope was found on the pull request. Empty when the run derived proposals. |

**The proposal record is the durable, deterministic deliverable.** One record
per actionable finding: a fingerprint (a stable identity a future fixing-PR
stage can key off), the finding's own id, rule, severity, path:line, the
finding's words verbatim, its standing, and the remediation text — deterministic
template prose derived from the rule body and the finding body, with no model
and no patch. Re-running over the same envelope produces byte-identical
records, so the records are cheap and idempotent without any new storage: the
envelope is the memory, and the records are a pure function of it.

## Standing: what counts as actionable

A finding is compared against the review envelope's own reconciled statuses —
`review` already owns the diff-aware reconciliation, and `remediation` reads
its result rather than re-verifying the diff:

| Standing   | Proposed? | Why                                                                                                      |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `created`  | yes       | A new claim — the code has not moved under it.                                                           |
| `persists` | yes       | The same claim is still standing.                                                                        |
| `reopened` | yes       | A previously resolved claim is back with new evidence.                                                   |
| `changed`  | **no**    | The code moved under the claim; the finding body is stale evidence — proposing against it would mislead. |
| `resolved` | **no**    | The diff moved past the claim.                                                                           |

## Failure behavior

| What happened                                           | What you get                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The warrant's `duties:` block never named `remediation` | `proposed: false`, the reason on the summary, **green**                                           |
| No review envelope found on the pull request            | `proposed: false`, the note says so, **green** — absent input is not a failure                    |
| Every finding `changed` or `resolved`                   | `proposed: false`, **green**                                                                      |
| A corrupt envelope (tampered or wrong-shaped)           | Read as absent — `proposed: false`, the note says so, **green**                                   |
| The warrant grants `edit-file` or `open-pr`             | **Red**, naming the capability — proposal-only, and a silent inert grant cannot read as authority |
| The warrant does not parse                              | **Red**, naming the file                                                                          |
| The pull request cannot be read                         | **Red**                                                                                           |

**The failure mode of this duty is a red refusal of an over-grant, never a
wrong write.** Everything this duty decides lands on a summary and three
outputs; there is no write to get wrong.

## Dry-run behavior

`dry-run: true` runs the whole pipeline — reads the warrant, reads the
envelope, derives the proposals — and writes every output and the summary.
There is nothing else a run would write, so dry-run differs from a real run
only in reporting. See [Rehearsing a run](../../guides/dry-run.md).

## Cost

No model is asked anything, ever. The whole duty is code: read the warrant,
read one comment, derive deterministic records, report. Every run costs a
handful of API reads and nothing else.

## Security considerations

- **This duty never writes repository state.** No `edit-file`, no `open-pr`,
  no state branch, no comments — the proposal records are published where
  GitHub already collects runs (the job summary and the outputs), and a future
  write to files under a `.reeve/`-style path would require a warrant grant
  like every other mutation.
- **The envelope it reads is `review`'s own, found by the same guard a review
  run uses**: a bot-authored comment whose body splits on the review marker
  with `official === ""`. A forged or quoted marker is never treated as
  review's memory. A corrupt payload reads as absent, not as a claim.
- **A review finding can never grant a capability.** The finding body and rule
  text are data this duty proposes about, never instructions; the only
  authority in a run is the parsed warrant file
  ([§9.1 of the north star](../../doctrine/north-star.md#91--does-reeve-modify-repository-state-only-within-explicit-authority)).
- **A grant of `edit-file` or `open-pr` fails red.** Those are real, later
  capabilities for the fixing-PR stage, and a run that ignores an over-grant
  would make the warrant read as more authority than it was given. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The `review` duty](review.md) · [The authority model](../../concepts/authority-model.md) ·
[The warrant](../../guides/warrant.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
