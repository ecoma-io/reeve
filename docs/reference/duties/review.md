<!-- source of truth: review/action.yml -->

# `review`

_Full contract for the `review` duty — every input, every output, checked against `review/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

A pull request changes, and the finding that was true at the previous SHA may
be one thing now: still standing, changed, resolved, or back after the code
came around again. `review` answers the pull request with exactly one comment
— its own, idempotent under its marker — that tracks its findings across
`synchronize` events instead of reposting them. It reviews; it does not code.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for, and what it will never become

The gap between a pull request and a careful reader is where the useful parts
of review live: a diff read against the repository's own rules, the findings
written down where the author can answer them, and the review that said a
thing once not repeating itself on every force-push. `review` fills that gap
with a single owned comment — the useful half of what a review bot does,
without the part that makes review bots noise.

**It is not a coding agent, and this is not a soft claim.** [The north
star](../../doctrine/north-star.md#8-non-goals) says Reeve does a duty and
stops; for `review` that means exactly one write is even thinkable — a
comment — and the warrant can grant no capability besides `comment`. It does
not edit code, open a fixing pull request, run a test suite, request changes
on the review API, or hold a conversation about its own findings. A
maintainer who wants any of that does it themselves; no input here, and no
warrant entry, turns it on. Review comments and threads only, and only where
the warrant grants `comment`.

**It is the top rung of [the ladder](../../doctrine/north-star.md#3-the-ladder),
and it is granted nothing on any default.** A finding printed on a pull
request reads, to everyone downstream, as though somebody from the project
reviewed it — which is the whole reason every default in this duty is the
strictest in this repository. `review` is granted nothing until a warrant
names it, whether the file is missing entirely or merely silent about this
duty. There is no cheap version of publishing a claim that reads as a project
review; `comment` is the only capability it has, and it is off until written
down.

## When to use it

A repository whose pull requests outpace how quickly a maintainer can say
something back. Grant nothing at first — the default warrant already runs this
duty with `comment` withheld, so a workflow can read the findings off the job
summary on real pull requests before deciding to let it post. Start from
`trigger: pr` and `dry-run: true`, watch a few `synchronize` events, and only
then grant `comment` and remove the dry-run.

## Example (minimal workflow YAML)

```yaml
name: Review

on:
  pull_request:
    types: [ready-for-review, synchronize, opened]

concurrency:
  group: reeve-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      # The rules file is part of the job's own pinned checkout, so a pull
      # request cannot replace it before the review reads it. Without `ref:`,
      # `checkout` would check out the pull request's merge ref — and until the
      # PR is merged, that ref carries the PR author's own `.github/reeve-rules.yml`.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: ecoma-io/reeve/review@v0.6 <!-- roadmap ref -->
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

That alone reviews and posts nothing: the checker reads the warrant, and a
`.github/reeve.yml` that does not grant `review: [comment]` leaves the findings
on the job summary and the thread untouched. Grant `comment` once you trust
it. The `pull-requests: write` scope covers both the read and the one write —
see [Required permissions](#required-permissions).

## Required permissions

**Token:** `pull-requests: write`. `GITHUB_TOKEN` is enough — this is one
indivisible GitHub scope, a token that can comment can also merge and close,
which is why what this run may actually do is decided in code against the
warrant file rather than by what the token can reach.

**Warrant grant:** like [`duplicate`](duplicate.md#required-permissions) and
[`respond`](respond.md#required-permissions), `review` is granted nothing by
default, and the `duties:` block in the warrant is the whole authority:

```yaml
# .github/reeve.yml
duties:
  review: [comment]
```

Leave the block silent about `review` and the run decides, reports on the job
summary, and posts nothing — a real answer, not a misconfiguration, and the
job summary says so. There is no smaller grant than `comment`; `review` has
exactly one capability to give. It needs `pull-requests: write` on the token,
and nothing on the workflow can widen the block. See
[the duties table](../../guides/warrant.md#duties). Like `duplicate` and
`respond` before it, `review` is one of the comment-posting duties with no
default at all — a written `duties:` block that simply leaves it unnamed
grants it nothing, exactly as an absent file does.

## Required inputs

`models` is the only input this action requires — the roster that reads the
diff, in preference order. Everything else has a default. `api-key` is not
required by the schema, but almost every real provider needs one — see
[Cost](../../guides/cost.md#running-it-with-no-key-at-all).

## Configuration

Every input `review/action.yml` declares.

| Input             | Required | Default                     | What it does                                                                                                                                                                                                                                                      |
| ----------------- | -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`    | no       | `${{ github.token }}`       | Token used to read the pull request and write the single owned comment. `pull-requests: write` on the token covers both; the warrant decides whether a comment is written at all.                                                                                 |
| `number`          | no       | _(empty)_                   | The pull request to review. Defaults to the one that triggered the workflow — meant to run on `pull_request` events, not on a backfill. An event that carries no pull request fails red naming the event.                                                         |
| `base-url`        | no       | `https://api.openai.com/v1` | An OpenAI-compatible `/chat/completions` endpoint.                                                                                                                                                                                                                |
| `api-key`         | no       | _(empty)_                   | The provider's key. Empty is a supported keyless configuration.                                                                                                                                                                                                   |
| `models`          | **yes**  | —                           | Model ids, comma or newline separated, in preference order. The roster that reads the diff.                                                                                                                                                                       |
| `warrant`         | no       | `.github/reeve.yml`         | Where the permissions live. `comment` is granted here, under `duties:`. A missing file grants `review` nothing, same as one that is silent about it.                                                                                                              |
| `rules-path`      | no       | `.github/reeve-rules.yml`   | The repository's own review rules, in the same YAML grammar the warrant uses. Missing is an empty rules set, not an error — the built-in default rules alone review the diff.                                                                                     |
| `trigger`         | no       | `pr`                        | `pr` — the default — waits for ready-for-review and skips a draft green, with the reason in the job summary. `prod` also reviews drafts.                                                                                                                          |
| `max-diff-chars`  | no       | `4000`                      | The whole-run budget of diff text one review may carry to the model, in characters — cumulative across files, walked in listing order, with the first file that does not fit and everything after it skipped as capped. `none` removes the bound. `0` is refused. |
| `confidence`      | no       | `0.6`                       | The floor for the whole review's reported confidence, between 0 and 1 — one number for the whole answer, not a per-finding bar. Below it, findings are still reconciled and shown in the job summary, but the comment is withheld.                                |
| `dry-run`         | no       | `false`                     | Run the whole pipeline, write every output, post nothing. The review comment that would have been posted is printed to the log, and the job summary still shows the full verdict.                                                                                 |
| `endpoints`       | no       | _(empty)_                   | Extra `alias = url` endpoints beyond `base-url`, each with an optional `timeout=`. A model id routes to one with `model@alias`.                                                                                                                                   |
| `api-keys`        | no       | _(empty)_                   | One `alias = key` per line for each `endpoints` alias that needs one. Each key — everything after its first `=` — is registered as a secret before any entry is validated.                                                                                        |
| `request-timeout` | no       | `120s`                      | How long one request may run before it counts as weather — whole seconds or minutes; a bare number names no unit and is refused.                                                                                                                                  |
| `temperature`     | no       | _(empty)_                   | Sampling temperature, `0`–`2`. Empty omits the field from every request — some providers reject it outright.                                                                                                                                                      |

**`endpoints`, `api-keys`, `request-timeout` and `temperature`** are the
same four provider inputs every duty takes — the full grammar, the
`model@alias` routing rule, and what more than one endpoint changes about
auth failures are all in
[Installation](../../getting-started/installation.md#more-than-one-endpoint).

**`rules-path` is read from the checkout and trusted — and the checkout is
the workflow's own, pinned to the base branch.** You have to be able to say
_who wrote the rules the model is following_, and nothing here can prove that
if the workflow checks out the pull request's merge ref: until the PR is
merged, that ref carries the PR author's own rules file. So review.md's
example checks out `github.event.pull_request.base.ref` — the rules a model
ever follows are the ones that already survived a review of their own. The
file is your own maintainers' text, reviewed like any other change, so it
enters the model's instructions unwrapped — the same shelf the taxonomy sits
on — but its values are never authority on their own (see
[Security considerations](#security-considerations)). The diff, and the pull
request it came from, are a stranger's words and stay behind the sanitising
boundary regardless. A repository that has not written the file yet is the
cold start — reviewed by the built-in default rules alone — not a
misconfiguration.

**`confidence` is a whole-answer floor worth measuring, not inheriting.**
The model states one confidence for the entire review — not a per-finding
number — and the floor admits or withholds the comment as a whole. [Measure
it](../../development/evaluation.md) against your own diffs before you move
it — what `0.6` means for one project's tolerance for a slightly-off finding
is not what it means for another's.

## The owned comment, and the ladder

**Exactly one comment per pull request, ever.** The core anti-pattern this
duty exists to avoid is a bot that reposts the same findings on every
synchronize event. The comment carries this duty's marker — a fingerprint of
the rendered review plus a base64 envelope holding the previous run's findings
and the SHAs it reviewed. The next run recomputes the fingerprint: a run that
reached the same review changes nothing (`commented: false`, the comment left
in place), and a run whose findings moved replaces the comment in place.
Reruns never stack a second review under the first.

**The changes a finding passes through.** A finding is a rule, a file, a line
and a reason, with a stable identity across runs. Comparing this run's
findings against the previous run's envelope gives each one a status:
`created` (new), `persists` (still standing), `changed` (the claim moved),
`resolved` (the diff moved on), or `reopened` (a resolved finding is back
with new evidence). The comment renders them under headings a human review
uses — "New findings", "Still standing", "Resolved" — so a thread's history
reads the way a reviewer's own comment would.

**Two code guards enforce "one comment, and it holds its memory."** This
duty's marker, found the same bot-author walk every duty uses, stops a rerun
from treating an existing comment as absent, and the marker's `official ===
""` check means a forged or quoted marker is never overwritten as if it were
Reeve's own. When a pull request has so many comments that this duty's own
cannot be found with certainty, the review is withheld — `withheld` — rather
than risk a duplicate. Neither guard is configurable, because an input can be
misconfigured and these two cannot be.

**The ladder stops at `resolved` — a human resolving the conversation is
invisible to it.** `reopened` is driven only by the model re-citing a finding
this duty's own memory recorded as resolved; the duty never reads GitHub's
thread or response state, so when a human or another bot replies "done",
`out of scope`, or marks the thread resolved, this review does not observe it.
A finding the diff has truly moved past is `resolved` by evidence — the line
or file it named left this run's review — not by anything anyone said. The
statuses a finding passes through are therefore always this duty's own claims
about the diff, and "resolved" never means "the author agreed with the
reviewer". Reopening an old claim is the newest model saying it again against
new evidence, not a reply-based waking of the thread. This keeps the ladder
honest (the duty documents only what its single owned comment decided) at the
cost of the last rung a human review thread has — conversation itself. See
[what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Deterministic findings, before any model

The repository rules file carries three deterministic pre-checks that fire
before a model is asked anything, each _always-right by construction_:

- **`ignore.files` / `ignore.paths`** — files that never reach the model.
- **`generated`** — suffixes (default `.min.js`, `.min.css`, `.map`) skipped
  as generated before the diff is shown.
- **`blocked`** — phrases the diff must not contain, reported once per line
  per phrase (capped at 40 per phrase) with the printed line number — the
  only reason a deterministic check can report a line a model was never
  shown.
- **`rules`** — the named rules a finding can cite, replacing the one
  built-in default rule (`dedup`, repeated code).

```yaml
# .github/reeve-rules.yml
version: 1
ignore:
  files: [docs/legacy.md]
  paths: ["vendor/**"]
generated: [".min.js", ".min.css", ".map", "_build/**"]
blocked:
  - phrase: "TODO-FIXME"
    severity: critical
    note: "Must be resolved before merge."
rules:
  - id: dedup
    name: Repeated code
    marker: duplication
    body: Flag code that is repeated and could share one definition.
```

A phrase like `TODO-FIXME` in the diff is a finding with a line number — one a
model could not be trusted to make about a line it was never shown, and one
this check can. A misspelled key is a warning, not a silent drop; a rules file
that yields no usable rule at all fails the run red, the same loudness the
warrant gives a file that does not parse.

## Unreadable output is no verdict

A model's answer is read strictly, and what does not parse is discarded, not
salvaged. A finding that names a file the diff never showed, or a line number
the patch cannot prove, is dropped — an anti-invention gate that refuses a
model's claim about a file nobody offered it. `finish_reason: length` is
treated as the protocol failure it is: an answer that ran out of room before
the JSON closed is unparseable the same as a malformed body. An unreadable
answer is recorded on the job summary as discarded, and it is never converted
into a verdict.

Two consequences follow. **Capacity is weather**: a model that fails on
capacity — a 429, a 5xx, a timeout — is rotated past, never retried, and a
roster that fails on all of them leaves `starved: true` without failing the
run. **An all-clear has to be earned**: if the diff had files to show and no
model produced a readable verdict — a capacity failure or an
injection-shaped answer — posting the empty chrome would stamp a diff nobody
actually reviewed as clean, which is precisely the false clean an injected
pull request is best served by. The comment is withheld instead; the job
summary still says what happened.

## Outputs

Every output `review/action.yml` declares.

| Output      | Value                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commented` | `true` when the single review comment was posted or replaced this run. `false` on every other path — including one that reconciled findings but the warrant, the confidence floor, or `dry-run` withheld the write. Never unset; there is no update-in-place beyond this duty's own owned comment. |
| `note`      | Why this run stopped before a verdict, when it did — merged, closed, a draft under `trigger: pr`, or a Reeve proposal pull request. Empty when the run reached a verdict.                                                                                                                          |
| `head-sha`  | The pull request's head SHA at review time. Empty when the run stopped before reading the pull request.                                                                                                                                                                                            |
| `starved`   | `true` when every model in `models` failed on capacity this run. Weather, never a failure by itself.                                                                                                                                                                                               |
| `findings`  | How many findings this run's reconciliation produced — created, persisted, changed, resolved and reopened combined. The comment, when one was posted, carries the same count.                                                                                                                      |

**`findings` is the output that matters most for a repository still tuning
`confidence`.** It is populated on every run that reached a verdict, whether
or not the floor or the warrant let the comment reach the pull request — so a
workflow can post the count to a review queue instead of the thread while you
watch how it does.

## Failure behavior

| What happened                                                    | What you get                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| A blocked phrase was in the diff                                 | Deterministic findings, `commented: true` when `comment` is granted   |
| Confidence below the floor                                       | Findings reconciled and on the summary, `commented: false`, **green** |
| `comment` not granted                                            | Findings on the summary, `commented: false`, **green**                |
| No readable verdict, files were shown                            | Comment withheld, summary says why, **green**                         |
| Every file skipped by the rules file                             | Comment withheld, coverage names each file and why, **green**         |
| Every model failed on capacity                                   | `starved: true`, whatever survived, **green**                         |
| A draft under `trigger: pr`, merged, closed, a Reeve proposal PR | `note` set, no model asked, **green**                                 |
| The warrant or a readable rules file does not parse              | **Red**, naming the file                                              |
| The pull request cannot be read                                  | **Red**                                                               |
| This duty's own comment could not be found with certainty        | Comment withheld, **green**                                           |

**The failure mode of this duty is a withheld write, never a wrong or a
doubled comment.** Every branch above ends without posting, or posts exactly
once — the same comment in place, replaced only when its findings moved.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and posts
nothing. The disposition a real run would have taken — `posted`, `replaced`,
`unchanged` — is rehearsed and printed to the log, and the job summary still
shows the full verdict. `commented` is `false` on a dry run, because nothing
was written. See [Rehearsing a run](../../guides/dry-run.md).

## Cost

One model pass reads the whole diff, once, and nothing repeats it — a
`synchronize` event that changed nothing is recognised by the marker's
fingerprint and skipped at the write, and the diff cap keeps a huge diff from
blowing the prompt. `max-diff-chars` (default `4000` for the whole run, `none`
for no bound) is the lever that bounds the total text a review may carry, and
`endpoints` spreads a roster across providers so a capacity failure demotes
only the `model@alias` that hit it. See [Cost](../../guides/cost.md) for the
full arithmetic.

## Security considerations

- **The pull request's words sit inside a per-call random nonce boundary**,
  not a fixed delimiter. See [Security](../../security/security.md).
- **The diff is untrusted and framed as untrusted**: every line entered the
  prompt behind `enclose`, and a pull request that quotes "ignore this rule"
  at the model stays a quotation. Only the repository's own rules file enters
  unwrapped **— and its contents are pre-injected bare strings, never
  authority.** A path in `ignore:` matching a file is one skip among the
  diff's own facts, decided in code against the parsed file; the rules file's
  values and its `MAX_RULES_CHARS` (20,000) cap are documented in
  [Deterministic findings](#deterministic-findings-before-any-model), and a
  file's `blocked` phrases and `rules` enter the model's system prompt exactly
  as the maintainer wrote them — never as instructions the diff can act on
  alone. When a rules value would be the sole reason the review has nothing to
  say, the review is withheld rather than stamped clean (see
  [Failure behavior](#failure-behavior)).
- **The review comment is visibly machine-written, unconditionally.** The
  fixed closing line — "This review was written by a model, not decided by a
  maintainer — read each finding as a lead to check" — is unstrippable: there
  is no input, no `show-attribution`-style setting, that renders the comment
  without it, the same site rule as `respond`'s notice.
- **What it will never do:** edit code, open a fixing pull request, run a
  test suite, or otherwise touch the repository on the pull request's behalf;
  request changes on the review API or approve; post a second comment to a
  pull request it already owns; overwrite a comment whose marker it cannot
  verify as its own; post without `comment` granted by the warrant; report a
  finding the diff cannot prove; hide, soften, or make removable the
  machine-written notice. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[The warrant](../../guides/warrant.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
