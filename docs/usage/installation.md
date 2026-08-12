# Installation

Adding a duty to a repository: the trigger, the permissions, the provider, and
the version to pin.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## The five-minute version

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
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

No `.github/reeve.yml`, and nothing else written down anywhere. This is level 0
of [the ladder](../north-star.md#3-the-ladder) — the narrowest authority Reeve
defines in code, built entirely from the labels and the label descriptions your
repository already has, so a first run costs you nothing typed twice: `triage`
may only `label`, against the taxonomy sitting in your repository settings
already.

**This is [Stage 1](../north-star.md#7-roadmap): no warrant needed, and no
`.github/reeve.yml` either.** See [The warrant](warrant.md) for when a written
one starts earning its keep. Everything from here down is what you configure
once a rung below stops being enough; read it the day you need it, not
before.

## 1. Pick a provider

Reeve talks to one thing: an endpoint speaking the OpenAI chat-completions
protocol. That is the entire vendor contract. OpenAI, a gateway, a model host, a
`llama.cpp` on your own hardware, a keyless free tier — each is a different value
for `base-url`, and none of them is a migration.

The request Reeve sends is deliberately the smallest one that protocol defines:
`model`, `messages`, `stream: false`, and a `temperature` only where a step wants
one. No `max_tokens`, no `response_format` — every answer a duty asks for is
prose or one short token, so nothing is gained by a field the cheapest providers
are the likeliest to reject.

```yaml
with:
  base-url: https://api.openai.com/v1 # the default
  api-key: ${{ secrets.OPENAI_API_KEY }}
  models: gpt-5-mini
```

**Leave `api-key` empty for a keyless provider.** That is a supported
configuration, not a degraded one — [Cost](cost.md) covers how to make it work
well.

**`models` takes a list, in order of preference.** One per line or comma
separated. A model that fails or answers unusably is rotated past, never retried:
a provider limit does not clear inside one run, so the next attempt starts from a
shorter list rather than the same wall.

```yaml
models: |
  gpt-5-mini
  gpt-5
  some-fallback
```

Order is preference, not last-resort. Put the model you actually want first.

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
[Security](../development/security.md) has the rest.

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

jobs:
  reeve:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/translate@v0.1
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
[The warrant](warrant.md).

| You want                     | Grant                                                 |
| ---------------------------- | ----------------------------------------------------- |
| Anything on issues           | `issues: write`                                       |
| Anything on pull requests    | `pull-requests: write`                                |
| Reading a taxonomy or memory | `contents: read`                                      |
| Committing corrections back  | `contents: write` — opt in, see [warrant](warrant.md) |

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
[platform limits](../development/platform-limits.md).

## 4. Pin a version

```yaml
- uses: ecoma-io/reeve/triage@v0.1 # floating minor — fixes only
- uses: ecoma-io/reeve/triage@v0.1.3 # an exact release
- uses: ecoma-io/reeve/triage@9c0f… # a commit SHA — cannot move at all
```

**`@v0.1` is the widest ref worth pinning today, and there is deliberately no
`v0`.** Reeve is on a `0.x` line, where a breaking change lands on the minor
digit ([why](../development/releasing.md#what-0x-and-10-mean-here)) — so a `v0`
tag would hand you one silently, and the repository does not publish one. `v0.1`
can only ever move forward by a patch. When the roadmap is finished and `1.0`
arrives, `v1` becomes the floating ref and behaves the way a major line is
supposed to.

Pin a SHA when you want something that cannot move at all. Every form works: the
built bundle is committed to this repository, so a duty resolves without a build
step on your runner.

## 5. Rehearse before you arm it

```yaml
with:
  dry-run: true
```

Every duty runs its whole pipeline under `dry-run` — reads the thread, detects
the language, screens, drafts, scores, verifies — logs what it would have done,
writes every output, and touches nothing.

Run it that way against ten real threads first. It costs the model calls and
nothing else, and it is the only honest way to find out what a taxonomy or a
provider does on your repository rather than on somebody else's.

## A complete first workflow

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
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini

  translate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/translate@v0.1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          languages: en, vi
```

Two duties, one version line, one provider — level 0 with an extra duty added,
nothing more. **Climbing the ladder from here means writing things down, not
switching anything on:** decide what each duty is allowed to do —
[The warrant](warrant.md) — and who reads what — [Languages](languages.md).
