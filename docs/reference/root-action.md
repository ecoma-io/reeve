<!-- source of truth: action.yml -->

# The root action

_The one action in this repository that runs no duty, and its `doctor: true` diagnostic mode. Prerequisites: None._

There is an `action.yml` at the repository root, and it runs no duty. Left at
its default, it exists to be listed on the Marketplace, and the code behind
it exists to refuse. Set `doctor: true` and the same action instead reads
your warrant and this repository's own labels, and reports what a duty would
find — without writing anything.

## What it does

**`doctor: false` (the default): nothing, on purpose.** It fails red and says
what to write instead.

**`doctor: true`: reads, never writes.** No label, no comment, no commit —
this only reports what a duty would do with the configuration it finds:
every label the warrant or a `lifecycle:` policy names, checked against this
repository's actual labels; the capabilities each duty would effectively
have, from the same defaults its own `main.ts` reads; and the defaults in
play where the file never wrote an opinion. See
[the doctor guide](../guides/doctor.md) for the full walkthrough.

## When to use it

**`doctor: false`:** never on purpose. It exists so that the obvious, wrong
thing a consumer might write — `uses: ecoma-io/reeve@v0.6`, naming no duty —
fails loudly instead of resolving and running nothing.

**`doctor: true`:** before a warrant reaches production, and again in CI
every time it changes — see [linting a warrant in
CI](../guides/doctor.md#example-lint-your-warrant-in-ci).

## Why it exists

GitHub reads a Marketplace listing from an `action.yml` at the repository
root and from nowhere else, while every duty ships from its own subdirectory
so a workflow can name the one it wants — see
[one repository, several actions](../development/architecture.md#one-repository-several-actions).
That split leaves a hazard: `uses: ecoma-io/reeve@v0.6` is the obvious thing
for a consumer to write, it resolves, and it would otherwise run nothing.
`doctor` lives on the same listing because a maintainer reaching for
`uses: ecoma-io/reeve@v0.6` is very often the same maintainer who wants to
know whether their configuration would work before they wire up a duty at
all — the same action, answering the two questions a first-time reader of
this line actually has.

The one thing `doctor: false` may not do is succeed quietly. A green run
that did nothing is indistinguishable from a duty that found nothing to do,
and [D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible)
does not allow the two to look alike. `doctor: true` keeps the same
posture in its own register: a red finding fails the step, and capacity —
never a finding — stays green and says so, exactly the way
[D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration)
asks of every duty.

## Required permissions

**`doctor: false`:** none. It reads no thread and touches no repository
state.

**`doctor: true`:** `issues: read` on the token. It reads this repository's
own labels and nothing else — no thread, no comment, no commit.

## Configuration

Every input `action.yml` declares. This table is the contract; a narrower
one would only be free to drift from it.

| Input          | Required | Default               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duty`         | no       | `""`                  | The duty you meant to run. Naming one here does not run it — this action cannot run any duty — but it is what turns a puzzling red job into a line you can paste. A workflow uses a duty directly: `uses: ecoma-io/reeve/triage@v0.6`. Under `doctor: true`, naming one here scopes the report to it instead — see `doctor` below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `doctor`       | no       | `"false"`             | `true` reads your warrant and checks it against this repository instead of refusing. Nothing is written anywhere — no label, no comment, no commit — this only reports what a duty would do with the configuration it finds: every label the warrant or a `lifecycle:` policy names, checked against this repository's actual labels; the capabilities each duty would effectively have, from the same defaults its own `main.ts` reads; and the defaults in play where the file never wrote an opinion. `false`, the default, keeps this action doing what it has always done — refusing, and naming the duty action you meant to write instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `github-token` | no       | `${{ github.token }}` | The token `doctor: true` reads labels with. `GITHUB_TOKEN` is enough — this action never writes anything, so nothing wider than `issues: read` is asked for. Unused when `doctor` is `false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `warrant`      | no       | `.github/reeve.yml`   | Where the taxonomy and the permissions live. Every label a duty may apply is named in this file, in your own words, with the cases it does not cover — and every effect is checked against the parsed file rather than against the model's account of what it was allowed to do. It may also carry a `languages:` key and a `lifecycle:` policy, both checked by `doctor: true` the same way. Missing at this default path, there is no failure: `doctor: true` reports the narrowest authority this build knows — labelling only, from this repository's own label descriptions, leaving out any label GitHub has no description for. Point this at a path of your own instead, and a file missing there is reported red, because naming a file that is not there is a configuration mistake rather than an absence. A file that exists but does not parse is always reported red, wherever it lives. A missing file at this default path can only be reported as the narrowest authority when a checkout reached the runner; without one, it is reported red as a checkout that never happened — see [the doctor guide](../guides/doctor.md#what-it-checks). Unused when `doctor` is `false`. |

The table above is every input `action.yml` declares: `doctor` itself has no
`models` or `api-key` input of its own. A workflow can still pass the
provider inputs a duty reads — `base-url`, `api-key`, `models`,
`request-timeout`, `endpoints`, `api-keys` — and when it does, `doctor: true`
uses them for one thing only: a single tiny probe completion against the
configured endpoint, reported green as weather (never authority), so a
maintainer learns whether the endpoint a duty would call answers at all. It
never prints a key, and a probe that refused, rate-limited, or timed out
cannot turn red — see
[the doctor guide](../guides/doctor.md#what-it-checks). Without those
inputs, `doctor` never calls anything but the GitHub labels endpoint.

## Outputs

Every output `action.yml` declares.

| Output     | Value                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `problems` | How many findings `doctor: true` reported that would refuse a duty at runtime — 0 when the configuration is healthy. Unset when `doctor` is `false`. |

## Failure behavior

**`doctor: false`:** every invocation fails red, naming the duty you meant
to run — `duty`, when set — and the corrected `uses:` line to write instead:
`uses: ecoma-io/reeve/<duty>@<the ref you pinned>`. The message repeats the
ref your workflow already pinned rather than naming any particular version,
so it can never go stale or tell you to switch lines. There is no green
path.

**`doctor: true`:** red exactly when a finding would refuse a duty at
runtime — a warrant that will not parse, a label that will not exist and
cannot be created, a token the labels endpoint refuses (401/403). GitHub's
own capacity (429, 5xx, a timeout) is reported green, naming the endpoint
and saying the check was not performed — weather, not a broken
configuration. See [Exit semantics](../guides/doctor.md#exit-semantics) for
the full table.

## Dry-run behavior

Not applicable. `doctor: false` performs no effect for `dry-run` to
withhold, and `doctor: true` already performs none — every run under
`doctor: true` is, in effect, a dry run of the configuration check itself.

## Cost

`doctor: false` calls nothing. `doctor: true` spends GitHub API reads only —
up to ten paginated calls to list this repository's labels (the same page
limit every duty's own label listing uses) — plus, when provider inputs are
configured, exactly one tiny completion against the configured provider
endpoint, spent as weather capped like any duty's own first rotation step.
With no provider configured, no model is called at all.

## Security considerations

`doctor: false` reads no thread and calls no model, so none of the
pipeline's guardrails apply to it — there is nothing here for a
prompt-injection attempt to reach. `doctor: true` reads no thread either —
only your warrant, already a file this repository's own maintainers wrote
and review, and this repository's own label listing — so it carries the
same absence of a text-injection surface. When provider inputs are
configured, the only thing sent to the endpoint is the constant word `ping`
— never a thread, never anything the environment could have shaped — and
nothing the endpoint answers can grant or deny a capability; the probe is
reported, never applied. It writes nothing under any input, so
[D2](../doctrine/north-star.md#d2--authority-is-granted-written-and-bounded)
is satisfied by construction rather than by a check.

## Related concepts

**Related:** [Doctor](../guides/doctor.md) · [Architecture](../development/architecture.md) ·
[Platform limits](platform-limits.md)
