# `translate`

Your contributors write in their language; your maintainers read in theirs. Every
thread carries both, in its own body, with the author's words kept byte-for-byte
and marked as the version the project answers for.

> [!IMPORTANT]
> Reeve is before `v1`. This page is the contract Stage 0 ships against.

## Why the body, and not a comment

A comment is read after the body, and a maintainer who cannot read the body has
already bounced by then. A thread's body is also the one thing GitHub shows in a
search result, a link preview and a project board card.

The cost of that choice is that the duty needs write access to the body — which
is why the author's half is kept byte-for-byte and marked official rather than
merely left nearby.

There is a second-order effect worth naming, because it is the one most people
miss: a contributor who suspects their English is the weakest thing about their
pull request writes less of it. The design note they would have written in their
own language, the caveat they would have flagged, the _"I am not sure this is the
right layer"_ — those go first, and they are the ones review most needs.

## Minimum

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
      - uses: ecoma-io/reeve/translate@v1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          languages: en, vi
```

That writes one block into the issue body carrying every configured language
except the one the issue was written in, below the author's own text and below a
line saying which half is which. Edit the issue and it replaces that block rather
than adding a second one. Edit nothing and the next run recognises its own output
and stops before it spends a single request.

For pull requests, use `pull_request_target` and read
[Installation](../installation.md#pull-requests) first.

## Inputs

`action.yml` in the duty's directory is the contract; a full copy here would only
be free to drift from it. These are the ones worth a word beyond their
description.

| Input               | Default      | Worth knowing                                                                                                         |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `models`            | _required_   | Order is preference, not last resort. Put the model you actually want first.                                          |
| `languages`         | `en, vi, zh` | What to translate **into**. Says nothing about what an author may write in. See [Languages](../languages.md).         |
| `drafts`            | `1`          | Attempts per language, scored deterministically, best published. The quality lever that costs calls instead of money. |
| `judge-models`      | _empty_      | A panel, not a fallback list. Independent of `drafts` — drafts with no judge is a perfectly good setting.             |
| `max-body-chars`    | `6000`       | Bounds what is **read from the thread**, not what the model answers. Measured against the author's half only.         |
| `translate-replies` | `false`      | Off because the ceiling is real. See below.                                                                           |
| `show-attribution`  | `none`       | How much of the machinery the published block names. See below.                                                       |
| `dry-run`           | `false`      | Whole pipeline, every output, nothing written.                                                                        |

**`max-body-chars`** deserves the extra sentence: when the body is longer, the
tail is left behind and the published block says so rather than pretending it
translated everything. Raising the limit later translates the rest, because the
fingerprint is over the part that was actually read.

## Outputs

| Output               | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| `source-language`    | The detected code, or empty — empty means none of your configured languages wrote it. |
| `translated`         | JSON array of the codes that were published.                                          |
| `skipped`            | JSON array of the codes no model could translate this run.                            |
| `replies-translated` | How many replies got a translation. `0` when `translate-replies` is off.              |

The first three describe the thread's own body. A reply has its own source
language and its own skipped set, so folding a dozen of those into one array would
produce a value no workflow could act on — replies report the one thing answerable
across all of them.

All four are written on every path that reaches an answer, including the ones
that answer "nothing", so a step branching on `skipped` reads `[]` on the run
where everything worked, never an unset output:

```yaml
- id: translate
  uses: ecoma-io/reeve/translate@v1
  with:
    models: gpt-5-mini

- if: steps.translate.outputs.skipped != '[]'
  run: echo "::warning::no translation for ${{ steps.translate.outputs.skipped }}"
```

That `if` is the whole reason `skipped` is an output rather than only a log line:
**a language nobody could translate does not fail the job.** The languages that
worked are worth publishing, and a run that went red over one of them would take
the others down with it.

## Naming the model that translated

A published section names its language and, by default, stops there. The two
audiences want opposite things from the same block: a contributor reading a
thread in their own language did not ask which model wrote it, and the model id is
noise in every notification email the thread sends. A maintainer deciding whether
a provider is worth keeping wants to know which model wrote the bad sentence — in
the thread, rather than in a workflow log that expires.

| Level    | What a section shows                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `none`   | **English** — the language, and nothing else. The default.                                                                        |
| `model`  | **English** · `gpt-5-mini` — plus the model that wrote the winning draft.                                                         |
| `detail` | The above, plus a line under the translation: its score, how many drafts it beat, what settled the ranking, how each judge voted. |

The detail line sits _below_ the translation, because a reader who expanded a
section came for the text. A run with no contest to report renders no line: one
draft that no judge voted on won by being the only candidate, and "decided by
score" would dress that up as a verdict.

This setting is deliberately **not** part of the fingerprint. Turning it on
decides how the next thread reads; it is not a mandate to re-spend a translation
budget on every old one.

## Translating the replies too

An issue body is where a problem is stated; the answer is usually four replies
down.

```yaml
on:
  issues:
    types: [opened, edited]
  issue_comment:
    types: [created, edited]

# …
with:
  translate-replies: true
```

**Each reply is detected on its own**, not inherited from the thread. A
Vietnamese issue collects English answers, and the reply above a reply says
nothing about what language it is in — so a reply already written in one of your
target languages is left out of that one, exactly as the body is.

**Each reply carries its own fingerprint**, which is what makes this affordable
rather than alarming. A run over a thread with forty replies re-reads all forty
and spends a request only on the ones whose text actually changed. The ordinary
case — one new comment on a thread translated last week — costs one listing, one
detection and one translation, and rewrites nothing else.

It is off by default because the ceiling is real: every reply, times every
language it is missing. Turn it on where the discussion is where the answers
live; leave it off where the issue body is the thing worth reading.

Two limits to know first. One run reads the most recent hundred replies and warns
when there were more, so a very long thread is translated from its newest end
rather than silently in part. And **review comments on a pull request's diff are
deliberately not included** — a translation appended to a line comment moves the
review conversation away from the line it is about.

## What the published block looks like

```markdown
<the author's own text, byte for byte, untouched>

<!-- reeve:translate … -->

---

_The text above is the original and the version this project answers for.
Everything below is a machine translation._

<details><summary><b>English</b></summary>

<the translation>

</details>
```

Everything above the marker is kept on every run, so everything GitHub reads out
of a body — `Fixes #42`, a task list, a `Co-authored-by:` trailer, an issue
template's headings — keeps working, and the author's references keep linking and
notifying.

A re-run splits at the marker, discards everything after it, and writes a fresh
block. There is only ever one, and last run's translations are never mistaken for
something to translate.

Delete the block and the next run regenerates it. That is the supported way to
force a retranslation.

## Failure, and what it looks like

| What happened                                   | What you get                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| One language had no working model this run      | Warning, that code in `skipped`, the others published, **green** |
| No language worked                              | Warning per language, `translated: []`, **green**                |
| The thread cannot be read                       | **Red**                                                          |
| The configuration is broken                     | **Red**, naming the input                                        |
| The event names no thread and `number` is empty | **Red**, naming the event                                        |

A skipped language is not in the fingerprint, so the next run tries it again
rather than reading its own claim and stopping.

## What it will not do

- **Translate the title.** Titles are short, load-bearing and searched on; a
  block cannot go there and a rewrite is off the table.
- **Rewrite the author's text.** Ever, under any input.
- **Verify that the translation is good.** Quality is _contained_ — the original
  is kept, marked official, never replaced — not guaranteed. That is the honest
  claim, and it is the whole reason for the marking.
