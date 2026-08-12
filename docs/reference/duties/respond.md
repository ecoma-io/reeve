<!-- source of truth: respond/action.yml -->

# `respond`

_Full contract for the `respond` duty — every input, every output, checked against `respond/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

A stranger opens an issue and, for a while, nobody answers. `respond` writes the
first reply — grounded in what this project already knows, in the language the
thread was opened in — and then it is done. It answers once and never
converses. It is not a chatbot.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for, and what it will never become

The gap between "a stranger filed a report" and "a maintainer had time to
look at it" is where a project loses people — not because the report was
bad, but because silence reads as indifference. `respond` closes that gap
with a single, visibly machine-written reply: an acknowledgement, grounded
in corrections this project has already made, so the second sentence is not
a template.

**It is not a chatbot, and this is not a soft claim.** [The north
star](../../doctrine/north-star.md#8-non-goals) says Reeve does a duty and
stops; for `respond` that means one reply, ever, per thread. It does not
answer follow-up comments, does not defend its own reply, and does not
notice being disagreed with — there is no second turn, and no input adds
one. A human's own reply, whenever it arrives, is the actual first response
as far as this duty is concerned from then on; `respond` has already said
its one thing and is not listening for what comes after.

**It is the top rung of [the ladder](../../doctrine/north-star.md#3-the-ladder),
and it is the only duty with no cheap default.** `triage` may `label` and
`translate` may `edit-body` before you write a single line of warrant — both
are one click to undo. There is no equally cheap version of "post a comment
that reads, to everyone downstream, as though this project answered." So
`respond` is granted **nothing** until a warrant names it, whether the file
is missing entirely or merely silent about this duty.

## When to use it

A repository whose issue volume outpaces how quickly a maintainer can say
something back. Grant nothing at first — the default warrant already runs
this duty with `comment` withheld, so a workflow can read `respond-text` off
a draft on real issues before deciding to let it post.

## Example (minimal workflow YAML)

```yaml
name: Respond

on:
  issues:
    types: [opened]

concurrency:
  group: reeve-respond-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  respond:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/respond@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

That alone drafts a reply and posts nothing, because the default warrant
grants `respond` no capability at all. The job summary is where to actually
read it — the fenced draft sits right under the verdict on every run that
withheld it, so watching a few real issues never means digging through
`respond-text` by hand. Grant `comment` once you trust it.

## Required permissions

**Token:** `issues: write`. `GITHUB_TOKEN` is enough — this is one
indivisible GitHub scope, a token that can comment can also label, close and
assign, which is why what this run may actually do is decided in code
against the warrant file rather than by what the token can reach.

**Warrant capability:** nothing else in Reeve needs this much ceremony, and
that is deliberate. Both halves have to agree, and the narrower one wins:

```yaml
# .github/reeve.yml
capabilities:
  respond: [comment]
```

```yaml
# the workflow
with:
  apply: comment
```

Leave either one silent about `respond` and the run drafts, reports, and
posts nothing — a real answer, not a misconfiguration, and the job summary
says so. There is no smaller grant than `comment`; `respond` has exactly one
capability to give. See [the capabilities table](../../guides/warrant.md#capabilities).

## Required inputs

`models` is the only input this action requires — the roster that writes
drafts, in preference order. Everything else has a default. `api-key` is not
required by the schema, but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `respond/action.yml` declares.

| Input             | Required | Default                     | What it does                                                                                                                     |
| ----------------- | -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | no       | `${{ github.token }}`       | Token used to read the thread and post the reply.                                                                                |
| `number`          | no       | _(empty)_                   | The issue to answer. Defaults to the thread that triggered the workflow. Meant to run on `issues: opened`.                       |
| `base-url`        | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                               |
| `api-key`         | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                  |
| `models`          | **yes**  | —                           | Model ids, comma or newline separated, in preference order. The roster that writes drafts.                                       |
| `judge-models`    | no       | _(empty)_                   | A panel that picks the best draft. Seats, not a fallback list — same grammar as [`translate`'s](translate.md#configuration).     |
| `drafts`          | no       | `1`                         | Attempts per run, scored and judged. A first reply is worth more than one attempt.                                               |
| `languages`       | no       | `en, vi, zh`                | Languages your contributors write in. The first named is the pivot for bridging a correction across a language gap.              |
| `warrant`         | no       | `.github/reeve.yml`         | Where `comment` is granted. A missing file grants `respond` nothing, same as one that is silent about it.                        |
| `apply`           | no       | `none`                      | `comment`, or `none`. The narrower of this and the warrant wins, always.                                                         |
| `confidence`      | no       | `0.75`                      | How sure the winning draft has to be before it is posted, between 0 and 1.                                                       |
| `guidance`        | no       | `.github/reeve-guidance.md` | A maintainer-authored file: tone, what this project never promises, where to point an unanswerable question.                     |
| `screen-models`   | no       | _(empty)_                   | The spam/off-topic check, same one `triage` runs. Empty turns it off.                                                            |
| `about`           | no       | _(empty)_                   | One sentence on what this repository is about. Used only by the off-topic half of `screen-models`' check.                        |
| `corrections`     | no       | `.reeve/corrections`        | The memory store. Empty is the cold-start case and works.                                                                        |
| `max-body-chars`  | no       | `6000`                      | How much of the author's own text one run reads, or `none` for no bound.                                                         |
| `dry-run`         | no       | `false`                     | Run the whole pipeline, write every output, post nothing.                                                                        |
| `endpoints`       | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.  |
| `api-keys`        | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Registered as a secret in full before anything is parsed.  |
| `request-timeout` | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused. |
| `temperature`     | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                     |

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Installation](../../getting-started/installation.md#more-than-one-endpoint).

**`confidence` is a floor worth measuring, not inheriting.** [Measure
it](../../development/evaluation.md) against your own drafts before you move
it — what `0.75` means for one project's tolerance for a slightly-off first
reply is not what it means for another's.

**`guidance` is read from the checkout and trusted.** It is your own
maintainers' text, reviewed like any other change, so it goes into the
model's instructions unfenced — the same shelf the taxonomy sits on. The
thread it is answering is a stranger's words and stays behind the
sanitising boundary regardless. A repository that has not written the file
yet is the cold start, not a misconfiguration.

**Two code guards enforce "only once," and neither is an input.** A human's
own reply — read oldest first — stops the run before a draft is even
written. This duty's own marker, found the same walk, stops a rerun on an
issue it already answered, however the issue is edited afterward: the
marker answers a _thread_, not a body version. Neither guard is
configurable, because an input can be misconfigured and these two cannot
be. An issue opened by a bot account also gets no reply — a "first reply"
answers a person.

## Outputs

Every output `respond/action.yml` declares.

| Output         | Value                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responded`    | `true` when a reply was posted this run. `false` on every other path, including one that drafted an answer but the floor, the warrant, `apply`, or `dry-run` withheld it. |
| `language`     | The detected language of the thread, or empty — empty means none of the configured languages wrote it. The reply, when there is one, is written in this language.         |
| `respond-text` | The winning draft's own text, already sanitised, whether or not it was posted. Written on every run that reached a verdict. Empty on a run that stopped before drafting.  |
| `starved`      | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                                      |

**`respond-text` is the output that matters most for a repository still
tuning `confidence`.** It is populated on every run that reached a verdict,
whether or not the floor or the warrant let the reply reach the thread, so a
workflow can post a draft to a review queue instead of the issue while you
watch how it does.

## Failure behavior

| What happened                                           | What you get                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| The screen stopped it                                   | `respond-text` empty, `responded: false`, **green** — a real answer |
| Confidence below the floor                              | `respond-text` populated, `responded: false`, **green**             |
| `comment` not granted                                   | `respond-text` populated, `responded: false`, **green**             |
| Every model failed on capacity                          | `starved: true`, whatever survived, **green**                       |
| A human, a bot author, or an existing marker stopped it | `responded: false`, no draft written, **green**                     |
| The warrant does not parse                              | **Red**, naming the file                                            |
| The thread cannot be read                               | **Red**                                                             |

**The failure mode of this duty is silence, never a wrong or a doubled
reply.** Every branch above ends without posting, or posts exactly once.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and posts
nothing. The reply that would have been posted is printed to the log and
still written to `respond-text`. See
[Rehearsing a run](../../guides/dry-run.md).

## Cost

`drafts` and `judge-models` are the levers that spend more for a better
first reply — a first reply is read before anything else this project says,
so this is one duty where spending more per thread is often worth it. The
screen (`screen-models`) and the two code guards stop a run before a single
expensive request wherever a reply would have been wasted: a bot-opened
issue, a thread already answered, a thread already carrying a human reply.
See [Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **The thread text sits inside a per-call random nonce boundary**, not a
  fixed delimiter. See [Security](../../security/security.md).
- **A draft that did not parse as a draft is dropped, never salvaged.**
- **The notice that this reply is machine-written is unconditional and
  unstrippable.** There is no input, no `show-attribution`-style setting,
  that renders this reply without it — the one place in this project a
  reader cannot afford to guess whether they are reading a maintainer or a
  model.
- **What it will never do:** post a second reply to a thread it already
  answered; reply to a comment, argue a point, or otherwise hold a
  conversation; answer over a human who got there first; answer a
  bot-opened issue or a thread the screen classified as spam or off-topic;
  post without `comment` granted by both the warrant and `apply`; hide,
  soften, or make removable the machine-written notice. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[The language layer](../../concepts/language-layer.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
