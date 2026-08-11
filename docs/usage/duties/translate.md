# `translate`

Your contributors write in their language; your maintainers read in theirs. Every
thread carries both, in its own body, with the author's words kept byte-for-byte
and marked as the version the project answers for.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

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
      - uses: ecoma-io/reeve/translate@v0.1
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
| `models`            | _required_   | Order is preference, not last resort. Put the model you actually want first. `id = Name` names one. See below.        |
| `languages`         | `en, vi, zh` | What to translate **into**. Says nothing about what an author may write in. See [Languages](../languages.md).         |
| `drafts`            | `1`          | Attempts per language, scored deterministically, best published. The quality lever that costs calls instead of money. |
| `judge-models`      | _empty_      | Seats, not a fallback list — every seat is asked. `\|` inside a seat is that seat's fallback. See below.              |
| `max-body-chars`    | `6000`       | Bounds what is **read from the thread**, not what the model answers. Measured against the author's half only.         |
| `translate-replies` | `false`      | Off because the ceiling is real. See below.                                                                           |
| `show-attribution`  | `none`       | How much of the machinery the published block names. See below.                                                       |
| `dry-run`           | `false`      | Whole pipeline, every output, nothing written.                                                                        |

**`max-body-chars`** deserves the extra sentence: when the body is longer, the
tail is left behind and the published block says so rather than pretending it
translated everything. Raising the limit later translates the rest, because the
fingerprint is over the part that was actually read.

### `judge-models` has two levels, and they mean opposite things

`models` is one rotation chain: the first model that answers is used and the rest
are spare. `judge-models` is not that, and the difference is the whole reason a
panel means anything.

```yaml
judge-models: |
  fast-model | fast-model-backup
  careful-model
  third-model | third-backup | third-last-resort
```

Comma or newline separates **seats**. Every seat is asked, so the above is three
votes and three requests per language. `|` separates the models **inside** one
seat, and they are that seat's availability rather than more votes: the second
is asked only when the first could not deliver the seat's vote, and the seat
casts one ballot however far down it had to go.

A seat rotates past a model that answered as readily as one that did not. A judge
asked for a single digit that replies "both are excellent" has spent a request
and produced nothing, which is exactly what the next model in the seat is for.

Two rules keep a plurality honest:

- **One model, one vote.** A model that has already voted, or already failed, is
  skipped by every later seat. Without it, `a | b` and `b | c` both land on `b`
  on the morning `a` is rate limited, and a majority counted over one model
  answering twice is not a majority.
- **A seat that cannot be filled casts nothing**, and says so in the log. Three
  configured seats quietly becoming two is precisely the thing you want told.

Nothing here is required. `judge-models: model-a` is one seat with no fallback,
which is what a plain list has always meant and remains a perfectly good setting.
So is leaving it empty.

### Naming a model, so the id never has to be public

A model id is a provider's identifier, and on a repository that routes through a
gateway it is routinely something a maintainer keeps to themselves. `=` gives one
a name, and everything a person reads — the published block, every warning in the
log — uses the name instead:

```yaml
models: |
  openai/gpt-5-mini = House model
  anthropic/claude-haiku-4-5 = Backup
judge-models: |
  fast-model | fast-model-backup = Quick reader
  careful-model = Careful reader
```

The id is what the provider is asked for and is all the id is ever used for. A
model nobody named shows its id, which is the old behaviour and is fine when the
id is not a secret.

Two things are worth knowing:

- **A name belongs to the seat, not to the model that happens to fill it.**
  `fast-model | fast-model-backup = Quick reader` is one voter called
  `Quick reader` whichever of the two answered — which is the honest rendering,
  because the panel heard one vote from one seat.
- **The name is cut at the first `=`.** An id is a path and a version and never
  an assignment; a name is prose somebody wrote and may well contain one.

Naming is presentation and nothing else. It is not masking: put the ids in
secrets if they are secret, and this decides what a reader sees instead of them.

### The run report

Every run writes a page to the job's own summary — the tab beside the log, not
the log itself — with three things on it:

- **What was translated**, per text and per language: the model that wrote the
  winning draft, its score, how many drafts it beat, and how each judge seat
  voted.
- **What was not**, and why: a language no model could translate, a body that
  was empty, a thread whose fingerprint already matched.
- **What it cost**: requests, prompt tokens and completion tokens, broken down
  by stage and by model, with a total.

This is deliberately not in the thread. A contributor opened the thread to read
an issue, and a token count in the body is noise in a notification email sent to
everyone watching it. `show-attribution` stays `none` by default for exactly
that reason — the detail is on the page belonging to the person who configured
the run.

Two honesty rules, so the numbers can be checked against an invoice:

- **Nothing is estimated.** Token counts come from the provider's own `usage`
  field. Many OpenAI-compatible gateways send none, and a run against one of
  those reports its requests and says how many came back uncounted, rather than
  filling the gap with arithmetic.
- **A failed request is in the total.** Rotating past a model that was out of
  quota costs a request, the provider counted it, and so does this.

The page is written even when the run failed halfway, because a run that fell
over on the third of twelve replies is exactly the one whose bill is worth
seeing.

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
  uses: ecoma-io/reeve/translate@v0.1
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

> [!NOTE]
> **The text above is the original, and it is the version this project answers for.**
> Everything below is a machine translation by [Reeve](https://github.com/ecoma-io/reeve).
> Where the two disagree, the text above is the one that counts.

<details open>
<summary><b>English</b></summary>

<the translation>

</details>

<sub>Translated from Vietnamese. Editing the text above republishes this; deleting this block regenerates it.</sub>
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

## Text with no prose in it

A body that is a stack trace, a log paste, a diff or a bare URL is written the
same way in every language, and there is nothing in it to translate into
anything. That is checked before detection rather than after it, and it costs
nothing: the same step that blanks the residue for [detection](../languages.md)
answers it, and a body whose residue is empty ends the run there.

Checked _before_ detection because detection would honestly answer `unknown` for
such a body, and `unknown` means "translate into all of them" — the most
expensive answer available, on the one input where no answer is worth anything.
The log says so, `translated` is `[]`, and nothing is written.

The same applies per reply when `translate-replies` is on: a reply that is only a
stack trace is skipped and does not count towards `replies-translated`.

## What it will not do

- **Translate the title.** Titles are short, load-bearing and searched on; a
  block cannot go there and a rewrite is off the table.
- **Rewrite the author's text.** Ever, under any input.
- **Verify that the translation is good.** Quality is _contained_ — the original
  is kept, marked official, never replaced — not guaranteed. That is the honest
  claim, and it is the whole reason for the marking.
