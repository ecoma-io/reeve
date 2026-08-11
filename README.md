<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/reeve"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/reeve/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/node-24-brightgreen.svg" alt="Node 24" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg" alt="TypeScript strict" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Reeve — repository upkeep, in every contributor's language" width="100%" />
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>The best bug report you ever received was written in a language you do not read.</strong><br />
  Reeve keeps a repository's recurring work moving — sorting, matching, answering —<br />
  <em>in whatever language it arrived in, inside an authority you wrote down and it cannot exceed.</em>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-it-refuses-to-do"><b>What it refuses to do</b></a> ·
  <a href="docs/north-star.md"><b>North star</b></a> ·
  <a href="docs/"><b>Documentation</b></a>
</p>

> [!IMPORTANT]
> **Reeve is being assembled, not announced.** It is on a `0.x` line: two
> duties ship and are dogfooded on this repository, and the rest of
> [the roadmap](docs/north-star.md#7-roadmap) is still open. `1.0` is the
> release where all of it is done — until then an input can still be renamed on
> a minor, and the release notes will say so.

## Why this exists

A project's contributors do not all share a language. Its automation acts as
though they do.

Every serious tool in this category is English-first, and it shows in the place
it matters least visibly: not in translation, but in _decisions_. Sorting is
worse. Duplicate detection simply fails — two reports of the same crash, one in
Vietnamese and one in English, never meet. The person who wrote the most useful
report you got this month gets a slower, worse answer than someone who wrote a
vaguer one in English.

Reeve treats language as something the core knows and every duty consumes, not
as one feature bolted on beside the others. That is the whole thesis, and
[`docs/north-star.md`](docs/north-star.md) is where it is argued properly.

## Quick start

```yaml
name: Reeve

on:
  issues:
    types: [opened, reopened, edited]

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/translate@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          languages: en, vi
```

One repository, one version line, one core — and each duty keeps its own inputs,
so nothing you write is meaningless to the thing you are configuring.

## A reeve, and why that is the word

A reeve was the officer who ran an estate on the owner's behalf: the daily work,
done without being asked each time, inside an authority the owner had granted
and could withdraw at any moment. The owner stayed the owner.

That is the whole product. Everything below follows from it.

## Duties, and the ladder they sit on

A **duty** is one job Reeve does, and none of them is switched on by a mode —
they sit on [a ladder](docs/north-star.md#3-the-ladder), and what runs is
exactly as much as you wrote down. The `uses:` line alone gets you the bottom
rung: the narrowest authority Reeve knows how to grant, built from the labels
your repository already has. Write a taxonomy and you climb one rung; write
capabilities, `owner`, `languages` and you climb another. Nothing widens on
its own.

Every duty shares a core — the provider client and its fallback, the language
layer, several drafts filtered by deterministic scoring, the sanitiser, the
allowlist, the state kept as files in your repository — and differs only in
what it decides:

| Duty        | Status  | What it does                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`    | ships   | Sorts a backlog against the taxonomy you wrote — or, at the bottom rung, against the labels your repository already has. The easy majority is decided by code for nothing, and only what survives that reaches a model. It applies labels you defined and nothing else — as well in Vietnamese as in English, or it is a bug. |
| `translate` | ships   | Your contributors write in their language; your maintainers read in theirs. Every issue and pull request carries both, in its own body, with the author's words kept byte-for-byte and marked as the version that counts.                                                                                                     |
| `duplicate` | Stage 5 | Finds the thread that already reported this — **across the language it was reported in**. Nothing else in this category does that, because everything else matches within one language. Top rung: opt-in, never on by accident.                                                                                               |
| `respond`   | ships   | Gives a stranger a first, useful reply in the language they wrote to you in, grounded in what the project already knows. Answers once and never converses. Top rung: granted nothing until a warrant names it.                                                                                                                |

What comes after them is decided by one test, and it is a strict one: the work
has to recur, be uniformly expensive today, already be work a maintainer stopped
doing, and be harder on a project whose contributors do not share a language.
[Doctrine D10](docs/north-star.md#d10--a-duty-must-earn-its-place) rejects most
feature requests, on purpose.

## What it refuses to do

The list is short, it is enforced in code, and it is the most important section
on this page.

|                                 |                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Act outside its warrant**     | What Reeve may do is a file in your repository, or its narrowest built-in default where you wrote no file at all. A label your taxonomy does not name is never applied; a capability you did not grant is never used. Checked against the file — never against the model's own claim about what it was allowed to do. |
| **Rewrite what a person wrote** | Titles and bodies belong to whoever wrote them. Machine output sits beside human text, marked, never in place of it.                                                                                                                                                                                                  |
| **Overrule a maintainer**       | It never removes a label, never reassigns, never reopens. It proposes; you decide.                                                                                                                                                                                                                                    |
| **Close, lock, or delete**      | Off by default and staying that way. Everything past the cheapest reversible action is opt-in, one at a time.                                                                                                                                                                                                         |
| **Write code**                  | Reeve reads and decides. It does not author diffs, run your tests, or fix your bugs. That is a different tool, and a crowded one.                                                                                                                                                                                     |
| **Guess when it cannot read**   | Model output that does not parse yields **no** result and a loud failure — not a best-effort read of the parts that looked fine. The shapes that fail to parse are the ones an injection produced.                                                                                                                    |
| **Pretend it worked**           | A run that cannot do its job fails red. It never reports an empty result in green to mean something went wrong.                                                                                                                                                                                                       |
| **Hold your data**              | No account, no dashboard, no hosted state. Taxonomy, corrections, configuration and markers are plain files in your repository — reviewed in a pull request, and deleted with `rm`.                                                                                                                                   |

## Cost

Three tiers and the first is free. Most of a backlog is decided by code — an
empty body, obvious spam, a thread Reeve has already handled and recognises as
its own. What survives that reaches a small model. What survives the small model
is the minority that was always worth a careful read, and only it reaches an
expensive one.

Providers serving OpenAI-compatible models with no key at all are a supported
configuration, not a tolerated one: point `base-url` at one and give Reeve
several models. Free models are individually weak and operationally flaky, which
is exactly what multi-draft scoring exists for — three cheap attempts filtered
deterministically cost calls instead of money.

## Documentation

| Document                                         | For                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [North star](docs/north-star.md)                 | What Reeve is for, the doctrine, the roadmap, and what it will never be. |
| [Installation](docs/usage/installation.md)       | Adding a duty to a workflow — triggers, permissions, versions.           |
| [The warrant](docs/usage/warrant.md)             | Writing down what Reeve is allowed to do to your repository.             |
| [Languages](docs/usage/languages.md)             | Who writes in what, who reads in what, and what detection costs.         |
| [The sweep](docs/usage/sweep.md)                 | Working a whole backlog on a schedule instead of one thread at a time.   |
| [Cost](docs/usage/cost.md)                       | What a backlog costs before you point it at one — including at zero.     |
| [Troubleshooting](docs/usage/troubleshooting.md) | A run went red, or went green and did nothing.                           |
| [Architecture](docs/development/architecture.md) | The pipeline, the boundaries, and how to change it.                      |
| [Threat model](docs/development/security.md)     | What holds when the model does what the attacker asked.                  |
| [Contributing](CONTRIBUTING.md)                  | How to work on it.                                                       |
| [Reporting a vulnerability](SECURITY.md)         | The private channel. Never a public issue.                               |

[`docs/`](docs/) is the full index, split by audience.

## License

[Apache-2.0](LICENSE).

---

<p align="center">
  <img src=".github/assets/logo.png" alt="" width="56" /><br />
  <sub>
    Part of the <a href="https://ecoma.io">Ecoma</a> ecosystem ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Organisation</a>
  </sub>
</p>
