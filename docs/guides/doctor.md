# Doctor

_Check a warrant against a repository before anything runs for real. Prerequisites: [The warrant](warrant.md)._

```yaml
with:
  doctor: true
```

`doctor: true` is a mode of [the root action](../reference/root-action.md) —
the one that otherwise only refuses. Where a duty reads a thread and, with
the right capability, writes to it, `doctor` reads nothing but your warrant
and this repository's own labels, and writes nothing at all. It answers one
question: **if a duty ran right now, would this configuration let it do
anything, and what?**

## What it checks

Six things, every one of them read the exact way a real run reads it — the
same `readWarrant`, the same `resolveAuthority`, the same
`DEFAULT_CAPABILITIES` each duty's own `main.ts` falls back to. A second,
looser reader here would be a second chance for this report and a real run
to disagree.

1. **Does the warrant parse.** A missing file at the default path is not a
   problem, when a checkout reached this runner — that is the narrowest
   built-in authority, and `doctor` reports it as a green note, not a red
   finding. A missing file at a path you named yourself, or a file that
   exists but does not parse, is red — the same failure a real run would
   have. See #5 for the one case where an absent file at the default path
   is read as something worse.
2. **Do the labels it names exist.** Every label the taxonomy and a written
   `lifecycle:` policy reference, checked against this repository's actual
   labels. Missing, but marked `create: true`, is a green note — a duty
   granted `label` creates it rather than failing. Missing and not
   creatable is red.
3. **What each duty would effectively be granted.** The same
   `duties:` block a real run reads, rendered as one row per duty:
   what it grants, whether that is the duty's own built-in default, and
   whether a written block simply leaves the duty unnamed — denied
   everything, which is a real, designed answer and not a finding.
4. **What ran on default, named once, together.** Every duty whose effective
   grant above is exactly its own built-in default right now is named in a
   single aggregated green note listing all of them, so "healthy" and
   "healthy because nothing is configured yet" never look identical. A duty
   a written block denies outright (see #3) is a different, separate fact
   and never appears in this note: denied is not default.
5. **Could the missing-warrant report be a lie?** When the warrant is absent
   at the default path, `doctor` also checks whether a checkout ever reached
   this runner. A workspace with a checkout in it is the genuine level-0
   absence — the repository wrote no warrant — and stays the green note in
   #1. An empty workspace is a runner the repository never reached, and the
   absence is read as what it is: the configuration never made it here, so
   `doctor` reports it red and tells you to run `actions/checkout` first.
   Without this check, a missing warrant on a checkout-less runner would be
   reported as the narrowest authority — silent, and wrong about what a
   real run would do.
6. **Would the configured provider answer at all?** When a `base-url`,
   `api-key`, and `models` are configured alongside `doctor: true`, the run
   sends the configured endpoint one tiny completion (the word `ping`) and
   reports, green, whether the first configured model answered — and, when
   models failed before it, how many rotated past. This is deliberately
   **weather, never authority**: a probe that answered grants nothing and a
   probe that failed red nothing, so even a refused key (HTTP 401/403), a
   rate limit, an unreachable endpoint, or a reply that would not parse is
   reported green, with the reason named. `doctor` stays a report about
   what a run would _be allowed_ to do — no verdict ever becomes a
   capability — and it never prints a key. No provider inputs configured
   means no probe at all, and no model is ever called.

## Example: lint your warrant in CI

The story `doctor` is for: catch a warrant that stopped parsing, or a label
a rename quietly deleted, in the pull request that changed it — before the
first real run finds out the hard way.

```yaml
name: Doctor

on:
  pull_request:
    paths:
      - .github/reeve.yml

concurrency:
  group: reeve-doctor-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: read

jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      # checkout is required — doctor reads .github/reeve.yml from the local checkout
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve@v0.6
        with:
          doctor: true
```

`issues: read` is the whole permission — `doctor` never writes, so nothing
wider than the labels endpoint is ever asked for. Point a step's own
`with: warrant:` at a path other than the default to check a file you keep
somewhere else; a missing file there is reported red, on purpose, because
naming a path that is not there is a configuration mistake rather than an
absence — see [the input reference](../reference/root-action.md#configuration).

Add `problems != '0'` as a job condition elsewhere in the same workflow to
gate on the result, or just let the step itself fail red — `doctor` already
does that whenever a finding would refuse a duty at runtime.

## Reading the result

The job summary is the primary surface — a `### Problems` section (red
findings, or "nothing here would refuse a duty at runtime"), a `### Notes`
section (everything green: defaults in play, labels that will be created,
capacity the check could not reach), and an `### Effective authority` table,
one row per duty, the same shape [the warrant guide's duties
section](warrant.md#duties) describes in prose.

The `problems` output is the number for a workflow to act on: how many
findings were red, `0` when the configuration is healthy. It is unset when
`doctor` is `false`.

## Exit semantics

**Red, at runtime, stays red here.** Anything that would refuse a duty —
a warrant that will not parse, a label that will not exist and cannot be
created, a token the labels endpoint refuses — is a red finding, and the
step itself fails if even one of them is present.

**GitHub's own capacity is weather, not a finding against your
configuration** — a rate limit, a 5xx, or a timeout on the labels endpoint
is reported green, naming the endpoint and saying plainly that the check
was not performed, the same posture [D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration)
takes everywhere else in this project. Run `doctor` again once GitHub
answers.

**A token the labels endpoint refuses (401/403) is red** — that is your
authentication, not GitHub's weather, and a real run would fail on it too.

## `doctor` is not a duty

It never reads a thread and never decides anything for a thread. `duty:`
narrows the report to one duty's row instead of running anything; naming a
duty on this action never runs it, `doctor` or not — see
[the root action](../reference/root-action.md) for the refusal it is a mode
of.

The one provider input a configuration _can_ carry is the probe in #6:
a `base-url`, `api-key`, and `models` you already pass a duty describe the
endpoint you also want `doctor` to say something about, so the same inputs
the duty's own action reads double as the probe's. They are weather, not
authority — no probe result ever grants or denies anything — and the report
never prints a key. Leave them unset, and `doctor` never touches a
provider at all.

---

**Related:** [The warrant](warrant.md) · [The root action](../reference/root-action.md) · [Troubleshooting](troubleshooting.md)
**Next:** [Troubleshooting](troubleshooting.md) — read what a run actually did, once you trust the configuration it ran with
