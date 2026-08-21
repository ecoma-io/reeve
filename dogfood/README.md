# Dependa vs Renovate Dogfood

> **Dependa is being evaluated alongside Renovate and is not yet the production replacement.**
> Renovate remains the authoritative dependency-maintenance system; dependa's
> PRs open as drafts a maintainer promotes or closes.

## Architecture

```
                 Repository
                     │
            ┌────────┴────────┐
            ↓                 ↓
        Renovate           Dependa
        production          dogfood
            │                 │
            ↓                 ↓
       real PRs           draft PRs
            │                 │
            └────────┬────────┘
                     ↓
                comparison
                     │
                     ↓
           conformance report
```

**Renovate** is the production system. It runs weekly (Monday before 6am UTC)
and creates real dependency update PRs.

**Dependa** dogfoods for real — the warrant grants
`dependa: [edit-file, open-pr]`, so the Wednesday drafting run commits
manifest updates to `reeve/dependa/*` branches and opens draft PRs, exactly
as a consumer's installation would. The Thursday conformance run keeps its
original shadow shape (`dry-run: true` on the action): the whole pipeline
runs, nothing is written, and what dependa discovered is compared against
Renovate.

> PRs opened with `GITHUB_TOKEN` do not trigger `pull_request` workflows —
> CI on a dependa PR starts after a maintainer's close/reopen or push. This
> is the documented trade against holding a long-lived PAT
> (see `.github/renovate.json5` for the same reasoning on Renovate's side).

**The comparison** produces a machine-readable conformance dataset that
classifies every discrepancy between what the two systems found.

## How to Run

### On demand (CI)

The workflow's `duty` input runs a single duty without waking the other
eight. A dispatch defaults to `dry-run: true` — observation:

```
gh workflow run reeve.yml -f duty=dependa
```

To let a manual run act (commit branches, open draft PRs), a maintainer
says so explicitly:

```
gh workflow run reeve.yml -f duty=dependa -f dry-run=false
```

### On schedule (CI)

The drafting row runs Wednesdays at 03:17 UTC and acts on the warrant's
grant; the conformance row runs Thursdays at 03:17 UTC and only observes.

### Local comparison

```bash
# From the repository root
pnpm install
npx tsx dogfood/conformance/cli.ts --repo-root .
```

This extracts both the Renovate baseline and dependa's shadow findings
from the local checkout, compares them, and prints a report.

## Artifact Format

The conformance dataset is stored as JSONL (one record per line). The first
line is a header; subsequent lines are dependency comparison records.

```jsonl
{"timestamp":"2026-08-14T00:00:00Z","repository":"ecoma-io/reeve","baseRef":"main","dependaVersion":"0.6.0","renovateVersion":"app","_type":"conformance-header"}
{"ecosystem":"npm","name":"lodash","manifestPath":"package.json","constraint":"^4.17.0","currentVersion":"4.17.21","renovateTargetVersion":"4.18.0","dependaTargetVersion":"4.18.0","classification":"MATCH","level":null,"reason":null,...}
{"ecosystem":"npm","name":"lockFileMaintenance","manifestPath":null,"classification":"INTENTIONAL_DIFFERENCE","level":"discovery","reason":"Renovate discovered lockFileMaintenance on npm; dependa did not",...}
```

## Discrepancy Classifications

Every discrepancy between Renovate and dependa is classified as exactly one of:

| Classification               | Meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `MATCH`                      | Both tools agree on this dependency                                          |
| `INTENTIONAL_DIFFERENCE`     | A known architectural difference — dependa does things differently by design |
| `DEPENDA_MISSING_CAPABILITY` | Dependa lacks the capability to discover or handle this case                 |
| `DEPENDA_BUG`                | Dependa should have found this but did not, or found the wrong answer        |
| `RENOVATE_DIFFERENCE`        | Renovate's behaviour differs from what might be expected                     |
| `INSUFFICIENT_EVIDENCE`      | Not enough information to classify the discrepancy                           |

### Common intentional differences

- **Lock file maintenance**: Renovate has `lockFileMaintenance`; dependa updates manifest constraints but does not regenerate lockfiles.
- **Digest pinning for GitHub Actions**: Renovate pins actions to commit SHAs (`pinDigests: true`); dependa has no pin/digest capability for actions.
- **Grouping policy**: Renovate groups by `packageRules[].groupName`; dependa groups by `by-ecosystem`/`by-package`/`single` from the warrant policy.
- **`allowedVersions` constraints**: Renovate's `allowedVersions: "<6"` for typescript; dependa has no equivalent per-package version ceiling.

### Common missing capabilities

- **SHA-to-tag resolution**: Dependa's `github-tags` datasource does not map commit SHAs back to their corresponding tags. Renovate does this for digest updates.
- **Lockfile editing**: Dependa only edits manifest constraints. Renovate updates lockfiles in-place.
- **Automerge**: Dependa opens PRs as draft or ready; it does not merge them. Renovate can automerge when checks pass.

## Comparison Levels

The comparison does not stop at "did both find the same version?" It compares
across six levels:

1. **Discovery** — Was the dependency detected by both tools?
2. **Version selection** — Did both select the same target version?
3. **Update classification** — patch/minor/major/pin/digest/security
4. **Grouping** — Did both group dependencies similarly?
5. **Mutation** — Would the same files change?
6. **Security** — Did both detect the same security condition?

The first level where a difference is found determines the comparison level.

> **Note:** Candidate resolution (did both find the same candidate versions?)
> was considered but cannot be compared with current data — neither extractor
> resolves candidate lists. It will be added when the extractors can produce
> that data.

## Metrics

| Metric                    | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| Discovery recall          | Of everything Renovate found, how much did dependa also find?     |
| Target version parity     | Of candidates both found, what fraction selected the same target? |
| Update type parity        | Of candidates both found, what fraction classified the same way?  |
| Security parity           | Of security findings, what fraction did dependa also flag?        |
| Grouping parity           | Of grouped findings, what fraction grouped the same way?          |
| Potential false positives | Dependa found something Renovate did not                          |
| Potential false negatives | Renovate found something dependa did not                          |

A single missed critical security update is more important than dozens of
harmless version differences.

## How to Add Fixtures

Create a new directory under `dogfood/fixtures/` with a manifest file:

```
dogfood/fixtures/my-edge-case/
  package.json          # npm fixture
  .github/workflows/    # actions fixture (if needed)
```

Then add a test case to `src/duties/dependa/conformance/compare.test.ts` that
verifies the expected classification for the fixture.

## How to Turn Discrepancies Into Regression Tests

1. **Identify** the discrepancy from the conformance report.
2. **Reproduce** it with a minimal fixture (manifest + expected output).
3. **Write** a colocated unit test in the dependa module that reproduces
   the discrepancy with the fixture's raw inputs.
4. **Fix** the module. The conformance fixture stays as the end-to-end
   witness; the colocated unit test is the fast regression guard.
5. **Rerun** the comparison to verify the fix.

## Security Boundaries

1. **No shared mutation path**: Renovate creates PRs on `renovate/` branches;
   dependa creates PRs on `reeve/dependa/` branches. The two never write the
   same ref.
2. **Warrant enforcement**: The warrant at `.github/reeve.yml` grants
   `dependa: [edit-file, open-pr]` and nothing else — no merge, no close of
   human PRs, no writes outside discovered manifests (the edit-path allowlist
   refuses paths that were never discovered as dependency manifests).
3. **Draft-only PRs**: Every dependa PR opens as a draft under the default
   `auto-approve: none`; a human promotes or closes it. Renovate remains
   authoritative until the conformance dataset shows parity.
4. **Observation stays observation**: The Thursday conformance row and any
   default manual dispatch run `dry-run: true` — the pipeline runs whole and
   writes nothing, whatever the job's token could do.
5. **Branch protection**: The `main` branch requires CI checks and review.
6. **No secrets exfiltration**: With `risk-interpretation` off (the default),
   no data is sent to the LLM provider. The pipeline is fully deterministic.

## Why Renovate Remains Authoritative

Renovate has years of production use, handles corner cases dependa has not
yet encountered, and is maintained by a large community. The dogfood
comparison exists to identify where dependa falls short — not to declare
parity prematurely.

When dependa's conformance metrics demonstrate consistent, high-quality
results across multiple comparison runs, the promotion from shadow to
production can be considered. Until then, Renovate stays in charge.

## Current Dependa vs Renovate Findings

> This section will be populated with actual observed results from the first
> comparison run. Until then, the expected gaps are:
>
> - **Lock file maintenance**: Renovate-only (INTENTIONAL_DIFFERENCE)
> - **Actions digest pinning**: Renovate-only (INTENTIONAL_DIFFERENCE)
> - **`allowedVersions: "<6"` for typescript**: Renovate caps at 5.x;
>   dependa would propose 6.x+ if available (INTENTIONAL_DIFFERENCE)
> - **Lint/format toolchain grouping**: Renovate groups these as one PR;
>   dependa groups by ecosystem (INTENTIONAL_DIFFERENCE)
> - **Lockfile editing**: Renovate-only (DEPENDA_MISSING_CAPABILITY)
> - **SHA-to-tag resolution**: Renovate-only (DEPENDA_MISSING_CAPABILITY)
