# Dependency maintenance

How `dependa` discovers, classifies, and proposes dependency updates — and
why every step that can be deterministic is.

Prerequisites: [Duties and the core](duties-and-the-core.md),
[The authority model](authority-model.md).

## The thesis

Dependency maintenance is recurring work that is uniformly expensive, that
maintainers have already stopped doing by hand, and that is harder on a
project whose contributors do not share a language — because changelogs,
release notes, and security advisories arrive in the ecosystem's dominant
language, not in the project's own. It passes
[D10](../doctrine/north-star.md#d10--a-duty-must-earn-its-place), and it
belongs in Reeve for the same reason every other duty does: the recurring
work the maintainer stopped doing, done inside an authority they wrote down.

## The pipeline

`dependa` moves through the same core stages every duty follows, adapted to
its own domain:

| #   | Stage                   | What it does                                                 | Model call? |
| --- | ----------------------- | ------------------------------------------------------------ | ----------- |
| 1   | **Warrant**             | Reads authority, checks `edit-file` + `open-pr` grants       | No          |
| 2   | **Discover**            | Managers scan the repository tree for manifest files         | No          |
| 3   | **Resolve**             | Datasources query registries for available versions          | No          |
| 4   | **Classify**            | Semver comparison determines update type                     | No          |
| 5   | **Evidence**            | Gather release metadata, changelogs, security advisories     | No          |
| 6   | **Risk facts**          | Compute deterministic risk facts from version metadata       | No          |
| 7   | **Risk interpretation** | Optional: model reads evidence, produces advisory risk level | Optional    |
| 8   | **Group**               | Deterministic grouping by policy rule                        | No          |
| 9   | **Policy**              | Match proposals against `dependa:` warrant key               | No          |
| 10  | **Enforce**             | Check capabilities, narrow with `apply` input                | No          |
| 11  | **Publish**             | Modify manifest files, open/update PRs                       | No          |

Stages 1–6 and 8–11 are deterministic. Stage 7 is the only one that
optionally calls a model, and it is advisory: a policy that gates on
`updateType === "patch"` can rely on that fact without trusting anything
the model said. The model may interpret evidence; it never grants permission.

This is [D4](../doctrine/north-star.md#d4--the-work-is-priced-before-it-is-done)
expressed as control flow: the expensive step runs last, and only when asked
for. `drafts: 0` (the default) means zero model calls for the entire run.

## Managers — dependency discovery

A **manager** is a deterministic parser that reads a manifest file and returns
the dependencies declared in it. No model is involved; a parser can do the
job.

Each manager knows:

- Which file patterns to look for (`package.json`, `Cargo.toml`, `go.mod`,
  `.github/workflows/*.yml`, `Dockerfile`)
- How to parse the file format and extract dependency names, version
  constraints, and dev/production classification
- How to apply an update back to the manifest, producing new file content

A monorepo with manifests in nested directories is handled natively: the
repository tree is walked once, every matching manifest is considered
independently, and each proposal carries its manifest path. Packages in
different workspaces do not collide merely because they share a dependency
name.

### The five managers

| Manager            | Reads                                                     | Produces                                                    |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| **npm**            | `package.json` (+ `pnpm-lock.yaml` / `package-lock.json`) | npm dependencies with constraint, current version, dev flag |
| **github-actions** | `.github/workflows/*.yml`                                 | Action references with `uses:` pins                         |
| **cargo**          | `Cargo.toml` (+ `Cargo.lock`)                             | crate dependencies with semver constraints                  |
| **go**             | `go.mod` (+ `go.sum`)                                     | Go module requirements                                      |
| **docker**         | `Dockerfile`                                              | `FROM` image references with tags/digests                   |

Each manager is a separate file under `src/duties/dependa/managers/`. Adding a
new ecosystem means adding one manager file and one datasource file; nothing
above them changes.

## Datasources — version resolution

A **datasource** queries an external registry for available versions of a
dependency. All external content — package metadata, release notes, changelogs
— is treated as untrusted evidence, not as instructions.

Each datasource produces a `ResolutionResult`: either `available` (with a list
of releases), `not-found`, `temporarily-unavailable`, or `malformed-metadata`.
A datasource that cannot reach its registry degrades gracefully —
[D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration):
a 429 or a timeout is weather, not a failure.

### The five datasources

| Datasource          | Queries                                 | Evidence returned                  |
| ------------------- | --------------------------------------- | ---------------------------------- |
| **npm**             | npm registry API (`registry.npmjs.org`) | Version metadata, deprecated flags |
| **github-tags**     | GitHub tags/releases API                | Release notes, tag names           |
| **crates**          | crates.io API                           | Version metadata, yanked flags     |
| **go-proxy**        | proxy.golang.org                        | Version list, module metadata      |
| **docker-registry** | Docker Hub / registry v2 API            | Tag list, digest                   |

Datasources are I/O wrappers around external APIs. They are covered by
integration tests that drive the built bundles against mock registries, not
by unit tests that would need to mock `fetch`.

## Classification — update type

Classification is semver string comparison. Code, not a model:

- `1.2.3` → `1.2.4` is **patch**
- `1.2.3` → `1.3.0` is **minor**
- `1.2.3` → `2.0.0` is **major**
- `^1.2.3` → `1.2.3` is **pin**
- `sha256:abc…` → `sha256:def…` is **digest**
- `2.0.0` → `1.9.0` is **rollback**
- A version the datasource flags as a security fix is **security**

The same current version and target version produce the same type every time.
A model may later interpret evidence _about_ the update, but the type itself
is a mechanical fact about the version strings.

## Evidence — external metadata, never authority

Every proposal carries the evidence that supports it:

| Kind              | Source                      | What it tells you             |
| ----------------- | --------------------------- | ----------------------------- |
| Changelog         | Changelog URL from registry | What changed between versions |
| Release notes     | GitHub release body         | The maintainer's own summary  |
| Security advisory | CVE/GHSA data               | What the vulnerability is     |
| Commit log        | Commit history              | Line-by-line changes          |

Evidence is:

- **Attributed.** Every piece of evidence names its source, so a maintainer
  reading the PR body can verify it themselves.
- **Enclosed.** Untrusted content is wrapped in an enclosure before any model
  sees it, so a malicious changelog cannot become an injection that escalates
  authority.
- **Length-capped.** Evidence is truncated to a fixed maximum, preventing a
  very long changelog from overwhelming the context window.
- **Never authority.** A changelog that says "breaking change" is a fact about
  the release. It is not a decision to skip the update — the policy decides.

## Risk assessment — facts and interpretation

**Risk facts** are deterministic, reproducible, and require no model call:

- Update type, version distances, days between releases, whether the current
  version is stale, whether a changelog exists, whether the dependency is
  dev-only, whether a security advisory is present.

A policy can safely gate on any of these without trusting anything the model
said. `"auto-approve: minor"` means "minor and patch PRs are ready" — a
deterministic fact, not a model's judgment.

**Risk interpretation** is optional and advisory-only. When `drafts` is above
zero, the model reads the evidence and produces:

- A risk level (`low`, `moderate`, `high`)
- A one-sentence summary
- A breaking-change flag

This interpretation is enclosed, marked as model output, and never the sole
basis for a policy decision. A maintainer reading the PR body can see that it
came from a model, not from the registry.

## Policy — the warrant decides

The `dependa:` key in the warrant is where the maintainer states what updates
may be proposed. The policy is deterministic: the same proposals and the same
policy produce the same decisions every time.

Key policy controls:

- **`allowed-types`**: Which update types may be proposed. Defaults exclude
  `major`.
- **`ignore`**: Packages to skip entirely, optionally by ecosystem and update
  type.
- **`grouping`**: How proposals become PRs — by ecosystem, by package, or
  single.
- **`security-separate`**: Whether security updates get their own PR.
- **`auto-approve`**: The maximum update type that opens as a ready PR.
- **`auto-close`**: Whether dependa may close its own obsolete PRs.
- **`auto-rebase`**: Whether dependa may rebase its own PRs.
- **`schedule`**: How often dependa may run.

The policy lives in the warrant because it answers "what may dependa do" — an
authority question ([D2](../doctrine/north-star.md#d2--authority-is-granted-written-and-bounded)).
The operational knobs (which ecosystems to scan, how many requests to spend,
which paths to consider) stay on the workflow, because they shape _how_
dependa works, not _what_ it is allowed to propose.

## Grouping — proposals into PRs

Grouping is deterministic: the same set of proposals and the same grouping rule
produce the same PRs every time.

| Mode           | What happens                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| `by-ecosystem` | One PR per ecosystem — all npm patches together, all Actions updates together |
| `by-package`   | One PR per dependency — each package gets its own PR                          |
| `single`       | One PR for everything — all updates in a single PR                            |

When `security-separate` is `true` (the default), security updates are pulled
out of the normal grouping and given their own PR — because a security update
is time-sensitive and should not wait behind a review of unrelated changes.

## PR lifecycle

1. **Check for existing PR.** dependa recognises its own markers on PR bodies
   — a re-run on the same branch updates an existing PR rather than opening a
   duplicate.
2. **Create branch.** `reeve/dependa/<group-id>` for each proposal group.
3. **Commit file edits.** Each manifest file is updated deterministically by
   the manager that parsed it.
4. **Open PR.** The body carries: update summary, evidence (attributed and
   enclosed), risk facts, optional risk interpretation (marked as model
   output), and the dependa marker.
5. **Update PR.** When a newer target version is available, the same branch
   and PR are updated with the new proposal.
6. **Close PR.** When `auto-close` is `true` and the update is no longer
   relevant (superseded, yanked, or the dependency was removed), dependa
   closes its own PR. When `auto-close` is `false` (the default), the PR
   stays open until a maintainer decides.
7. **Rebase PR.** When `auto-rebase` is `true` (the default) and the base
   branch has moved forward, dependa rebases its own PR. This is a mechanical
   operation that does not change the proposal's content.

## Monorepo support

A monorepo is a repository with manifests in more than one directory. `dependa`
handles it natively:

- The repository tree is walked once, discovering every matching manifest.
- Each manifest is parsed independently by its ecosystem manager.
- Each proposal carries its manifest path, so packages in different workspaces
  do not collide.
- The `paths` input scopes the scan to specific directories when you want to
  limit dependa to a subset of the monorepo.
- Grouping is by ecosystem across the whole repository, not per-directory. A
  single "npm" PR contains updates from every `package.json` that has them.

This is the same pattern `harmonise` uses for documentation files: walk the
tree, discover matches, process independently, group by policy.

## The boundary with `harmonise`

Both `dependa` and `harmonise` modify repository files and open pull requests.
Both require `edit-file` and `open-pr` capabilities, both default to empty
capabilities at level 0, and both go through the same enforcement stage
before any write.

The difference is domain: `harmonise` synchronises documentation across
locales; `dependa` updates dependency versions in manifests. They share the
core — the provider client, the warrant loader, the enforcement stage, the
state branch mechanism — and differ only in what they decide.

---

**Related:** [`dependa`](../reference/duties/dependa.md) ·
[`harmonise`](../reference/duties/harmonise.md) ·
[The authority model](authority-model.md) ·
[Duties and the core](duties-and-the-core.md) ·
[Architecture](../development/architecture.md)
