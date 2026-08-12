<!-- source of truth: translate/action.yml -->

# `translate`

_Full contract for the `translate` duty — every input, every output, checked against `translate/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

Your contributors write in their language; your maintainers read in theirs. Every
thread carries both, in its own body, with the author's words kept byte-for-byte
and marked as the version the project answers for.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

Closing the gap between the language a contributor writes in and the language
a maintainer reads in — in the thread's own body, not a comment underneath
it, because a comment is read after the body and a maintainer who cannot read
the body has already bounced by then. The author's half is kept byte-for-byte
and marked as the version the project answers for; nothing is rewritten,
only added below.

**What it is explicitly not for:** improving, correcting or shortening what a
contributor wrote. Quality is _contained_ — the original is kept, marked
official, never replaced — not guaranteed.

## When to use it

Any repository whose contributors and whose maintainers do not share one
language. `edit-body` is granted by default at [level 0 of the
ladder](../../doctrine/north-star.md#3-the-ladder) — no warrant file needed to
start. There is a second-order effect worth knowing before you decide this
duty is not for you: a contributor who suspects their English is the weakest
thing about their pull request writes less of it — the design note, the
caveat, the _"I am not sure this is the right layer"_ — and those are usually
the ones review needs most.

## Example (minimal workflow YAML)

```yaml
name: Translate

on:
  issues:
    types: [opened, edited]

concurrency:
  group: reeve-translate-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  translate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/translate@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          languages: en, vi
```

That writes one block into the issue body carrying every configured language
except the one the issue was written in, below the author's own text and
below a line saying which half is which. Edit the issue and it replaces that
block rather than adding a second one; edit nothing and the next run
recognises its own output and stops before it spends a single request.

For pull requests, use `pull_request_target` and read
[Installation](../../getting-started/installation.md#pull-requests) first.

## Required permissions

**Token:** `issues: write` on the token used against issues, `pull-requests:
write` against pull requests — `GITHUB_TOKEN` is enough for either, and is
also what gives the run recursion prevention: a body this duty edits does not
start another `GITHUB_TOKEN`-triggered run. A PAT or a GitHub App
installation does not get that suppression from the platform, so the
fingerprint in the published marker is what stops the loop instead.

**Warrant capability:** `edit-body` is granted by default, at level 0, with
no warrant file at all. Once a `capabilities:` block is written into
`.github/reeve.yml`, the enumeration becomes total: leaving `translate` out
of it grants this duty nothing, and the run says so rather than guessing. See
[the capabilities table](../../guides/warrant.md#capabilities).

## Required inputs

`models` is the only input this action requires — model ids, comma or
newline separated, in preference order. Everything else in the table below
has a default. `api-key` is not required by the schema (a keyless endpoint is
a supported configuration), but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `translate/action.yml` declares.

| Input               | Required | Default                     | What it does                                                                                                                                                               |
| ------------------- | -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`      | no       | `${{ github.token }}`       | Token used to read and write the thread. Also what gives recursion prevention on `GITHUB_TOKEN`.                                                                           |
| `number`            | no       | _(empty)_                   | The issue or pull request to translate. Defaults to the thread that triggered the workflow.                                                                                |
| `base-url`          | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                         |
| `api-key`           | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                            |
| `models`            | **yes**  | —                           | Model ids, comma or newline separated, in preference order. `id = Name` gives a model a display name.                                                                      |
| `languages`         | no       | `en, vi, zh`                | What to translate **into**. Says nothing about what an author may write in. Ignored once the warrant's own `languages:` key is written.                                    |
| `warrant`           | no       | `.github/reeve.yml`         | Where `edit-body` is granted, and optionally where `languages` lives instead. Missing at this default path is not a failure.                                               |
| `drafts`            | no       | `1`                         | Attempts per language, each scored deterministically, best published. The quality lever that costs calls instead of money.                                                 |
| `judge-models`      | no       | _(empty)_                   | A panel asked which draft reads best. Seats, not a fallback list — see below.                                                                                              |
| `max-body-chars`    | no       | `6000`                      | How much of the author's own text one run reads, or `none` for no bound.                                                                                                   |
| `translate-replies` | no       | `false`                     | Also translate the thread's replies, each detected and fingerprinted on its own.                                                                                           |
| `show-attribution`  | no       | `none`                      | How much of the machinery the published block names: `none`, `model`, or `detail`.                                                                                         |
| `dry-run`           | no       | `false`                     | Run the whole pipeline, write every output, change nothing.                                                                                                                |
| `sweep`             | no       | `false`                     | Work the backlog instead of the one thread this event named. Cannot combine with `number`.                                                                                 |
| `since`             | no       | _(empty)_                   | The oldest thread a sweep will consider, bounded by when it was opened.                                                                                                    |
| `limit`             | no       | `50`                        | The most threads one sweep will actually process, or `none` for no cap — paging follows real demand either way.                                                            |
| `endpoints`         | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                            |
| `api-keys`          | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated. |
| `request-timeout`   | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                           |
| `temperature`       | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                               |

**`max-body-chars`** bounds what is read from the thread, not what the model
answers. When the body is longer, the tail is left behind and the published
block says so rather than pretending it translated everything. Raising the
limit later translates the rest, because the fingerprint is over the part
that was actually read.

Whatever `max-body-chars` reads, it is never sent to a model in one piece.
The body is split into chunks a few thousand characters wide before drafting
starts, each translated in its own draft-and-judge pass, one at a time. A
fenced code block is never split across two chunks — a chunk that would cut
one in half is grown past the budget instead — and a chunk that is entirely
code is reused verbatim rather than spent on an answer already known: the
code inside it would have to come back unchanged regardless of what a model
said. This is what makes `max-body-chars: none` affordable at all: without
chunking, an unbounded body would be one request of unbounded size instead of
several ordinary ones. **One chunk failing skips the whole language**,
exactly as [Failure behavior](#failure-behavior) already describes for a
language no model could translate — a translation missing its middle
paragraph is worse than no translation this run, and the next run tries
again in full. The fingerprint is over the source text, never over where the
chunk boundaries happened to fall, so the same body always fingerprints the
same way regardless of `max-body-chars`.

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Installation](../../getting-started/installation.md#more-than-one-endpoint).

**`judge-models` has two levels, and they mean opposite things.** `models`
is one rotation chain: the first model that answers is used and the rest are
spare. `judge-models` is not that — comma or newline separates **seats**,
and every seat is asked:

```yaml
judge-models: |
  fast-model | fast-model-backup
  careful-model
  third-model | third-backup | third-last-resort
```

`|` separates the models **inside** one seat, and they are that seat's
availability rather than more votes: the second is asked only when the first
could not deliver the seat's vote, and the seat casts one ballot however far
down it had to go. Two rules keep a plurality honest: a model that has
already voted, or already failed, is skipped by every later seat — so `a | b`
and `b | c` do not both land on `b` the morning `a` is rate limited — and a
seat that cannot be filled casts nothing and says so in the log.

**Naming a model with `=`** keeps an id private: `models: openai/gpt-5-mini
= House model` shows "House model" everywhere a person reads instead of the
id. The name is cut at the first `=`, since an id is never an assignment and
a name may well contain one. This is presentation, not masking — put ids in
secrets if they are secret.

**The run report** is written to the job's own summary, not the thread: what
was translated (model, score, votes), what was not and why, and cost —
requests and tokens, by stage and by model. `show-attribution` stays `none`
by default because that detail belongs to the person who configured the run,
not to everyone the thread notifies.

## Outputs

Every output `translate/action.yml` declares.

| Output               | Value                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-language`    | The detected language code of the thread's body, or empty — empty means none of the configured languages wrote it.                                          |
| `translated`         | JSON array of the language codes that were published.                                                                                                       |
| `skipped`            | Outside `sweep`: JSON array of the language codes no model could translate this run. Under `sweep`: a count of threads already carrying this duty's marker. |
| `replies-translated` | How many replies got a translation. `0` when `translate-replies` is off.                                                                                    |
| `starved`            | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                        |
| `processed`          | How many threads a sweep actually processed this run. `0` outside `sweep`.                                                                                  |
| `remaining`          | Candidates this sweep did not reach. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                  |

All are written on every path that reaches an answer, including the ones
that answer "nothing" — a step branching on `skipped` reads `[]` on the run
where everything worked, never an unset output:

```yaml
- id: translate
  uses: ecoma-io/reeve/translate@v0.1
  with:
    models: gpt-5-mini

- if: steps.translate.outputs.skipped != '[]'
  run: echo "::warning::no translation for ${{ steps.translate.outputs.skipped }}"
```

That `if` is the whole reason `skipped` is an output rather than only a log
line: a language nobody could translate does not fail the job.

## Failure behavior

| What happened                                   | What you get                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| One language had no working model this run      | Warning, that code in `skipped`, the others published, **green** |
| No language worked                              | Warning per language, `translated: []`, **green**                |
| The thread cannot be read                       | **Red**                                                          |
| The configuration is broken                     | **Red**, naming the input                                        |
| The event names no thread and `number` is empty | **Red**, naming the event                                        |

A skipped language is not in the fingerprint, so the next run tries it
again rather than reading its own claim and stopping.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The block that would have been published is printed to the log
instead, taking the same path a real run does. See
[Rehearsing a run](../../guides/dry-run.md) for the pattern every duty in
Reeve shares.

## Cost

Text that carries no prose — a stack trace, a log paste, a diff, a bare URL
— is checked before detection and costs nothing, because detection would
honestly answer `unknown` for it, and `unknown` means "translate into all of
them," the most expensive answer available on the one input where no answer
is worth anything. A thread already carrying this duty's own marker with an
unchanged fingerprint costs one read. `drafts` and `judge-models` are the
levers that spend more for a better translation; both default to the
cheapest setting. See [Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **The thread text sits inside a per-call random nonce boundary**, not a
  fixed delimiter, so text written before the call cannot forge the boundary
  that separates it from the prompt. See
  [Security](../../security/security.md).
- **The author's own text is never rewritten**, under any input — only kept
  and appended to. A prompt-injection attempt embedded in a thread body can
  at worst distort its own translation, never the original the project
  answers for.
- **Everything above the marker survives every re-run**, so `Fixes #42`, a
  task list, or a `Co-authored-by:` trailer keep working and keep notifying
  the people they always would have.
- **What it will never do:** translate the title; rewrite the author's text;
  verify that a translation is good — quality is contained, not guaranteed.
  See [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The language layer](../../concepts/language-layer.md) ·
[The authority model](../../concepts/authority-model.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
