# Evaluation runner

`pnpm eval <duty>` drives each duty's built bundle over its fixtures under
`eval/fixtures/<duty>/` and reports every run as exactly one of three
outcomes:

- **`finding`** — the run succeeded and did the thing the fixture expected.
- **`failed`** — the duty's bundle errored (setFailed, crash, nonzero exit).
- **`skipped`** — the run succeeded but deliberately did nothing: dry-run,
  warrant denial, screened-out as spam or off-topic, already-synced,
  already-answered, or a below-floor verdict.

A duty is a finding only when it does what its fixture asked. A clean
deliberate no-op is reported as `skipped`, never as a finding — the whole
point of the three-way split is that "nothing happened" is distinguishable
from "the wrong thing happened" and from "the run broke."

The exit code is fail-closed:

- `0` when every fixture is a `finding`, and none failed or skipped.
- `1` when any fixture failed or skipped, or when a duty has no fixtures at
  all (an unevaluated duty is never mistaken for a passing one). A skipped
  fixture is a run that deliberately did nothing — a duty the warrant no
  longer grants would read `skipped` everywhere — and that must not exit
  green.
- `2` when the requested duty is not one the runner knows.

## Multilingual coverage

The fixtures under `eval/fixtures/triage/` and `eval/fixtures/respond/`
include a language matrix: one triage fixture and one respond fixture per
language, each asserting the language its thread must be identified as
(`expected.language`, the label the run's `language` output carries) alongside
the triage/duplicate/respond decision. A fixture that declares a language and
a run that identified the thread as something else is **`failed`**, never
`skipped` — a misidentified language is a thread handled wrong, not a clean
stop (`eval/language.ts`, pinned by `eval/contract/multilingual.test.ts`).

| Language                           | Code | Detection path      | Triage         | Respond          |
| ---------------------------------- | ---- | ------------------- | -------------- | ---------------- |
| English (baseline)                 | `en` | profile             | `en-report`    | `en-first-reply` |
| Vietnamese                         | `vi` | profile             | `vi-report`    | `vi-first-reply` |
| Japanese                           | `ja` | profile (Han vs zh) | `ja-duplicate` | `ja-first-reply` |
| Portuguese                         | `pt` | profile             | `pt-report`    | `pt-first-reply` |
| Spanish                            | `es` | profile             | `es-report`    | `es-first-reply` |
| Korean (structural: Hangul script) | `ko` | script              | `ko-report`    | `ko-first-reply` |
| Arabic (structural: RTL)           | `ar` | script              | `ar-report`    | `ar-first-reply` |
| Indonesian (provider-identified)   | `id` | model               | `id-model`     | `id-model-reply` |

Each fixture's warrant configures the language in `languages:`, so the thread
is identified against a candidate set that actually lists it. The Japanese
duplicate fixture drives the duplicate-detection-and-close pipeline on a
non-Latin thread. The Indonesian fixtures spell out the provider-based
identification step (the script step cannot narrow a Latin thread, and the
bundled profile data does not cover the language), so an answer that
misidentified it would break the fixture as `failed`. The review duty now
covers the same provider-identified surface for PR language: `review/id-pr`
carries an Indonesian pull request whose detection must reach the model and
answer `id` (asserted against the summary's `| Language | id |` row), so a
misidentifying answer breaks that fixture as `failed` the same way. The
`review/update-pr` fixture additionally pins the synchronize flow — a rerun
that finds its own previous marker comment replaces it in place (the PATCH
`issues/comments/{id}` path) instead of POSTing a second review.

## Running

```sh
pnpm eval harmonise   # one duty
pnpm eval triage      # one duty
pnpm eval respond     # one duty
pnpm eval all         # every duty with fixtures
```

Each command builds the duty's bundle first (`tools/build.mjs`), so a run
measures the source under review, never a stale committed `dist/`.

The runner does not need a network. Every run is driven over a local HTTP
stub (`eval/harness.ts`) that answers the GitHub and provider calls a duty
makes, with the model's responses scripted from the fixture's own
`.expected.json`.

`lifecycle` is the one duty with no model call anywhere: its driver mounts
only the GitHub API routes it reads (the thread, its comments and events, the
repository's labels, the token's identity) and computes every timestamp
relative to the run's own clock, so an inactivity or `when:` track whose
`after` falls inside the fixture's window is due on every run.

## Measurement register

The CI gate measures structure, not accuracy: the stub scripts every model
answer, so a run cannot tell whether a real provider would have said the
same thing. Accuracy is measured deliberately, against a real provider, with
`eval/live.ts`:

```sh
REEVE_EVAL_BASE_URL=https://.../v1 REEVE_EVAL_API_KEY=sk-... \
REEVE_EVAL_MODELS=oc/deepseek-v4-flash-free \
node --experimental-strip-types eval/live.ts   # all three language duties
```

The GitHub side stays stubbed; only the completion endpoint is real. Each
fixture that asserts a language is scored by the language its run identified
(`language` output, or the review summary's `| Language | id |` row). The
worst-language number is the lowest per-language accuracy — the language
this model most often misidentifies, never the average.

### 2026-08-17 — DeepSeek v4 flash (`oc/deepseek-v4-flash-free`)

| Duty    | Languages measured             | Correct | Worst-language rate |
| ------- | ------------------------------ | ------- | ------------------- |
| triage  | en, vi, ja, pt, es, ko, ar, id | 8/8     | 100%                |
| respond | en, vi, ja, pt, es, ko, ar, id | 8/8     | 100%                |
| review  | id                             | 1/1     | 100%                |

Every language the fixture set declares was identified correctly on the
first full pass — the worst-language rate is 100% for every duty, because no
language fell below it. The model-dependent thread — Indonesian (`id`), the
one language the script and profile steps together cannot narrow — reached
the real provider in `triage/id-model`, `respond/id-model-reply` and
`review/id-pr`, and the provider identified it as `id` every time. All other
languages resolve in the script or profile step; the number guards the whole
pipeline, not the model alone.

Reproduce: set the three `REEVE_EVAL_*` variables for a reachable provider
and run the command above. A regression — a prompt change that makes a model
misidentify a language — shows up here as a diff in this table (this is
[Stage 6](../docs/doctrine/north-star.md#7-roadmap)'s "numbers are committed
alongside the fixture set"). The next release's number goes below; a duty
whose worst language fell is a duty that does not ship.

## The warrant contract

All fixtures run against the post-T1 warrant model: a `version: 1` file with
a `duties:` block (`labels:` and `duties:` at the root, no `apply:` or
`languages:` input vocabulary). The contracts this reader must keep — what
`duties: { triage: true }` grants, what an explicit list means, how an
unnamed duty behaves — are pinned by the eval contract suite:

```sh
pnpm test:contract
```

## Adding a fixture

Each fixture is a directory under `eval/fixtures/<duty>/` holding:

- a `.expected.json` describing the scenario and the assertions the run must
  satisfy — configuration at the top level, assertions under `expected`;
- any content files that scenario needs (a thread body, a seed file);
- for harmonise, the fixture's own `en.md`/`vi.md`/`zh.md` files the driver
  rewires onto the repository layout.

The eight drivers (`eval/drivers/harmonise.ts`, `triage.ts`, `respond.ts`,
`translate.ts`, `duplicate.ts`, `lifecycle.ts`, `dependa.ts`, `review.ts`)
own the mapping
from a fixture's `.expected.json` to the stub routes and scripted model
answers, plus the assertion that turns a run into an outcome. A new duty means
a new driver under `eval/drivers/`, a fixtures directory, and one more entry
in `DUTIES` in `eval/runner.ts`.

`dependa`'s fixtures are publish-path-limited: its datasource URLs
(`registry.npmjs.org`, `crates.io`, `proxy.golang.org`,
`registry.hub.docker.com`, `api.github.com`) are hardcoded in the duty's
source rather than read from `GITHUB_API_URL`, so no fixture can drive a real
registry call against the stub. Each fixture stops before the datasource loop
— warrant denial, no recognised manifest, or the policy's own `ecosystems:`
narrowing — and asserts the clean empty run.

`review` is the one duty whose whole surface the stub can stand in for: every
read (the pull request, its file list, its comments) and every write (the one
review comment) goes through the GitHub API, so nothing is hardcoded out of
reach the way dependa's datasources are. Each fixture runs under a `trigger:
pr` warrant with a `rules-path` pointing at a `reeve-rules.yml` in the scratch
checkout. `open-pr` proves the deterministic preflight (the rules file's
`blocked:` phrase fires on the diff) alongside an admitted model finding on the
same patch-proven line; `clean-pr` shows a readable empty verdict posted as a
real answer; `denied` stops before the pull request is read.
