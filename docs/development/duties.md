# Writing a duty

What a duty is allowed to be, what the core owes it, and what it owes back.

Read [the architecture](architecture.md) first — this page assumes the pipeline
and the boundary.

## What a duty is

One job Reeve does, shipped as its own action in its own subdirectory, sharing
one core with every other duty.

A duty is **a decision, plus the shape of its result**. It is not a program. The
pipeline is the program, and it is the same pipeline for every duty.

```
src/
  core/            the pipeline, and everything it is made of
  duties/
    translate/     one decision
    triage/        another decision
translate/action.yml
triage/action.yml
```

## What the core supplies

A duty never writes any of this, and a duty that reimplements one has broken the
boundary:

| The core gives it          | So a duty never                                                              |
| -------------------------- | ---------------------------------------------------------------------------- |
| The provider client        | Constructs a request, handles a status code, or decides what a failure means |
| Model rotation             | Retries anything                                                             |
| The language layer         | Detects, guesses, or asks a model what language something is in              |
| The warrant                | Parses the file, or decides what it is allowed to do                         |
| Multi-draft scoring        | Compares its own candidates                                                  |
| The judge                  | Runs a panel or counts votes                                                 |
| The sanitiser              | Touches model prose before publishing                                        |
| The `Thread` port          | Talks to GitHub                                                              |
| The marker and fingerprint | Decides whether it has already run                                           |

## What a duty supplies

Four things, and they are all values:

**A prompt shape.** What to ask, given a thread and a language. Pure — it takes
data and returns messages.

**A result shape.** What a well-formed answer looks like, and a parser that
returns nothing rather than something partial when the answer is malformed.

**Scoring criteria.** Which measurements of a draft matter for _this_ decision,
and which ones are grounds for refusing a draft outright rather than ranking it
low. The scoring machinery is shared; the weights and the refusals are the duty's.

**A publication.** What to write, as data — not the writing itself. A duty
returns "this label, this block under this marker". The publish stage performs it.

## What a duty may never do

**Talk to the outside world.** If a duty imports anything that fetches, reads the
filesystem, or touches the GitHub API, the boundary broke. That is the test: not
a style rule, a mechanical check you can run by reading the import list.

**Decide its own authority.** A duty does not read the warrant file. It is handed
what it may do, already parsed and already intersected with the workflow's input.

**Trust its own output.** A duty's parser hands the verdict to the guardrail
stage, which re-checks it against the file. A duty that validated its own result
and published it would be validating inside the same context that built the
prompt.

**Detect language.** Ever. The language layer runs before a duty is invoked and
the answer is passed in, including `unknown`.

**Assume English.** The prompt shape, the scoring criteria and the result shape
must be correct for a thread written in any of the configured languages. A duty
that only reads well in English is not finished.

## Adding one

### 1. Earn it

[D10](../north-star.md#d10--a-duty-must-earn-its-place) is a strict gate and it
rejects most proposals on purpose. The work has to:

1. **recur** — a maintainer does it repeatedly, not once;
2. **be uniformly expensive today** — not merely occasionally annoying;
3. **already be work a maintainer stopped doing** — the honest test, because a
   duty that automates something nobody was doing anyway automates nothing;
4. **be harder on a project whose contributors do not share a language.**

If it fails (4) it might still be a good idea. It is not a good idea _here_, and
[the non-goals](../north-star.md#8-non-goals) are where that gets argued.

### 2. Write the evaluation first

[D11](../north-star.md#d11--every-duty-ships-with-an-evaluation): a duty ships
with a way to measure it or it does not ship. Write the fixture set before the
duty, in at least two languages, and decide up front what number would make you
withdraw the duty. See [evaluation](evaluation.md).

Writing it first is not discipline for its own sake. A fixture set written after
the implementation is a set of cases the implementation already handles.

### 3. Write the doc page

`docs/usage/duties/<name>.md`, before the code. It forces the input contract to be
something a stranger could configure, and it is where you find out that two of
your inputs mean the same thing.

### 4. Write the duty

Four values, no I/O, no authority decisions. If it needs something the core does
not have, that is a change to the core in its own commit with its own scope — not
a private helper inside the duty that the next duty will duplicate.

### 5. Wire the action

`<name>/action.yml` declares every input and its default, and **it is the only
place they are declared.** A second list of names in the source is free to drift
from it.

An integration test reads `action.yml` back and fails when the names it declares
and the names the duty asks for stop matching. A rename in one place alone would
otherwise leave the duty reading an empty string on every run, silently.

Then add the entry point to `tools/build.mjs` and the duty's directory to the
archive step in `.github/workflows/release.yml`. Both are short lists naming
every duty, and a duty missing from the second one builds on your machine and is
absent from the release tree.

### 6. Add the commit scope

`commitlint.config.mjs` and `CONTRIBUTING.md`. A duty whose commits cannot name
it is a duty whose history cannot be read.

## The four inputs every duty shares

`github-token`, `base-url`, `api-key`, `models`. Same names, same defaults, same
meanings, everywhere.

A duty that needed `model` instead of `models`, or `token` instead of
`github-token`, would make a consumer relearn the core for each duty — which is
the whole thing one repository and one version line exist to avoid.

`dry-run` is the fifth. It is not optional: a duty a consumer cannot rehearse is a
duty they have to arm to evaluate.

## Testing a duty

Three tiers, and the middle one is where the value is.

**Unit** — the prompt shape, the parser, the scoring criteria. Pure functions,
so the tests are about behaviour rather than mocks. The parser deserves the most
hostile cases you can write: truncated JSON, a verdict wrapped in prose, a label
list containing an object, an answer that is entirely an apology.

**Integration** — the duty against a fake provider and a fake `Thread`. This is
where "the model misbehaved" is exercised, and it is the tier that decides whether
the duty is safe. Every branch that ends in "do nothing, loudly" needs a test that
proves it ends there.

**Contract** — `action.yml` against what the duty reads, and the invariants in
[the threat model](security.md#invariants).

A duty is judged on what it does when the model misbehaves, not on what it does
when everything works. A pull request whose tests only cover the happy path is
not finished, and a reviewer will say so.

## Existing duties as references

| Duty        | Read it for                                                                                |
| ----------- | ------------------------------------------------------------------------------------------ |
| `translate` | Multi-draft scoring, refusal-vs-ranking, publishing under a marker, per-reply fingerprints |
| `triage`    | The warrant as an allowlist, the guardrail stage, screening before spending                |

Between them they exercise every part of the core. A third duty that needs
something neither of them does is worth a conversation before it is worth a
branch.
