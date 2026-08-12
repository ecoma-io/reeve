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
too only if the policy's `threads:` includes pull requests — and `threads:`
gates both paths in code, not just the sweep: a `number:` run naming a thread
whose kind the policy excludes is a green skip that says so, never an
evaluation. This is one indivisible GitHub scope, exactly as for every other
duty — what a run may actually do is decided in code, against the warrant,
not by what the token can reach. See
[The authority model](../../concepts/authority-model.md).

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
| `limit`        | no       | `30`                  | The most threads one sweep will actually examine — read in full and run through the clock — or `none` for no cap. A thread `threads:` excludes by kind never counts against it. Kept modest by default because this is the one duty that writes per examined thread.                                               |

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
  inactivity (no `when:`), and each has an ordered list of `steps:`. Each
  step fires `after:` a duration (`14d`) counted from the previous step's
  own firing — or, for the first step, from the last thing that reset the
  clock. The durations are cumulative, not parallel: a track whose first
  step is `after: 14d` and whose closing step is `after: 21d` reminds on
  day 14 of silence and closes on day 35, not day 21.
- **A step** applies a `label`, posts a `say:` (built-in text, your own
  text, or a per-language mapping), and/or `close`s — never more than one
  `close` per track, and always the track's last step. An inactivity
  track's first step may not close: a close with no prior warning is
  refused by the parser itself.
- **`resets:`** (`author` or `any`) governs whose activity resets a track's
  clock — a `when:`-started track defaults to the label-applier's own
  replies counting (`author`); a plain inactivity track defaults to anyone's.
- **`exempt:`** the permanent escape hatch — `labels`, `milestones`,
  `assignees`, `taxonomy`, `drafts` — a thread matching one gets no reminder,
  no label, no close from any due step. The exemption filters actions after
  evaluation rather than keeping the thread out of a track: its clocks still
  run, and the removal of this duty's own stale clock-hand labels
  deliberately survives every exempt layer, so a label its own actor applied
  does not linger forever on a thread that later gained a milestone.
  `comments` sits apart: a thread reaching that comment floor blocks `close`
  steps only — a conversation that active has earned a human's decision, but
  reminders and labels still fire. **`exempt.labels` must be non-empty the
  moment any track anywhere configures a `close` step**; the file fails to
  parse otherwise.
- **`overrides:`** per-label timing exceptions, layered on top: an entry
  carries either `after:` (a different duration, honoured on the first step
  of an inactivity track — the only step an override's timing reaches) or
  the separate boolean key `never:` (no step is ever due on threads carrying
  that label, though stale clock-hand cleanup still runs). When several
  overridden labels match one thread, the longest `after` wins.
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

| Output            | Value                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processed`       | How many threads a sweep actually examined this run — read in full and run through the clock. A thread `threads:` excludes by kind is filtered out of the listing for free and never counts. `0` outside `sweep`.                                                                                                                                                                                         |
| `remaining`       | Candidates this sweep did not reach — past `limit`, or after a mid-sweep stop (see `starved`). The next sweep starts here. `0` outside `sweep`, and `0` when a sweep finished its whole backlog.                                                                                                                                                                                                          |
| `starved`         | Under `sweep`: `true` when GitHub's own capacity (a rate limit, or a slow/unavailable request) ran out mid-sweep and the sweep stopped early — everything reported alongside it is still real. `false` outside `sweep`.                                                                                                                                                                                   |
| `skipped`         | Outside `sweep`: `true` when this thread had no policy to run against (no `lifecycle:` key, `capabilities:` not naming this duty, a closed thread, a `threads:` kind mismatch, a draft or other permanent exemption). Under `sweep`: every thread skipped for one of those reasons — including the ones filtered out of the listing before a per-thread read was spent, not only `exempt.labels` matches. |
| `reminded`        | Outside `sweep`: `true` when this run posted a step's `say:` or its close explanation. Under `sweep`: how many examined threads got one.                                                                                                                                                                                                                                                                  |
| `labeled`         | Outside `sweep`: how many labels a due step applied this run. Under `sweep`: the same count, summed across every thread examined.                                                                                                                                                                                                                                                                         |
| `closed`          | Outside `sweep`: `true` when this run closed the thread as not planned. Under `sweep`: how many examined threads were closed.                                                                                                                                                                                                                                                                             |
| `unstaled`        | Outside `sweep`: how many of this track's own clock-hand labels were removed as stale this run. Under `sweep`: the same count, summed across every thread examined.                                                                                                                                                                                                                                       |
| `due-not-granted` | Outside `sweep`: how many steps were due this run but skipped whole because `apply` or the warrant withheld a capability the step's action needed. Under `sweep`: the same count, summed across every thread examined.                                                                                                                                                                                    |

Under `dry-run`, every one of these reads what a real run would have done —
the full would-do ledger, not zeros.

## Failure behavior

| What happened                                                     | What you get                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No `lifecycle:` key, or `capabilities:` does not name this duty   | `skipped` populated, nothing applied, **green**                                                                      |
| A thread matches `exempt`                                         | `skipped` populated, no due action applied — stale clock-hand labels of this duty's own are still removed, **green** |
| A due step's action needs a withheld capability                   | `due-not-granted` populated, that step skipped whole, **green**                                                      |
| A bot-closed thread was reopened by a human                       | Every track's `close` step is blocked on that thread from then on; reminders still fire, **green**                   |
| A `number:` run names a closed thread, or one `threads:` excludes | Green skip that says so — a backfill never rewrites a maintainer's close                                             |
| A thread's creation date cannot be read                           | Skipped with a notice — never treated as instantly overdue, **green**                                                |
| GitHub capacity runs out mid-sweep (429/5xx/timeout)              | Sweep stops early: `starved: true`, honest `processed`/`remaining`, full job summary of what was done, **green**     |
| `sweep` and `number` both set                                     | **Red**, before a single request is made                                                                             |
| An event carries no thread and `number`/`sweep` are both unset    | **Red**, naming the event                                                                                            |
| The warrant does not parse, or `lifecycle:` names a missing label | **Red**, naming the file and the label — on both the sweep and the `number:` path                                    |
| The default warrant path is simply missing                        | Green no-op, naming the missing key                                                                                  |
| A path of your own for `warrant` is missing                       | **Red**, naming the path                                                                                             |
| The thread cannot be read, or the token is refused (401/403)      | **Red**                                                                                                              |

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

No model, ever — there is no roster to rotate through, and the only capacity
that can run out is GitHub's own (`starved: true` on a sweep that had to
stop early; see [Outputs](#outputs)). A sweep's own cost is entirely GitHub
API reads: one listing call for the backlog, then one standing read
(comments, events, labels) per examined thread, capped by `limit`.

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
- **A close it made that a human undid stays undone.** Once a bot-closed
  thread is reopened by a person, every track's `close` step is blocked on
  that thread — thread-wide, permanently, whichever track's step closed it.
  The strongest guarantee on this page: this duty can never win a close
  argument with a maintainer, because the maintainer's reopen is the last
  close-shaped word.

## Related concepts

**Related:** [The authority model](../../concepts/authority-model.md) ·
[Duties and the core](../../concepts/duties-and-the-core.md) ·
[Threat model](../../security/threat-model.md)
