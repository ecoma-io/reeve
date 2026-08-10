# Releasing

How a commit becomes a version somebody can pin, and why each step in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) is where it
is.

## What "publish" means here

There is no package registry in the picture. A consumer writes
`uses: ecoma-io/reeve/triage@v1` and GitHub resolves that straight to a git ref
in this repository.

So publishing is exactly two things:

1. A release exists at an exact tag, carrying source, the committed bundle, an
   archive and a signed attestation.
2. A floating tag points at it.

Both are things the workflow can actually do. There is no rehearsal step and no
credential to provision.

## The version is not chosen by hand

release-please reads the conventional commits since the last release, opens a
pull request carrying the bump and the changelog entry, and cuts the release when
that pull request merges.

The maintainer act is **reviewing and merging that pull request** — not
remembering what `feat:` does to the second digit.

| Commit                       | Below `1.0.0`      | From `1.0.0` |
| ---------------------------- | ------------------ | ------------ |
| `fix:`                       | nothing on its own | patch        |
| `feat:`                      | minor              | minor        |
| `feat!:` / `BREAKING CHANGE` | **minor**          | major        |

`bump-minor-pre-major` sends breaking changes to the minor digit below `1.0.0`,
which is what keeps Reeve out of a premature `1.0`.

## Floating tags, and why `v0` must not exist

The floating tag is what a consumer pins to get fixes without editing their
workflow. What it is allowed to deliver decides its shape.

- **From `1.0.0`:** `v1`. Semver promises a major line adds features and fixes
  bugs without breaking anyone.
- **Below `1.0.0`:** `v0.1`, `v0.2`, … — the widest ref that can still only ever
  deliver patches.

**There is deliberately no `v0`.** Below `1.0.0` a breaking change lands on the
minor digit, so anyone pinned to `v0` would take one silently on the next minor.

Both cases are read off the version just released rather than configured
anywhere, in the `floating-tag` job.

## The order the workflow runs in, and why

```
release ──► provenance ──► floating-tag
   │            │               │
 tag, notes,  sign the      point v1 (or v0.x)
 archive      digest        at the release
```

**Moving the floating tag is last, in its own job.** It is the step that silently
updates every consumer pinned to it, so it may not fire until the release it
points at is complete — archive attached, attestation signed.

The recoverable order is _a release nobody is pointed at yet_. The unrecoverable
one is _consumers already running code whose provenance never arrived_.

**Everything lives in one workflow, and that is forced rather than preferred.**
release-please tags with `GITHUB_TOKEN`, and GitHub does not start a workflow from
an event that token caused ([platform limits §1](platform-limits.md#1-a-github_token-write-does-not-trigger-a-workflow)).
A separate `on: push: tags:` workflow would never run. So everything downstream is
gated on the action's own `release_created` output instead.

## `dist/` is committed, and CI enforces it

What a consumer's runner executes is `dist/index.js`. There is no install step and
no build step on their side.

So the bundle is committed, and **two separate jobs prove it matches its source**:

- CI on every pull request rebuilds and fails on `git diff --exit-code -- dist`.
- The release job rebuilds again at the release commit and refuses to continue.

The second is not redundant. The artifact being released _is_ the committed
bundle, so "the bundle matches its source" is the one property whose failure would
ship silently and run wrong code in every consumer's repository. A failure there
leaves the release created with no floating tag pointing at it — recoverable:
delete the release, fix the bundle, release again.

**When you change `src/`, run `pnpm build` and commit `dist/` in the same
commit.** A pull request whose bundle is stale fails CI, and the message says so.

## Provenance

The signing half answers a question the delivery half cannot.

`dist/index.js` is megabytes of bundled JavaScript running in someone's repository
with a write token — far past what anyone reads before pinning. CI proves the
bundle matches `src/`, and the release job proves it again, but both are _this
repository asserting something about itself_.

Provenance is the same claim in a form a stranger can check without trusting us:
the sha256 of the exact bytes, signed by Sigstore against the identity of the
workflow that produced them. `slsa-verifier` checks it.

That is the only reason the archive exists. Nobody installs an action from a
tarball; they verify one from it.

**The SLSA generator is the one `uses:` in this repository not pinned to a commit
SHA, and the only one that may not be.** It reads its own ref to attest which
builder produced the provenance, so it refuses to run when called by digest or by
a shortened `@vX` tag. Pinning it would not tighten the supply chain — it would
stop releases from being signed at all. Renovate keeps it current and
`.github/renovate.json5` carves it out of digest pinning by name.

## The Marketplace

The one part that is not automatable: the first publication is a checkbox on the
release page, done once by a maintainer. Once ticked, every later release updates
the listing on its own.

**Only the root `action.yml` gets a listing.** Duties live in subdirectories, and
GitHub's Marketplace reads the repository root
([platform limits §10](platform-limits.md#10-an-action-can-live-in-a-subdirectory-the-marketplace-only-sees-the-root)).
Consumers get one version line and one core; the cost is that individual duties
are not separately listed. That trade was made deliberately.

## Before `v1`

Reeve is pre-release, and two things follow that a contributor will run into:

**A release must not be cut before a duty's `dist/` exists.** A `v0.1.0` tag whose
tree has no duty bundle would make `uses: ecoma-io/reeve/triage@v0.1.0` resolve to
nothing — a broken pin that cannot be unpublished, only superseded. release-please
will open a release pull request as soon as there are releasable commits on
`main`; **leave it open** until Stage 0 has landed a real bundle.

**The release workflow carries a `TODO(stage-0)`** at the archive step: the
`cp -r dist action.yml …` line becomes a list including `translate/action.yml` and
`triage/action.yml` as duties land. `tools/build.mjs` carries the matching one for
entry points. Both are marked so neither is discovered by a consumer.

## Cutting a release

1. Merge work to `main` with conventional commits. Scopes are in
   [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
2. release-please opens or refreshes `chore(workspace): release X.Y.Z`.
3. Review the changelog it wrote. It is the release notes, and it is generated
   from commit subjects — a subject nobody could read in a changelog is a subject
   to fix before merging, not after.
4. If a duty changed, put its evaluation numbers in the release notes
   ([D11](../north-star.md#d11--every-duty-ships-with-an-evaluation)).
5. Merge. The rest runs on its own.
6. Verify: the release exists, `reeve-action.tar.gz` and
   `reeve-action.intoto.jsonl` are attached, and the floating tag moved.

If the workflow fails after the release was created but before the floating tag
moved, consumers pinned to the floating tag are still on the previous version and
nothing is broken. Fix forward.

## What a breaking change is

Judged from the consumer's workflow file, not from the source:

- Removing or renaming an input, an output, or a duty.
- Changing an input's default.
- Changing what a duty does by default — a capability that becomes on, or a
  guardrail that becomes looser.
- Breaking one of [the invariants](security.md#invariants), which is a breaking
  change regardless of what any `action.yml` says.
- Raising the Node major in `runs.using`.

Adding an input with a default that preserves today's behaviour is not one.
