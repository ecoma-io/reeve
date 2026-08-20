<!-- source of truth: duplicate/action.yml -->

# `duplicate`

_Full contract for the `duplicate` duty — every input, every output, checked against `duplicate/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

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

## When to use it

A backlog large or old enough that "does this already exist" is no longer
answerable by scrolling. Unlike `triage` and `translate`, this duty starts
with **no** capability granted — read [Required permissions](#required-permissions)
before wiring it into a trigger that expects it to post on day one.

## Example (minimal workflow YAML)

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
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/duplicate@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

This alone reports and posts nothing. Read `duplicate-of` and `score` off
the job summary to see what it would have proposed before granting anything.

## Required permissions

**Token:** `issues: write`. `GITHUB_TOKEN` is enough — it reads the thread,
lists the corpus, and posts the one comment this duty may write.

**Warrant grant:** unlike every other duty in Reeve, `duplicate` has
**no** cheapest-reversible-action default. `triage` labels for free;
`translate` writes a block for free. A comment naming the wrong thread as a
duplicate is a claim posted in public about somebody else's report, not
something undone with one click — so there is no default worth reaching
for. The grant has to be written explicitly before this duty ever writes to
a thread:

```yaml
# .github/reeve.yml
duties:
  duplicate: [comment]
```

Without it, the duty still reports `duplicate-of` and `score` and touches
nothing. `close` exists as a capability name, mirrored from
`triage`, for a future where this duty might close a confirmed duplicate
itself — off by default, undocumented as a setting to turn on, and this duty
never checks for it today. `duplicate-of` is what a workflow reads to close
a thread itself, under its own authority, right now. The `duties:` block is
the whole authority — nothing on the workflow can widen it. See
[the duties table](../../guides/warrant.md#duties).

## Required inputs

`models` is the only input this action requires — used for detection, the
pivot bridge, and the verdict alike. Everything else has a default. `api-key`
is not required by the schema, but almost every real provider needs one —
see [Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `duplicate/action.yml` declares.

| Input              | Required | Default                     | What it does                                                                                                                                                                                                                                                          |
| ------------------ | -------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`     | no       | `${{ github.token }}`       | Token used to read the thread, list the corpus, and post the one comment this duty may write.                                                                                                                                                                         |
| `number`           | no       | _(empty)_                   | The issue to check. Defaults to the thread that triggered the workflow.                                                                                                                                                                                               |
| `base-url`         | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                                                                                                                    |
| `api-key`          | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                                                                                                                       |
| `models`           | **yes**  | —                           | Model ids, comma or newline separated, in preference order. Used for detection, the pivot bridge, and the verdict. One rotation chain — this duty has no judge panel and no `judge-models` input; the model asked for the verdict is the first of these that answers. |
| `warrant`          | no       | `.github/reeve.yml`         | Where the permissions live. Grants nothing to this duty until `duplicate: [comment]` is written into it. Missing at this default path is not a failure.                                                                                                               |
| `candidates`       | no       | `5`                         | How many of the closest-ranked open threads reach the verdict.                                                                                                                                                                                                        |
| `corpus-limit`     | no       | `none`                      | How many open threads the ranking runs against at all. `none` is every open issue.                                                                                                                                                                                    |
| `corpus-since`     | no       | _(empty)_                   | The oldest thread the corpus considers, bounded by when it was opened. A cost control, not a correctness setting.                                                                                                                                                     |
| `max-body-chars`   | no       | `6000`                      | How much of a body — the thread and every candidate alike — is indexed and put to the verdict. `none` reads the whole thing.                                                                                                                                          |
| `confidence`       | no       | `0.75`                      | How sure the model's verdict has to be before the comment is posted, between 0 and 1.                                                                                                                                                                                 |
| `show-attribution` | no       | `none`                      | How much of the machinery the posted comment names: `none`, `model`, or `detail`.                                                                                                                                                                                     |
| `dry-run`          | no       | `false`                     | Run the whole pipeline, write every output, change nothing.                                                                                                                                                                                                           |
| `sweep`            | no       | `false`                     | Check the backlog instead of the one thread this event named. No idempotent skip — see below. Cannot combine with `number`.                                                                                                                                           |
| `since`            | no       | _(empty)_                   | The oldest issue a sweep will consider, bounded by when it was opened. Bounds which threads the sweep checks, not the corpus each one is checked against.                                                                                                             |
| `limit`            | no       | `50`                        | The most issues one sweep will actually process, or `none` for no cap — paging follows real demand either way.                                                                                                                                                        |
| `endpoints`        | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                                                                                                                       |
| `api-keys`         | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated.                                                                                            |
| `request-timeout`  | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                                                                                                                      |
| `temperature`      | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                                                                                                                          |

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Providers and the runtime](../../guides/providers.md#more-than-one-endpoint).

**A published block is stripped out of every body before it is indexed or
judged** — the thread's own and every candidate's alike, cut at the first
marker of any kind. This keeps ranking measuring one thing — what the two
authors actually wrote — and leaves cross-language recall to the pivot
bridge on purpose, rather than as a side effect of which threads a
`translate` workflow happened to reach first.

**No idempotent skip in `sweep`.** `triage`'s sweep can tell a taxonomized
thread from an untaxonomized one by reading its labels, a free fact. Whether
a thread is a duplicate is exactly the question every thread in the walk is
asked, and there is no cheaper fact standing in for the answer — so every
open issue a sweep reaches is processed, not skipped.

**The verdict's `duplicate_of` is checked for membership in the exact
shortlist the verdict model was shown, twice** — once inside the parser, once again
where the number is about to become an output or a comment. A thread body
cannot steer a verdict at a thread the ranking never surfaced by claiming
"this duplicates #999" inside its own text.

## Outputs

Every output `duplicate/action.yml` declares.

| Output         | Value                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `duplicate-of` | The issue number the verdict thinks this repeats, or empty. Unset on a `sweep` run.                                                                                |
| `score`        | The verdict's own confidence, to two decimal places. `0.00` when there was no verdict at all. Distinct from the `confidence` input. Unset on a `sweep` run.        |
| `language`     | The detected language of the thread, or empty for none of the configured ones. Unset on a `sweep` run.                                                             |
| `commented`    | `true` when this run leaves its comment standing — posted, replaced, or already there unchanged. `false` on every other single-thread run. Unset on a `sweep` run. |
| `starved`      | `true` when every model in `models` failed on capacity this run. Weather, not a failure.                                                                           |
| `processed`    | How many issues a sweep processed. `0` outside `sweep`.                                                                                                            |
| `remaining`    | Candidates a sweep did not reach. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                            |

**`score` and `confidence` are not the same axis.** `score` is what the
model actually answered; `confidence` is the floor it has to clear before
anything is posted. A workflow reading `score` off a run under the floor
sees a real number, not zero.

## Failure behavior

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

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The rehearsal takes the same path a real run does — the same
ranking, the same floor, the same warrant — so what it reports is what a
real run would do. `commented` still reads `false` under a dry run, since
nothing was actually left standing on the thread; the job summary spells
out what would have happened instead. See
[Rehearsing a run](../../guides/dry-run.md).

## Cost

`corpus-limit`/`corpus-since` bound how large the ranked index is, and
`candidates` bounds how many of that index reach an expensive model — the
lexical rank itself costs no model call. The pivot bridge is only spent when
the free script/profile pass finds a candidate the thread's own language
could never match. See [Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **The thread text sits inside a per-call random nonce boundary**, not a
  fixed delimiter. See [Security](../../security/security.md).
- **A verdict naming anything outside its own shortlist is refused**, the
  same as an answer that failed to parse — never resolved against the wider
  repository after the fact. A thread body cannot forge a duplicate target
  the ranking never surfaced.
- **The rationale sentence is model prose, not a second source of truth.**
  Any `#N` it writes that is not the duplicate itself is fenced as `` `#N` ``
  before posting, so GitHub never autolinks a stray cross-reference onto an
  unrelated thread the model happened to name in passing.
- **What it will never do:** close, reopen, label or assign anything; edit a
  title or a body; post more than one comment per thread; post at all
  without the warrant granting `comment`. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[The language layer](../../concepts/language-layer.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
