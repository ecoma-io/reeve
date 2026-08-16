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
misidentified it would break the fixture as `failed`. The review duty's
PR-language dimension is not covered — T6 (review) has not landed on this
branch yet; that surface belongs to its own task.

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

The three drivers (`eval/drivers/harmonise.ts`, `triage.ts`, `respond.ts`)
own the mapping from a fixture's `.expected.json` to the stub routes and
scripted model answers, plus the assertion that turns a run into an outcome.
A new duty means a new driver under `eval/drivers/`, a fixtures directory,
and one more entry in `DUTIES` in `eval/runner.ts`.
