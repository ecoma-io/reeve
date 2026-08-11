# Reeve documentation

The root [`README.md`](../README.md) is the pitch. This directory is the part a
reviewer, a security team, or a maintainer deciding how much authority to grant
actually needs.

It is split by who is reading, because the two audiences want opposite things
from the same system. Somebody installing Reeve wants to know what to write in a
file and what it will do to their repository. Somebody changing Reeve wants to
know why the code is shaped the way it is and which parts they are not allowed
to move.

| Where                                   | Who it is for                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| [`north-star.md`](north-star.md)        | Everyone. What Reeve is for, the doctrine, the roadmap, and what it will never be. |
| [`usage/`](usage/README.md)             | People installing and running Reeve on their own project.                          |
| [`development/`](development/README.md) | People changing Reeve: architecture, boundaries, evaluation, threat model.         |

[`north-star.md`](north-star.md) comes first, and not as a courtesy. It is the
document the others answer to — a change that contradicts it is not merged until
it changes first.

## Status

Reeve is on a `0.x` line. The doctrine and the shape are settled; the code is
landing behind them, stage by stage, and **the version number is read off
[the roadmap](north-star.md#6-roadmap)** — `0.x` while a stage is still open,
`1.0` when every one of them is done
([the rule](development/releasing.md#what-0x-and-10-mean-here)).

So the documents here are **normative rather than descriptive**: they state what
a stage must do, and each stage lands as the pull request that makes its section
true. Where a document describes something not yet built, it says so in that
section rather than in a global disclaimer you would have to remember.

The two duties that ship — [`triage`](usage/duties/triage.md) and
[`translate`](usage/duties/translate.md) — have their contracts written in full,
because writing a stranger's configuration page first is how you find out that
two of your inputs mean the same thing. `duplicate` and `respond` have no pages,
because a page about an input that does not exist yet is worse than no page.

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
