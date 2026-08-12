# The warrant

_Write and extend a warrant file for your repository. Prerequisites: [Installation](../getting-started/installation.md)._

What Reeve is allowed to do to your repository, written down in your repository,
and enforced against the file rather than against anything a model said.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## Where the warrant sits on the ladder

[The ladder](../doctrine/north-star.md#3-the-ladder) is climbed almost entirely inside
this file. Write nothing, and a duty runs at level 0 — the narrowest authority
Reeve defines in code, built from the labels and the descriptions your
repository already has, with nothing typed twice. Write `.github/reeve.yml`
with a taxonomy and no `capabilities:` block, and every duty stays on that
same narrow default — a taxonomy sharpens what gets decided, never what is
allowed to act, and a taxonomy-only file is level 1 on its own, complete and
worth stopping at for as long as it serves you. **Only once you write a
`capabilities:` block does enumeration become total:** a duty the block does
not name is then granted nothing at all, not its old default, because once
you begin enumerating who may act, the enumeration is the whole answer, and
the file's mere existence never was. That block — with `owner` and
`exclusive_with` alongside it — is level 2 of the ladder, reviewed the same
way, in the same file, for as long as you use Reeve.

**Level 0 is [Stage 1](../doctrine/north-star.md#7-roadmap), landed: an absent warrant
is an implicit authority, not a failed run.** The corrected reading of the
`capabilities:` block above is [Stage 3](../doctrine/north-star.md#7-roadmap), also
landed: a duty left out of an already-written `capabilities:` block is
granted nothing at all, not its old default — [the capabilities reference
below](#capabilities) is where that is spelled out in full.

The concept underneath this page — capabilities, the warrant, and the ladder
as one model — is explained at a level above this page's how-to detail in
[The authority model](../concepts/authority-model.md), for a reader who wants
the shape before the syntax.

## Why this is a file and not a setting

A reeve acted on the owner's behalf under an authority the owner had granted and
could withdraw. The authority was the point, and so is this.

Three properties follow from putting it in your repository rather than in a
service:

**It is reviewed like code.** Widening what Reeve may do is a pull request with a
diff, an author and a reviewer. Nobody widens it by clicking something in a
console at 2am.

**It is the allowlist, not a hint.** Every guardrail is defined in terms of this
file. When a verdict names a label, the check is `is this name in the file` — run
in code, against the parsed file, never against the model's own claim about what
it was permitted to do. That is the single property that makes injected text
unable to invent an authority: text can persuade a model, and it cannot edit a
file it is not in.

**Deleting it withdraws what you wrote, not more than that.**
`rm .github/reeve.yml` takes a duty back down to level 0 of the ladder rather
than to no authority at all. There is no second copy of the file anywhere,
either way.

## Where it lives

`.github/reeve.yml` by default. Any duty that needs one takes a path input if you
keep it elsewhere.

**A warrant that does not parse is a failed run.** Not a run with no allowlist.
Everything downstream is defined in terms of this file, so the fail-safe
direction is stop, and it is the only place Reeve fails red over configuration
rather than warning and continuing.

## Format

```yaml
# .github/reeve.yml
version: 1

# What each duty may do to a thread. Absent means the duty's own default, which
# is always the cheapest reversible action and nothing else.
capabilities:
  triage: [label]
  translate: [edit-body]
  duplicate: [comment]

# What to translate into. Optional — leave it out and the `languages` input
# on each duty answers this instead, exactly as it always has. Written here,
# it is the whole answer: the input is ignored, and the run says so once.
languages:
  - en
  - vi
  - zh

labels:
  - name: bug
    description: >-
      Something in a released version does not do what its documentation says it
      does. The reporter is using it as intended and getting a wrong result.
    not: >-
      A feature that was never built, a question about how to use something, or
      a failure caused by a configuration the docs warn against.
    examples:
      - "Export produces an empty file when the table has exactly one row"
      - "The retry counter resets on a 500 but not on a timeout"

  - name: performance
    description: >-
      Correct behaviour that is too slow or uses too much memory to be usable at
      a size the project claims to support.
    not: >-
      Slowness at a scale nothing promises — that is a feature request for a
      higher ceiling.
    owner: "@ecoma-io/runtime"

  - name: needs reproduction
    description: >-
      A plausible defect report that does not yet contain enough to reproduce it.
    not: >-
      A report that is merely short. If the steps are there, this is not it.
    exclusive_with: [bug]

  - name: security
    description: >-
      A report that a user's data, credentials or access could be exposed to
      someone who should not have them.
    confidence: 0.9
```

Every field's name, whether it is required, and what it does is
[the warrant format reference](../reference/warrant-format.md#label-fields) —
this page stays on why and how to write one; the schema itself lives there.

**`confidence` here replaces the run's own floor for this one label, in
either direction — it is not a ceiling still subject to it.** A verdict needs
to clear a floor to apply any label at all — the `confidence` input, above
the taxonomy in the run's own settings — and a label's own `confidence:`
substitutes a different floor for _that_ label alone: lower it for a label
safe to apply on a hunch, raise it above the run's own floor for one costly
enough to get wrong that a hunch is not enough, without moving the bar for
every other label in the file to do it. `security` is the usual example:

```yaml
- name: security
  description: >-
    A report that a user's data, credentials or access could be exposed to
    someone who should not have them.
  confidence: 0.9
```

`version` is currently `1`. It exists so a format change can be refused with a
message naming the version, rather than parsed into something plausible and
wrong.

### `not` is where the accuracy is

Worth reading twice.

Ask a general model to choose between `bug` and `enhancement` and it does
tolerably. Ask it to choose between `bug` and `needs reproduction`, or between
`performance` and `bug`, and it does badly — not because it is weak, but because
that boundary is a decision **your project made** and nothing in the model's
training says where you put it.

A `description` gets written as a definition, and definitions overlap. A `not`
forces the boundary to be stated:

```yaml
- name: enhancement
  description: A capability the project does not have and should.
  not: >-
    A capability the project HAS, that does not work. That is `bug`, even when
    the reporter phrases it as a request.
```

That last sentence is worth more than three paragraphs of `description`, because
it names the exact confusion it prevents. Write `not` against the label yours
gets confused with most often. If you do not know which that is,
[measure it](../development/evaluation.md) — the confusion matrix tells you.

**Write both fields for a reader who does not share your language.** A `not` that
turns on an English idiom does not survive contact with a report written in
Vietnamese. Say what the boundary _is_, not what it sounds like.

## Capabilities

The second half of the warrant: not what the labels mean, but what a duty may do
at all. [The full table](../reference/warrant-format.md#capabilities) — what each
capability permits and its default — is in the reference; this section is the
behaviour around it.

**A duty left out of the block entirely keeps its own default, for as long as
no `capabilities:` block exists at all** — that is level 1 of
[the ladder](../doctrine/north-star.md#3-the-ladder), and a taxonomy-only warrant stays
there for as long as that is all you want. Write a `capabilities:` block at
all, though, and enumeration becomes total: a duty you left out of it is
granted nothing, not its old default, because naming who may act is the whole
answer once you start. **This is [Stage 3](../doctrine/north-star.md#7-roadmap),
landed.** A duty left out of an already-written block runs, decides nothing,
and says so in its own run report — write every duty you use into the block
once one exists.

**The default is the capability whose failure is cheapest, and nothing else.**
Labels-only for triage is not caution for its own sake — it is where the projects
running this at scale independently converged. A wrong label costs a maintainer
one click and is noise they already know how to filter. A wrong comment is
addressed to a human who then has to answer it. A wrong close tells a reporter
their report was not worth keeping open, and costs you a contributor.

Turn the others on deliberately, one at a time, after a [`dry-run`](dry-run.md) on your own
backlog told you what the rate actually is.

**`duplicate` has no default at all — not even the cheapest one.** Its own
`capabilities:` entry and its `apply` input both start at nothing, so posting
a comment naming a suspected duplicate needs `duplicate: [comment]` written
here **and** `apply: comment` on the workflow; either alone still leaves the
run reporting `duplicate-of` and `score` without touching the thread. See
[the duty's own page](../reference/duties/duplicate.md) for why a claim about somebody
else's report did not earn the same free default a label did.

**Neither does `respond`.** It is the top rung, and there is no cheap,
reversible version of "post a comment that reads as this project answering a
stranger." So an absent warrant, or a written one that is simply silent about
`respond`, grants it nothing — not `comment`, not anything — until
`capabilities: { respond: [comment] }` names it explicitly. See [the
`respond` duty](../reference/duties/respond.md#required-permissions).

**Neither does `propose`.** It is `triage`'s own sweep-only capability, not a
duty of its own — opening or updating one pull request that adds or retires
taxonomy labels from a monorepo's own package layout, gated by evidence
before it ever proposes a name. It needs `contents: write` and
`pull-requests: write` on the token, `triage: [propose]` under
`capabilities:`, and `propose` in `apply`, same as `record`. It is not
a self-amending authority: the file it changes is a pull request like any
other, reviewed and merged by a person — no capability of Reeve's ever
merges one. See [the `triage` duty's own page](../reference/duties/triage.md).

**A duty also takes an `apply` input, and the narrower of the two wins.** The
file and the workflow are both reviewable, they can disagree, and the fail-safe
direction is the intersection. A workflow can restrict what the file granted; it
can never widen it.

**`none` is not `dry-run`.** `none` is a permanent configuration for a repository
that consumes the outputs itself and does its own applying. [`dry-run`](dry-run.md) is a
rehearsal. They differ in intent, and outputs let a workflow tell them apart.

## Languages

`languages:` is optional, and it moves one more thing off the workflow and
into the file that is reviewed like code:

```yaml
languages:
  - en
  - vi
  - "zh-Hans:简体中文:Hans"
```

The grammar is the same one the `languages` input has always used — a bare
code, or a spelled-out `code:Label:Script` with `+` between scripts for a
language written in several — because this is the same list read from a
different place, not a second format to learn. One YAML element is one entry,
so a label with a comma in it needs no special care here, where the input's
one-line form would read that comma as a separator. See
[Languages](languages.md) for the full grammar and how detection uses it.

**Written here, it is the whole answer.** Once `languages:` exists in the
warrant, the `languages` input on `translate` and `triage` is not consulted
at all — not blended with it, not a fallback for anything it left out — and
the run says so once, naming both the file and the input, rather than
silently picking one. Leave the key out and nothing changes: the input
answers the question exactly as it always has. Writing the key with nothing
under it is refused rather than read as leaving it out — an unfinished edit
should fail loudly, not quietly hand the answer back to the input.

An implicit warrant — no file at the default path — carries no languages of
its own, for the same reason it carries no capabilities of its own: there is
nothing written down to read. The input answers the question there too.

## What no capability can ever turn on

These are not defaults. There is no input, no file key and no flag:

- **Removing a label a maintainer applied.** A label a human put there is a
  decision. Removing it is Reeve overruling a person. The one bounded
  exception is `lifecycle`'s own clock-hand labels — see
  [the clock-hand exception](../reference/duties/lifecycle.md#the-clock-hand-exception).
- **Reopening what a maintainer closed**, or reassigning what they assigned.
- **Editing a title, or a person's own body text.** Reeve appends below its own
  marker. Everything above it is kept byte-for-byte on every run.
- **Applying a label the taxonomy does not name**, whatever a model returned and
  whatever it asserted about its instructions.
- **Writing code, opening a pull request, or running your tests.**

The last one is a product boundary rather than a safety one, and it is argued in
[the north star](../doctrine/north-star.md#8-non-goals).

Every rule the parser itself enforces — before a model is even asked — is
[the warrant format reference's validation list](../reference/warrant-format.md#validation).

## Memory

Corrections a maintainer has already made, kept as newline-delimited JSON under
`.reeve/`, and given to a duty as examples on the next similar thread.

Reading ships. A duty ranks the store against the thread in front of it and puts
the nearest few corrections in the prompt, lexically and for nothing — no
provider, no extra request in the ordinary, same-language case.

**Writing ships too, behind `record`.** Grant it and a labelled or unlabelled
event from a human — never a re-triage, never a bot — commits that thread's
taxonomy-filtered current labels to the store, replacing any earlier entry for
the same thread. It needs `contents: write` on the token, which is why it is
opt-in rather than a duty default: a project decides to keep a memory at all.
No checkout happens for this — the commit goes through the Contents API — and
a token without the scope fails the run the way any other authentication
problem does, plainly.

**`record` needs naming in both halves — this file and the workflow's
`apply`.** [The narrower of the two wins](#capabilities) for `record` exactly
as it does for `label` or `comment`, and granting it here alone is not
enough: `apply` defaults to `label`, so a labelled event on a run whose file
grants `record` but whose workflow does not name it re-triages the thread
instead of recording it, and a `core.notice` on that run says so. Both halves
need to agree:

```yaml
capabilities:
  triage: [label, record]
```

```yaml
on:
  issues:
    types: [labeled, unlabeled]

concurrency:
  group: reeve-${{ github.event.issue.number }}
  cancel-in-progress: true

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
          apply: label, record
```

The `concurrency` group is what keeps two of this thread's events from racing
each other's write — a `labeled` and an `unlabeled` landing together, most
often. Nothing after the write retries on its own: a duty that finds another
write already landed reports that plainly rather than silently picking a
winner. See [installation](../getting-started/installation.md#2-pick-a-trigger)
for the same pattern on the trigger that starts the run in the first place.

See [the triage duty](../reference/duties/triage.md#configuration) for the full shape of this.

**The pivot language is what makes the store cross-language.** By default it
is the first language `triage` resolves — from `languages:` here, or from the
`languages` input. Write `pivot:` in this file to name it instead:

```yaml
pivot: en
```

`pivot:` must name one of the resolved `languages` — a pivot that is not read
or written into is not a bridge to anything — and a mismatch refuses the run,
naming both. A correction recorded in another language is also translated
into the pivot and stored alongside the original; recalling for a thread in
yet another language translates the query into the pivot too, and the two
renderings meet there. A correction already in the pivot language, or a store
that only ever sees one language, spends no extra request on any of this — the
bridge is only built when there is a language gap for it to cross. This is
[Stage 4](../doctrine/north-star.md#7-roadmap), landed.

**`memory:` tunes how much of the store one run reads.** `recall`, a whole
number, is how many corrections are put in the prompt — the same `4` this
duty has always used, now a written default rather than an unwritten one:

```yaml
memory:
  recall: 4
```

`0` is accepted and turns recall off — the store is still written to when
`record` is granted, only never read back — which is different from deleting
`.reeve/corrections` outright: the history stays, ready the day `recall` goes
back above `0`.

**An empty store is the cold-start case, not an error.** Every duty works with no
memory. It works better with one.

## A starting warrant

If you have nothing, start here, run it with `dry-run: true` for a week, and
write a `not` for every pair you watch it confuse.

```yaml
version: 1

capabilities:
  triage: [label]

labels:
  - name: bug
    description: >-
      Released behaviour contradicts its own documentation, for someone using it
      as intended.
    not: >-
      A missing capability, a question, or a configuration the docs warn against.

  - name: enhancement
    description: A capability the project does not have and should.
    not: >-
      A capability the project HAS, that does not work — that is `bug`, however
      the reporter phrased it.

  - name: question
    description: >-
      Someone asking how to do something the project already supports.
    not: >-
      A report that the documented way does not work. That is `bug`.

  - name: needs reproduction
    description: >-
      A plausible defect report that does not yet contain enough to reproduce it.
    not: A report that is merely short. If the steps are there, this is not it.
    exclusive_with: [bug]
```

---

**Related:** [The authority model](../concepts/authority-model.md) · [The warrant format reference](../reference/warrant-format.md) · [Dry run](dry-run.md)
**Next:** [Languages](languages.md) — configure who Reeve writes to, on top of what it may do
