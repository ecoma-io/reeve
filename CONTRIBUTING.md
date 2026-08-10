# Contributing to Reeve

Thank you for being here. This document is the short version of everything a
pull request is judged on, so nothing about the process is a surprise.

By contributing you agree that your work is licensed under the
[Apache License 2.0](LICENSE), and that you have the right to grant that
license — see [Ownership of what you contribute](#ownership-of-what-you-contribute).

> The runtime works and has been run against a real provider end to end. Releases
> are cut by release-please from the commits on `main` — see
> [Releases](#releases).

## The one rule that decides most questions

**This action is general, and it is not designed around the repository that
happens to maintain it.** Ecoma dogfoods it, which is a good way to find out
whether it works and a bad reason to shape it. So the test for any proposal is
whether it would still be the right design for a repository whose languages,
provider and conventions are nothing like ours.

Three consequences worth stating outright, because each one has already turned a
plausible design down:

- **Nothing is special-cased by language.** Not Vietnamese, not Chinese, not
  English. Languages arrive through the `languages` input, and any rule that
  cannot be derived from that input — a script set, a length expectation, a
  script-leak check — does not get to exist. A heuristic that reads "if the text
  is Chinese" is the shape of the bug, not the shape of the fix.
- **The free-tier path is a supported path, not a degraded one.** Some people
  will run this against an OpenAI-compatible endpoint with no key, on models
  that are individually weak. That configuration is why multi-draft scoring is
  mandatory rather than optional. A change that only makes sense when the model
  is good is a change that abandons those users.
- **Provider-specific behaviour lives behind the provider seam or nowhere.**
  What crosses into the rest of the code is the OpenAI chat-completions
  protocol. If a feature needs more than that protocol offers, it needs a design
  discussion first, because it is proposing to narrow who can use this.

## Setting up

Requirements: **Node ≥ 24** (`.node-version` pins the major) and **pnpm 11**
(pinned via `packageManager`, so Corepack fetches the right one).

```bash
git clone https://github.com/ecoma-io/reeve.git
cd reeve
pnpm install
```

`pnpm install` runs `lefthook install`, which is what puts the Git hooks in
place. If you have ever wondered why a repository's hooks did not run for you:
it is because that step was skipped. Do not skip it.

**TypeScript stays on 5.x on purpose.** TypeScript 7 is the native rewrite, and
`typescript-eslint` refuses to load against it — `pnpm lint` fails on every file
at once, not gradually. Renovate is configured to hold the pin, so if you find
yourself bumping it by hand, that is the reason not to.

## The commands

| Command             | What it does                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`         | ESLint, with type information, zero warnings tolerated                                                        |
| `pnpm typecheck`    | `tsc --noEmit` — esbuild strips types without checking them, so this is the only place a type error is caught |
| `pnpm test`         | Vitest, unit and integration, with coverage thresholds                                                        |
| `pnpm build`        | esbuild, one bundle per action — the listing's, and each duty's beside its own `action.yml`                   |
| `pnpm format`       | Prettier, in place                                                                                            |
| `pnpm format:check` | Prettier, read-only — what CI runs                                                                            |
| `pnpm try <duty>`   | Runs one duty here, against a real provider and a real thread — see below                                     |

Before you push, run all of the first six. A shorter local run just moves the
red to the pull request. `pnpm try` is not one of them: it needs a network and a
token, so it is a thing you do when a change deserves it, not a gate.

`pnpm test` runs with coverage and the thresholds in `vitest.config.ts` apply,
so the floor is enforced from the first test rather than retrofitted later. It
does not carry `--passWithNoTests`: a glob that stops matching anything is a
suite nobody ran, and it should go red rather than green.

`pnpm lint` reads type information, not just syntax — which is what lets it
report a floating promise, an `await` on something that is not a thenable, or a
condition that can never be false. The rule set is `strictTypeChecked`
deliberately, and the `no-unsafe-*` rules are errors rather than warnings for a
specific reason: nearly every value Reeve handles arrives as `any` — a
webhook payload, a JSON body a model wrote — and the moment one of those is
allowed to spread untyped, the parsing that was supposed to validate it has been
skipped without anyone noticing.

`no-console` is also an error. Logging goes through `@actions/core`, which is
what applies secret masking; a raw `console.log` of a request object is how an
API key reaches a public build log.

## Trying it against a real provider

Nothing in the suite reaches a model. The unit tests mock the provider and the
integration tests drive the real bundle against a local HTTP stub, which is what
makes them deterministic, offline, and safe to run on a fork's pull request. It
is also the one thing they cannot tell you: whether a real endpoint answers the
way a duty assumes.

`pnpm try <duty>` is that instrument. It does what a runner does — reads the
defaults out of that duty's `action.yml`, sets `INPUT_*`, spawns the freshly
built bundle from the duty's own directory — with the settings coming from a
`.env` you own:

```sh
cp .env.example .env
# fill in GITHUB_TOKEN (`gh auth token` prints one), the repository, the number,
# and whichever endpoint you have
pnpm try translate
```

The duty is named rather than defaulted, because a duty ships from its own
directory and that directory is what a workflow names too. Run it with no name
and it lists the ones that exist.

`.env` is git-ignored and `.env.example` is not, so the example file names no
endpoint and holds no key. Two things are worth knowing before the first run:

- **`DRY_RUN=true` is the shipped default, and it means nothing is written** —
  the body it would have written is printed instead. Turn it off only against a
  thread you are willing to write to: the duty writes to a real thread under a
  real account, appending below its own marker and never over the author's
  text.
- **An exported shell variable beats `.env`.** That is Node's own precedence:
  `DRY_RUN=false pnpm try translate` is a one-off without an edit, and a `GITHUB_TOKEN`
  already exported in your shell is the one that will be used.

This repository also runs its own duties on its own issues and pull requests —
`.github/workflows/reeve-*.yml`, pointed at the working tree with `uses: ./`
rather than at a tag, so a change is dogfooded on the pull request that makes it.
The provider comes from repository secrets, which a maintainer sets. A fork has
none, so the duty is skipped there and the run says so in a notice — a fork
inheriting workflows it cannot configure should not inherit a red tick for it
either.

## The committed bundle

**`dist/` is checked in, and that is not an accident.** GitHub runs a JavaScript
action straight off the checked-out repository — there is no install step and no
build step on the runner — so the bundle is the artifact consumers execute.
Every other repository in this organisation ignores `dist/`; this one must not,
and `.gitignore` says so in a comment.

What that means for you:

```bash
pnpm build && git add dist
```

The `pre-push` hook rebuilds and refuses to push if the result differs from what
you committed. CI checks the same thing, and so does the release workflow. If
you have ever seen an action repository merge a fix that changed nothing in
practice, this is the check that was missing.

Review the bundle diff the way you would review generated output — glance at it,
do not read it. It is marked `linguist-generated` so GitHub collapses it.

## What the hooks do

- **pre-commit** — Prettier formats the staged files and re-stages what it
  rewrote, then ESLint runs over them. The commit contains formatted bytes
  rather than a follow-up fixup.
- **commit-msg** — commitlint checks the message shape.
- **pre-push** — `typecheck`, `test`, and the bundle-freshness check above.

Bypassing a hook with `--no-verify` is occasionally the right call during a
rebase. It is never the right way to land a change.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint.

```
<type>(<scope>): <subject>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

**Scope is optional**, and when used must come from this list. It separates the
core every duty shares from the duties themselves, because a change to one
duty's judgement is a different kind of change from a change to the machine
underneath all of them:

core — `action`, `provider`, `language`, `warrant`, `score`, `judge`,
`sanitize`, `memory`, `forge`, `publish`; duties — `translate`, `triage`,
`duplicate`, `respond`; and around them — `eval`, `brand`, `docs`, `workspace`,
`deps`, `ci`.

`deps` and `ci` are on that list because Renovate writes them: it opens
`chore(deps):` and `chore(ci):` pull requests, and a scope list without them
would fail commitlint on every dependency update.

```
feat(warrant): reject a duty the warrant file does not enable
fix(sanitize): escape <summary> so injected Markdown cannot close the container
chore(deps): update dependency esbuild to v0.27.1
```

A breaking change is marked with `!` after the type or scope, and explained in a
`BREAKING CHANGE:` footer. Here that means something narrower than usual and
more consequential: **the breaking surface is `action.yml`.** Consumers pin a
floating tag, so renaming an input, changing a default, or tightening what an
input accepts reaches every one of them on the next run, with no version bump
they chose. Removing an input is breaking. Making an optional input required is
breaking. Changing what an output contains is breaking. Say plainly what a
consumer must edit in their workflow file.

### If your commit was AI-assisted

Add a trailer naming the tool: `Assisted-by: <tool>`, or `Generated-by: <tool>`
where the tool produced substantially the whole commit. A pull request
description can be edited later and no clone carries it; the commit trailer
travels with the code.

**One trailer per pull request, on the last commit** — not one per commit.
Squashing concatenates the full message of every commit on the branch into the
body of the single commit that lands, trailers and all, so a trailer repeated
across five commits arrives in history five times.

## Releases

Nobody picks a version number here. `release-please` reads the conventional
commits on `main`, keeps a release pull request up to date with the next version
and its changelog entry, and cuts the release when that pull request merges. So
**the commit type you choose is the version decision**, which is the reason the
section above is strict about it:

| Commit          | While below 1.0.0 | From 1.0.0 on |
| --------------- | ----------------- | ------------- |
| `fix:`          | patch             | patch         |
| `feat:`         | minor             | minor         |
| `feat!:`        | **minor**         | major         |
| everything else | no release        | no release    |

The bolded cell is the deliberate part. `bump-minor-pre-major` sends breaking
changes to the minor digit while the version is below 1.0.0, so a duty
cannot back into a 1.0 it has not earned. 1.0.0 will be a decision someone
makes, on the day the `action.yml` contract is one we are willing to keep.

**There is no `v0` tag, on purpose.** The floating tag is what a consumer pins
to get fixes without editing their workflow, so what it is allowed to deliver
decides its shape. Below 1.0.0 a minor bump may break you — that is what the
bolded cell above makes routine — so a `v0` would hand breaking changes to
anyone tracking it. The floating tag is the minor line instead: `v0.1`, `v0.2`.
From 1.0.0 on it becomes `v1`, where semver's promise makes a floating major
safe again.

Three things about the release pull request that are not obvious, each of which
has already gone red once:

- **Its title is pinned** to `chore(workspace): release <version>` by
  `pull-request-title-pattern`. release-please's own default puts the target
  branch in the scope — `chore(main): release 0.1.0` — and `main` is not in the
  scope list above, so CI would reject it on every release. If you edit the
  scope list, keep `workspace` in it.
- **`CHANGELOG.md` and `.release-please-manifest.json` are in `.prettierignore`.**
  release-please writes them and Prettier disagrees with its output. Formatting
  them by hand would only produce a commit release-please overwrites next time.
- **Its CI run needs one approval click.** The pull request is opened by
  `github-actions[bot]`, and this repository requires approval before running
  workflows for external contributors — the strict setting, which is the right
  one for a public repository and is not going to be loosened to save a click.
  So the required `ci-gate` check stays absent until a maintainer presses
  "Approve and run".

## Tests

Two tiers live beside the source, distinguished by filename:

| Tier            | File                                | What it may touch                                                                                                                |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | `src/**/<name>.test.ts`             | The unit alone. Every project-internal collaborator is stubbed; third-party libraries are not.                                   |
| **Integration** | `src/**/<name>.integration.test.ts` | Real collaborators — justified only when that interaction _is_ the behaviour being pinned. "Isolating it was annoying" never is. |

**No model is ever called from a test.** Not a real one, not a free one, not
"just this one integration test". A test that talks to a provider is a test that
fails on someone else's rate limit and passes for the wrong reason on a good
day. The provider seam is stubbed, and what gets pinned is how this code behaves
against the responses a provider actually produces — including the ugly ones.

Three things a reviewer will check:

- **A test pins intent, not just current output.** If the logic that matters
  could change without failing your test, the test is not doing its job.
- **A test is titled by the behaviour it pins**, never by the phase of work that
  added it. `escapes a summary tag inside model output`, not
  `sanitizer fix round 2`.
- **The failure cases are covered, not just the success case.** See below.

### What a reviewer will actually look for

This action runs in other people's repositories holding a write token. So the
question a change is judged on is not "does it work when the model behaves" — it
is **what happens when the model misbehaves, and what happens when the input is
hostile.** Concretely, a change that touches the pipeline is expected to have an
answer for:

- the provider returns a non-2xx, or times out, or returns HTML;
- the provider returns HTTP 200 with an error object in the body — several do;
- the model returns prose where JSON was demanded, or JSON with the wrong shape;
- the model returns a result the warrant does not permit, and claims it does;
- the model returns half a result, or stops partway through;
- the thread body contains an instruction aimed at the model;
- the thread body contains something shaped like a duty's own marker;
- every model in the list fails.

None of those is hypothetical. Each has been observed against a free endpoint,
which is exactly the configuration Reeve is meant to survive.

`fast-check` is available for the properties worth stating over a generated
input space rather than a handful of examples — a sanitiser's output containing
no unescaped `<details>` for _any_ input is a property, not three test cases.
Keep runs deterministic on CI, and when a generated case finds a bug, commit
that case as a plain pinned regression test alongside the fix.

Never commit a focused or skipped test. `it.only` silences the rest of the suite
while still reporting green; `it.skip` reports green for something nobody ran.
An unimplemented case is `it.todo`, which is visible.

## Analysis

CodeQL runs over two languages, and the second one is the interesting one:
`actions` reads the workflow files in this repository. This _is_ a GitHub Action,
and the mistakes that leg reports — an untrusted checkout under
`pull_request_target`, `github.event.*` interpolated into a `run:` block, a job
with no `permissions:` — are precisely the mistakes our own consumers will make
in workflows they copy from our README. Treat a finding in a workflow file as a
finding in documentation as well as in code.

There is no Semgrep configuration here yet, and
[`analysis.yml`](.github/workflows/analysis.yml) explains why: the sinks worth
writing rules for do not exist until the runtime does.

## Opening a pull request

1. Branch from `main`.
2. Make the change, with tests, and run the full command list above.
3. Rebuild the bundle and commit it.
4. Fill in the pull request template honestly — especially **Consumer impact**.
   Writing "none" is fine when it is true; leaving it blank is not.
5. Keep it focused. Unrelated cleanup found along the way is welcome as its own
   pull request — mixed into this one it makes the real change unreviewable.

### How a pull request lands

**Squash, always.** Three things follow, and the first is the reason for a check
you will see in CI:

- **The pull request title becomes the subject of the commit on `main`**, so the
  title itself must be a valid Conventional Commit. CI checks it with the same
  commitlint configuration the `commit-msg` hook uses, so a valid message has
  one definition rather than two. Your own commit messages are kept — they land
  in the body of the squash commit — but only the title reaches the first line.
- **One release-worthy change per pull request.** A pull request holding a
  `feat:` and an unrelated `fix:` gets one subject line, so it announces one of
  them. If you have two, send two.
- **You do not need to sign your commits.** GitHub signs the squash commit it
  creates, and the commits on your branch are never the ones that land.

## Reporting problems

- **Bugs and proposals** — use the issue forms. The questions they ask are the
  ones that decide whether something is actionable.
- **A wrong decision by a duty** is a bug, and a public issue is the right place
  for it — use the _Duty output quality_ form and include what the duty saw, so
  it can become an evaluation case.
- **Security vulnerabilities** — never a public issue. Follow
  [SECURITY.md](SECURITY.md).

## Ownership of what you contribute

You keep the copyright in your contribution and license it to the project under
Apache-2.0, which includes the patent grant that license carries.

Please only send work you have the right to send. If you are employed as a
developer, your employment agreement may assign what you write to your employer
even on your own time and your own hardware — in which case you need their
permission before contributing, not after. Anything you did not write yourself,
including substantial output from an AI tool, must be disclosed as described
above.

## Code of Conduct

Everyone taking part is held to the [Code of Conduct](CODE_OF_CONDUCT.md).
Reports go to john.itvn@gmail.com.
