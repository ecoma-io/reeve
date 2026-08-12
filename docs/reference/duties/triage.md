<!-- source of truth: triage/action.yml -->

# `triage`

_Full contract for the `triage` duty — every input, every output, checked against `triage/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

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

## When to use it

The duty to start with. It needs no warrant to run at all — an absent
`.github/reeve.yml` is [level 0 of the ladder](../../doctrine/north-star.md#3-the-ladder),
the narrowest authority Reeve defines in code, built from the labels and label
descriptions your repository already has. Reach for it the moment a backlog
arrives in more than one language, or the moment a general model keeps
confusing two labels whose boundary your project drew and nothing in a
model's training could know.

It is also the duty every other reference page on this site points back to for
two mechanics every duty shares: the guardrail stage, and the maintainer
memory. Reading this page once makes the shorter equivalents on
[`translate`](translate.md), [`duplicate`](duplicate.md) and
[`respond`](respond.md) easier to follow.

## Example (minimal workflow YAML)

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
narrowest implicit authority [the ladder](../../doctrine/north-star.md#3-the-ladder)
promises at level 0, built from the labels and label descriptions this
repository already has. Write one when a rung below stops being enough:
[The warrant](../../guides/warrant.md).

Then run it with `dry-run: true` over a month of your own history before you let
it label anything — see [Rehearsing a run](../../guides/dry-run.md).

## Required permissions

**Token:** `issues: write`. `GITHUB_TOKEN` is enough. This is one indivisible
GitHub scope — a token that can label can also comment, close and assign —
which is why the warrant file exists: what this run may actually do is
decided in code, against a file in your repository, and not by what the token
can reach. See [The authority model](../../concepts/authority-model.md).

Grant `contents: write` on the token only if you also grant the `record`
capability below — recording a correction is a commit through GitHub's
Contents API, not a checkout.

**Warrant capability:** `label` is granted by default, at level 0, with no
warrant file at all. Wider effects — `comment`, `close`, `assign`, `record` —
need `.github/reeve.yml` to name them under `capabilities.triage`, and
`apply` on the workflow to name them too; the narrower of the two always
wins. See [the capabilities table](../../guides/warrant.md#capabilities).

## Required inputs

`models` is the only input this action requires — model ids, comma or
newline separated, in preference order. Everything else in the table below
has a default. `api-key` is not required by the schema (a keyless endpoint is
a supported configuration), but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `triage/action.yml` declares. This table is the contract; a
narrower one would only be free to drift from it.

| Input             | Required | Default                     | What it does                                                                                                                                                               |
| ----------------- | -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | no       | `${{ github.token }}`       | Token used to read the thread and apply what the warrant permits.                                                                                                          |
| `number`          | no       | _(empty)_                   | The issue to triage. Defaults to the thread that triggered the workflow.                                                                                                   |
| `base-url`        | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                         |
| `api-key`         | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                            |
| `models`          | **yes**  | —                           | Model ids, comma or newline separated, in preference order. `id = Name` gives a model a display name.                                                                      |
| `screen-models`   | no       | _(empty)_                   | A cheaper roster asked which language a thread is in and whether it is spam or off-topic, before `models` is spent.                                                        |
| `languages`       | no       | `en, vi, zh`                | Languages your contributors write in. Ignored once the warrant's own `languages:` key is written.                                                                          |
| `warrant`         | no       | `.github/reeve.yml`         | Where the taxonomy and permissions live. Missing at this default path is not a failure — see [The warrant](../../guides/warrant.md).                                       |
| `apply`           | no       | `label`                     | What this run may do, comma separated: `label`, `comment`, `close`, `assign`, `record`, or `none`. Narrowed by the warrant, never widened past it.                         |
| `confidence`      | no       | `0.75`                      | How sure the verdict has to be before anything is applied, between 0 and 1.                                                                                                |
| `corrections`     | no       | `.reeve/corrections`        | Directory of `.ndjson` files recording maintainer corrections, shown to the model as examples.                                                                             |
| `min-body-chars`  | no       | `40`                        | How much authored text is enough to be worth a model, in characters. `0` turns the length screen off.                                                                      |
| `max-body-chars`  | no       | `6000`                      | How much of the author's own text one run reads, or `none` for no bound.                                                                                                   |
| `about`           | no       | _(empty)_                   | What this repository is about, in one sentence. Used only by the spam screen.                                                                                              |
| `dry-run`         | no       | `false`                     | Run the whole pipeline, write every output, change nothing.                                                                                                                |
| `sweep`           | no       | `false`                     | Work the backlog instead of the one thread this event named. Cannot combine with `number`.                                                                                 |
| `since`           | no       | _(empty)_                   | The oldest issue a sweep will consider, bounded by when it was opened.                                                                                                     |
| `limit`           | no       | `50`                        | The most issues one sweep will actually process, or `none` for no cap — paging follows real demand either way.                                                             |
| `endpoints`       | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                            |
| `api-keys`        | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated. |
| `request-timeout` | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                           |
| `temperature`     | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                               |

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Installation](../../getting-started/installation.md#more-than-one-endpoint).

**`screen-models` is the whole cost argument.** Spam, a blank body and an
exact repeat are decided by a small model or by no model at all, and a
backlog is mostly those. Leave it empty and everything code did not decide
goes straight to `models` — the documented behaviour of the default, and
simply more expensive. [Cost](../../guides/cost.md) has the arithmetic.

**`confidence` is a number you should measure rather than inherit.** What
`0.75` means for your taxonomy is not what it means for anyone else's,
because the labels are yours. [Measure it](../../development/evaluation.md)
before you move it.

**`record` needs naming in both halves — the file and the workflow.** The
narrower of `reeve.yml`'s `capabilities:` block and the workflow's `apply`
input wins, always, and that rule applies to `record` exactly as it applies
to `label` or `comment`. Granting `record` in the file alone is not enough:
`apply` defaults to `label`, and a run triggered on a labelled event with
`record` left out of `apply` re-triages the thread instead of recording it —
silently, because nothing about that is a misconfiguration the warrant
reader could catch. A trigger this duty would otherwise have recorded, doing
an ordinary verdict instead because `apply` did not name `record`, is
logged as a notice for exactly this reason. The workflow needs both the
trigger and the grant:

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
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          apply: label, record
```

and the file's own half, alongside whatever else `triage` is granted:

```yaml
capabilities:
  triage: [label, record]
```

**Recording writes down what stands, not a fresh verdict.** A labelled or
unlabelled event from a human — never a re-triage, never a bot — commits
that thread's taxonomy-filtered current labels to the store, replacing any
earlier entry for the same thread, through GitHub's Contents API with no
checkout.

## Outputs

Every output `triage/action.yml` declares.

| Output         | Value                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels`       | JSON array of the labels that were applied. `[]` is the ordinary answer on a thread nobody could label, never unset.                                        |
| `proposed`     | JSON array of every label the verdict named, including the ones that were refused.                                                                          |
| `confidence`   | How sure the verdict was, to two decimal places. `0.00` when there was no verdict.                                                                          |
| `language`     | The detected language of the thread, or empty — empty means none of the configured languages wrote it.                                                      |
| `duplicate-of` | The issue number the verdict thinks this repeats, or empty. Reported whether or not `apply` names `close`.                                                  |
| `screened-out` | Why the run stopped before reaching the expensive model — `empty`, `template`, `too-short`, `spam` or `off-topic` — or empty when it did not.               |
| `applied`      | What actually changed, as JSON: `labels`, `commented`, `assigned`, `closed`. `{}` under `dry-run`.                                                          |
| `starved`      | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                        |
| `processed`    | How many issues a sweep actually processed this run. `0` outside `sweep`.                                                                                   |
| `skipped`      | How many issues a sweep found already labelled and left alone. `0` outside `sweep`.                                                                         |
| `remaining`    | Candidates this sweep did not reach. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                  |
| `recorded`     | `true` when a labelled or unlabelled event, with `record` granted, wrote this thread's current labels to the corrections store. `false` on every other run. |

**The difference between `proposed` and `labels` is what the guardrails
stopped.** That is the output to watch while tuning `confidence` or a `not`
field — it is the only place a refused verdict is visible.

## Failure behavior

| What happened                                        | What you get                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| The cheap pass stopped it                            | `screened-out` populated, `labels: []`, **green** — a real answer |
| Every model failed                                   | Warning naming each attempt, empty verdict, **green**             |
| The verdict did not parse                            | Loud warning, empty verdict, nothing applied, **green**           |
| Confidence below the floor                           | `proposed` populated, `labels: []`, **green**                     |
| The warrant does not parse, or names a missing label | **Red**, naming the file and the label                            |
| The thread cannot be read                            | **Red**                                                           |

**The failure mode of this duty is doing nothing.** Every branch above ends
there, and none of them ends in a wrong label.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The rehearsal takes the same path a real run does — the same
screens, the same floor, the same warrant — so what it reports is what a
real run would do. Under `record`, a dry run reports what it would have
written to the corrections store rather than writing it. See
[Rehearsing a run](../../guides/dry-run.md) for the pattern every duty in
Reeve shares.

## Cost

`screen-models` is what makes `triage` cheap at scale: a small model
answers "is this worth the expensive one" before `models` is spent, and
code alone decides an empty body, an unfilled template, or a thread already
carrying this duty's own marker at no model cost at all. A re-triage that
finds nothing changed since its last run's fingerprint costs one API read.
See [Cost](../../guides/cost.md) for the full arithmetic and a worked
estimate across a real month's backlog.

## Security considerations

- **The thread text sits inside a per-call random nonce boundary**, not a
  fixed delimiter, so text written before the call cannot forge the
  boundary that separates it from the prompt.
- **A label the taxonomy does not name is dropped, whatever the model
  returned.** The check runs against the parsed warrant file, never against
  the model's own claim about what it was allowed to do — see
  [Security](../../security/security.md).
- **Unreadable output is an empty verdict**, never a best-effort parse of
  the parts that looked fine — the shapes that fail to parse are the shapes
  an injection produced.
- **What it will never do:** remove a label a maintainer applied; reopen
  what a maintainer closed, or overwrite an assignment; apply a label your
  warrant does not name; edit a title or a body; comment, close or assign
  without that capability being turned on by name. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[The language layer](../../concepts/language-layer.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
