# The `.reeve/` governance tree — draft specification

_What each file in the 2.x governance tree is for, who may change it, and how
today's warrant lifts into it. Prerequisites:
[The agent runtime](agent-runtime.md), [The 2.x roadmap](roadmap-2x.md)._

> [!IMPORTANT]
> **Draft. Nothing on this page ships today, and the spellings are not
> frozen.** No code in this repository reads a `.reeve/` directory; the tree
> lands in [Phase 2 of the 2.x roadmap](roadmap-2x.md#phase-2-the-governance-tree-and-authorityyaml),
> after the kernel exists to read it. What this page fixes now is the
> **shape** — which file grants, which files merely inform, and what review
> each requires. Key names and nesting are settled by the pull requests that
> land them, against this page, and this page is corrected where they
> disagree. Every present-tense sentence below reads "this is what it will
> do."

## Why a tree, when doctrine says one file

[The north star's ladder](../doctrine/north-star.md#3-the-ladder) is blunt:
one configuration file, ever, so that a maintainer can read the whole of what
Reeve may do in one place. A directory looks like a violation of that, so the
reconciliation has to be earned, not asserted.

The discipline's point survives because **exactly one file in this tree
grants anything.** `authority.yaml` is the whole answer to "what may Reeve
do," the way the warrant is today. Everything else in the tree is input to
_judgement_ — prose a model reads while deciding what a good reply sounds
like, records of what humans corrected — and none of it is consulted by the
Authority Kernel, none of it can widen a grant, and deleting all of it
changes what Reeve decides, never what Reeve may do. One authority file,
still. The tree exists because 2.x has more kinds of non-granting input than
1.x, not because authority got a second home.

## The tree

```
.reeve/
├── authority.yaml     the grant — the only file the kernel reads
├── constitution.md    prose judgement: tone, taste, what "good" means here
├── policies/          the constitution, split by concern when it outgrows one file
├── duties/            per-duty doctrine — the project's own rulings
└── memory/            the corrections store, relocated
```

Version-controlled, reviewed in pull requests, deleted with `rm` — the same
discipline the warrant already follows, because
[D6](../doctrine/north-star.md#d6-the-repository-is-the-database) does not
gain an exception by the file count growing.

### `authority.yaml` — the grant

The 2.x spelling of the warrant, read by the Authority Kernel and by nothing
else. Two halves, with deliberately opposite polarities:

```yaml
# A sketch, not a schema — see the banner above.
authority:
  capabilities:
    - issues.read
    - issues.search
    - issues.label
    - issues.comment
    - translate
    - duplicate
  forbidden:
    - issues.close
    - issues.delete
    - code.write
    - pull_request.merge
```

`capabilities:` is the allowlist the warrant's `duties:` block already
is: what is absent is not granted, and once the block exists, enumeration is
total — [D2's rule](../doctrine/north-star.md#d2-authority-is-granted-written-and-bounded),
unchanged.

`forbidden:` is new, and it is not redundancy. An allowlist expresses "not
yet"; a floor expresses "not ever," and the difference is what a diff shows a
reviewer. Widening an allowlist is a quiet added line among grants; crossing
a floor requires deleting a line that says _forbidden_, which no review reads
as routine. `code.write` lives there **permanently** — not as a strong
default but as an entry the parser itself refuses to see removed:
a file whose `forbidden:` list does not contain the permanent floor is an
invalid file, refused red, the same way a misspelled capability already is
([the warrant's refused-not-dropped rule](../reference/warrant-format.md#validation)).
The floor is enforced in code against the parsed file, never against prose,
because [the load-bearing idea](../security/security.md#the-load-bearing-idea)
does not change spelling in 2.x: authority is a file, and a model's output is
a claim.

Validation follows the warrant's precedent exactly: unknown keys, unknown
capability names, and contradictions (a name in both lists) are errors with
the offending text quoted back — refused, never dropped.

### `constitution.md` — judgement, not permission

Prose the agent reads while reasoning: what this project considers a good
first reply, what tone it keeps, what it never says. It is the same kind of
text the taxonomy's `description` and `not:` fields already are — a
project's own rulings, in words a model is shown — generalised past labels.

The boundary that keeps it safe is structural, not aspirational: the kernel
never reads this file. A constitution that says "you may close issues" is a
sentence shown to a model, and
[a model's output is a claim](../security/security.md#the-load-bearing-idea);
the close still dies at the kernel because `authority.yaml` never granted it.
Persuasive prose in the tree has exactly the power persuasive prose in a
hostile thread has — none, where authority is concerned
([D8](../doctrine/north-star.md#d8-every-thread-is-hostile)).

### `policies/` — the constitution, sharded

The same kind of prose, split by concern, for a project whose constitution
outgrows one file. Same trust class, same non-relationship to the kernel.

### `duties/` — per-duty doctrine

The project's rulings about how a particular duty should decide — the way the
warrant's `not:` fields already carry rulings about labels, given room that a
YAML string field does not have. Input to that duty's reasoning; grants
nothing.

### `memory/` — the store, relocated

The corrections files [State](architecture.md#state) already describes,
moved under the governance roof. Same format, same write path (`record`,
top-rung, `contents: write`), same review question —
[open question §10.3](../doctrine/north-star.md#10-open-questions) about who
reviews memory is not answered by the move, and this page does not pretend
it is.

## The review model

One rule, one reason: **a change to `authority.yaml` is a change to what
Reeve may do, and it goes through pull request review like every other line
of code that holds power.** There is no API that edits it, no duty that may
write into `.reeve/` except `memory/`, and — permanently — no path by which
an agent widens its own grant:
[the forbidden floor](agent-runtime.md#what-is-permanently-forbidden)
includes modifying the authority file itself, so the one writer of the grant
is a human, in a reviewed diff.

The other files are inputs to judgement, and review treats them the way
prompts are treated — worth reviewing, because they steer decisions, but not
authority reviews. The asymmetry is the design: a bad constitution makes
Reeve decide worse inside its box; only a bad `authority.yaml` changes the
box, and the box's diff is the loud one.

## Migration: how a warrant lifts into `authority.yaml`

Mechanical, lossless, and unforced — all three are commitments, not
adjectives:

- **Mechanical:** every key in a valid 1.x warrant has exactly one 2.x
  spelling, published as a table when Phase 2 lands. The shape of it today,
  at sketch precision: `version` maps to the tree's own version key;
  `duties:` maps to `authority.capabilities` with per-duty grants
  preserved; `labels:` — the taxonomy is an allowlist checked in code, so it
  is authority and it moves into `authority.yaml`, entries unchanged;
  `languages:` likewise — including its precedence:
  [written in the warrant, it is the whole answer](../guides/warrant.md#languages)
  and each duty's own default is ignored, and the lifted file keeps
  exactly that relationship to the defaults. Prose that today has nowhere to
  live (`not:` grew out of its string field) may _additionally_ expand into
  `duties/`, but the lift itself never requires it.
- **Lossless:** nothing expressible in a 1.x warrant is inexpressible in
  `authority.yaml`. A lift that loses a `not:` field or an
  `exclusive_with:` is a defective lift, and the migration tooling's tests
  are written against the published mapping table.
- **Unforced:** `.github/reeve.yml` keeps working, unchanged, with no
  deprecation warning and no sunset. The tree is the 2.x spelling, not the
  2.x requirement — a repository that wants Agent Mode needs
  `authority.yaml`, because the floor only exists there; a repository that
  wants exactly what it has today keeps exactly what it has today.

**Both files at once is an error, not a precedence puzzle.** A repository
carrying `.github/reeve.yml` and `.reeve/authority.yaml` fails red, naming
both paths. The tempting alternative — narrower wins, or newer wins — would
mean a maintainer's mental model of "what may Reeve do" depends on a merge
rule held in their head, which is precisely what
[the ladder's one-file discipline](../doctrine/north-star.md#3-the-ladder)
exists to prevent. Two files that can disagree about authority are a
configuration that said something and got it wrong, and that is the case
[D5](../doctrine/north-star.md#d5-failure-is-loud-it-is-never-plausible)
already rules on: loud, immediate, named.

---

**Related:** [The agent runtime](agent-runtime.md) ·
[The 2.x roadmap](roadmap-2x.md) ·
[The compatibility contract](agent-compatibility.md) ·
[Warrant format reference](../reference/warrant-format.md)
