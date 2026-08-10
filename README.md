<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/reeve"><img src="https://api.scorecard.dev/projects/github.com/ecoma-io/reeve/badge" alt="OpenSSF Scorecard" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/node-24-brightgreen.svg" alt="Node 24" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg" alt="TypeScript strict" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>The work a maintainer gives up first is the work that never stops arriving.</strong><br />
  Reeve does that work — sorting the backlog, translating the thread, the rest as
  it lands — with any OpenAI-compatible model,<br />
  <em>inside an authority you wrote down and it cannot exceed.</em>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#what-it-refuses-to-do"><b>What it refuses to do</b></a> ·
  <a href="docs/north-star.md"><b>North star</b></a> ·
  <a href="docs/"><b>Documentation</b></a>
</p>

> [!IMPORTANT]
> **Reeve is being assembled, not announced.** It consolidates two shipped
> projects — [Dragoman][dragoman] (translation, in production) and
> [Winnow][winnow] (triage, contract shipped) — onto one core. Until `v1`, use
> those. What is settled here is the doctrine and the shape, in
> [`docs/north-star.md`](docs/north-star.md); the code is arriving behind it.

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
      - uses: ecoma-io/reeve/triage@v1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/translate@v1
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

## Duties

A **duty** is one job Reeve does. They share a core — the provider client and
its fallback, several drafts filtered by deterministic scoring, the sanitiser,
the allowlist, the state kept as files in your repository — and differ only in
what they decide.

| Duty        | Status                | What it does                                                                                                              |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `triage`    | folding in from Winnow | Separates a backlog the way a winnowing basket separates grain: the light material leaves cheaply, and only what is left reaches an expensive model. It applies labels you defined, and nothing else. |
| `translate` | folding in from Dragoman | Your contributors write in their language; your maintainers read in theirs. Every issue and pull request carries both, in its own body, with the author's words kept byte-for-byte and marked as the version that counts. |

What comes after them is decided by one test, and it is a strict one: the work
has to recur, be uniformly expensive today, and already be work a maintainer
stopped doing. [Duty D9](docs/north-star.md#d9--a-duty-must-earn-its-place)
rejects most feature requests, on purpose.

## What it refuses to do

The list is short, it is enforced in code, and it is the most important section
on this page.

|                                    |                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Act outside its warrant**        | What Reeve may do is a file in your repository. A label your taxonomy does not name is never applied; a duty you did not enable never runs. Checked against the file — never against the model's own claim about what it was allowed to do. |
| **Rewrite what a person wrote**    | Titles and bodies belong to whoever wrote them. Machine output sits beside human text, marked, never in place of it.                                                                                    |
| **Overrule a maintainer**          | It never removes a label, never reassigns, never reopens. It proposes; you decide.                                                                                                                     |
| **Close, lock, or delete**         | Off by default and staying that way. Everything past the cheapest reversible action is opt-in, one at a time.                                                                                           |
| **Guess when it cannot read**      | Model output that does not parse yields **no** result and a loud failure — not a best-effort read of the parts that looked fine. The shapes that fail to parse are the ones an injection produced.      |
| **Pretend it worked**              | A run that cannot do its job fails red. It never reports an empty result in green to mean something went wrong.                                                                                        |
| **Hold your data**                 | No account, no dashboard, no hosted state. Taxonomy, corrections, configuration and markers are plain files in your repository — reviewed in a pull request, and deleted with `rm`.                     |

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

| Document                                     | For                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [North star](docs/north-star.md)             | What Reeve is for, the doctrine, the roadmap, and what it will never be.   |
| [Documentation index](docs/)                  | Everything else.                                                           |
| [Contributing](CONTRIBUTING.md)               | How to work on it.                                                         |
| [Security](SECURITY.md)                       | The threat model, and how to report something.                             |

## License

[Apache-2.0](LICENSE).

[dragoman]: https://github.com/ecoma-io/dragoman
[winnow]: https://github.com/ecoma-io/winnow
