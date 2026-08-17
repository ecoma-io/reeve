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

| Duty         | Cost        | Best for                                                                                                                                                                                   |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`triage`** | Low         | First duty. Labels issues from your existing taxonomy — no warrant file needed.                                                                                                            |
| `translate`  | Low         | Multilingual repositories. Appends translated blocks to issue bodies.                                                                                                                      |
| `duplicate`  | Low         | High-volume issue trackers. Reports likely duplicates without acting by default (report-only at level 0).                                                                                  |
| `respond`    | Medium      | Drafts replies to issues from guidance files you write. Reports by default (report-only at level 0).                                                                                       |
| `lifecycle`  | **Zero**    | Stale-issue management. Calls no model — driven entirely by your warrant policy.                                                                                                           |
| `harmonise`  | Medium      | Keeps translated files (README, docs) in sync with a source language. Report-only at level 0 — needs a `duties:` grant in the warrant to act.                                              |
| `dependa`    | Medium–High | Dependency maintenance. Discovers updates, classifies risk, opens PRs. Report-only at level 0 — needs a `duties:` grant in the warrant to act. Can run without a model for discovery only. |
| `review`     | Medium      | Pull request review. Deterministic pre-checks plus one model pass, reported as a single owned comment. Report-only at level 0 — needs a `duties:` grant in the warrant to act.             |

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
configuration, not a degraded one — [Cost](../guides/cost.md) covers how to make it work
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

**`request-timeout` bounds how long one request may run** before it counts as
weather rather than a failure — `120s` by default, a whole number of seconds
or minutes (`30s`, `2m`). A bare number with no unit is refused rather than
guessed at: the runner's own job timeout and this provider's request timeout
are not the same number, and treating them as interchangeable hides which one
actually fired.

**`temperature` sets the sampling temperature Reeve asks for**, between `0`
and `2`. Left empty — the default — the field is left out of the request
entirely, because some providers reject it outright rather than fall back to
a default of their own when one is sent. A value outside `0`–`2` is refused
rather than clamped to the nearest end.

### More than one endpoint

A single `base-url`/`api-key` pair is the ordinary case, and everything above
still describes it unchanged. `endpoints` adds more without replacing it —
a free provider to rotate to when the paid one is out of quota, a second
gateway that carries models the first does not, a self-hosted `llama.cpp`
sitting beside a hosted one:

```yaml
with:
  base-url: https://api.openai.com/v1
  api-key: ${{ secrets.OPENAI_API_KEY }}
  endpoints: |
    free = https://api.example.com/v1 timeout=30s
  api-keys: |
    free = ${{ secrets.FREE_API_KEY }}
  models: |
    gpt-5-mini
    llama-3-70b@free
```

Each `endpoints` line is `alias = url`, with an optional trailing
`timeout=<duration>` overriding `request-timeout` for that one endpoint.
One alias is reserved: `default` names the built-in `base-url` endpoint in
every log line and summary, so it cannot be declared as an alias of its own.
`api-keys` is `alias = key`, one line per alias that needs one — every value
in it is registered as a secret before anything else is even parsed, so a
malformed later line's error message can never expose an earlier key. An
alias named in `api-keys` that `endpoints` never declared is refused; a key
is optional, and an alias with none simply sends no `Authorization` header,
the same as a keyless `base-url`.

**`model@alias` routes that one model to that one endpoint.** The alias is
split off the model id at its _last_ `@`, and only when that alias was
actually declared in `endpoints` — a model id that happens to contain its own
`@` and names no declared alias is left whole and sent to the default
`base-url`, exactly as it always was, so an id is never misread as a routing
suffix by accident. A model with no `@alias` always means the default
endpoint, whatever else is configured.

**Weather is tracked per model _and_ per endpoint.** A 429, a 5xx or a
timeout from `llama-3-70b@free` demotes that pair alone — the same model
reached through a different endpoint, or a different model reached through
`free`, is still tried. A transport-level failure — the connection itself,
never an answer from the provider — demotes the whole endpoint instead, on
the reasoning that a broken connection says nothing about the model that was
asked over it.

**An auth failure behaves differently once there is more than one endpoint.**
A single-endpoint run still fails red immediately on the first 401 or 403,
exactly as
[D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration)
has always described. Once `endpoints` names more than one, a 401 or 403 is
recorded instead of thrown, and the run keeps going — one endpoint's wrong
key says nothing about another endpoint's — failing red only at the end, and
only once **every** endpoint this run's model ids actually route to has
ended up auth-failed. An endpoint no model routes to does not keep a doomed
run green: the question is whether anything that could have been asked still
authenticated. See the doctrine's own amendment at that same link for the
full reasoning.

Once more than one endpoint has carried any spend, every duty's job summary
gains an Endpoint column, naming which one answered each row.

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
