# Duties and the core

_Understand the boundary between the core and a duty, and why it is drawn there. Prerequisites: [The authority model](authority-model.md)._

Every duty — `triage`, `translate`, `duplicate`, `respond` — is a decision
sitting on top of the same pipeline, the same warrant, the same guardrails.
Knowing where that boundary runs is what makes the rest of the model
predictable: once you have used one duty, you already know what any other
duty can and cannot do on its own, because none of them can do more than a
duty is allowed to.

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

This is why a duty cannot behave inconsistently with another: the parts a
maintainer actually relies on for safety — talking to GitHub, reading the
warrant, deciding what has already run — are not duty code at all. They are
the same code, running the same way, underneath every one of them.

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

These are not implementation notes — they are the reason [the warrant](../guides/warrant.md)
can be a single, small file that governs every duty at once, and the reason
adding a fifth duty tomorrow changes nothing about how the first four are
trusted today.

---

**Related:** [The authority model](authority-model.md) · [The language layer](language-layer.md) · [The warrant](../guides/warrant.md)
**Next:** [The warrant](../guides/warrant.md) — where a duty's actual authority is written down
