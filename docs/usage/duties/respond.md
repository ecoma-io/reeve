# `respond`

A stranger opens an issue and, for a while, nobody answers. `respond` writes the
first reply — grounded in what this project already knows, in the language the
thread was opened in — and then it is done. It answers once and never
converses. It is not a chatbot.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for, and what it will never become

The gap between "a stranger filed a report" and "a maintainer had time to look
at it" is where a project loses people — not because the report was bad, but
because silence reads as indifference. `respond` closes that gap with a single,
visibly machine-written reply: an acknowledgement, grounded in corrections this
project has already made, so the second sentence is not a template.

**It is not a chatbot, and this is not a soft claim.** [The north
star](../../north-star.md#8-non-goals) says Reeve does a duty and stops; for
`respond` that means one reply, ever, per thread. It does not answer follow-up
comments, does not defend its own reply, and does not notice being disagreed
with — there is no second turn, and no input adds one. A human's own reply,
whenever it arrives, is the actual first response as far as this duty is
concerned from then on; `respond` has already said its one thing and is not
listening for what comes after.

**It is the top rung of [the ladder](../../north-star.md#3-the-ladder), and it
is the only duty with no cheap default.** `triage` may `label` and `translate`
may `edit-body` before you write a single line of warrant — both are one click
to undo. There is no equally cheap version of "post a comment that reads, to
everyone downstream, as though this project answered." So `respond` is granted
**nothing** until a warrant names it, whether the file is missing entirely or
merely silent about this duty. See [Granting it](#granting-it) below.

## Minimum

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

That alone drafts a reply and reports it on `respond-text` — and posts nothing,
because the default warrant grants `respond` no capability at all. Read the
draft on a few real issues first; grant `comment` once you trust it.

## Granting it

Nothing else in Reeve needs this much ceremony, and that is deliberate.

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

**Both halves have to agree, and the narrower one wins.** The file is the
authority; `apply` is the workflow's own half of the answer, useful for turning
posting off on one trigger — a fork, a `schedule` rerun — without touching the
file. Leave either one silent about `respond` and the run drafts, reports, and
posts nothing: a real answer, not a misconfiguration, and the job summary says
so.

There is no smaller grant than `comment`. `respond` has exactly one capability
to give.

## Only the opened issue, only once

`respond` is meant to run on `issues: opened` and nothing else. Two code
guards enforce the "once" half, and neither is an input — an input can be
misconfigured, and these two cannot be:

**A human's own reply ends it.** The thread's replies are read oldest first,
GitHub's own order, and the first human reply stops the run before a draft is
even written. Answering the first reply is the whole of what this duty does;
there is no input that lets it speak over a person who got there first.

**Its own marker ends it, however the issue is edited afterward.** The reply
`respond` posts carries a marker the same way every duty's output does, and a
rerun that finds it stops immediately — this thread already has its one
reply. This is deliberately **not** "the body hasn't changed since last
time": the marker answers a _thread_, not a body version, so editing the
issue after `respond` has already spoken does not earn a second reply.

The marker lives only in that one comment, though, and nowhere else. Delete
the comment and the marker goes with it — the next run reads an unanswered
thread and drafts again. That is the accepted trade for keeping no record
outside the thread itself: see [What the reply looks
like](#what-the-reply-looks-like) for why the footer names the comment as the
record instead of promising otherwise.

Both guards are one walk over the same page of replies, so they cost nothing
extra to check.

**Not owed to a bot.** An issue opened by a bot account gets no reply — a
"first reply" answers a person, and there is no maintainer relationship for a
bot-filed thread to start.

**Never engages a thread the screen already dropped.** When `screen-models` is
configured, the same cheap spam/off-topic check [`triage`
runs](triage.md#the-pipeline) runs here too, before a single expensive
request. A thread the screen classified as spam or off-topic gets no reply — a
first-reply bot that courteously answers spam is a spam amplifier, not a
feature, and `respond` never second-guesses that verdict once it is in.
Leaving `screen-models` empty — the default — turns the check off, and every
issue reaches a draft.

## Inputs

`action.yml` in the duty's directory is the contract. The ones worth a word
beyond their description:

| Input            | Default                     | Worth knowing                                                                                                                                                            |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models`         | _required_                  | The roster that writes drafts. Order is preference.                                                                                                                      |
| `drafts`         | `1`                         | Attempts per run, scored and judged. A first reply is read before anything else this project says — worth more than one attempt.                                         |
| `judge-models`   | _empty_                     | A panel that picks the best draft. Seats, not a fallback list — same grammar as [`translate`'s](translate.md#judge-models-has-two-levels-and-they-mean-opposite-things). |
| `warrant`        | `.github/reeve.yml`         | Where `comment` is granted. A missing file grants `respond` nothing, same as one that is silent about it — see [Granting it](#granting-it).                              |
| `apply`          | `none`                      | `comment`, or `none`. The narrower of this and the warrant wins, always.                                                                                                 |
| `confidence`     | `0.75`                      | Below this the draft is reported on `respond-text` and nothing is posted.                                                                                                |
| `guidance`       | `.github/reeve-guidance.md` | A maintainer-authored file: tone, what this project never promises, where to point a question this duty cannot answer. See below.                                        |
| `screen-models`  | _empty_                     | The spam/off-topic check. Empty turns it off — see [Only the opened issue, only once](#only-the-opened-issue-only-once).                                                 |
| `about`          | _empty_                     | One sentence on what this repository is about. Used only by the off-topic half of `screen-models`' check.                                                                |
| `corrections`    | `.reeve/corrections`        | The memory store. Empty is the cold-start case and works.                                                                                                                |
| `max-body-chars` | `6000`                      | How much of the author's own text one run reads. `none` for no bound at all — `0` is refused, since it would silently mean "read nothing."                               |
| `dry-run`        | `false`                     | Whole pipeline, every output, nothing posted.                                                                                                                            |

**`confidence` is a floor worth measuring, not inheriting.** [Measure it](../../development/evaluation.md)
against your own drafts before you move it — what `0.75` means for one
project's tolerance for a slightly-off first reply is not what it means for
another's.

**`guidance` is read from the checkout and trusted.** It is your own
maintainers' text, reviewed like any other change, so `draft.ts` puts it in
the model's instructions the same way it puts the taxonomy there — unfenced.
The thread it is answering is a stranger's words and stays behind the
sanitising boundary regardless. A repository that has not written the file
yet is the cold start, not a misconfiguration: the run proceeds exactly as it
would with an empty one.

## Outputs

| Output         | Value                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `responded`    | `true` when a reply was posted this run. `false` on every other path — including one that drafted an answer but the floor, the warrant, `apply`, or `dry-run` withheld it.                            |
| `language`     | The detected language of the thread, or empty for `unknown`. The reply itself, when there is one, is written in this language.                                                                        |
| `respond-text` | The winning draft's own text, already sanitised, whether or not it was posted. Written on every run that reached a verdict — a repository that withholds `comment` can still route a draft to review. |
| `starved`      | `true` when every model in `models` failed on capacity this run. Weather, not a broken configuration — see [Failure](#failure-and-what-it-looks-like).                                                |

**`respond-text` is the output that matters most for a repository still
tuning `confidence`.** It is populated on every run that reached a verdict,
whether or not the floor or the warrant let the reply reach the thread, so a
workflow can post a draft to a review queue instead of the issue while you
watch how it does.

## The pipeline

```
issue ─► read ─► guard ─► screen ─► recall ─► draft ─► judge ─► post
           │       │        │         │         │        │       │
       warrant  human or  cheap or  nearest   several  panel   only what
       parsed   own       no model  maintainer attempts picks   `apply`
       first    marker    at all    correction          winner  permits
```

**Read.** Parse the warrant and fetch the thread, same order as every other
duty, for the same reason: everything downstream is defined in terms of the
file, so it has to be checked first.

**Guard.** The two code guards from [Only the opened issue, only
once](#only-the-opened-issue-only-once): a bot-opened issue gets no reply, and
the replies are walked oldest-first for a human reply or this duty's own
marker, either of which ends the run.

**Screen.** The same cheap spam/off-topic check [`triage` runs in its own
pipeline](triage.md#the-pipeline), when `screen-models` is configured. A
dropped verdict ends the run before a single expensive request.

**Recall.** The nearest maintainer corrections for this thread, retrieved the
same way [`triage`'s memory](../warrant.md#memory) works — lexical, free in
the ordinary case, bridged across the language boundary through the pivot when
the store and the thread do not already share one language.

**Draft.** Ask for `drafts` first replies, each grounded in the recalled
corrections, the taxonomy meaning of whatever labels are already on the
thread, and `guidance` when one is written. The same two non-negotiable
properties every duty's model stage has:

- **The thread text sits inside a per-call random nonce boundary**, never a
  fixed delimiter — see [Security](../../development/security.md).
- **Unreadable output is discarded, never a best-effort parse.** A draft that
  did not parse as a draft is dropped, not salvaged.

**Judge.** With more than one admitted draft, `judge-models` — when
configured — picks the winner; deterministic scoring breaks every tie and
decides alone when no panel is configured. One draft with no panel is not a
contest, and the reply says nothing about being "decided" for it.

**Post.** Compare the winner's confidence against the floor, then the double
gate — `apply` and the warrant both have to grant `comment` — then `dry-run`.
Clear all three and the reply is posted as a brand-new comment. There is no
other outcome available at this point: every reason not to post is a guard
above it, and each one already stopped the run.

## What the reply looks like

```markdown
> [!NOTE]
> This reply was drafted by [Reeve](https://github.com/ecoma-io/reeve), not by a maintainer.
> A maintainer has not reviewed it. Treat it as a starting point, not an answer.

<the drafted reply, in the thread's own language>

<sub>Drafted by `gpt-5-mini`. Confidence 0.91 of 1.00, best of 2 drafts, decided by judges. Votes: `Referee`→`gpt-5-mini`.</sub>
<sub>The thread was written in Vietnamese. Reeve answers a thread once. This comment is the record of it.</sub>
```

**The notice at the top is unconditional and unstrippable.** There is no
input, no `show-attribution`-style setting, that renders this reply without
it — a first reply is the one place in this project a reader cannot afford to
guess whether they are reading a maintainer or a model, so guard 6 of this
duty's charter is that the attribution can never be turned off or disguised.

**The provenance line is always there too**, in `<sub>`, below the reply: the
model that wrote it, and — only when there was a contest — the confidence, how
many drafts it beat, and how the panel voted. One draft with no panel skips
the confidence line entirely rather than dressing up a foregone conclusion as
a verdict.

**The footer names the comment as the record, because the guard is the
comment.** `respond`'s once-only guard is not a fact kept anywhere else — it
is the marker inside this exact reply, found the same walk that looks for a
human's own reply. Delete the comment and the marker goes with it: the next
run reads an unanswered thread and drafts again. That is the accepted trade,
not an oversight — the alternative is a record kept outside the thread, which
is state this duty does not want to own or a maintainer to have to trust
separately from what they can see. The footer says what the comment is, not a
promise about what deleting it would do.

## Failure, and what it looks like

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

## What it will never do

- Post a second reply to a thread it already answered, however many times the
  issue is edited afterward.
- Reply to a comment, argue a point, or otherwise hold a conversation. One
  reply, once, and then this duty is finished with that thread.
- Answer over a human who got there first.
- Answer a bot-opened issue, or a thread the screen classified as spam or
  off-topic.
- Post without `comment` granted by both the warrant and `apply` — [the
  warrant's own list](../warrant.md#what-no-capability-can-ever-turn-on)
  applies here exactly as it does to every other duty.
- Hide, soften, or make removable the notice that the reply is machine-written.
