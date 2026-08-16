<p align="center">
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/reeve"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/reeve/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/reeve/releases/latest"><img src="https://img.shields.io/github/v/release/ecoma-io/reeve?sort=semver&color=brightgreen" alt="Latest release" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Reeve — repository upkeep, in every contributor's language" width="100%" />
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>The best bug report you ever received was written in a language you do not read.</strong><br />
  Reeve keeps a repository's recurring work moving — sorting, matching, answering, maintaining dependencies —<br />
  <em>in whatever language it arrived in, inside an authority you wrote down and it cannot exceed.</em>
</p>

<p align="center">
  Reeve labels, translates, deduplicates, answers issues, manages lifecycles, synchronises documentation, and maintains dependencies from inside your own
  warrant file — not a chatbot, not a hosted service, not a workflow engine.
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-it-refuses-to-do"><b>What it refuses to do</b></a> ·
  <a href="docs/doctrine/north-star.md"><b>North star</b></a> ·
  <a href="docs/"><b>Documentation</b></a>
</p>

> [!IMPORTANT]
> **Reeve is being assembled, not announced.** It is on a `0.x` line: eight
> duties ship, dogfooded on this repository as they land — `duplicate` and
> `respond` in report-only mode, writing verdicts to job summaries and touching
> nothing — and the rest of [the roadmap](docs/doctrine/north-star.md#7-roadmap) is
> still open. `1.0` is the
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
[the north star](docs/doctrine/north-star.md) is where it is argued properly.

## Quick start

> [!IMPORTANT]
> Running this workflow will incur charges on your OpenAI account.
> See [Cost](docs/guides/cost.md) for estimates. `dry-run: true` runs the full
> pipeline without writing anything — use it first.

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
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/triage@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          languages: en, vi
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` is required: Reeve reads your warrant file
> (`.github/reeve.yml`) from the local checkout, not the GitHub API.
> Without checkout, your warrant restrictions are silently bypassed.
> At level 0 — no warrant file — this step can be omitted, but adding it
> now costs nothing and prevents a silent misconfiguration later.

One repository, one version line, one core — and each duty keeps its own inputs,
so nothing you write is meaningless to the thing you are configuring.

Before granting a capability for real, check what your warrant would actually
do with `uses: ecoma-io/reeve@v0.6` and `doctor: true` — it reads your file
and this repository's labels and reports what a duty would find, writing
nothing. See [Doctor](docs/guides/doctor.md).

## A reeve, and why that is the word

A reeve was the officer who ran an estate on the owner's behalf: the daily work,
done without being asked each time, inside an authority the owner had granted
and could withdraw at any moment. The owner stayed the owner.

That is the whole product. Everything below follows from it.

## What it refuses to do

The list is short, it is enforced in code, and it is the most important section
on this page.

|                                                   |                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Act outside its warrant**                       | What Reeve may do is a file in your repository, or its narrowest built-in default where you wrote no file at all. A label your taxonomy does not name is never applied; a capability you did not grant is never used. Checked against the file — never against the model's own claim about what it was allowed to do. |
| **Rewrite what a person wrote**                   | Titles and bodies belong to whoever wrote them. Machine output sits beside human text, marked, never in place of it.                                                                                                                                                                                                  |
| **Overrule a maintainer**                         | It never removes a label a person applied, never reassigns, never reopens. It proposes; you decide. (The one bounded carve-out: [`lifecycle`'s clock-hand exception](docs/reference/duties/lifecycle.md#the-clock-hand-exception) takes back a label its own actor applied, and only that.)                           |
| **Close, lock, or delete**                        | Off by default and staying that way. Everything past the cheapest reversible action is opt-in, one at a time.                                                                                                                                                                                                         |
| **Modify repository state outside its authority** | Reeve writes files and opens pull requests only through explicit capabilities (`edit-file`, `open-pr`) that a maintainer granted in the warrant. Dependency updates remain reviewable proposals; model output is evidence, never permission, and no run can widen its own grant.                                      |
| **Guess when it cannot read**                     | Model output that does not parse yields **no** result and a loud failure — not a best-effort read of the parts that looked fine. The shapes that fail to parse are the ones an injection produced.                                                                                                                    |
| **Pretend it worked**                             | A run that cannot do its job fails red. It never reports an empty result in green to mean something went wrong.                                                                                                                                                                                                       |
| **Hold your data**                                | No account, no dashboard, no hosted state. Taxonomy, corrections, configuration and markers are plain files in your repository — reviewed in a pull request, and deleted with `rm`.                                                                                                                                   |

## Duties, and the ladder they sit on

A **duty** is one job Reeve does, and none of them is switched on by a mode —
what runs is exactly as much as you wrote down, one rung of
[the ladder](docs/concepts/authority-model.md) at a time. Every duty shares a
core — the provider client and its fallback, the language layer, several
drafts filtered by deterministic scoring, the sanitiser, the allowlist, the
state kept as files in your repository — and differs only in what it decides:

| Duty        | What it does                                                                                                                                                                                                                                  | Reference                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `triage`    | Sorts a backlog against the taxonomy you wrote — or, at the bottom rung, against the labels your repository already has.                                                                                                                      | [Reference](docs/reference/duties/triage.md)    |
| `translate` | Puts every issue and pull request in every language your project reads — in the thread's own body, marked as the version that counts.                                                                                                         | [Reference](docs/reference/duties/translate.md) |
| `duplicate` | Finds the thread that already reported this — across the language it was reported in. Top rung: opt-in, never on by accident.                                                                                                                 | [Reference](docs/reference/duties/duplicate.md) |
| `respond`   | Gives a stranger a first, useful reply in the language they wrote to you in, grounded in what the project already knows. Top rung: granted nothing until a warrant names it.                                                                  | [Reference](docs/reference/duties/respond.md)   |
| `lifecycle` | Runs your own staleness policy — reminders, un-staling, and a final close as not planned — from timestamps and labels alone. No model is ever called.                                                                                         | [Reference](docs/reference/duties/lifecycle.md) |
| `harmonise` | Synchronises your documentation across languages and formats — translating README files and keeping them current as the source changes. Report-only at level 0 — needs `capabilities:` in a warrant to act.                                   | [Reference](docs/reference/duties/harmonise.md) |
| `dependa`   | Maintains your dependencies — discovers updates, assesses risk, and opens reviewable PRs within the authority you granted. Report-only at level 0 — needs `capabilities:` in a warrant to act.                                                | [Reference](docs/reference/duties/dependa.md)   |
| `review`    | Reviews a pull request — deterministic pre-checks plus one model pass, reported as a single owned comment that tracks its findings across `synchronize` events instead of reposting them. Top rung: granted nothing until a warrant names it. | [Reference](docs/reference/duties/review.md)    |

What comes after them is decided by one test, and it is a strict one: the work
has to recur, be uniformly expensive today, already be work a maintainer stopped
doing, and be harder on a project whose contributors do not share a language.
[Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
rejects most feature requests, on purpose.

## Cost

Reeve is arranged so the expensive step runs last and least: code decides the
easy majority for nothing, a cheap model screens what survives that, and only
the minority that was always worth a careful read reaches the model you chose.

| Tier                    | Decides                                                                                       | Costs         |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| **Code**                | Empty bodies, unfilled templates, obvious spam, exact repeats, a thread Reeve already handled | Nothing       |
| **A cheap model**       | Is this worth a careful read — spam, off-topic, out of scope                                  | Very little   |
| **The model you chose** | The actual verdict, on what survived                                                          | The real bill |

Providers serving OpenAI-compatible models with no key at all are a supported
configuration, not a tolerated one: point `base-url` at one and give Reeve
several models. Full breakdown, including a worked estimate and how to measure
it instead of estimating it: [Cost](docs/guides/cost.md).

## Documentation

[`docs/`](docs/) is the full index, organized by who's reading. Start here:

| If you are…                  | Start at                                                |
| ---------------------------- | ------------------------------------------------------- |
| New to Reeve                 | [Getting started](docs/getting-started/installation.md) |
| Deciding whether to adopt it | [The authority model](docs/concepts/authority-model.md) |
| Running it day to day        | [Guides](docs/guides/warrant.md)                        |
| Reviewing it for security    | [Threat model](docs/security/threat-model.md)           |
| Changing the code            | [Development](docs/development/README.md)               |

## License

[Apache-2.0](LICENSE).

---

<p align="center">
  <img src=".github/assets/logo.png" alt="" width="56" /><br />
  <sub>
    Reeve is developed at <a href="https://github.com/ecoma-io/reeve">github.com/ecoma-io/reeve</a>.
  </sub>
</p>
