# `duplicate`

Finds the open thread that already asked this — ranked by shared words, then
confirmed by a model asked a judged question against the exact shortlist it
was shown, never against a claim a thread body makes about itself.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

The question a maintainer asks first on a new report, before anything else:
"does this already exist?" Answering it by hand means reading titles across
whatever the tracker's search turns up, in whatever language they happen to
be written in. This duty ranks the whole open backlog against the thread in
front of it, bridges the ranking across a language gap when one exists, and
asks a model to confirm the top candidates are genuinely the same problem
rather than merely similar words.

**What it is explicitly not for:** closing anything. It proposes a candidate
and a reason; a human closes. `duplicate-of` is reported on every run so a
workflow that wants to close automatically can — that is the workflow's
decision, made in a workflow file, never this duty's.

## Minimum

```yaml
name: Duplicate check

on:
  issues:
    types: [opened, edited]

concurrency:
  group: reeve-duplicate-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  duplicate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/duplicate@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

This alone reports and posts nothing: `duplicate` has no cheapest-reversible-
action default the way `triage`'s `label` is one. Add `duplicate: [comment]`
to `.github/reeve.yml`'s `capabilities:` block **and** `apply: comment` on the
workflow before it writes anything — see [why below](#capabilities-have-no-
default-here) and [the warrant](../warrant.md#capabilities). Until then, run
it and read `duplicate-of` and `score` off the job summary to see what it
would have proposed.

## Inputs

`action.yml` in the duty's directory is the contract. The ones worth a word:

| Input              | Default             | Worth knowing                                                                                                       |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `models`           | _required_          | Used for detection, the pivot bridge, and the judge alike.                                                          |
| `warrant`          | `.github/reeve.yml` | Grants nothing to this duty until `duplicate: [comment]` is written into it — see below.                            |
| `apply`            | `none`              | `comment`, or `none`. Narrowed by, never widening, the warrant — and neither half defaults to `comment` on its own. |
| `candidates`       | `5`                 | How many of the closest-ranked open threads reach the judge.                                                        |
| `corpus-limit`     | `none`              | How many open threads the ranking runs against at all. `none` is every open issue.                                  |
| `corpus-since`     | _empty_             | Bounds the corpus by creation date, same grammar as `since`. A cost control, not a correctness setting.             |
| `confidence`       | `0.75`              | Below this the verdict is reported and nothing is posted.                                                           |
| `max-body-chars`   | `6000`              | How much of a body — the thread and every candidate alike — is indexed and judged. `none` reads the whole thing.    |
| `show-attribution` | `none`              | How much of the machinery the posted comment names. Same three values `translate` uses.                             |
| `sweep`            | `false`             | Check the whole backlog instead of one thread. No idempotent skip — see [the pipeline](#the-pipeline).              |

## Outputs

| Output         | Value                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-of` | The issue number the verdict thinks this repeats, or empty. Reported whether or not `apply` names `comment`.                                                                     |
| `score`        | The judge's own confidence, to two decimal places. Distinct from the `confidence` input, which is the floor it is checked against.                                               |
| `language`     | The detected language of the thread, or empty for none of the configured ones.                                                                                                   |
| `commented`    | `true` when this run leaves its comment standing — posted, replaced, or already there and left unchanged. `false` on every other path, including one under the confidence floor. |
| `starved`      | `true` when every model in `models` failed on capacity this run. Weather, not a failure.                                                                                         |
| `processed`    | How many issues a sweep processed. `0` outside `sweep`.                                                                                                                          |
| `remaining`    | Candidates a sweep did not reach. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                                          |

**`score` and `confidence` are not the same axis.** `score` is what the judge
actually answered; `confidence` is the floor it has to clear before anything
is posted. A workflow reading `score` off a run under the floor sees a real
number, not zero — `duplicate-of` names the candidate that scored it.

## The pipeline

```
issue ─► read ─► language ─► corpus ─► bridge ─► rank ─► judge ─► verify ─► apply
          │         │           │         │        │       │        │        │
      warrant    script,    every open  pivot,   BM25,   judged  candidates  only
      checked    profile,   thread the  only if  top N   question the   from the  comment,
      first      or a       bounds      worth              judge shortlist  only if
                 model      allow       a request           saw           granted
```

**Read.** The warrant first, same order and reason as every other duty — and
the same short-circuit: a written `capabilities:` block that does not name
`duplicate` stops the run before the thread is even fetched, reported as a
green no-op rather than spent against.

**Language.** Script, then profile, then — only if neither decided — a model.
The judge is told what it is reading rather than left to infer it.

**Corpus.** Every open issue `corpus-limit`/`corpus-since` allow, paged until
those bounds are satisfied or the open list runs out — deliberately not the
fixed ten-page ceiling a sweep's own listing uses, because this is an index a
maintainer configured, not a work budget layered on top of one.

**A published block is stripped out of every body before it is indexed or
judged — the thread's own and every candidate's alike.** A body that
`translate` (or, in principle, any future body-editing duty) has already
written into carries that duty's marker followed by its own output, and this
duty cuts a body off at the first marker of any kind it finds, keeping only
what came before. Two designs were on the table. Indexing the machine block
too would have made a translated candidate lexically reachable from a
same-language query "for free" — real cross-language recall, but recall that
depends on which threads happened to get translated first rather than on
which are actually alike, and a candidate translated into five languages
would out-rank a closer match only ever written in one for a reason that has
nothing to do with how similar the two reports are. Stripping keeps ranking
measuring one thing — what the two authors actually wrote — and leaves
cross-language recall entirely to the pivot bridge below, which buys it on
purpose, one query at a time, rather than as a side effect of which threads a
translate workflow happened to reach first.

**Bridge, when it is worth a request.** Every configured language is checked
against every corpus candidate for free — script and profile only, no model,
whatever the corpus size — before anything is spent. Only once that free pass
finds a candidate the thread's own language would never match is
`translateToPivot` worth a request, and a failure there degrades to
same-language matching rather than blocking the run.

**Rank.** BM25 over the corpus — the same lexical scoring
[memory](../../north-star.md#9-settled-questions) runs over the corrections
store, on a different corpus. `candidates` deep, closest first.

**Judge.** The expensive roster, asked whether the top candidate is genuinely
the same problem — a judged question, not a lexical one. The candidates
offered are named in the prompt by number and shown nowhere else, so the only
numbers the judge can answer with are the ones this run's own ranking put in
front of it.

**Verify.** The confidence floor, in code, and one more check that is not
optional: **the verdict's `duplicate_of` is checked for membership in the
exact shortlist the judge was shown, twice** — once inside the parser that
reads the model's answer, and once again where the number is about to become
an output or a comment. A thread body cannot steer a verdict at a thread the
ranking never surfaced by claiming "this duplicates #999" inside its own
text: an answer naming anything outside the shortlist is refused the same as
one that failed to parse, never resolved against the wider repository
after the fact. This is stricter than `triage`'s own duplicate reference,
which trusts any positive integer because the whole repository is in scope
there — here, the model was handed a specific list and asked to pick from
it.

**Apply.** Only `comment`, only when both the warrant and `apply` grant it,
and only as a find-and-replace under this duty's own marker
(`reeve:duplicate`) — a rerun that reaches the same fingerprint changes
nothing, and one that reaches a different one replaces the comment rather
than stacking a second opinion under the first.

**The suspected duplicate is machine-readable in the marker itself, not only
in the sentence underneath it.** The tag reads
`<!-- reeve:duplicate source=<fingerprint> duplicate-of=<N> -->` — the same
tag idempotency already reads, carrying one more field. This duty never
closes anything itself, but whatever eventually does — a workflow reading
`duplicate-of`, or a later duty — needs to attribute that close back to
"Reeve said this repeats #N" without parsing the rationale sentence, which is
translated, reworded by `show-attribution`, or absent depending on how the
comment was configured. Attribution elsewhere in Reeve is "a marker, and the
comment it lives in was posted by a bot" — this is what makes that rule work
for a duplicate verdict specifically, rather than every reader having to
learn a second way to find the number.

**This duty never closes a thread, on a reopened one or any other — which is
exactly what makes it safe on `reopened` events.** A workflow that lists
`reopened` alongside `opened`/`edited` gets a run that re-decides and, if
still eligible, replaces its own comment — the same idempotent find-and-
replace every other retrigger does. It cannot re-fight a maintainer who just
reopened a thread over a close, because closing was never this duty's motion
to begin with: `duplicate-of` is the whole interface a workflow has for
acting further, and a workflow built on it is the one place that needs its
own version of this guard — checking for a prior bot close under this duty's
marker followed by a human `reopened` event, and refusing to re-close if so —
because this duty's own authority stops one step short of ever needing it.
A future duty that does close carries the same rule where it applies: a
maintainer's reopen is never something Reeve overrules.

**No idempotent skip in `sweep`.** `triage`'s sweep can tell a taxonomized
thread from an untaxonomized one by reading its labels, a free fact. Whether
a thread is a duplicate is exactly the question every thread in the walk is
asked, and there is no cheaper fact standing in for the answer — so every
open issue a sweep reaches is processed, not skipped.

## Capabilities have no default here

Every other duty in Reeve grants its cheapest reversible action for free —
`triage` labels, `translate` writes a block below the marker. `duplicate` is
different: a comment naming the wrong thread as a duplicate is a claim posted
in public about somebody else's report, not something a maintainer undoes
with one click. So there is no default worth reaching for. Both halves —
`duplicate: [comment]` in the warrant and `apply: comment` on the workflow —
have to be set explicitly before this duty ever writes to a thread; either
alone still leaves it reporting `duplicate-of` and `score` and touching
nothing.

`close` exists as a capability name, mirrored from `triage`, for a future
where this duty might close a confirmed duplicate itself — but it is off by
default, undocumented as a setting to turn on, and this duty never checks for
it today. `duplicate-of` is what a workflow reads to close a thread itself,
under its own authority, right now.

## Failure, and what it looks like

| What happened                                                                      | What you get                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| The corpus has no open candidates worth ranking                                    | `duplicate-of` empty, **green** — a real answer             |
| Every model failed                                                                 | Warning naming each attempt, empty verdict, **green**       |
| The verdict did not parse, or named a candidate outside the shortlist it was shown | Loud warning, empty verdict, nothing applied, **green**     |
| Confidence below the floor                                                         | `duplicate-of`/`score` populated, nothing posted, **green** |
| The pivot translation failed                                                       | Same-language matching only, **green**                      |
| The warrant does not parse                                                         | **Red**, naming the file                                    |
| The thread cannot be read                                                          | **Red**                                                     |

**The failure mode of this duty is doing nothing.** Every branch above ends
there, and none of them ends in a comment naming the wrong thread.

## What it will never do

- Close, reopen, label or assign anything — `duplicate-of` is the whole
  interface for a workflow that wants to act further.
- Edit a title or a body.
- Post more than one comment per thread — a rerun replaces its own under the
  same marker rather than stacking.
- Post at all without both the warrant and `apply` naming `comment`.

[The warrant](../warrant.md#what-no-capability-can-ever-turn-on) is where
those are enforced, and there is no input that turns any of them on.
