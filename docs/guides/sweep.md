# The sweep

_Run Reeve against a backlog instead of one thread. Prerequisites: [Installation](../getting-started/installation.md)._

Working a backlog that already exists, on a schedule, instead of one thread at
a time — and what it looks like when a free provider cannot finish it in one
run.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## What `sweep`, `since` and `limit` are

Every duty gains three workflow-level inputs — not warrant authority, because
what a sweep may touch is still bounded by the same taxonomy and the same
capabilities a single-thread run answers to. A sweep decides **how much work a
run looks for**, never **what it is allowed to do to it**:

```yaml
with:
  sweep: true
  since: 2026-01-01
  limit: 200
```

`sweep: true` turns a run from "the one thread this event named" into "every
open thread this duty has not already handled." `since` bounds it by date, and
`limit` bounds it by count — both exist for the same reason: a scheduled run
has to end, and ending with an honest partial is the entire point of this
page. `limit` defaults to `50` when left unset (`30` for `lifecycle`, the one duty
that writes per examined thread), modest enough to protect a free tier's own
rate limit; the example above raises it deliberately.

`limit: none` removes the count bound entirely. Paging against the forge
follows real demand — the listing keeps asking for more until `since` says
the rest is too old, or the backlog itself runs out — so a backlog past the
size of one page is not silently cut off partway through: a repository with
several thousand open issues sees all of them considered, not just however
many the first page happened to hold. `limit` deliberately does not stop the
listing early, only how much of it one run processes: the sweep has to see
the whole candidate set to report `remaining` honestly, so that output
always says how much was left unprocessed when the run ended — never a
number that quietly stops moving once a page boundary is behind it.

## Why a sweep exists at all: weather

[D12](../doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
is the doctrine; this is what it looks like from the outside. A 429, a 5xx or
a timeout is **weather** — a provider could not serve this particular request
right now, and that says nothing about whether Reeve is allowed near your
repository. A run that meets one rotates to the next model on the list, and
when the list runs out, it does not fail. It **delivers what it finished**,
says exactly what is left in its outputs, and ends in a warning — yellow,
never red.

That is a deliberately unfinished-looking result, and it is the correct one.
The repositories a keyless, IP-rate-limited provider serves see 429s that do
not clear inside a single job no matter how long the job waits — they clear on
the provider's own schedule, which a GitHub Actions runner does not control
and should not try to. Waiting them out is a runner-minute bill with no floor.
**The sweep is what comes back for whatever the weather left undone.**

A 401 or a 403 gets the opposite treatment, on purpose: that is
**configuration**, not conditions, and it fails the run red immediately,
because no amount of scheduling repairs a key that was never going to work. A
scheduled sweep does not paper over a broken credential by trying again later
— it would just fail the same way, quietly, forever, and a repository that
never gets served is worse than one that visibly stopped.

## Idempotency by observation

A sweep does not need a state file to know what it already did, because
nothing about the duty pipeline changed to make room for it — [the same
fingerprint marker](cost.md#2-idempotency) that makes re-running one thread
free is exactly what makes a sweep converge. A thread whose marker already
carries the fingerprint of what a run would produce is skipped before a
provider is ever constructed: one API read, nothing else. A thread the last
sweep left half-done — some languages translated, some still on a provider's
naughty list — is picked back up from where the fingerprint says it stopped,
not redone from the start.

That is the whole mechanism. There is no ledger of "threads the sweep has
seen" anywhere in this repository, because the marker already committed to
each thread is that ledger, and it is checked the same way whether a thread
arrived through an event or through a sweep listing it.

## A complete scheduled-sweep workflow

```yaml
name: Reeve sweep

on:
  schedule:
    - cron: "0 3 * * *" # once a day; a keyless provider earns a gentler cron
  workflow_dispatch: {}

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: ecoma-io/reeve/triage@v0.1
        with:
          sweep: true
          limit: 200
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: |
            gpt-5-mini
            gpt-5
```

Nothing here differs from an event-triggered workflow except the trigger
itself and the three sweep inputs. The warrant, the provider list, the
rotation, the fingerprint — every guardrail that applies to one thread applies
to all two hundred.

## The free-tier, IP-rate-limited story

This is the configuration the sweep was built for. A keyless provider caps
requests by IP rather than by key, a runner's IP is shared and its quota
resets on nobody's schedule Reeve can read, and a single scheduled run against
a four-thousand-issue backlog is going to spend most of its list rotating
through 429s. **That is not a failure of this design — it is the exact
condition it was designed around.** One run gets through as many threads as
the weather allowed, ends yellow, and says how many are left. The next
scheduled run picks up from there, for free, on the threads the fingerprint
says are still untouched. Given enough scheduled runs, the backlog finishes —
not because any single run got lucky, but because the combination of
weather-not-error and free-skip-by-fingerprint means nothing is ever lost
between runs, only deferred.

## `since` for a mid-flight integration

Installing Reeve on a repository with three years of history does not mean
committing to translate or sort three years of history. `since` bounds a
sweep by **creation date**, never by when a thread was last touched — a
sweep's own labelling or translating would otherwise push an update-date
bound forward under it, quietly widening the backlog a supposedly-bounded
run considers. So the first sweep can be scoped to "everything opened from
the day I installed this" and a backfill of everything older stays a
deliberate, separate decision — run once, by hand, with `limit` set to
whatever you are willing to spend finding out what it costs.

## Bulk migration: `record` composed with `sweep`

Triage-only, and the one place `sweep` changes what a run is allowed to do
rather than only how much of it looks for work. Grant `record` in both the
warrant and `apply` on a `sweep` run, and the backlog walk stops triaging and
starts importing instead — every candidate's standing labels are written to
the corrections store as history, the same shape a single labelled event
records, but attributed to `"sweep"` rather than to whoever last touched the
label:

```yaml
with:
  sweep: true
  sweep-state: all
  limit: 500
  apply: record
```

```yaml
# .github/reeve.yml
capabilities:
  triage: [record]
```

`sweep-state` is what makes this worth having: an ordinary sweep only ever
lists `open` threads, because triaging a thread nobody is going to look at
again is wasted work. Bulk migration is the opposite case — the decisions
worth importing are exactly the ones a maintainer already closed the book on
— so `sweep-state: closed` or `sweep-state: all` reaches those too. It is a
filter on what the listing fetches, nothing more; the taxonomy and the
capabilities that bound an ordinary sweep bound this one identically.

A candidate carrying none of the taxonomy's labels is skipped — there is
nothing on it to import — and every other guardrail applies exactly as it
does to a single `record` run: taxonomy-filtered labels, the same pivot
rendering, the same idempotent replace-by-thread write. Run it once, by hand,
the same way a `since` backfill is: a deliberate `workflow_dispatch`, not a
recurring schedule — once a project's history is in the store, the ordinary
per-event `record` path is what keeps it current.

## What this replaces

Working through an existing backlog one thread at a time, from a
`workflow_dispatch` you trigger by hand with the
[`number`](../getting-started/installation.md#a-backfill-or-one-thread-on-purpose) input, still
works exactly as before. `sweep` does not remove that path — a single thread
on purpose is still exactly that — it adds the scheduled, unattended one next
to it.

---

**Related:** [Cost](cost.md) · [Dry run](dry-run.md) · [Troubleshooting](troubleshooting.md)
**Next:** [Cost](cost.md) — what a run like this actually spends, and how to keep it predictable
