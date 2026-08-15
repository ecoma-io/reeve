<!-- source of truth: dependa/action.yml -->

# `dependa`

_Full contract for the `dependa` duty — every input, every output, checked against `dependa/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

Keeps dependencies current — discovers from manifest files, classifies updates
by semver, gathers evidence from registries, enforces policy, and proposes
updates through pull requests you review. Deterministic where it can be,
model-assisted only for optional risk interpretation.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

The recurring work of keeping a project's dependencies up to date — discovering
what is stale, classifying what kind of update each one is, checking whether the
project's policy allows it, gathering evidence about what changed, and proposing
the update in a pull request a maintainer can review.

**External metadata is evidence, never authority.** A changelog that says
"breaking change" is a fact about the release; it is not a decision to skip the
update. A security advisory's severity is a fact about the vulnerability; it is
not a decision to auto-merge. The policy in your warrant decides what happens —
the model may interpret evidence, but it never grants permission.

**Deterministic where it can be.** Discovery parses manifests with ecosystem
parsers, not a model. Classification is semver string comparison, not a model
call. Grouping, policy matching, and file editing are all deterministic. Only
optional risk interpretation asks a model, and that interpretation is advisory,
never a gate.

**What it is explicitly not for:** writing code, running tests, debugging
failures, or producing implementation diffs. That is a different tool, and a
crowded one. `dependa` touches manifest and lock files, not source code.

## When to use it

Any repository whose dependencies go stale because no one is updating them by
hand. `edit-file` and `open-pr` are **not** granted at
[level 0 of the ladder](../../doctrine/north-star.md#3-the-ladder) — committing
files and opening pull requests is too much authority for zero-config, so an
explicit `capabilities:` block in the warrant is required before this duty can
act.

This is the duty to reach for when the cost of a stale dependency is a known
vulnerability left unpatched, or a version so old that upgrading becomes a
rewrite. Frequency beats urgency — a weekly schedule of small updates is safer
than a quarterly fire drill.

## Supported ecosystems

| Ecosystem          | Manager finds             | Datasource queries           | Dogfoods on Reeve |
| ------------------ | ------------------------- | ---------------------------- | ----------------- |
| **npm**            | `package.json`            | npm registry API             | ✅                |
| **GitHub Actions** | `.github/workflows/*.yml` | GitHub tags/releases API     | ✅                |
| **Cargo**          | `Cargo.toml`              | crates.io API                | ❌                |
| **Go**             | `go.mod`                  | proxy.golang.org API         | ❌                |
| **Docker**         | `Dockerfile`              | Docker Hub / registry v2 API | ❌                |

Each ecosystem adds one manager and one datasource. The interfaces are shared —
only parsing and API details differ. A monorepo containing manifests in nested
directories is handled natively: the repository tree is walked once, every
matching manifest is considered independently, and each proposal carries its
manifest path.

## Example (minimal workflow YAML)

```yaml
name: Dependa

on:
  schedule:
    - cron: "0 3 * * 1" # every Monday at 03:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  dependa:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/dependa@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          apply: edit-file, open-pr
```

That discovers all supported manifest files, resolves current versions,
classifies available updates, groups them by ecosystem, checks policy, and
opens one pull request per ecosystem group — each carrying evidence,
risk facts, and the specific file edits. Security updates get their own PR by
default. A PR that contains major updates is opened as a draft; minor and
patch updates are ready for review.

## Required permissions

**Token:** `contents: write` to create or update files on a branch, and
`pull-requests: write` to open or update pull requests. `GITHUB_TOKEN` is
enough for both.

**Warrant capability:** `edit-file` and `open-pr` are **not** granted by
default. At level 0, with no warrant file, this duty cannot act — it discovers
and classifies without touching the repository. A maintainer who wants
`dependa` to propose update PRs must write:

```yaml
# .github/reeve.yml
version: 1
capabilities:
  dependa: [edit-file, open-pr]
```

Once a `capabilities:` block exists, the enumeration becomes total: leaving
`dependa` out of it grants this duty nothing, and the run says so rather than
guessing. See [the capabilities table](../../guides/warrant.md#capabilities).

**`apply`** is the workflow's own half of the same gate — `edit-file, open-pr`,
or `none` for a run that discovers, classifies, and groups but never commits
or opens a PR. The narrower of `apply` and the warrant always wins. `apply:
none` is a good way to watch what a run would have proposed before it is
allowed to propose anything.

## Required inputs

`models` is the only input this action requires for risk interpretation —
model ids, comma or newline separated, in preference order. When `models` is
empty and `drafts` is `0`, the duty runs without any model calls at all;
deterministic risk facts alone are used. `api-key` is not required by the
schema (a keyless endpoint is a supported configuration), but almost every
real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `dependa/action.yml` declares.

| Input             | Required | Default                     | What it does                                                                                                                                                                 |
| ----------------- | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | no       | `${{ github.token }}`       | Token used to read and write repository files and pull requests.                                                                                                             |
| `base-url`        | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint. Used only for optional risk interpretation — the core pipeline is deterministic.                                          |
| `api-key`         | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                              |
| `models`          | no       | _(empty)_                   | Model ids for risk interpretation, comma or newline separated, in preference order. `id = Name` gives a model a display name. Empty + `drafts: 0` = fully deterministic run. |
| `warrant`         | no       | `.github/reeve.yml`         | Where `edit-file` and `open-pr` are granted. Missing at this default path is not a failure.                                                                                  |
| `apply`           | no       | `none`                      | What this run may do: `edit-file, open-pr`, or `none` to discover and classify without touching the repository. The narrower of this and the warrant wins.                   |
| `ecosystems`      | no       | _(empty)_                   | Which ecosystems to scan: `npm`, `github-actions`, `cargo`, `go`, `docker` — comma or newline separated. Empty = all known. Narrows the warrant's own list; cannot widen it. |
| `drafts`          | no       | `0`                         | Risk interpretations per proposal, scored deterministically. `0` = no model call at all; deterministic facts alone. The quality lever that costs calls instead of money.     |
| `dry-run`         | no       | `false`                     | Run the whole pipeline, write every output, change nothing.                                                                                                                  |
| `max-requests`    | no       | `none`                      | How many provider requests one run may spend, or `none` for no bound. Checked at each clean-cut boundary — before each dependency, before each group.                        |
| `paths`           | no       | _(empty)_                   | Manifest paths to scan, comma or newline separated. Empty scans the whole repository. Use this to limit dependa to a subdirectory in a monorepo.                             |
| `request-timeout` | no       | `120s`                      | How long one request may run before it counts as weather. Whole seconds or minutes; a bare number is refused.                                                                |
| `temperature`     | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request.                                                                                                     |

**`ecosystems` narrows, never widens.** The warrant's own `ecosystems:` list
sets the ceiling; the `ecosystems` input can only remove ecosystems from that
list, never add ones the warrant did not name.

**`drafts` controls model use for risk interpretation.** When `0` (the
default), no model is called for risk assessment — the deterministic risk
facts alone are used. When above zero, the model reads the evidence (changelogs,
release notes, advisory text) and produces an advisory risk level and summary.
That summary is enclosed and marked as model output; it is never the sole
basis for a policy decision.

**`paths` scopes the scan for monorepos.** When empty, the entire repository
tree is walked. When set, only files under the named paths are considered —
`packages/app/` would restrict `dependa` to manifests in that directory and
its subdirectories, leaving other workspaces alone.

**`max-requests` is a ceiling this run sets for itself.** Every request made
counts against it — datasource queries and risk interpretations combined.
Checked at every clean-cut boundary — before each dependency resolution,
before each proposal group — never mid-proposal. `none`, the default, never
trips it.

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the same
provider inputs every duty takes — the full grammar, the `model@alias` routing
rule, and what more than one endpoint changes about auth failures are all in
[Installation](../../getting-started/installation.md#more-than-one-endpoint).

## Policy

The `dependa:` key in the warrant controls what updates this duty may propose.
Absent entirely, `dependa` runs with conservative defaults:

```yaml
# .github/reeve.yml
dependa:
  ecosystems: [] # empty = all known
  allowed-types: [patch, minor, pin, digest, rollback, security]
  ignore: []
  grouping: by-ecosystem
  security-separate: true
  auto-approve: minor
  auto-close: false
  auto-rebase: true
  schedule: null # null = every invocation
```

**`allowed-types` gates what update types may be proposed.** The default
excludes `major` — a major update is too consequential to propose without a
maintainer's explicit opt-in. Add `major` to the list only after reviewing
what your project's major dependencies look like when they bump their leading
version.

**`ignore` skips packages entirely.** Each rule names a package, optionally an
ecosystem, and optionally specific update types. A package ignored for
`major` still gets minor and patch proposals; a package ignored with no types
is never proposed at all:

```yaml
ignore:
  - name: "@types/*"
  - name: "lodash"
    types: [major]
```

**`grouping` controls how proposals become PRs.** `by-ecosystem` (the default)
creates one PR per ecosystem — all npm patch updates in one PR, all GitHub
Actions updates in another. `by-package` creates one PR per dependency. `single`
creates one PR for everything. Grouping is deterministic: the same inputs
produce the same groups every time.

**`security-separate` pulls security updates into their own PR.** Defaults
`true` — a security update is time-sensitive and should not wait behind a
review of unrelated changes. When `false`, security updates follow the normal
grouping rule.

**`auto-approve` sets the maximum update type that opens as a ready PR.**
`"minor"` (the default) means patch and minor PRs are ready for review;
major PRs are opened as drafts. `"patch"` means only patches are ready.
`"none"` means every PR is a draft.

**`auto-close` controls whether dependa may close its own obsolete PRs.**
Defaults `false` — closing is a maintainer decision
([D3](../../doctrine/north-star.md#d3-the-humans-work-is-inviolable)).
When `true`, dependa closes a PR when the update is no longer relevant:
the target version was yanked, the dependency was removed from the manifest,
or a newer proposal supersedes it. **Not yet implemented** — the setting is
parsed from the warrant but has no effect at runtime; a `core.notice()` is
emitted when it is set.

**`auto-rebase` controls whether dependa may rebase its own PRs.** Defaults
`true` — rebasing is a mechanical operation that does not change the
proposal's content. When `false`, a PR with merge conflicts stays conflicted
until a maintainer resolves it. **Not yet implemented** — the setting is
parsed from the warrant but has no effect at runtime; a `core.notice()` is
emitted when it is set.

**`schedule` throttles how often dependa runs.** An interval means "skip if
the last run was fewer than N days ago." A cron expression means "only run
when the expression matches." `null` means every invocation runs.

```yaml
schedule:
  interval: 7 # at most once per 7 days
# schedule:
#   cron: "0 3 * * 1"   # every Monday at 03:00 UTC
```

## Update classification

Every update is classified by semver comparison — code, not a model:

| Type       | What it means                                       |
| ---------- | --------------------------------------------------- |
| `patch`    | `1.2.3` → `1.2.4`                                   |
| `minor`    | `1.2.x` → `1.3.0`                                   |
| `major`    | `1.x` → `2.0.0`                                     |
| `pin`      | Floating range (`^1.2.3`) → exact version (`1.2.3`) |
| `digest`   | Hash-only update (Docker, lockfile-only)            |
| `rollback` | Target is actually older than current               |
| `security` | Datasource flagged this version as a security fix   |

Classification is deterministic: the same current version and target version
produce the same type every time, regardless of what the model might suggest.

## Risk assessment

Split into facts and interpretation so that enforcement can treat them
differently.

**Risk facts** are deterministic and reproducible — computed from version
metadata alone, no model call:

| Fact                  | What it means                                          |
| --------------------- | ------------------------------------------------------ |
| `updateType`          | The semver classification (see above)                  |
| `majorDistance`       | How many major versions apart                          |
| `minorDistance`       | How many minor versions apart                          |
| `patchDistance`       | How many patch versions apart                          |
| `daysBetweenReleases` | Calendar days between current and target release dates |
| `currentVersionStale` | Whether the current version is over a year old         |
| `isSecurity`          | Whether this is a security update                      |
| `hasChangelog`        | Whether the target version has published release notes |
| `isDev`               | Whether this is a development dependency               |

**Risk interpretation** is optional and model-assisted. When `drafts` is above
zero, the model reads the evidence and produces an advisory risk level
(`low`, `moderate`, or `high`), a one-sentence summary, and a flag for
breaking changes. This interpretation is enclosed and marked as model output;
it supplements the facts, but it never overrides them. A policy that gates on
`updateType === "patch"` can rely on that fact without trusting anything the
model said.

## Evidence

Every proposal carries the evidence that supports it, attributed to its source:

| Kind                | Source                               | Deterministic? |
| ------------------- | ------------------------------------ | -------------- |
| `changelog`         | Changelog URL from the registry      | Yes            |
| `release-notes`     | GitHub release body                  | Yes            |
| `security-advisory` | CVE/GHSA summary from the datasource | Yes            |
| `commit-log`        | Commit history between versions      | Yes            |
| `github-release`    | GitHub release API response          | Yes            |

Evidence is always enclosed, attributed, and length-capped. A maintainer
reading a PR body can see _where_ every claim came from and verify it
themselves. A malicious changelog is an injection vector that the enclosure
model contains; a broken registry response is malformed metadata that the
datasource reports, not a wrong version number that dependa silently accepts.

## Outputs

Every output `dependa/action.yml` declares.

| Output             | Value                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `proposed`         | JSON array of proposal group IDs that were proposed this run.                                                                             |
| `refused`          | JSON array of proposal group IDs that were refused by policy or enforcement this run.                                                     |
| `security`         | JSON array of proposal group IDs that contain security updates.                                                                           |
| `pull-requests`    | JSON array of objects with `group` (proposal group ID) and `pr` (pull request number) for each PR opened or updated this run.             |
| `starved`          | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                      |
| `budget-exhausted` | `true` only when `max-requests` genuinely turned work away this run. Never `true` when `max-requests` is `none`. Distinct from `starved`. |

All are written on every path that reaches an answer, including the ones
that answer "nothing" — a step branching on `security` reads `[]` on the run
where nothing was security-flagged, never an unset output.

## Failure behavior

| What happened                           | What you get                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| A datasource is temporarily unavailable | That ecosystem skipped, others proceed, warning in summary, **green**           |
| A package is not found in the registry  | Reported as `not-found`, no proposal, **green**                                 |
| Registry metadata is malformed          | Reported as `malformed-metadata`, no proposal, **green**                        |
| No warrant capabilities for `dependa`   | Notice, no model calls, **green** — the duty decides nothing when it cannot act |
| `apply: none`                           | Pipeline runs, nothing committed or PR'd, **green**                             |
| A proposal is refused by policy         | Refusal recorded in output and summary, **green**                               |
| The configuration is broken             | **Red**, naming the input                                                       |

**A package that cannot be resolved is not an error.** The datasource reports
`not-found` or `temporarily-unavailable`, and the pipeline continues with the
packages it could resolve. A partial result is better than a red run over one
unreachable registry.

**Running with no `capabilities:` block at all is noted, once, rather than
left silent.** An absent warrant file at the default path is level 0, and
`dependa` at level 0 has no granted capabilities — the run says so and stops
before spending a single model request.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The proposals, the risk assessments, and the PRs that would have been
opened are all printed to the log instead.

**Dry-run still spends datasource queries.** Resolution runs normally — only
the write (file commits and PR creation) is withheld. A dry-run on a large
monorepo costs the same in registry calls as a real run. Use `apply: none`
to prevent model calls for risk interpretation.

See [Rehearsing a run](../../guides/dry-run.md) for the pattern every duty
in Reeve shares.

## Cost

No proposal, no cost. A dependency whose current version is already the latest
costs one datasource query and nothing else. Classification and grouping are
free — they are deterministic code. Risk interpretation costs one model call
per proposal per draft, and `drafts` defaults to `0`, so the default run
spends zero model requests.

The cost levers: `drafts` (more interpretations per proposal for better risk
assessment), and the model tier you pick. A cheap model for risk interpretation
costs very little; an expensive one costs more. The core pipeline — discovery,
classification, grouping, policy enforcement — never calls a model at all.

See [Cost](../../guides/cost.md) for the full arithmetic.

## Security considerations

- **External metadata is evidence, never authority.** Changelogs, release notes,
  registry metadata, and security advisories are enclosed, attributed, and
  length-capped. They never override your policy. A changelog that says
  "breaking change" is a fact about the release; it is not a decision to skip
  the update.
- **The model may interpret evidence, but it never grants permission.** Risk
  interpretation is advisory. Enforcement checks every proposal against the
  warrant and the policy, deterministically, before any file is written.
- **Every file mutation passes through `edit-file`.** No proposal can write a
  file without the capability being granted in the warrant and confirmed by
  enforcement. The model cannot bypass this.
- **Every PR passes through `open-pr`.** No PR is created without the
  capability. The model cannot bypass this either.
- **Evidence is enclosed before any model sees it.** A malicious changelog
  containing prompt injection is contained by the enclosure model — the model
  may read it, but its output is scored, sanitised, and never treated as
  authority.
- **Partial registry failure is never an affirmative decision.** An
  unavailable registry means `temporarily-unavailable`, not "safe to update"
  or "no updates needed." A malformed registry response means
  `malformed-metadata`, not a best-effort version number.
- **What it will never do:** merge its own PR; close a PR without explicit
  `auto-close: true`; edit a file that is not a manifest or lock file; treat
  registry metadata as authority; bypass enforcement. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[The warrant](../../guides/warrant.md) ·
[`harmonise`](harmonise.md) ·
[Security](../../security/security.md)
