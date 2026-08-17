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
  Reeve keeps a repository's recurring work moving — sorting, matching, answering, reviewing, maintaining dependencies —<br />
  <em>in whatever language it arrived in, inside an authority you wrote down and it cannot exceed.</em>
</p>

<p align="center">
  Reeve labels, translates, deduplicates, answers issues, reviews pull requests, manages lifecycles, synchronises documentation, and maintains dependencies from inside your own
  warrant file — not a chatbot, not a hosted service, not a workflow engine.
</p>

## What Reeve is

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
Everything Reeve can do is a **duty** — one job shipped as its own action, sharing
one core with every other duty — and every duty runs inside boundaries you write
down in one file, [the warrant](docs/guides/warrant.md).

## Quick start

Interested in what it does and what it refuses to do before installing
anything? Jump to [the refusal table](#what-it-refuses-to-do), then
[the authority model](docs/concepts/authority-model.md). Ready to run? Five
minutes:

> [!IMPORTANT]
> Running this workflow will incur charges on your OpenAI account.
> See [Cost](docs/guides/cost.md) for estimates. `dry-run: true` runs the full
> pipeline without writing anything — use it first.

1. **Store a model key** as a repository secret named `OPENAI_API_KEY`, or point
   `base-url` at a keyless provider —
   [Providers and the runtime](docs/guides/providers.md).
2. **Add a workflow.** The smallest working one: one duty, no warrant file,
   acting against the labels your repository already has.

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
          # languages lives under the warrant's `languages:` key, not here —
          # see docs/reference/duties/translate.md.
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` is required: Reeve reads your warrant file
> (`.github/reeve.yml`) from the local checkout, not the GitHub API.
> Without checkout, your warrant restrictions are silently bypassed.

Three things happen to that `issues: write` token the moment you merge it.
Read them once, before you turn `dry-run` off:
[what a run may do](#what-reeve-is-allowed-to-do) comes from the file alone,
[what each duty is](#the-duties) is one row below, and
[what it never does](#what-it-refuses-to-do) is enforced in code.

The whole install walkthrough — picking a trigger, permissions, pinning a
version — is [Installation](docs/getting-started/installation.md).
A complete two-duty workflow end to end:
[first-workflow.md](docs/getting-started/first-workflow.md).

## A reeve, and why that is the word

A reeve was the officer who ran an estate on the owner's behalf: the daily work,
done without being asked each time, inside an authority the owner had granted
and could withdraw at any moment. The owner stayed the owner.

That is the whole product. How Reeve runs follows from it: each duty is one
decision on top of a shared pipeline — the provider client, the language layer,
deterministic scoring, the sanitiser, the allowlist, state kept as files in your
repository — and differs only in what it decides.
[The architecture](docs/development/architecture.md) walks the pipeline stage by
stage.

## What Reeve is allowed to do

A file in your repository — `.github/reeve.yml` — is the whole authority. Write
nothing and a duty runs at level 0 of [the ladder](docs/concepts/authority-model.md):
its narrowest built-in default (labels only for `triage`, body edits for
`translate`, `[label, comment]` for `lifecycle`, nothing at all for `duplicate`,
`respond` and `review`). Write a `duties:` block and enumeration becomes total:
a duty the block does not name is granted nothing at all.

The workflow file says when a run happens and how the runtime operates
(`dry-run`, `number`, provider settings). It cannot grant a capability. Untrusted
input can influence a decision; it cannot grant authority.
[The warrant](docs/guides/warrant.md) and
[the authority model](docs/concepts/authority-model.md) are the two places this
is spelled out.

## The duties

Every duty is one row, and none of them is switched on by a mode — what runs is
exactly as much as you wrote down, one rung of
[the ladder](docs/concepts/authority-model.md) at a time.

| Duty        | What it does                                                                                                                                                                                                                                  | Reference                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `triage`    | Sorts a backlog against the taxonomy you wrote — or, at the bottom rung, against the labels your repository already has.                                                                                                                      | [Reference](docs/reference/duties/triage.md)    |
| `translate` | Puts every issue and pull request in every language your project reads — in the thread's own body, marked as the version that counts.                                                                                                         | [Reference](docs/reference/duties/translate.md) |
| `duplicate` | Finds the thread that already reported this — across the language it was reported in. Top rung: opt-in, never on by accident.                                                                                                                 | [Reference](docs/reference/duties/duplicate.md) |
| `respond`   | Gives a stranger a first, useful reply in the language they wrote to you in, grounded in what the project already knows. Top rung: granted nothing until a warrant names it.                                                                  | [Reference](docs/reference/duties/respond.md)   |
| `review`    | Reviews a pull request — deterministic pre-checks plus one model pass, reported as a single owned comment that tracks its findings across `synchronize` events instead of reposting them. Top rung: granted nothing until a warrant names it. | [Reference](docs/reference/duties/review.md)    |
| `lifecycle` | Runs your own staleness policy — reminders, un-staling, and a final close as not planned — from timestamps and labels alone. No model is ever called.                                                                                         | [Reference](docs/reference/duties/lifecycle.md) |
| `harmonise` | Synchronises your documentation across languages and formats — translating README files and keeping them current as the source changes. Report-only at level 0 — needs a `duties:` grant in a warrant to act.                                 | [Reference](docs/reference/duties/harmonise.md) |
| `dependa`   | Maintains your dependencies — discovers updates, assesses risk, and opens reviewable PRs within the authority you granted. Report-only at level 0 — needs a `duties:` grant in a warrant to act.                                              | [Reference](docs/reference/duties/dependa.md)   |

**The review duty deserves the extra sentence.** It reviews pull requests:
deterministic pre-checks first — ignore, generated, blocked — and a single
model pass after them. The verdict lands once, as one owned comment, and
tracks its findings across `synchronize` events instead of reposting. Rules
are your own (`.github/reeve-rules.yml`) and a maintainer always owns the
diff. [Review](docs/reference/duties/review.md).

What comes after these eight is decided by one test, and it is a strict one: the
work has to recur, be uniformly expensive today, already be work a maintainer
stopped doing, and be harder on a project whose contributors do not share a
language. [Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
rejects most feature requests, on purpose.

## Capabilities and authority

"_A label outside the warrant is never applied_" is not a slogan. It is the
shape of every duty: [the warrant](docs/guides/warrant.md) is parsed in code,
capabilities are resolved before a model is ever called, and every effect is
checked against the parsed file — never against the model's own claim about
what it was allowed to do. Capabilities are an allowlist, not a request.

Think of it as a ladder:

- **Level 0** — no file. The narrowest authority Reeve defines in code: read
  straight off the labels and descriptions your repository already has.
- **Level 1** — a taxonomy with no `duties:` block. Sharpens what gets decided,
  never what is allowed to act.
- **Level 2** — a written `duties:` block. Enumeration is total: a duty the
  block does not name is granted nothing at all.
- **Level 3** — the top rung. Recall into memory, answering strangers,
  writing corrections back into the repository.

Every climb is a diff to the same file, reviewed the same way a code change
would be. [The authority model](docs/concepts/authority-model.md) is the shape
of the idea; [the warrant guide](docs/guides/warrant.md) is the how-to; and
[the capabilities table](docs/reference/warrant-format.md#the-capabilities-table)
is the enumeration of every grant.

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

The reasoning that sits under each boundary — why the refusal exists, and what
would change it — is in [the threat model](docs/security/threat-model.md).

## Providers and the runtime

Reeve talks to one thing: an endpoint speaking the OpenAI chat-completions
protocol. That is the entire vendor contract. OpenAI, a gateway, a model host,
a keyless free tier — each is a different value for `base-url`, and none of them
is a migration. Keyless providers are a supported configuration, not a tolerated
one.

Everything about wiring that endpoint — `base-url`, `api-key`, `models`
(required on the duties that draft), `endpoints` and `model@alias` routing,
`request-timeout`, `temperature` — lives in
[Providers and the runtime](docs/guides/providers.md).

## Doctor

Before you trust a warrant, ask Reeve what it would do. Point the root action at
your repository with `doctor: true` and it reads your warrant and this
repository's labels and reports what each duty would be granted — writing
nothing, spending at most one tiny provider probe.

```yaml
permissions:
  contents: read
  issues: read

steps:
  - uses: actions/checkout@v4
  - uses: ecoma-io/reeve@v0.6
    with:
      doctor: true
```

The same action with `doctor: false` — its default — explains and refuses: it
names the leaf action that runs each duty and fails red, so the obvious, wrong
`uses: ecoma-io/reeve@v0.6` can never resolve and run nothing. Run `doctor`
in CI every time your warrant changes.
[The doctor guide](docs/guides/doctor.md).

## Custom rules and instructions

Reeve reads your project's own words, in three places:

- **The taxonomy** — what each label means, in your own words, under
  `labels:` in [the warrant](docs/guides/warrant.md). This is what `triage`,
  `duplicate` and `lifecycle` decide against.
- **Review rules** — `.github/reeve-rules.yml`, the same YAML grammar as the
  warrant, is what `review` enforces before its model pass: which files a PR
  may touch, what a diff must contain, what a merge may never do.
  [`review`'s configuration](docs/reference/duties/review.md#configuration).
- **Guidance** — `.github/reeve-guidance.md` is what `respond` reads for tone
  and policy: what the project promises, where to point an unanswerable
  question. It is your own file, read from the checkout and trusted.
  [`respond`'s configuration](docs/reference/duties/respond.md#configuration).

None of these are prompts to the model. They are the file the model's output is
checked against — see [Security](#security) below.

## Security

Every deployment of Reeve has the same uncomfortable shape: it holds a write
token, its input is written by strangers, its reasoning is done by a model that
can be instructed by that input, and its output is written back under that same
token. The design does not ask a prompt to survive contact with an attacker. It
makes the warrant the security property:

- **Never trust a model's claims about its own permissions.**
- **String all untrusted text through a per-call nonce and frame it as data.**
- **Sanitise machine output before it is published; never touch the author's
  half.**
- **Treat capacity as weather — 429 is a warning, not a failure.**
- **Fail red loudly rather than produce a plausible empty answer.**

None of this is a slogan: it is a list of ten invariants, each with a test.
[Security](docs/security/security.md) is the mechanism, stage by stage;
[the threat model](docs/security/threat-model.md) is the reasoning above it.
How to report a vulnerability:
[Reporting](docs/security/reporting.md) and [`SECURITY.md`](SECURITY.md).

## Migration from pre-1.0

Reeve is not at 1.0, and not everything is stable — see
[what `0.x` and `1.0` mean](docs/development/releasing.md#what-0x-and-10-mean-here).
If you installed a `0.x` release before the warrant became the whole authority
(the `apply:` and `capabilities:` era), the input surface changed, its
`languages:` input moved into the file, and your workflow's `apply:` grant is
now spelled as a `duties:` block.
[Migrating to the current line](docs/guides/migration.md) is the mapping, row
by row.

## Troubleshooting

A run that did not do what you expected is one of a handful of known shapes —
green but nothing happened, red because `models` is required, red because the
warrant does not parse, red because a label does not exist. Each has a distinct
diagnosis and a distinct fix.
[Troubleshooting](docs/guides/troubleshooting.md).

## 1.0 guarantees

`1.0` is not a feeling about maturity. It is a checkable promise: **every stage
of [the roadmap](docs/doctrine/north-star.md#7-roadmap) done, every number
published.** Until then an input can still be renamed, collapsed into the
warrant, or removed on a minor — and the release notes will say so. From 1.0,
the input surface is under semver's promise, and a rename costs a major. Every
release pins `v0.$MINOR` (there is deliberately no `v0`), and the `v0.6` line
is where this README's examples point.

The roadmap itself, the doctrine that decides what ships, and what stays
deliberately out of scope, are all one document:
[the north star](docs/doctrine/north-star.md#7-roadmap).

## Cost

Reeve is arranged so the expensive step runs last and least: code decides the
easy majority for nothing, a cheap model screens what survives that, and only
the minority that was always worth a careful read reaches the model you chose.

| Tier                    | Decides                                                                                       | Costs         |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| **Code**                | Empty bodies, unfilled templates, obvious spam, exact repeats, a thread Reeve already handled | Nothing       |
| **A cheap model**       | Is this worth a careful read — spam, off-topic, out of scope                                  | Very little   |
| **The model you chose** | The actual verdict, on what survived                                                          | The real bill |

Full breakdown, including a worked estimate and how to measure it instead of
estimating it: [Cost](docs/guides/cost.md).

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
