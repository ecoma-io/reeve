<!-- source of truth: harmonise/action.yml -->

# `harmonise`

_Full contract for the `harmonise` duty — every input, every output, checked against `harmonise/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

Keeps multilingual documentation files synchronised across locales — not by
translating the whole file each time, but by classifying the diff and
propagating only shared semantic changes. Translation corrections and
locale-specific adaptations stay local. A contributor edits one locale; the
other locales follow via a pull request.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

Keeping a multilingual documentation set in sync when the source locale
changes — adding a new section, updating an instruction, fixing a factual
error. It is a version-control system for semantic changes across languages,
not a file translator: it classifies the diff and only propagates what is
shared meaning, leaving translation quality and local adaptations untouched.

**What it is explicitly not for:** translating entire files from scratch,
improving translations, or synchronising content that has no cross-locale
relationship. A repository with one language has no synchronisation problem,
and a project that needs full retranslation on every change is better served
by [`translate`](translate.md) on its own.

## When to use it

Any repository that maintains documentation in more than one language and
needs those versions to stay in step. `edit-file` and `open-pr` are **not**
granted at [level 0 of the ladder](../../doctrine/north-star.md#3-the-ladder) —
committing files and opening pull requests is too much authority for
zero-config, so an explicit `duties:` entry in the warrant is required
before this duty can act.

This is the duty to reach for when the cost of a stale translation is a
reader following wrong instructions, not a maintainer clicking the wrong
label. Accuracy beats speed — the model tier should reflect that.

## Example (minimal workflow YAML)

```yaml
name: Harmonise

on:
  push:
    branches: [main]
    paths:
      - "docs/**/*.md"
      - "README.md"

permissions:
  contents: write
  pull-requests: write

jobs:
  harmonise:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/harmonise@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5
          source-language: en
```

That opens a **draft** pull request for each document group whose source locale
changed, updating only the locale variants that are stale. No source change,
no PR. A human edit in a target locale since the last sync is reported as a
conflict, not overwritten. The PR must be marked "ready for review" before it
can be merged — this is deliberate: a sync should never merge unreviewed.

`edit-file` and `open-pr` are **not** granted at level 0, so this example only
does what it promises once the warrant names the capability. The minimal
warrant that makes the workflow above work:

```yaml
duties:
  harmonise: [edit-file, open-pr]
```

Without it, the run classifies and reports, writes nothing, and ends green —
see [the warrant](../../guides/warrant.md). The first time you run a real sync,
also needs the initial translation to already exist — committing the first
`README.vi.md` / `README.zh.md` yourself is the load-bearing step.

## Required permissions

**Token:** `contents: write` to create or update files on a branch, and
`pull-requests: write` to open or update pull requests. `GITHUB_TOKEN` is
enough for both.

**Warrant grant:** `edit-file` and `open-pr` are **not** granted by
default. At level 0, with no warrant file, this duty cannot act — it
classifies and reports without touching the repository. A maintainer who
wants `harmonise` to open sync PRs must write:

```yaml
# .github/reeve.yml
version: 1
duties:
  harmonise: [edit-file, open-pr]
```

The `duties:` block in the warrant is the whole authority. Once it exists,
the enumeration becomes total: leaving `harmonise` out of it grants this duty
nothing, and the run says so rather than guessing. Nothing on the workflow
can widen the block. See [the duties table](../../guides/warrant.md#duties).

A run that should classify and draft but never commit or open a PR is a
[`dry-run`](../../guides/dry-run.md) — the pipeline runs, every output is
written, nothing changes. Watch what a run would have changed before you
grant it `edit-file` and `open-pr`.

## Required inputs

`models` is the only input this action requires — model ids, comma or
newline separated, in preference order. Everything else in the table below
has a default. `api-key` is not required by the schema (a keyless endpoint is
a supported configuration), but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `harmonise/action.yml` declares.

| Input             | Required | Default                     | What it does                                                                                                                                                                                                                                                 |
| ----------------- | -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token`    | no       | `${{ github.token }}`       | Token used to read and write repository files and pull requests.                                                                                                                                                                                             |
| `base-url`        | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                                                                                                           |
| `api-key`         | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                                                                                                              |
| `models`          | **yes**  | —                           | Model ids, comma or newline separated, in preference order. `id = Name` gives a model a display name.                                                                                                                                                        |
| `source-language` | no       | `en`                        | The locale code of the source language — the language the unsuffixed documentation files are written in. A deliberate organisational decision, not an incidental preference.                                                                                 |
| `warrant`         | no       | `.github/reeve.yml`         | Where the permissions live. `edit-file` and `open-pr` are granted here, under `duties:`, and are not granted by default. Missing at this default path is not a failure.                                                                                      |
| `drafts`          | no       | `1`                         | Attempts per stale locale, each scored deterministically, best published. The quality lever that costs calls instead of money.                                                                                                                               |
| `judge-models`    | no       | _(empty)_                   | A panel asked which draft reads best. Seats, not a fallback list — see [`translate`](translate.md#configuration) for the full grammar.                                                                                                                       |
| `provenance-dir`  | no       | `.reeve/provenance`         | Directory for provenance state — per-document sync status and source revision tracking. The state file lives at `${provenance-dir}/state.json`.                                                                                                              |
| `state-branch`    | no       | `reeve/provenance`          | A branch to write provenance state to, instead of the default branch. When set, the state file is committed to this branch and a draft PR is opened for review. `edit-file` and `open-pr` must both be granted. Empty writes directly to the default branch. |
| `glossary-dir`    | no       | `.reeve/glossary.yml`       | A glossary of project-specific terms that translations must respect. Overrides = bug.                                                                                                                                                                        |
| `paths`           | no       | _(empty)_                   | Doc paths to scan for locale variants. Empty scans the whole repository. Comma or newline separated.                                                                                                                                                         |
| `dry-run`         | no       | `false`                     | Run the whole pipeline, write every output, change nothing.                                                                                                                                                                                                  |
| `max-requests`    | no       | `none`                      | How many provider requests — classification, drafting and judging combined — one run may spend before it stops asking for more, or `none` for no bound.                                                                                                      |
| `endpoints`       | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                                                                                                              |
| `api-keys`        | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated.                                                                                   |
| `request-timeout` | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                                                                                                             |
| `chunk-chars`     | no       | `0`                         | Maximum character budget per drafting request. When above zero, source and target are split into chunks at Markdown boundaries and each chunk is drafted independently. Zero sends the whole document in one request.                                        |
| `ignore`          | no       | `true`                      | Whether to honour `<!-- reeve:ignore-* -->` markers. When true, marked sections are preserved as-is and excluded from translation.                                                                                                                           |
| `temperature`     | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                                                                                                                 |

**`source-language` names the authoritative locale.** The unsuffixed files —
like `docs/getting-started.md` — are written in this language. Unlike
`translate` (where the pivot language is implicit because contributors may
write in any language), `harmonise` works on committed documentation whose
source language is a known organisational decision — it must be named
explicitly.

**Target locales come from the warrant.** The locale-suffixed files
(`docs/getting-started.vi.md`) are matched against the warrant's own
`languages:` key — the source language must NOT appear in the list. The list
says which translations belong to the same document group; it says nothing
about what language a contributor may write in. Leave the key out of the
warrant and the duty's own default answers.

**`provenance-dir` tracks provenance.** `.reeve/provenance/state.json` records
the source revision and per-locale sync status for each document group. When a
source file's SHA changes from the recorded revision, target locales are
marked stale. If a target locale has been edited by a human since the last
sync, the run reports a conflict — it does not overwrite. Delete the state
file to force a full re-sync.

**`state-branch` moves provenance to a review-first path.** When set and
both `edit-file` and `open-pr` are granted, the state file is committed to
this branch and a draft PR is opened for maintainer review, instead of
writing directly to the default branch. When `open-pr` is not granted, the
state file still lands on the default branch and a notice says so — the write
is not lost, only the PR wrapping it. Set `state-branch: ""` to write
directly to the default branch.

**`glossary-dir` enforces project terms.** `.reeve/glossary.yml` lists terms
that must not be translated — proper nouns, technical jargon, brand names.
A draft that replaces a glossary term is a bug, not a creative choice. The
file is read before every translation, not cached between runs.

**`paths` scopes the scan.** When empty, the entire repository is scanned
for the suffix pattern. When set, only files under the named paths are
considered — `docs/` would restrict `harmonise` to documentation, leaving
`README.md` and other root-level files alone.

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Providers and the runtime](../../guides/providers.md#more-than-one-endpoint).

**`max-requests` is a ceiling this run sets for itself**, not the provider
running dry. Every request made counts against it, whatever it answered.
Checked at every clean-cut boundary — before each document group, before
each stale locale — never partway through a locale already being synced.
`none`, the default, never trips it.

**`chunk-chars` splits large documents at Markdown boundaries.** When set
above zero, source and target documents that exceed the budget are split
into chunks — fences and code spans are never split across a boundary — and
each chunk is drafted independently. Code-only chunks are passed through
verbatim without spending a model request. The reassembled draft is scored
against the full original target, not per-chunk. Zero, the default, sends
the whole document in one request — the right choice when the document fits
the model's context window.

**`ignore` preserves sections that must not be translated.** HTML comment
directives in target files mark sections that `harmonise` should skip:

```markdown
<!-- reeve:ignore-next-line -->

This line will not be translated or propagated.

<!-- reeve:ignore-start -->

Everything between these markers
is preserved as-is in every locale.
<!-- reeve:ignore-end -->
```

`ignore-next-line` skips the immediately following non-blank line.
`ignore-start` / `ignore-end` skip everything between them, inclusive.
An unclosed `ignore-start` runs to the end of the document. An
`ignore-end` without a matching `ignore-start` is a literal comment — no
effect. Nesting is not supported. When `ignore` is `false`, all markers
are treated as ordinary HTML comments.

## Diff classification

When a contributor edits a locale file, `harmonise` classifies the diff
before deciding whether to propagate:

| Classification                 | What it means                                     | Propagated? |
| ------------------------------ | ------------------------------------------------- | ----------- |
| **Shared semantic**            | New section, changed meaning, updated instruction | **Yes**     |
| **Translation correction**     | Fixing a bad translation in one locale            | No          |
| **Locale-specific adaptation** | Local link, local example, regional note          | No          |

Code cannot distinguish "this diff fixes a bad translation" from "this diff
adds new meaning" without understanding the text. The model classifies each
change, and code enforces the result: only `shared semantic` changes are
translated and applied to other locales.

The classification consumes the `models` roster through the same rotation
every other model consumer uses — a model that fails is passed over for the
next. Only when the whole roster is exhausted does the run fail loud rather
than silently skip a propagation it could not decide on.

## File naming convention

Locale variants are discovered by a suffix pattern, not by locale folders:

```text
docs/getting-started.md       ← EN (source, no suffix)
docs/getting-started.vi.md    ← VI
docs/getting-started.zh.md    ← ZH
README.md                     ← EN
README.vi.md                  ← VI
```

## Bootstrap

A locale variant must **already exist** for a document group to be discovered.
A repository with only `README.md` and no `README.vi.md` / `README.zh.md`
reports no document groups and ends green having synced nothing — it will not
create the first translation for you. Commit the initial
`README.vi.md` / `README.zh.md` yourself (a human first translation is the
load-bearing step), and the duty takes over keeping them current once the
source changes.

The suffix `.<locale-code>.md` before the final `.md` extension marks a
target locale. Files without a locale suffix are the source. Grouping is by
base name — `docs/getting-started` is the document group, `vi` is the
locale within it.

## Outputs

Every output `harmonise/action.yml` declares.

| Output             | Value                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classified`       | JSON array of document groups classified this run, with their classification and stale locales.                                                                                                                                       |
| `synced`           | JSON array of document groups whose stale locales were synced this run — a PR was opened or updated.                                                                                                                                  |
| `conflicts`        | JSON array of document groups where a human edit in a target locale blocked propagation.                                                                                                                                              |
| `skipped`          | JSON array of document groups where no propagation was needed — already in sync, or all changes were corrections or locale-specific.                                                                                                  |
| `starved`          | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                                                                                                  |
| `budget-exhausted` | `true` only when `max-requests` genuinely turned work away this run. Never `true` when `max-requests` is `none`. Distinct from `starved` — this run's own budget.                                                                     |
| `state-pr`         | The number of the draft PR that carries the provenance state file, when `state-branch` is set and the run completed successfully. Empty when writing to the default branch, when no state was written, or when the run was a dry run. |

All are written on every path that reaches an answer, including the ones
that answer "nothing" — a step branching on `conflicts` reads `[]` on the
run where nothing conflicted, never an unset output.

## Failure behavior

| What happened                               | What you get                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| One locale had no working model this run    | Warning, that locale left stale, the others synced, **green**                   |
| No locale could be synced                   | Warning per locale, `synced: []`, **green**                                     |
| Human edit in target locale since last sync | Conflict reported, that locale not overwritten, **green**                       |
| Warrant grants `harmonise` nothing          | Notice, no model calls, **green** — the duty decides nothing when it cannot act |
| `dry-run: true`                             | Pipeline runs, nothing committed or PR'd, **green**                             |
| The provenance state file cannot be read    | **Red** — provenance is how the duty knows what changed                         |
| The configuration is broken                 | **Red**, naming the input                                                       |

A skipped document group is not re-synced until its source changes again.
A conflicted locale is reported in the PR body and the summary, and a
maintainer decides whether to accept the sync or keep the human edit.

**Running with no `duties:` block at all is noted, once, rather
than left silent.** An absent warrant file at the default path is level 0,
and `harmonise` at level 0 has no retained grant — the run says so
and stops before spending a single model request.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The classification, the drafts, and the PR that would have been
opened are all printed to the log instead.

**Dry-run still spends model requests.** Classification and drafting run
normally — only the write (file commits and PR creation) is withheld. A
dry-run on a large document set costs the same in provider calls as a real
run. Leave `harmonise` out of the warrant's `duties:` block if you want to
prevent model calls entirely.

See [Rehearsing a run](../../guides/dry-run.md) for the pattern every duty
in Reeve shares.

## Cost

No change, no cost. A document group whose source has not changed since the
last sync costs one provenance read and nothing else. Classification runs
once per changed source file. Drafting runs once per stale locale per
document group, multiplied by `drafts`. Judging runs once per locale that
has drafts to compare. `drafts` and `judge-models` are the levers that
spend more for a better sync; both default to the cheapest setting. See
[Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **Input is trusted.** Unlike `translate`, whose input is hostile thread
  text, `harmonise` operates on committed repository files — no thread
  sanitiser is needed.
- **Human edits are inviolable.** A target locale edited by a human since
  the last sync is reported as a conflict, never overwritten. This is D3.
- **Provenance is a file in the repository.** `.reeve/provenance/state.json`
  is the source of truth for sync status. Tampering with it is a
  configuration issue, not a security boundary — the file is committed
  alongside the docs it tracks.
- **Only locale-suffix files are touched.** `edit-file` scopes writes to
  files matching the `.<locale>.md` suffix pattern. Files outside that
  pattern are never modified, regardless of what a model suggests.
- **No direct commits to the default branch for sync PRs.** Every sync lands
  in a pull request on a `reeve/harmonise/` branch. Human review is required
  before merge. Provenance state is written to a dedicated branch (`reeve/provenance`
  by default) with its own draft PR; set `state-branch: ""` to write directly
  to the default branch instead.
- **What it will never do:** overwrite a human edit; translate a file that is
  not a locale variant; merge its own PR. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The language layer](../../concepts/language-layer.md) ·
[The authority model](../../concepts/authority-model.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[`translate`](translate.md)
