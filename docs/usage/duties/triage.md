# `triage`

Sorts a backlog against the taxonomy you wrote — as well in Vietnamese as in
English, or it is a bug. The easy majority is decided by code for nothing, and
only what survives that reaches a model.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

The repetitive half of maintaining an issue tracker: deciding what a thread _is_
before deciding what to do about it. It applies labels your warrant names, and
nothing else by default.

**What it is explicitly not for:** deciding whether a report is worth answering,
replacing a maintainer's judgment, or resolving anything. It proposes; you
decide. A label is one click to undo, and that is why it is the only capability
on by default.

## Minimum

```yaml
name: Triage

on:
  issues:
    types: [opened, reopened, edited]

concurrency:
  group: reeve-triage-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

No warrant needed to start: an absent `.github/reeve.yml` grants the
narrowest implicit authority [the ladder](../../north-star.md#3-the-ladder)
promises at level 0, built from the labels and label descriptions this
repository already has. Write one when a rung below stops being enough:
[The warrant](../warrant.md).

Then run it with `dry-run: true` over a month of your own history before you let
it label anything.

## Inputs

`action.yml` in the duty's directory is the contract. The ones worth a word:

| Input            | Default              | Worth knowing                                                                                                                                                                      |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`         | _required_           | The model that produces the verdict. Order is preference.                                                                                                                          |
| `screen-models`  | _empty_              | Cheap models for the first pass, which decides only whether an issue is worth the expensive one.                                                                                   |
| `warrant`        | `.github/reeve.yml`  | The taxonomy, the capabilities, and optionally a `languages:` key that wins over the input below. A file that does not parse is a failed run.                                      |
| `apply`          | `label`              | What this run may do, comma separated. Narrowed by, never widening, the warrant.                                                                                                   |
| `confidence`     | `0.75`               | Below this the verdict is reported and nothing is applied. [Measure](../../development/evaluation.md) before you move it.                                                          |
| `corrections`    | `.reeve/corrections` | The memory store. Empty is the cold-start case and works.                                                                                                                          |
| `languages`      | `en, vi, zh`         | Which languages detection chooses between. The verdict is told the answer; the taxonomy is never translated. Ignored once the warrant's own `languages:` key is written.           |
| `min-body-chars` | `40`                 | How much authored text is worth a model. `0` turns the length screen off.                                                                                                          |
| `max-body-chars` | `6000`               | How much of a long thread reaches the prompt, or `none` for no bound at all. The tail is dropped, and the summary says so. `0` is refused — write `none` for that meaning instead. |
| `about`          | _empty_              | What this repository is about, in one sentence. Used only by the spam screen.                                                                                                      |
| `dry-run`        | `false`              | Whole pipeline, every output, nothing applied.                                                                                                                                     |

**`screen-models` is the whole cost argument.** Spam, a blank body and an exact
repeat are decided by a small model or by no model at all, and a backlog is mostly
those. Leave it empty and everything code did not decide goes straight to
`models` — the documented behaviour of the default, and simply more expensive.
[Cost](../cost.md) has the arithmetic.

**`confidence` is a number you should measure rather than inherit.** What `0.75`
means for your taxonomy is not what it means for anyone else's, because the labels
are yours.

**`about` is one sentence and it does real work.** The spam screen's hard case is
not advertising — it is a real request, written by a real person, about somebody
else's software. Nothing in a thread says which project it was meant for. This is
what tells it.

## Outputs

| Output         | Value                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `labels`       | JSON array of the labels actually applied. Empty when none were.                                                                                                                     |
| `proposed`     | JSON array of every label the verdict proposed, **including the ones the guardrails refused.**                                                                                       |
| `confidence`   | The verdict's own confidence, as a decimal string.                                                                                                                                   |
| `language`     | The author language detected for this thread, or empty for `unknown`.                                                                                                                |
| `duplicate-of` | Issue number this one appears to duplicate, empty when none was found. Reported, never acted on unless `apply` names `close`.                                                        |
| `screened-out` | Why the cheap pass stopped the run before an expensive model saw it. Empty when the issue went through in full.                                                                      |
| `applied`      | JSON object recording what was actually done. Empty of actions under `dry-run`, which is how a workflow tells a rehearsal from a run.                                                |
| `recorded`     | `true` when this run wrote (or under `dry-run`, would have written) the thread's current labels to the corrections store. `false` on every other run, including an ordinary verdict. |

**The difference between `proposed` and `labels` is what the guardrails
stopped.** That is the output to watch while you are tuning `confidence` or a
`not` field — it is the only place a refused verdict is visible.

`screened-out` being non-empty is the one case where "the duty did nothing" is the
correct answer, and it is distinguishable from every other case _because_ that
output is populated.

## The pipeline

Six stages. The order is not arbitrary: each exists to make the next cheaper or
safer, and the guardrail stage is deliberately last, so nothing upstream can be
trusted to have done its job.

```
issue ─► read ─► screen ─► recall ─► triage ─► verify ─► apply
           │       │         │         │        │         │
       warrant   cheap or  nearest   the      against   only what
       parsed    no model  maintainer model,  the FILE, `apply`
       first     at all    correction inside  never the  permits
                                     a nonce  model
```

**Read.** Fetch the thread and parse the warrant, in that order and before
anything else — including before every label the warrant names is checked to
exist in the repository, which is where a renamed label produces an error naming
both rather than a verdict whose labels are all silently dropped later.

A thread that is already closed, or already labelled, is not skipped by default:
re-triage is legitimate when a taxonomy changed or a backfill is running. What it
must not do is fight a maintainer, and the apply stage is where that is enforced.

**Screen.** The stage that makes a large backlog affordable, and most issues stop
here.

Decided with no model at all, in code:

- a thread with no authored text to work from;
- a body that is only an issue template with nothing filled in;
- a body under `min-body-chars` of authored text, with template scaffolding and
  quoted code stripped before the count.

**The title counts as authored text.** `Export produces an empty file for
single-row tables` with no body at all is a report a maintainer labels in a
second, and a screen that read only the body would drop a large share of a real
tracker.

Decided by `screen-models` when configured: spam and off-topic. Those need
judgment a regex cannot supply, and the _cheapest_ judgment available — the
decision is binary and the input is short.

**The free screen runs before language detection**, which is a deliberate
departure from the order drawn above: detection can cost a request, and there is
nothing to detect the language of in a thread that is about to stop here anyway.

**Not yet built: the exact repeat.** A code screen for a thread that repeats an
existing issue by content hash needs a corpus of the issues already filed, and
GitHub's search API cannot supply one — it stops at a thousand results and
truncates hardest on exactly the backlogs where duplicates matter. It is left out
rather than approximated. The verdict may still _report_ a duplicate, which is
the `duplicate-of` output.

**Recall.** Retrieve the maintainer corrections most similar to this thread and
put them in the prompt as examples.

This is the stage that moves accuracy, and the reason is not model quality.
Labels are **org-subjective**: whether a slow query is `performance` or `bug` is a
decision your project made, and no general model can know it. A longer prompt does
not fix that. Retrieval over decisions your maintainers already made does.

What ships today is lexical retrieval — a BM25 ranking over the corrections in
`corrections`, which needs no provider, costs nothing and adds no request to a
run. It matches on words, so it finds the correction written in the same language
as the thread.

Cross-language retrieval is the part nothing else in this category has: a
correction a maintainer made on an English report should inform the verdict on the
Vietnamese one describing the same thing. Lexical ranking cannot do that on its
own, so recall asks the store twice when it might help — once in the thread's
own language, once translated into the pivot language — and merges the two
rankings. A thread and a store that already share one language never pay for
the second query: the pivot bridge is built only when there is a language gap
worth crossing.

**Writing ships too, behind the `record` capability.** Grant it (it needs
`contents: write` on the token, so it is off by default) and a labelled or
unlabelled event from a human — never a re-triage, never a bot — commits that
thread's taxonomy-filtered current labels to the store, replacing any earlier
entry for the same thread. This does not ask for a fresh verdict: a label
change already is the maintainer's decision, and `record` writes down what
stands rather than second-guessing it. When the thread's own language is not
the pivot, its title and excerpt are also translated into the pivot and stored
alongside the original — best effort: a translation that could not be
produced this run still leaves the correction recorded, without that
rendering. No checkout happens for any of this; the commit goes through
GitHub's Contents API. See [the warrant's capability
table](../warrant.md#capabilities) for what grants it.

**`record` needs naming in both halves — the file and the workflow.** The
narrower of `reeve.yml`'s `capabilities:` block and the workflow's `apply`
input wins, always, and that rule applies to `record` exactly as it applies
to `label` or `comment`. Granting `record` in the file alone is not enough:
`apply` defaults to `label`, and a run triggered on a labelled event with
`record` left out of `apply` re-triages the thread instead of recording it —
silently, because nothing about that is a misconfiguration `checkLabelsExist`
or the warrant reader could catch. A trigger this duty would otherwise have
recorded, doing an ordinary verdict instead because `apply` did not name
`record`, is logged as a notice for exactly this reason. The workflow needs
both the trigger and the grant:

```yaml
on:
  issues:
    types: [labeled, unlabeled]

permissions:
  contents: write
  issues: write

jobs:
  record:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          number: ${{ github.event.issue.number }}
          # `models` and `api-key` are required on every run, `record` included —
          # same values as [the minimum example](#minimum) above.
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          apply: label, record
```

and the file's own half, alongside whatever else `triage` is granted:

```yaml
capabilities:
  triage: [label, record]
```

**Triage.** Ask for a verdict: labels from the taxonomy, a confidence, an optional
duplicate reference, a rationale. Three properties are non-negotiable:

- **The thread text sits inside a per-call random nonce boundary**, not a fixed
  delimiter. A fixed delimiter is forgeable by anyone who has read this source,
  and this source is public. [Security](../../development/security.md).
- **A model is rotated past, never retried.** A provider limit does not clear
  inside one run.
- **Unreadable output is an empty verdict** — not a best-effort parse of the parts
  that looked fine. The shapes that fail to parse are the shapes an injection
  produced, so an optimistic parser is most lenient exactly when it should be
  strictest.

**Verify.** Re-check the verdict, in code, against the warrant file and the
confidence floor. Never against the model's own claim about what it was allowed to
do.

- A label the taxonomy does not name is **dropped**, whatever the model returned.
- A verdict below `confidence` appears in `proposed` and in the log; `labels`
  stays empty.
- `exclusive_with` conflicts are resolved here, in code, rather than requested of
  the model.
- A duplicate reference is reported, never acted on unless `apply` names `close`.

This stage is separate from the one above it on purpose. Validation performed
inside the function that constructed the prompt drifts toward trusting the prompt;
validation that only ever sees the verdict and the file cannot.

**Apply.** Exactly what `apply` and the warrant both permit, and nothing else.
Under `dry-run` every one of these logs what it would have done and does nothing.

## Language, and the claim that matters

A triage verdict must be as good on a report written in Vietnamese as on the same
report written in English. That is the reason this duty exists inside Reeve rather
than as its own tool.

Three concrete consequences:

- **Detection runs before the verdict**, so the model is told what it is reading
  rather than inferring it, and the outputs record it.
- **The taxonomy is not translated.** Your `description` and `not` are the
  authority in whatever language you wrote them; translating them would put a
  machine paraphrase between your decision and its enforcement.
- **The headline accuracy number is the worst language, not the average.** A duty
  that scores 0.91 in English and 0.62 in Vietnamese reports **0.62**. See
  [D11](../../north-star.md#d11--every-duty-ships-with-an-evaluation).

## Failure, and what it looks like

| What happened                                        | What you get                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| The cheap pass stopped it                            | `screened-out` populated, `labels: []`, **green** — a real answer |
| Every model failed                                   | Warning naming each attempt, empty verdict, **green**             |
| The verdict did not parse                            | Loud warning, empty verdict, nothing applied, **green**           |
| Confidence below the floor                           | `proposed` populated, `labels: []`, **green**                     |
| The warrant does not parse, or names a missing label | **Red**, naming the file and the label                            |
| The thread cannot be read                            | **Red**                                                           |

**The failure mode of this duty is doing nothing.** Every branch above ends there,
and none of them ends in a wrong label.

## What it will never do

- Remove a label a maintainer applied.
- Reopen what a maintainer closed, or overwrite an assignment.
- Apply a label your warrant does not name.
- Edit a title or a body.
- Comment, close or assign without that capability being turned on by name.

[The warrant](../warrant.md#what-no-capability-can-ever-turn-on) is where those
are enforced, and there is no input that turns any of them on.
