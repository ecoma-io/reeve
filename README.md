<p align="center">
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/reeve/releases/latest"><img src="https://img.shields.io/github/v/release/ecoma-io/reeve?sort=semver&color=brightgreen" alt="Latest release" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<!-- reeve:ignore-start -->
<p align="center">
  <sub><strong>English</strong> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.zh.md">中文</a></sub>
</p>
<!-- reeve:ignore-end -->

<p align="center">
  <img src=".github/assets/banner.png" alt="Reeve — repository upkeep, in every contributor's language" width="100%" />
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>A policy-bound agent runtime for autonomous repository operations.</strong><br />
  It sorts, translates, matches, answers, reviews and maintains — unattended, in every language your contributors write in —<br />
  <em>inside an authority you wrote down, which it can read and never widen.</em>
</p>

## What Reeve is

**Reeve is a runtime.** The nine duties are workloads that run on it.

The runtime is the product: one fixed pipeline of reviewed TypeScript that
reads your authority file, reads the thread, resolves language, decides what
code alone can decide, asks a model only for the rest, checks every proposed
effect against the file, defangs what the model wrote, and only then publishes.
A duty supplies a decision and the shape of its result — it never builds an
HTTP client, never reads the warrant, and never writes to GitHub itself.
That boundary is why the second duty costs less than the first, and why using
one duty tells you what any of them can do.

It runs where your code already runs: each duty is a GitHub Action, executing
in your own repository's Actions job, under the token that workflow grants.
There is no service, no account, and no state held anywhere you cannot `rm`.

[The architecture, stage by stage](docs/development/architecture.md) ·
[Duties and the core](docs/concepts/duties-and-the-core.md)

## The problem it solves

Software that can act on your repository needs authority. Hand that authority
to a model, and you have handed it to whoever writes the next issue — because
the model reads their words and cannot tell an instruction from a bug report.
Most tools answer this with a better prompt. Reeve answers it structurally:
**what a run may do is resolved from a file in your repository before a model
is called, and nothing a model returns can change that answer.**

The second problem is the one nobody in this category treats as a problem at
all: your contributors do not share a language, and English-first automation
degrades where it matters least visibly — not in translation, but in
_decisions_. Sorting is worse. Duplicate detection simply fails: two reports
of the same crash, one in Vietnamese and one in English, never meet. Reeve
treats language as something the runtime knows and every duty consumes.
[The north star](docs/doctrine/north-star.md) is the whole argument;
[the language layer](docs/concepts/language-layer.md) is how it works.

## How it works

Eight primitives, all of them in the code today:

| Primitive                 | What it means                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Policy**                | One file — `.github/reeve.yml` — is the whole authority. No file at all runs every duty at the narrowest default defined in code. Write a `duties:` block and enumeration becomes total: a duty the block does not name is granted nothing. The workflow decides _when_, never _what_.        |
| **Capabilities**          | A closed set of nine named effects — `label`, `edit-body`, `comment`, `close`, `assign`, `record`, `propose`, `edit-file`, `open-pr`. A name outside it is refused, not ignored.                                                                                                              |
| **Enforcement**           | Every intended effect is intersected with the grant by a module that has never spoken to a model and has only ever seen the verdict and the parsed file. It is never asked what the model believed it was allowed to do.                                                                      |
| **Evidence boundaries**   | Untrusted text reaches a model only inside a fence keyed to a fresh 64-bit nonce per call — forging the boundary means guessing it. Tool results are fenced the same way, mid-conversation. Machine output is sanitised before publication; the author's own words never are.                 |
| **Bounded reasoning**     | `review` can serve its diff through a read-only tool loop (`review-mode: agentic`): the model lists the changed files, pages the patches worth reading, and pulls base-branch context on demand. Every tool is a read the duty already performs, through the same gates. No tool has effects. |
| **Execution budgets**     | Rounds per pass, calls per round, characters per read and per run; `max-requests` ceilings; `max-diff-chars` and `max-context-chars`; a sweep's `limit` and `since`; a per-request timeout. A loop that spends its budget without a verdict is a failed pass, never a partial one.            |
| **Deterministic control** | The stages that cost nothing run first — the warrant, intake, trust, language, screening — and most items never reach a model. Model output is filtered by a scorer that answers valid or invalid, never "good enough".                                                                       |
| **Auditability**          | Every run explains itself on the job summary: what was decided, what was refused, what each model and each stage cost, and — in the tool loop — what it read. Idempotency markers live in the thread itself, carrying a fingerprint of what a run actually did, so re-running is cheap.       |

**The principle, in one sentence:** the agent decides how to reason and what
evidence to gather; it can never widen its own authority. Untrusted text can
steer which file gets read. It cannot change what the tools can reach, what a
finding must prove to be reported, or what the warrant allows to be written.
The blast radius of a steered read is a worse review, never a wider write.

**Fail-closed, everywhere.** A warrant that does not parse is a run with no
allowlist, so the run stops red. A model answer that does not parse yields no
verdict — not a best-effort read of the parts that looked fine. A run that
could not do its job never exits green with an empty result, because a
maintainer cannot tell that apart from "there was nothing to do". Running out
of provider quota is weather and ends in a warning; a warrant violation ends
in a dropped effect, visible in the outputs. The two are never allowed to look
alike.

[The authority model](docs/concepts/authority-model.md) ·
[The warrant guide](docs/guides/warrant.md) ·
[Every grant, enumerated](docs/reference/warrant-format.md#the-capabilities-table) ·
[Security, stage by stage](docs/security/security.md)

## The duties

Each duty ships as its own action and runs on the same runtime under the same
warrant. "Default" is what it may do when the warrant says nothing about it —
everything past that is one explicit line in the file.

| Duty          | What it does                                                                     | Default capability                                                                                      |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `triage`      | Sorts a backlog against your taxonomy — or the labels the repository already has | `label` — [reference](docs/reference/duties/triage.md)                                                  |
| `translate`   | Puts each thread in every language your project reads, beside the author's words | `edit-body` — [reference](docs/reference/duties/translate.md)                                           |
| `duplicate`   | Finds the thread that already reported this, across the language it arrived in   | none; grant `comment` — [reference](docs/reference/duties/duplicate.md)                                 |
| `respond`     | Gives a stranger a first, useful reply in the language they wrote to you in      | none; grant `comment` — [reference](docs/reference/duties/respond.md)                                   |
| `review`      | Reviews a pull request: deterministic pre-checks, then risk-tiered model passes  | none; grant `comment` — [reference](docs/reference/duties/review.md)                                    |
| `remediation` | Turns a review's standing findings into deterministic proposals, written nowhere | none; grant `propose` — [reference](docs/reference/duties/remediation.md)                               |
| `lifecycle`   | Runs your own staleness policy from timestamps and labels alone; calls no model  | `label`, `comment`, once a `lifecycle:` policy exists — [reference](docs/reference/duties/lifecycle.md) |
| `harmonise`   | Keeps documentation synchronised across languages as the source changes          | none; grant `edit-file`, `open-pr` — [reference](docs/reference/duties/harmonise.md)                    |
| `dependa`     | Maintains dependencies: discovers updates, assesses risk, opens reviewable PRs   | none; grant `edit-file`, `open-pr` — [reference](docs/reference/duties/dependa.md)                      |

What comes after these nine is decided by one strict test — recurring,
uniformly expensive, already abandoned by maintainers, and harder on a
multilingual project.
[Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
rejects most feature requests, on purpose.

## Quick start

Five minutes, two duties, nothing written until you say so:

> [!IMPORTANT]
> Running this workflow will incur charges on your model provider account.
> `dry-run: true` runs the full pipeline and writes nothing — use it first.

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
      - uses: ecoma-io/reeve/triage@v0.8
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.8
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` is required: Reeve reads your warrant file
> (`.github/reeve.yml`) from the local checkout, not the GitHub API.

Triggers, permissions and version pinning:
[Installation](docs/getting-started/installation.md) and
[your first workflow](docs/getting-started/first-workflow.md).
Before you trust a warrant, ask Reeve what it would do —
[the doctor](docs/guides/doctor.md) reads your configuration and reports what
each duty would be granted, writing nothing. Then
[rehearse it](docs/guides/dry-run.md).

## What it refuses to do

Every row is enforced in code, and no warrant entry turns any of them on:

|                                 |                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Act outside its warrant**     | A label your taxonomy does not name is never applied; a capability you did not grant is never used. Checked against the parsed file, never against a model's claim about what it was allowed to do. |
| **Rewrite what a person wrote** | Titles and bodies belong to whoever wrote them. Machine output sits beside human text, marked, never in place of it.                                                                                |
| **Overrule a maintainer**       | It never removes a label a person applied, never reassigns, never reopens. It proposes; you decide.                                                                                                 |
| **Write or run your code**      | Reeve does a duty and stops. Authoring diffs, running tests, fixing bugs — there is no capability for it, and none is planned.                                                                      |
| **Guess when it cannot read**   | Model output that does not parse yields **no** result and a loud red failure — not a best-effort read of the parts that looked fine.                                                                |
| **Pretend it worked**           | A run that cannot do its job fails red. It never reports an empty result in green.                                                                                                                  |
| **Hold your data**              | No account, no dashboard, no hosted state. Everything Reeve knows is plain files in your repository — reviewed in a pull request, deleted with `rm`.                                                |

Reeve holds a write token, reads text written by strangers, and reasons with a
model that text can try to instruct. The design does not ask a prompt to
survive contact with an attacker; it makes the warrant the security property,
enforced as eleven checked invariants.
[Threat model](docs/security/threat-model.md) ·
[Security](docs/security/security.md) ·
[Reporting a vulnerability](SECURITY.md)

## What it costs

The expensive step runs last and least — code decides what it can for nothing,
a cheap model screens what is worth a careful read, and only what survives
reaches the model you chose. Any OpenAI-compatible endpoint works, including a
keyless free tier, and none of them is a migration.
[Cost, with a worked estimate](docs/guides/cost.md) ·
[Providers](docs/guides/providers.md).

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

Where the runtime is going next — sequencing several duties in one run, behind
an authority kernel that is asked for every effect — is written down before it
is built, and **none of it ships today**:
[the agent runtime direction](docs/development/agent-runtime.md).

Reeve is on a `0.x` line under semver's usual promise: an input can still
change on a minor, the release notes say so when one does, and every release
pins `v0.$MINOR` —
[what `0.x` and `1.0` mean here](docs/development/releasing.md#what-0x-and-10-mean-here).

## License

[Apache-2.0](LICENSE).

---

<p align="center">
  <sub>
    Maintained by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
