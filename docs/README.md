# Reeve documentation

A project's contributors do not all share a language. Its automation acts as
though they do.

Every serious tool in this category is English-first, and it shows in the
place it matters least visibly: not in translation, but in _decisions_.
Sorting is worse. Duplicate detection simply fails — two reports of the same
crash, one in Vietnamese and one in English, never meet. The person who wrote
the most useful report you got this month gets a slower, worse answer than
someone who wrote a vaguer one in English.

Reeve treats language as something the core knows and every duty consumes,
not as one feature bolted on beside the others. That is the whole thesis, and
[`doctrine/north-star.md`](doctrine/north-star.md) is where it is argued
properly — it comes first in everything below, and not as a courtesy: it is
the document the rest of this directory answers to, and a change that
contradicts it is not merged until it changes first.

## A note on the claims in here

Reeve's whole argument is that a general model is unreliable about decisions a
project made for itself, so a document that asserted Reeve's own accuracy from
confidence would be arguing against itself.

Every quantitative claim in this directory is one of three things, and always
says which:

- **documented** — a link to the platform or provider documentation that states it;
- **measured** — a number this repository produced, with the command that produces it again;
- **estimated** — arithmetic over a stated assumption, with the assumption written down.

A fourth category is not available.

## Find your path

Five kinds of reader end up here, and they want different things from the same
system.

**New to Reeve.** Never run it before, want a working workflow fast. Start at
[Installation](getting-started/installation.md), then
[a complete first workflow](getting-started/first-workflow.md).

**Deciding whether to adopt it.** Want to know what it does and what it
refuses to do before installing anything. Start at
[the root README's refusal table](../README.md#what-it-refuses-to-do), then
[the authority model](concepts/authority-model.md), then skim
[the duty reference pages](reference/duties/) — you can read a duty's whole
contract without installing it.

**Running it day to day.** Already installed, need to write a warrant, add a
language, run a sweep, control cost, or work out why a run did not do what you
expected. Start at [the guides](guides/warrant.md), and keep
[the duty reference pages](reference/duties/) open beside them.

**Reviewing it for security.** Deciding how much authority to grant, or
auditing what is already granted. Start at
[the threat model](security/threat-model.md) for the summary, then
[security](security/security.md) for the mechanics.

**Changing the code.** Contributing to Reeve itself. Start at
[development](development/README.md), which routes you through architecture,
adding a duty, evaluation, and releasing.

## Status

Reeve is on a `0.x` line. The doctrine and the shape are settled; the code is
landing behind them, stage by stage, and **the version number is read off
[the roadmap](doctrine/north-star.md#7-roadmap)** — `0.x` while a stage is
still open, `1.0` when every one of them is done
([the rule](development/releasing.md#what-0x-and-10-mean-here)).

So the documents here are **normative rather than descriptive**: they state
what a stage must do, and each stage lands as the pull request that makes its
section true. Where a document describes something not yet built, it says so
in that section rather than in a global disclaimer you would have to
remember.

Five duties ship — [`triage`](reference/duties/triage.md),
[`translate`](reference/duties/translate.md),
[`duplicate`](reference/duties/duplicate.md),
[`respond`](reference/duties/respond.md), and
[`lifecycle`](reference/duties/lifecycle.md) — and the first four are
dogfooded on this repository today: `triage` and `translate` acting on real
threads, `duplicate` and `respond` in report-only mode, writing verdicts to
job summaries and touching nothing. `lifecycle` is the newest of the five and
does not yet have a workflow of its own here.

## Full index

Every page, one row each, for anyone the five paths above didn't fit.

| Page                                                                       | Doc type                 | What it's for                                                                     |
| -------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| [`README.md`](../README.md)                                                | overview                 | Say what Reeve is, prove it with a working quick start, name what it refuses.     |
| [`doctrine/north-star.md`](doctrine/north-star.md)                         | doctrine                 | Normative doctrine — the document the others answer to. Unchanged.                |
| [`getting-started/installation.md`](getting-started/installation.md)       | tutorial                 | Get a first workflow running in five minutes.                                     |
| [`getting-started/first-workflow.md`](getting-started/first-workflow.md)   | tutorial                 | Walk a complete two-duty workflow end to end.                                     |
| [`guides/warrant.md`](guides/warrant.md)                                   | how-to                   | Write and extend a warrant file for your repository.                              |
| [`guides/languages.md`](guides/languages.md)                               | how-to                   | Configure which languages Reeve recognizes and how detection works in practice.   |
| [`guides/sweep.md`](guides/sweep.md)                                       | how-to                   | Run Reeve against a backlog instead of one thread.                                |
| [`guides/cost.md`](guides/cost.md)                                         | how-to                   | Control and predict what a run costs.                                             |
| [`guides/troubleshooting.md`](guides/troubleshooting.md)                   | how-to                   | Diagnose a run that didn't do what you expected.                                  |
| [`guides/dry-run.md`](guides/dry-run.md)                                   | how-to                   | Rehearse a run with nothing written.                                              |
| [`concepts/authority-model.md`](concepts/authority-model.md)               | concept                  | Explain capabilities, the warrant, and the ladder as one coherent model.          |
| [`concepts/language-layer.md`](concepts/language-layer.md)                 | concept                  | Explain the three language roles and how detection reasons about them.            |
| [`concepts/duties-and-the-core.md`](concepts/duties-and-the-core.md)       | concept                  | Explain the boundary between the core and a duty, and why it's drawn there.       |
| [`reference/duties/triage.md`](reference/duties/triage.md)                 | reference                | Full contract for the triage duty.                                                |
| [`reference/duties/translate.md`](reference/duties/translate.md)           | reference                | Full contract for the translate duty.                                             |
| [`reference/duties/duplicate.md`](reference/duties/duplicate.md)           | reference                | Full contract for the duplicate duty.                                             |
| [`reference/duties/respond.md`](reference/duties/respond.md)               | reference                | Full contract for the respond duty.                                               |
| [`reference/duties/lifecycle.md`](reference/duties/lifecycle.md)           | reference                | Full contract for the lifecycle duty.                                             |
| [`reference/warrant-format.md`](reference/warrant-format.md)               | reference                | Full warrant YAML schema.                                                         |
| [`reference/platform-limits.md`](reference/platform-limits.md)             | reference                | Enumerate GitHub/provider platform behaviors Reeve works around.                  |
| [`reference/root-action.md`](reference/root-action.md)                     | reference                | Contract for the root signpost action.                                            |
| [`security/threat-model.md`](security/threat-model.md)                     | security                 | Answer "what can go wrong and what stops it" without reading architecture.        |
| [`security/security.md`](security/security.md)                             | security                 | Full trust-boundary and sanitising mechanics.                                     |
| [`security/reporting.md`](security/reporting.md)                           | security                 | How to report a vulnerability.                                                    |
| [`development/README.md`](development/README.md)                           | overview                 | Route a contributor through the development docs; state the ground rules.         |
| [`development/architecture.md`](development/architecture.md)               | architecture             | The pipeline, stage by stage, and its failure semantics.                          |
| [`development/duties.md`](development/duties.md)                           | how-to                   | Add a new duty.                                                                   |
| [`development/language.md`](development/language.md)                       | reference                | Detection's evaluation harness and open questions (contributor-facing remainder). |
| [`development/evaluation.md`](development/evaluation.md)                   | how-to                   | Build and run a duty's evaluation fixture set.                                    |
| [`development/releasing.md`](development/releasing.md)                     | how-to                   | Cut a release; what 0.x/1.0 mean.                                                 |
| [`development/agent-runtime.md`](development/agent-runtime.md)             | architecture (direction) | The 2.x agent runtime's architecture, and the entry to the 2.x set — not shipped. |
| [`development/roadmap-2x.md`](development/roadmap-2x.md)                   | roadmap (direction)      | The dependency-ordered phases from today's duties to Agent Mode.                  |
| [`development/agent-governance.md`](development/agent-governance.md)       | reference (draft)        | The `.reeve/` governance tree, and how a warrant lifts into it.                   |
| [`development/agent-compatibility.md`](development/agent-compatibility.md) | contract (direction)     | What every 1.x consumer is promised across the 2.x line.                          |
