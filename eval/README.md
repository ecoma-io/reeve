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

- `0` when every fixture is a `finding` and none failed.
- `1` when any fixture failed, or when a duty has no fixtures at all (an
  unevaluated duty is never mistaken for a passing one).
- `2` when the requested duty is not one the runner knows.

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
