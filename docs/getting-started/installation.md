# Installation

_Get a first workflow running in five minutes. Prerequisites: a GitHub repository, an OpenAI-compatible API key with billing enabled, and the key stored as a repository secret._

Adding a duty to a repository: the trigger, the permissions, the provider, and
the version to pin.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## The five-minute version

> [!IMPORTANT]
> Running this workflow sends issue content to your configured model endpoint
> and may incur charges. The example uses OpenAI's paid `gpt-5-mini` model.
> See [Cost](../guides/cost.md) before your first run. Add `dry-run: true` to
> rehearse the full pipeline without writing to GitHub.

```yaml
name: Reeve

on:
  issues:
    types: [opened, reopened, edited]

concurrency:
  group: reeve-issue-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/triage@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

No `.github/reeve.yml`, and nothing else written down anywhere. This is level 0
of [the ladder](../doctrine/north-star.md#3-the-ladder) — the narrowest authority Reeve
defines in code, built entirely from the labels and the label descriptions your
repository already has, so a first run costs you nothing typed twice: `triage`
may only `label`, against the taxonomy sitting in your repository settings
already.

> [!NOTE]
> `actions/checkout` is required: Reeve reads your warrant file
> (`.github/reeve.yml`) from the local checkout, not the GitHub API.
> Without checkout, your warrant restrictions are silently bypassed.
> At level 0 — no warrant file — this step can be omitted, but adding it
> now costs nothing and prevents a silent misconfiguration later.

### Which duty should I start with?

| Duty         | Cost        | Best for                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`triage`** | Low         | First duty. Labels issues from your existing taxonomy — no warrant file needed.                                                                                                                                                                                                                                       |
| `translate`  | Low         | Multilingual repositories. Appends translated blocks to issue bodies.                                                                                                                                                                                                                                                 |
| `duplicate`  | Low         | High-volume issue trackers. Reports likely duplicates without acting by default (report-only at level 0).                                                                                                                                                                                                             |
| `respond`    | Medium      | Drafts replies to issues from guidance files you write. Reports by default (report-only at level 0).                                                                                                                                                                                                                  |
| `lifecycle`  | **Zero**    | Stale-issue management. Calls no model — driven entirely by your warrant policy.                                                                                                                                                                                                                                      |
| `harmonise`  | Medium      | Keeps translated files (README, docs) in sync with a source language. Report-only at level 0 — needs a `duties:` grant in the warrant to act.                                                                                                                                                                         |
| `dependa`    | Medium–High | Dependency maintenance. Discovers updates, classifies risk, opens PRs. Report-only at level 0 — needs a `duties:` grant in the warrant to act. Can run without a model for discovery only.                                                                                                                            |
| `review`     | Medium      | Pull request review. Deterministic pre-checks plus one or more model passes by profile (`default` runs one correctness pass; `deep` adds a security pass), with model findings verified against deterministic evidence before they are reported, synthesized into a single owned comment. Report-only at level 0 — needs a `duties:` grant in the warrant to act. |

**Start with `triage`.** It is the narrowest authority, the cheapest to run,
and the one that needs nothing beyond a model key and the labels your
repository already has. `lifecycle` is the only duty that costs nothing at all
— it reads your policy and acts, with no model call — making it a good second
duty for repositories that want stale-issue management without API spend.

**This is [Stage 1](../doctrine/north-star.md#7-roadmap): no warrant needed, and no
`.github/reeve.yml` either.** See [The warrant](../guides/warrant.md) for when a written
one starts earning its keep. Everything from here down is what you configure
once a rung below stops being enough; read it the day you need it, not
before.

## 1. Pick a provider

Reeve talks to one thing: an endpoint speaking the OpenAI chat-completions
protocol. A provider is three things on the step — `base-url`, `api-key`, and
`models` — and the full grammar (keyless providers, `endpoints`, `model@alias`
routing, `request-timeout`, `temperature`) is
[Providers and the runtime](../guides/providers.md). The minimum:

```yaml
with:
  base-url: https://api.openai.com/v1 # the default
  api-key: ${{ secrets.OPENAI_API_KEY }}
  models: gpt-5-mini
```

`models` is the one thing every drafting duty needs, in order of preference —
a model that fails is rotated past, never retried.

## 2. Pick a trigger

### Issues

```yaml
on:
  issues:
    types: [opened, reopened, edited]

concurrency:
  # A rapid edit supersedes the previous run: only the newest text is worth
  # spending calls on.
  group: reeve-issue-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write
```

`concurrency` is doing a second job here beyond cancelling the stale run: it is
also what keeps two runs from writing the same thread at once. A duty's own
write is not a lock — `publish()` writes once, reads once to check what landed,
and warns rather than fails when the two disagree, because by then the write
already happened and there is nothing left to roll back. The `group` above is
the actual fix: keyed on the thread, it serializes every run that could touch
one, so there is only ever one write in flight to warn about, never two racing
each other.

### Pull requests

One deliberate change, and it is the one to understand before you copy it.

```yaml
on:
  # NOT `pull_request`: a fork's token there is read-only, so the job could
  # never write anything back. `pull_request_target` runs against the BASE ref
  # with a write token — safe here only because nothing from the PR head is ever
  # checked out or executed.
  pull_request_target:
    types: [opened, edited]

permissions:
  contents: read
  pull-requests: write
```

`pull_request_target` hands a write token to a job whose subject a stranger
controls. Reeve is safe under it for one specific reason: it reads the thread
through the API, as **data**. Nothing from the head is checked out and nothing
from it is executed. If you add `ref: ${{ github.event.pull_request.head.sha }}`
to a checkout in that workflow — the obvious fix when something else in the job
needs the code — you have handed a fork's code your write token. Do not.
[Security](../security/security.md) has the rest.

### A backfill, or one thread on purpose

`number` names the thread, and it is the only thing a backfill needs. The
workflow does not have to be triggered by an issue at all:

```yaml
on:
  workflow_dispatch:
    inputs:
      number:
        description: Issue or pull request number
        required: true

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  reeve:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.6
        with:
          number: ${{ inputs.number }}
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

Leave `number` out and a duty reads the thread that triggered the workflow. On an
event that names no thread — a `schedule`, a `push`, a bare `workflow_dispatch` —
it fails and says which event it was, rather than asking GitHub for issue `NaN`.

## 3. Permissions

`issues: write` is one scope, and GitHub does not subdivide it. Labelling,
commenting, closing and editing are the same permission as far as the token is
concerned — which is why duties carry their own capability inputs. **The token
cannot express "labels only", so the duty has to.** See
[The warrant](../guides/warrant.md).

| You want                                                   | Grant                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Anything on issues                                         | `issues: write`                                                 |
| Anything on pull requests                                  | `pull-requests: write`                                          |
| Reading manifests or blobs from the Contents API           | `contents: read`                                                |
| Reading the warrant or corrections from the local checkout | No GitHub permission — `actions/checkout@v4` provides the files |
| Committing corrections back                                | `contents: write` — opt in, see [warrant](../guides/warrant.md) |

**`actions/checkout@v4` must run before any duty step.** Reeve reads the
warrant file (`.github/reeve.yml`) from the local checkout, not the GitHub
API. Without checkout, the runner has no repository files and your warrant
restrictions are silently bypassed — the duty falls back to its implicit
authority, which may be wider than what you wrote. At level 0 (no warrant
file), checkout is not strictly required, but adding it now prevents a silent
misconfiguration when you later add a warrant.

The ambient `secrets.GITHUB_TOKEN` covers everything a duty does by default, and
it is the `github-token` default. Pass something else only for the reason in the
next paragraph.

**This runs unmodified on GitHub Enterprise Server** — the tracker client reads
the runner's own `GITHUB_API_URL`, so there is nothing to point at your instance
and no input for it to get wrong.

**A label applied by `GITHUB_TOKEN` does not start a workflow listening on
`issues: [labeled]`.** GitHub suppresses that to prevent recursion, and it does
so silently. If a downstream workflow has to see Reeve's label, pass a GitHub App
token from `actions/create-github-app-token` instead. This and the other GitHub
behaviours that shaped the design are in
[platform limits](../reference/platform-limits.md).

## 4. Pin a version

```yaml
- uses: ecoma-io/reeve/triage@v0.6 # floating minor — the current one
- uses: ecoma-io/reeve/triage@v0.6.0 # an exact release
- uses: ecoma-io/reeve/triage@9c0f… # a commit SHA — cannot move at all <!-- historical ref -->
```

Every release publishes both `v0.$MINOR` and `v0.$MINOR.$PATCH`, and the
`floating-tag` job moves `v0.$MINOR` forward on every release — so
**`@v0.6` is the widest ref worth pinning today, and there is deliberately no
`v0`.** Reeve is on a `0.x` line, where a breaking change lands on the minor
digit ([why](../development/releasing.md#what-0x-and-10-mean-here)) — so a `v0`
tag would hand you one silently, and the repository does not publish one. A
`v0.$MINOR` tag only ever moves forward by a patch within its own minor. When the
roadmap is finished and `1.0` arrives, `v1` becomes the floating ref and behaves
the way a major line is supposed to.

Pin a SHA when you want something that cannot move at all. Every form works: the
built bundle is committed to this repository, so a duty resolves without a build
step on your runner.

## 5. Rehearse before you arm it

```yaml
with:
  dry-run: true
```

Every duty runs its whole pipeline under `dry-run` and touches nothing. Run it
against ten real threads before you point a taxonomy or a provider at your
actual backlog — [Dry run](../guides/dry-run.md) covers what it does and does
not tell you.

---

**Related:** [The warrant](../guides/warrant.md) · [Languages](../guides/languages.md) · [Cost](../guides/cost.md)
**Next:** [A complete first workflow](first-workflow.md) — two duties, one version line, walked end to end
