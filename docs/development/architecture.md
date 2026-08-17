# Architecture

Reeve is one machine that does several jobs. This document describes the machine
and where a job is allowed to plug into it.

The shape exists to make one claim true: **adding the second duty is cheaper
than the first**. Every rule below is there because some version of it, relaxed,
turns this repository into a collection of unrelated bots that happen to share a
`package.json`.

## The run, stage by stage

A duty invocation moves through the core in a fixed order. The order is not a
suggestion — several stages exist specifically to run _before_ a model is given
anything, and moving them costs the guarantee.

| #   | Stage        | What it does                                                                                                                                       | What it may **not** do                                                |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **Warrant**  | Reads the authority file, resolves which duties are enabled and which effects each may produce.                                                    | Call a model. Reach the network beyond reading the repository.        |
| 2   | **Intake**   | Reads the event and the thread from the forge.                                                                                                     | Write anything.                                                       |
| 3   | **Trust**    | Classifies the author from forge metadata — association, prior merged work — into a tier.                                                          | Ask a model who to trust. Read the thread body to decide it.          |
| 4   | **Language** | Resolves the author's language deterministically, and the project's and maintainers' languages from the warrant. See [`language.md`](language.md). | Call a model. A detector is code.                                     |
| 5   | **Screen**   | Decides what code alone can decide: an empty body, a thread already carrying this duty's marker, a shape the taxonomy answers outright.            | Call a model. This tier costs nothing and must keep costing nothing.  |
| 6   | **Draft**    | Asks the provider for several candidate outputs, rotating models on failure.                                                                       | Decide anything. It produces candidates, not verdicts.                |
| 7   | **Score**    | Rejects candidates deterministically: malformed structure, truncation, wrong script, code touched, schema violated.                                | Rank on quality. It answers valid or invalid, nothing else.           |
| 8   | **Judge**    | Breaks a tie among candidates that already passed scoring.                                                                                         | Rescue an invalid candidate. A candidate the scorer rejected is gone. |
| 9   | **Enforce**  | Checks every intended effect against the warrant from stage 1.                                                                                     | Consult the model's output about what it was permitted to do.         |
| 10  | **Sanitise** | Contains model prose before it can be published — mentions, links, directives, anything that acts on a reader.                                     | Trust an instruction in the prompt to have done this already.         |
| 11  | **Publish**  | Performs the permitted effects and writes the idempotency marker.                                                                                  | Perform an effect that did not pass stage 9.                          |

Two properties follow from the ordering and are worth stating on their own:

- **Nothing untrusted reaches a model before stage 6**, and nothing a model
  produced reaches the forge before stages 7, 9 and 10 have each had a veto.
- **Stages 1–5 cost no money.** A repository with four thousand stale issues can
  be swept for the price of API reads, because most items never reach stage 6.
  This is D4 expressed as control flow rather than as a good intention.

## Failure semantics

There are exactly two outcomes: the duty did its job, or the run is red.

A stage that cannot complete does not degrade. Model output that will not parse
yields no verdict — not a partial read of the parts that looked well-formed,
because a malformed shape is the signature of an injection, and a partial read
of an injection is the injection succeeding. A run that could not do its job
never exits green with an empty result, because a maintainer cannot distinguish
that from "there was nothing to do".

This is D5, and it is the doctrine most often argued with during review. The
argument is always some version of "but a partial answer is better than none".
It is not, when the partial answer is indistinguishable from a successful one.

## What a run reports, and where

Three audiences, three places, and the difference is not cosmetic:

| Where               | Who reads it                     | What belongs there                                              |
| ------------------- | -------------------------------- | --------------------------------------------------------------- |
| **The thread**      | Everyone the thread notifies     | The work itself, and as little machinery as the duty can manage |
| **The job summary** | The maintainer who configured it | The whole run: what was decided per item, and what it cost      |
| **The log**         | Whoever is debugging this run    | Everything, in the order it happened                            |

The rule that follows: **the summary is where a run explains itself, and the
thread is not.** A contributor opened the thread to read an issue, and a token
count in the body is noise in a notification email sent to everyone watching.
The same numbers on the job's own page are exactly what the person paying for
the provider came to see.

The cost half of that page comes from the meter, which wraps the provider rather
than being called by a duty. Anything a duty had to remember to report would be
reported for the stages somebody remembered — a stage that is not metered simply
does not appear, which is a hole a reader can see rather than a total that is
quietly wrong. Nothing in it is estimated: a provider that reports no `usage` is
recorded as a request with no numbers, and the page says how many of those there
were.

Writing the summary can never fail a job. It is a record of work that is already
done, and a runner too old to offer the page is not a reason to lose the run.

## The boundary

The core is the product. A duty is a policy about one kind of work, expressed
against it.

**A duty supplies:**

- the prompts for the tiers it uses, and which tiers it uses at all;
- a scorer for its own output shape — the structural rules that make its output
  valid or invalid, in code;
- its idempotency marker format, and the reader that recognises it;
- its evaluation set, in every language it claims to work in;
- its `action.yml` inputs, and nothing that belongs to another duty.

**A duty may not:**

- construct an HTTP client, or call a provider directly;
- read a configuration file, or decide its own permissions;
- write to the forge;
- import platform SDKs or `node:` modules for I/O.

The last one is the cheap mechanical test. If a duty imports anything that talks
to the outside world, the boundary broke, regardless of whether the code works.
A duty's dependencies are the core's exported services and nothing else.

**The core may not** contain anything only one duty could use. A helper added to
`src/core/` while implementing one duty must be usable, unchanged, by a duty
that does something unrelated. If it cannot be, it belongs to the duty, and the
pull request template asks about this for a reason.

## State

There is no database. Everything Reeve knows between runs is a file, in the
user's repository, reviewed like any other file:

| What                                                | Where it lives    | Who writes it            |
| --------------------------------------------------- | ----------------- | ------------------------ |
| Authority — enabled duties, permitted effects       | the warrant file  | the maintainer           |
| Taxonomy — the labels a project actually uses       | the repository    | the maintainer           |
| Corrections — the times a human overrode a decision | the repository    | Reeve, in a pull request |
| Idempotency markers — what has already been done    | the thread itself | Reeve, with the effect   |

The marker living in the thread rather than in a side file is deliberate: it
cannot drift from the thing it describes, and it survives the repository being
forked, migrated, or restored from a backup that predates it.

## One repository, several actions

The platform resolves an action from a subdirectory, so one core and one version
line do not cost callers their ergonomics:

```yaml
- uses: ecoma-io/reeve/triage@v0.6
- uses: ecoma-io/reeve/translate@v0.6
```

Each subdirectory holds a thin `action.yml` naming that duty's inputs and
pointing at the same bundle with a different entry point. A caller configuring
`triage` never sees an input that belongs to `translate`, and neither duty
carries the other's defaults.

The build produces one bundle per duty entry point. Two lists say which:
`tools/build.mjs` names the entry points, and the archive step in
`.github/workflows/release.yml` names the directories that go into the release
tree. A duty that is in the first and not the second builds locally and ships
nothing.

### The root action, which is a signpost

There is an `action.yml` at the repository root as well, and it runs no duty.

It exists because GitHub reads a Marketplace listing from the root and from
nowhere else. That leaves a hazard worth handling rather than tolerating:
`uses: ecoma-io/reeve@v0.6` is the obvious thing for a consumer to write, it
resolves, and it runs. So the root action **explains where each duty ships —
the eight leaf actions — and then fails red with the corrected `uses:` line**
— `src/refusal.ts`, with the message shaped by what the ref actually carries,
and the `leaf-action` output carrying the same corrected line
machine-readable.

The one thing it may not do is succeed quietly. A green run that did nothing is
indistinguishable from a duty that found nothing to do, and
[D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible) does not allow
the two to look alike.

The root is permanently the listing and the refusal — it never becomes a duty
runner itself. A single action that decides which duty to run from an event is
Agent Mode, and Agent Mode is the 2.x line, not a role the root grows into;
see [the 2.x roadmap](roadmap-2x.md).
