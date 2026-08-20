<p align="center">
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
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
  Reeve keeps a repository's recurring work moving — sorting, matching, answering, reviewing, maintaining dependencies —<br />
  <em>in whatever language it arrived in, inside an authority you wrote down and it cannot exceed.</em>
</p>

## Why Reeve

Your contributors do not all share a language, and every serious tool in this
category acts as though they do. It shows where it matters least visibly: not
in translation, but in **decisions**. Sorting is worse. Duplicate detection
simply fails — two reports of the same crash, one in Vietnamese and one in
English, never meet. The person who wrote the most useful report you got this
month gets a slower, worse answer than someone who wrote a vaguer one in
English.

Reeve treats language as something the core knows and every duty consumes.
And it runs the way its name suggests: a reeve was the officer who ran an
estate on the owner's behalf — the daily work, done without being asked each
time, inside an authority the owner granted and could withdraw at any moment.
The owner stayed the owner. Not a chatbot, not a hosted service, not a
workflow engine — nine duties, one warrant file, your repository.
[The north star](docs/doctrine/north-star.md) is the whole argument.

## The duties

Each duty is its own action. What runs is exactly as much as you wrote down,
one rung of [the ladder](docs/concepts/authority-model.md) at a time.

| Duty          | What it does                                                                                                                                                            | Reference                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `triage`      | Sorts a backlog against the taxonomy you wrote — or, at the bottom rung, against the labels your repository already has.                                                | [Reference](docs/reference/duties/triage.md)      |
| `translate`   | Puts every issue and pull request in every language your project reads — in the thread's own body, marked as the version that counts.                                   | [Reference](docs/reference/duties/translate.md)   |
| `duplicate`   | Finds the thread that already reported this — across the language it was reported in. Opt-in, never on by accident.                                                     | [Reference](docs/reference/duties/duplicate.md)   |
| `respond`     | Gives a stranger a first, useful reply in the language they wrote to you in, grounded in what the project already knows. Granted nothing until a warrant names it.      | [Reference](docs/reference/duties/respond.md)     |
| `review`      | Reviews a pull request — deterministic pre-checks, then risk-tiered model passes synthesized into one owned comment that tracks its findings instead of reposting them. | [Reference](docs/reference/duties/review.md)      |
| `remediation` | Turns a review's standing findings into deterministic remediation proposals — recorded on the job summary, never written to the repository.                             | [Reference](docs/reference/duties/remediation.md) |
| `lifecycle`   | Runs your own staleness policy — reminders, un-staling, a final close as not planned — from timestamps and labels alone. No model is ever called.                       | [Reference](docs/reference/duties/lifecycle.md)   |
| `harmonise`   | Keeps your documentation synchronised across languages as the source changes. Report-only until a warrant grants it more.                                               | [Reference](docs/reference/duties/harmonise.md)   |
| `dependa`     | Maintains your dependencies — discovers updates, assesses risk, opens reviewable PRs. Report-only until a warrant grants it more.                                       | [Reference](docs/reference/duties/dependa.md)     |

What comes after these nine is decided by one strict test — recurring,
uniformly expensive, already abandoned by maintainers, and harder on a
multilingual project.
[Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
rejects most feature requests, on purpose.

## Quick start

Five minutes, two duties, nothing written until you say so:

> [!IMPORTANT]
> Running this workflow will incur charges on your model provider account.
> `dry-run: true` runs the full pipeline without writing anything — use it first.

1. **Store a model key** as a repository secret named `OPENAI_API_KEY` — or
   point `base-url` at any OpenAI-compatible endpoint, including a keyless
   free one: [Providers and the runtime](docs/guides/providers.md).
2. **Add a workflow:**

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
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` is required: Reeve reads your warrant file
> (`.github/reeve.yml`) from the local checkout, not the GitHub API.

The full walkthrough — triggers, permissions, pinning:
[Installation](docs/getting-started/installation.md) and
[your first workflow](docs/getting-started/first-workflow.md). Before you
trust a warrant, ask Reeve what it would do:
[the doctor](docs/guides/doctor.md) reads your configuration and reports what
each duty would be granted, writing nothing.

## An authority you wrote down

One file — `.github/reeve.yml` — is the whole authority. Write nothing and
every duty runs at its narrowest built-in default. Write a `duties:` block
and enumeration becomes total: a duty the block does not name is granted
nothing at all. The workflow file decides _when_ a run happens; it cannot
grant a capability, and neither can anything a model says.
Every widening is a diff to the same file, reviewed like any other change.

[The authority model](docs/concepts/authority-model.md) ·
[The warrant guide](docs/guides/warrant.md) ·
[Every grant, enumerated](docs/reference/warrant-format.md#the-capabilities-table)

## What it refuses to do

The most important table on this page, and every row is enforced in code:

|                                 |                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Act outside its warrant**     | A label your taxonomy does not name is never applied; a capability you did not grant is never used. Checked against the parsed file — never against the model's own claim about what it was allowed to do. |
| **Rewrite what a person wrote** | Titles and bodies belong to whoever wrote them. Machine output sits beside human text, marked, never in place of it.                                                                                       |
| **Overrule a maintainer**       | It never removes a label a person applied, never reassigns, never reopens. It proposes; you decide.                                                                                                        |
| **Close, lock, or delete**      | Off by default and staying that way. Everything past the cheapest reversible action is opt-in, one at a time.                                                                                              |
| **Guess when it cannot read**   | Model output that does not parse yields **no** result and a loud red failure — not a best-effort read of the parts that looked fine.                                                                       |
| **Pretend it worked**           | A run that cannot do its job fails red. It never reports an empty result in green.                                                                                                                         |
| **Hold your data**              | No account, no dashboard, no hosted state. Everything Reeve knows is plain files in your repository — reviewed in a pull request, deleted with `rm`.                                                       |

The reasoning under each boundary is in
[the threat model](docs/security/threat-model.md).

## What it costs

The expensive step runs last and least:

| Tier                    | Decides                                                                        | Costs         |
| ----------------------- | ------------------------------------------------------------------------------ | ------------- |
| **Code**                | Empty bodies, unfilled templates, exact repeats, threads Reeve already handled | Nothing       |
| **A cheap model**       | Is this worth a careful read — spam, off-topic, out of scope                   | Very little   |
| **The model you chose** | The actual verdict, on what survived                                           | The real bill |

Any OpenAI-compatible endpoint works — OpenAI, a gateway, a self-hosted
model, a keyless free tier — and none of them is a migration.
[Cost](docs/guides/cost.md), with a worked estimate ·
[Providers](docs/guides/providers.md).

## Security

Reeve holds a write token, reads input written by strangers, and reasons with
a model that input can try to instruct. The design does not ask a prompt to
survive contact with an attacker — it makes the warrant the security
property, enforced as ten tested invariants: untrusted text is fenced and
framed as data, machine output is sanitised before publishing, and nothing a
model claims about its own permissions is ever believed.
[Security, stage by stage](docs/security/security.md) ·
[Threat model](docs/security/threat-model.md) ·
[Reporting a vulnerability](SECURITY.md)

## Documentation

[`docs/`](docs/) is the full index, organized by who's reading:

| If you are…                  | Start at                                                |
| ---------------------------- | ------------------------------------------------------- |
| New to Reeve                 | [Getting started](docs/getting-started/installation.md) |
| Deciding whether to adopt it | [The authority model](docs/concepts/authority-model.md) |
| Running it day to day        | [Guides](docs/guides/warrant.md)                        |
| Something looks wrong        | [Troubleshooting](docs/guides/troubleshooting.md)       |
| On an early `0.x` install    | [Migration](docs/guides/migration.md)                   |
| Reviewing it for security    | [Threat model](docs/security/threat-model.md)           |
| Changing the code            | [Development](docs/development/README.md)               |

Reeve is on a `0.x` line under semver's usual promise: an input can still
change on a minor, the release notes say so when one does, and every release
pins `v0.$MINOR` —
[what `0.x` and `1.0` mean here](docs/development/releasing.md#what-0x-and-10-mean-here).

## License

[Apache-2.0](LICENSE).

---

<p align="center">
  <img src=".github/assets/logo.png" alt="" width="56" /><br />
  <sub>
    Reeve is developed at <a href="https://github.com/ecoma-io/reeve">github.com/ecoma-io/reeve</a>.
  </sub>
</p>
