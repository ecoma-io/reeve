# Reeve documentation

The root [`README.md`](../README.md) is the pitch. This directory is the part a
reviewer, a security team, or a maintainer deciding how much authority to grant
actually needs: what each duty does, what the core forbids it from doing, and
which of its claims are measured rather than assumed.

[`north-star.md`](north-star.md) comes first, and not as a courtesy. It is the
document the others answer to — a change that contradicts it is not merged until
it changes first.

| Document                                     | The question it answers                                                                                                                                     | Status  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`north-star.md`](north-star.md)             | What Reeve is for, the doctrine every duty is bound by, the shape, the roadmap, and the things it will never be. Normative over everything else in here.        | written |
| `spec.md`                                    | The core, stage by stage, and what each stage is contractually forbidden from doing. Where a duty's boundary with the core is drawn.                            | planned |
| `warrant.md`                                 | The authority file: its format, why authority lives in a reviewed file rather than in workflow YAML, and why the allowlist is checked in code.                  | planned |
| `security.md`                                | The threat model. Prompt injection from a stranger's thread, the write authority Reeve asks for and the authority it refuses.                                   | planned |
| `cost.md`                                    | Why the cheap screening tier exists, what it decides with no model at all, and how to reason about spend on a backlog you have not run yet.                     | planned |
| `memory.md`                                  | The corrections store: how a maintainer's correction becomes retrieval context for every duty, and why that beats a longer prompt.                              | planned |
| `evaluation.md`                              | How a duty proves it works on **your** project before it is allowed to act on it.                                                                              | planned |
| `platform-limits.md`                         | The GitHub behaviours that shape the design rather than being worked around: token recursion suppression, rate limits, search caps, cache scoping.              | planned |
| `duties/`                                    | One document per duty — its inputs, its idempotency marker, its refusals, its evaluation set.                                                                   | planned |

## Status

Reeve consolidates [Dragoman][dragoman] and [Winnow][winnow] onto one core. The
doctrine and the shape are settled; the code is being folded in behind them.
Until `v1` ships, those two repositories are what you run.

So the documents here are **normative rather than descriptive**: they state what
a stage must do, and each stage lands as the pull request that makes its section
true. Where a document describes something not yet built, it says so in that
section rather than in a global disclaimer you would have to remember.

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

[dragoman]: https://github.com/ecoma-io/dragoman
[winnow]: https://github.com/ecoma-io/winnow
