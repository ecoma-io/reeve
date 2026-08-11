# The warrant

What Reeve is allowed to do to your repository, written down in your repository,
and enforced against the file rather than against anything a model said.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## Where the warrant sits on the ladder

[The ladder](../north-star.md#3-the-ladder) is climbed almost entirely inside
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

**Level 0 is [Stage 1](../north-star.md#7-roadmap), landed: an absent warrant
is an implicit authority, not a failed run.** The corrected reading of the
`capabilities:` block above is [Stage 3](../north-star.md#7-roadmap) work,
not yet built. Until Stage 3, a duty left out of an already-written
`capabilities:` block still quietly keeps its own default rather than being
granted nothing — [the capabilities reference below](#capabilities) says
where that gap is today.

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
```

### Label fields

| Field            | Required | What it does                                                                                                     |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`           | yes      | Must match a label that exists in the repository, exactly. Verified before anything is applied.                  |
| `description`    | yes      | When this label applies. Written as a boundary, not as a synonym for the name.                                   |
| `not`            | no       | When it does **not** apply, against the label it gets confused with most. The highest-value field on this page.  |
| `examples`       | no       | Real titles from your own repository. Two or three; more is a corpus, and that is what [memory](#memory) is for. |
| `owner`          | no       | Team or user assigned when this label is applied and the duty may assign.                                        |
| `exclusive_with` | no       | Labels that may not be applied alongside this one. Enforced in code, never requested of the model.               |

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
at all.

| Capability  | What it permits                                      | Default            |
| ----------- | ---------------------------------------------------- | ------------------ |
| `label`     | Add a label from the taxonomy. Never remove one.     | on for `triage`    |
| `edit-body` | Append Reeve's own block below its marker in a body. | on for `translate` |
| `comment`   | Post a rationale as a new comment.                   | off                |
| `close`     | Close as not planned, with a comment saying why.     | off                |
| `assign`    | Assign the `owner` the taxonomy names for a label.   | off                |
| `none`      | Run everything, write every output, change nothing.  | —                  |

**A duty left out of the block entirely keeps its own default, for as long as
no `capabilities:` block exists at all** — that is level 1 of
[the ladder](../north-star.md#3-the-ladder), and a taxonomy-only warrant stays
there for as long as that is all you want. Write a `capabilities:` block at
all, though, and enumeration is meant to become total: a duty you left out of
it is granted nothing, not its old default, because naming who may act is
supposed to be the whole answer once you start. **This is
[Stage 3](../north-star.md#7-roadmap) work, not yet built.** Today, a duty
left out of an already-written block still quietly keeps its default — write
every duty you use into the block once one exists, and do not lean on the gap.

**The default is the capability whose failure is cheapest, and nothing else.**
Labels-only for triage is not caution for its own sake — it is where the projects
running this at scale independently converged. A wrong label costs a maintainer
one click and is noise they already know how to filter. A wrong comment is
addressed to a human who then has to answer it. A wrong close tells a reporter
their report was not worth keeping open, and costs you a contributor.

Turn the others on deliberately, one at a time, after a `dry-run` on your own
backlog told you what the rate actually is.

**A duty also takes an `apply` input, and the narrower of the two wins.** The
file and the workflow are both reviewable, they can disagree, and the fail-safe
direction is the intersection. A workflow can restrict what the file granted; it
can never widen it.

**`none` is not `dry-run`.** `none` is a permanent configuration for a repository
that consumes the outputs itself and does its own applying. `dry-run` is a
rehearsal. They differ in intent, and outputs let a workflow tell them apart.

## What no capability can ever turn on

These are not defaults. There is no input, no file key and no flag:

- **Removing a label a maintainer applied.** A label a human put there is a
  decision. Removing it is Reeve overruling a person.
- **Reopening what a maintainer closed**, or reassigning what they assigned.
- **Editing a title, or a person's own body text.** Reeve appends below its own
  marker. Everything above it is kept byte-for-byte on every run.
- **Applying a label the taxonomy does not name**, whatever a model returned and
  whatever it asserted about its instructions.
- **Writing code, opening a pull request, or running your tests.**

The last one is a product boundary rather than a safety one, and it is argued in
[the north star](../north-star.md#8-non-goals).

## Validation

Checked when the file is read, before any model call:

- **The file parses and `version` is supported.**
- **Every `name` is unique.**
- **Every `name` exists as a label in the repository.** A taxonomy naming a label
  that was renamed produces an error naming both — rather than a verdict whose
  labels are all silently dropped later, which looks exactly like a model that
  never agreed with anything.
- **Every `exclusive_with` entry names a label in this same file.**
- **Every capability named is one a duty defines.** A misspelling is refused, not
  dropped: this list is the only thing standing between a verdict and your issue
  tracker, and a silently ignored `lablel` is worse than a failed run.
- **`owner`, if present, is a syntactically valid handle.** Whether it can
  actually be assigned is decided by the API at apply time; a non-assignable
  owner is a warning, not a failed run.

**An issue cannot be assigned to a team.** That is GitHub's rule, not Reeve's:
the assignees API takes users, and `@org/team` is not one. A team `owner` is
still worth writing — it says who a label belongs to, and the run report says so
— but a run with `assign` turned on warns about it once and carries on. It never
fails the run over it, because who owns a label is documentation and refusing to
label a thread over it would be the wrong trade.

## Memory

Corrections a maintainer has already made, kept as newline-delimited JSON under
`.reeve/`, and given to a duty as examples on the next similar thread.

Reading ships. A duty ranks the store against the thread in front of it and puts
the nearest few corrections in the prompt, lexically and for nothing — no
provider, no extra request. The ranking is a seam: a similarity that crosses
languages, by translating to a pivot language first, goes in behind the same
interface, and that is Stage 4 in [the roadmap](../north-star.md#7-roadmap).

**Writing does not ship yet.** Recording a correction is a commit, it needs
`contents: write`, and it is opt-in for that reason. Until then the store is a
directory you fill in yourself, one JSON object per line, or leave empty.

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
