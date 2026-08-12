<!-- source of truth: lifecycle/action.yml -->

# `lifecycle`

_Full contract for the `lifecycle` duty — every input, every output, checked against `lifecycle/action.yml`. Prerequisites: [The warrant](../../guides/warrant.md) — or "None," to read this cold._

Runs a repository's own staleness policy — reminders, un-staling, and a final
close as not planned — entirely from timestamps and labels. No model is ever
called.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../../development/releasing.md#what-0x-and-10-mean-here).

## What it is for

The clock every backlog needs and nobody wants to run by hand: remind a
thread that has gone quiet, then close it if it stays quiet, and take the
reminder label back off the moment a human returns. It is code against
timestamps and labels, not a model — there is nothing here for a model to be
right or wrong about.

**What it is explicitly not for:** deciding whether a thread deserves to
stay open on its merits, or replacing a maintainer's own close. It only ever
acts on silence, and only in the direction of un-staling, warning, or the one
closing step a track's own last rung may configure.

## When to use it

Any repository whose backlog accumulates threads nobody ever comes back to.
Unlike every other duty, it has **no built-in default policy** — there is no
pre-existing artifact a staleness track could fall back to the way a taxonomy
falls back to a repository's own labels, so an absent `lifecycle:` key is a
green no-op naming the missing key rather than a starting behaviour. Write
[`lifecycle:`](#configuration) to configure it before this duty does anything
at all.

## Example (minimal workflow YAML)

```yaml
name: Lifecycle

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  lifecycle:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: ecoma-io/reeve/lifecycle@v0.1
        with:
          sweep: true
```

A schedule is the natural trigger — there is no single event a clock check
answers to the way a `labeled` event answers to `record`. Run it once against
`dry-run: true` first: see [Rehearsing a run](../../guides/dry-run.md).

## Required permissions

**Token:** `issues: write`. `GITHUB_TOKEN` is enough. Add `pull-requests: write`
too only if the policy's `threads:` includes pull requests. This is one
indivisible GitHub scope, exactly as for every other duty — what a run may
actually do is decided in code, against the warrant, not by what the token
can reach. See [The authority model](../../concepts/authority-model.md).

**Warrant capability:** `label` and `comment` are granted by default —
`DEFAULT_CAPABILITIES` for this duty is `[label, comment]`, matching
`apply`'s own default of `label, comment` below. `close` needs naming in
both halves — `.github/reeve.yml`'s `capabilities.lifecycle` **and** the
workflow's `apply` — before this duty ever closes a thread. See
[the capabilities table](../../guides/warrant.md#capabilities).

## Required inputs

None. `lifecycle:` in the warrant is what actually configures a policy —
every workflow input below has a default, and a run with no `lifecycle:`
key stays a green no-op that names the missing key.

## Configuration

Every input `lifecycle/action.yml` declares. This table is the contract; a
narrower one would only be free to drift from it.

| Input          | Required | Default               | What it does                                                                                                                                                                                                                                                                                                       |
| -------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-token` | no       | `${{ github.token }}` | Token used to read a thread's comments and events, and to apply what `apply` and the warrant both grant.                                                                                                                                                                                                           |
| `number`       | no       | _(empty)_             | The issue or pull request to check. Defaults to the thread that triggered the workflow. Cannot be combined with `sweep`.                                                                                                                                                                                           |
| `warrant`      | no       | `.github/reeve.yml`   | Where the `lifecycle:` policy lives. There is no built-in default track — see [When to use it](#when-to-use-it) — so an absent key or a missing file at this default path is a green no-op naming the missing key. A path of your own missing there fails the run red.                                             |
| `apply`        | no       | `label, comment`      | What this run may do: `label`, `comment`, `close`, comma or newline separated, or `none`. The narrower of this and the warrant always wins; a step whose action needs a withheld capability is skipped whole, never partially applied.                                                                             |
| `languages`    | no       | _(empty)_             | Contributors' languages, comma or newline separated, used only to pick which `say:` text a step posts. Unlike every other duty, unconfigured is not refused — a policy whose tracks use plain `say:` text, or the English built-in, never needed this. Ignored once the warrant's own `languages:` key is written. |
| `dry-run`      | no       | `false`               | Run the whole pipeline, write every output, change nothing.                                                                                                                                                                                                                                                        |
| `sweep`        | no       | `false`               | Check the backlog instead of the one thread this event named — every open issue, oldest created first, and every open pull request too once the policy's `threads:` includes them. Cannot be combined with `number`.                                                                                               |
| `since`        | no       | _(empty)_             | The oldest thread a sweep will consider, bounded by when it was opened. A calendar date or a duration (`90d`).                                                                                                                                                                                                     |
| `limit`        | no       | `50`                  | The most threads one sweep will actually process, or `none` for no cap. Kept modest by default to protect a free tier's own rate limit.                                                                                                                                                                            |

**A single-thread run needs `number`; a sweep needs neither `number` nor a
triggering event that carries a thread.** An event that carries no thread —
`schedule`, `push`, a bare `workflow_dispatch` — fails red naming the event,
outside `sweep`, rather than asking GitHub for issue `NaN`.

## The `lifecycle:` policy

The warrant is the whole configuration surface — see
[the schema reference](../warrant-format.md#lifecycle-fields) for every
field, type and default. In outline:

- **`tracks:`** (required, non-empty) — one or more named tracks. A track
  either starts on a label a human applies (`when:`) or runs on plain
  inactivity (no `when:`), and each has an ordered list of `steps:`, each
  step firing `after:` a duration (`14d`) of silence since the last thing
  that reset its clock.
- **A step** applies a `label`, posts a `say:` (built-in text, your own
  text, or a per-language mapping), and/or `close`s — never more than one
  `close` per track, and always the track's last step. An inactivity
  track's first step may not close: a close with no prior warning is
  refused by the parser itself.
- **`resets:`** (`author` or `any`) governs whose activity resets a track's
  clock — a `when:`-started track defaults to the label-applier's own
  replies counting (`author`); a plain inactivity track defaults to anyone's.
- **`exempt:`** the permanent escape hatch — `labels`, `milestones`,
  `assignees`, `taxonomy`, `comments` — any thread matching one never enters
  a track at all. **`exempt.labels` must be non-empty the moment any track
  anywhere configures a `close` step**; the file fails to parse otherwise.
- **`overrides:`** per-label timing exceptions (`after:` a different
  duration, or `never`) layered on top of a track's own steps.
- **`threads:`** (`issues`, `prs`, or `both`) which kind of thread a sweep,
  and this policy, considers at all.

## The clock-hand exception

Every other duty in Reeve only adds. `lifecycle` un-stales: when a track's
clock resets — a human came back — the step label **it applied itself**
comes back off, but only if the label's own event history shows this duty's
own actor put it there last. A label a person applied by hand is never
touched; that is still [D3](../../doctrine/north-star.md#d3--the-humans-work-is-inviolable)
in full. Naming a label as a track's clock-hand in the warrant is what
declares it machine-managed state in the first place — a maintainer's own
deliberate line in a reviewed file, which is the more considered of the two
acts.

## Outputs

Every output `lifecycle/action.yml` declares.

| Output            | Value                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processed`       | How many threads a sweep actually evaluated this run. `0` outside `sweep`.                                                                                                                                                               |
| `remaining`       | Candidates this sweep did not reach, past `limit`. The next sweep starts here. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                                                     |
| `starved`         | Always `false` — this duty calls no model and never rotates a roster, so there is nothing here to run out of capacity.                                                                                                                   |
| `skipped`         | Outside `sweep`: `true` when this thread had no policy to run against (no `lifecycle:` key, `capabilities:` not naming this duty, or an `exempt` match). Under `sweep`: the count of processed threads skipped for one of those reasons. |
| `reminded`        | Outside `sweep`: `true` when this run posted a step's `say:` or its close explanation. Under `sweep`: how many processed threads got one.                                                                                                |
| `labeled`         | Outside `sweep`: how many labels a due step applied this run. Under `sweep`: the same count, summed across every thread processed.                                                                                                       |
| `closed`          | Outside `sweep`: `true` when this run closed the thread as not planned. Under `sweep`: how many processed threads were closed.                                                                                                           |
| `unstaled`        | Outside `sweep`: how many of this track's own clock-hand labels were removed as stale this run. Under `sweep`: the same count, summed across every thread processed.                                                                     |
| `due-not-granted` | Outside `sweep`: how many steps were due this run but skipped whole because `apply` or the warrant withheld a capability the step's action needed. Under `sweep`: the same count, summed across every thread processed.                  |

## Failure behavior

| What happened                                                     | What you get                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| No `lifecycle:` key, or `capabilities:` does not name this duty   | `skipped` populated, nothing applied, **green**                 |
| A thread matches `exempt`                                         | `skipped` populated, nothing applied, **green**                 |
| A due step's action needs a withheld capability                   | `due-not-granted` populated, that step skipped whole, **green** |
| `sweep` and `number` both set                                     | **Red**, before a single request is made                        |
| An event carries no thread and `number`/`sweep` are both unset    | **Red**, naming the event                                       |
| The warrant does not parse, or `lifecycle:` names a missing label | **Red**, naming the file and the label                          |
| The default warrant path is simply missing                        | Green no-op, naming the missing key                             |
| A path of your own for `warrant` is missing                       | **Red**, naming the path                                        |
| The thread cannot be read                                         | **Red**                                                         |

**The failure mode of this duty is doing nothing.** Nothing above ends in a
close, a label, or a comment this policy did not itself configure.

## Dry-run behavior

`dry-run: true` runs the whole pipeline, writes every output, and changes
nothing. The rehearsal takes the same path a real run does — the same
policy, the same exemptions, the same un-staling check — so what it reports
is what a real run would do. See
[Rehearsing a run](../../guides/dry-run.md) for the pattern every duty in
Reeve shares.

## Cost

No model, ever — `starved` is always `false` and there is no roster to
rotate through. A sweep's own cost is entirely GitHub API reads: one listing
call for the backlog, then one standing read (comments, events, labels) per
candidate thread, capped by `limit`.

## Security considerations

- **What it will never do:** remove a label a maintainer applied by hand;
  reopen what a maintainer closed, or overwrite an assignment; close as
  anything other than not planned; apply a label the policy does not name;
  edit a title or a person's own body text; comment or close without that
  capability being turned on by name. See
  [what no capability can ever turn on](../../guides/warrant.md#what-no-capability-can-ever-turn-on).
- **The one label a run ever removes** is scoped in code to exactly the
  names the parsed policy declares as clock-hands, and only when this duty's
  own actor applied it last — see [the clock-hand exception](#the-clock-hand-exception).
- **`exempt.labels` is a required, permanent escape hatch** the moment any
  track configures a `close` step — the parser refuses the file otherwise, so
  a policy that can close cannot ship without a way out already written down.

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
