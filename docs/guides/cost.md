# Cost

_Control and predict what a run costs. Prerequisites: [Installation](../getting-started/installation.md)._

What a backlog costs before you point Reeve at one, why most of it is free, and
how to run the whole thing without a key.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a
> minor — see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).
> Every number below is marked **estimated** or **structural**: structural claims are
> facts about how the code is arranged, estimates are arithmetic on assumptions
> your repository will not share exactly. Nothing here is measured on your data —
> `dry-run` is how you get that.

## The shape of the bill

Reeve is arranged so that the expensive thing runs last and least.

| Tier                    | Decides                                                                                       | Costs         |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| **Code**                | Empty bodies, unfilled templates, obvious spam, exact repeats, a thread Reeve already handled | Nothing       |
| **A cheap model**       | Is this worth a careful read — spam, off-topic, out of scope                                  | Very little   |
| **The model you chose** | The actual verdict, on what survived                                                          | The real bill |

**Structural:** the first tier cannot cost money, because nothing before the
drafting stage constructs a provider at all. That is enforced by the
[architecture](../development/architecture.md), not by discipline — stages 1–5 of
the pipeline have no provider in scope.

The claim this arrangement makes is not "AI is cheap". It is that **a backlog is
mostly not the interesting cases**, and paying a careful model to read an empty
issue template is the largest avoidable line on the bill.

## The three levers

### 1. Screening

```yaml
with:
  screen-models: gpt-5-nano
  models: gpt-5-mini
```

`screen-models` runs a cheap model on one binary question — is this worth the
expensive one — with short input and a one-token answer. What reaches `models` is
what survived.

Leave `screen-models` empty and no screening model runs: everything code did not
decide goes straight to `models`. That is the documented behaviour of the
default, not a degraded mode. It is simply more expensive.

### 2. Idempotency

Every duty that writes into a thread anchors on a marker carrying a fingerprint
of what it did — the text it read, and the languages it produced.

**Structural:** a run that computes a fingerprint already published stops
_before_ it constructs a provider. One API read, nothing else.

Three things follow:

- **The `edited` trigger is safe.** Writing a body fires `edited`, which starts a
  run that recognises its own output and returns.
- **A backfill over a few hundred old threads is affordable**, because the second
  pass over them is free.
- **A long discussion does not cost a long bill.** Each reply carries its own
  fingerprint, so a new comment on a thread handled last week costs one
  translation, not forty.

The fingerprint records **what a run did, never what it was asked to do**. A
language a provider had no quota for is not in it, so the next run tries again. A
body whose tail was left behind is fingerprinted over the part that was read, so
raising the limit later translates the rest. And model ids and `drafts` are
deliberately _not_ in it: rotating past a dead model or raising a quality knob
should not re-spend the budget for your entire repository.

### 3. Drafts instead of a better model

```yaml
with:
  drafts: 3
  models: |
    model-a
    model-b
    model-c
```

Three attempts, filtered by a deterministic score, and the winner published.
Draft `n` prefers the `n`th model, so two drafts disagree the way two models do
rather than the way one model's sampling does.

**This costs calls instead of money.** It is the quality lever that exists when a
stronger model is not on your menu — which is exactly the situation on a free
tier.

## Running it with no key at all

Some providers serve OpenAI-compatible models with no key. That configuration is
supported by design ([D7](../doctrine/north-star.md#d7--any-endpoint-including-the-free-ones)),
not tolerated:

```yaml
- uses: ecoma-io/reeve/translate@v0.1
  with:
    base-url: https://your-keyless-provider.example/v1
    models: |
      model-a-free
      model-b-free
      model-c-free
    drafts: 3
    judge-models: model-a-free | model-b-free
```

Free models are individually weak and operationally flaky. Both are handled by
the same machinery: **flaky** by rotation — a model that fails is passed, never
retried, because a provider limit does not clear inside one run — and **weak** by
drafts and deterministic scoring.

The judge above is one seat with a fallback, not two votes: `model-b-free` is
asked only on the run where `model-a-free` is out of quota, and it costs one
request either way. Spending a second request on a second opinion is what a
second seat is for, written `model-a-free, model-b-free` — worth knowing before
you double a free tier's daily call count by accident.

Give a keyless configuration more models than you think it needs. The list is the
budget.

## `limit`, and the sweep

A backlog swept on a schedule rather than read one thread at a time needs a
different kind of cost control than a single run does: not "which model," but
"how much of the backlog does this run even attempt." `limit` is that control
— it bounds a sweep by count, so a scheduled run against a four-thousand-issue
backlog spends a predictable amount and stops, rather than running until the
job's own timeout cuts it off mid-list. It defaults to `50`, modest enough to
protect a free tier's own rate limit; raise it for a paid provider or a
deliberate backfill.

Combined with the fingerprint that already makes a re-run free, `limit` turns
an unbounded backlog into a bounded, repeatable bill: the first scheduled run
costs `limit` threads' worth of calls, and every run after it costs only the
threads that changed, because everything already matching its fingerprint is
skipped before a provider is constructed. [The sweep](sweep.md) covers the
whole mechanism, including what a run that did not finish looks like and why
that is the correct outcome rather than a failure to budget for.

## A worked estimate

**Estimated**, on assumptions worth arguing with. A repository receiving 300
issues a month, an English/Vietnamese split, `screen-models` set, `translate` and
`triage` both on:

| Stage                        | Threads reaching it | Why                                                               |
| ---------------------------- | ------------------- | ----------------------------------------------------------------- |
| Arrive                       | 300                 |                                                                   |
| Survive code screening       | ~210                | Empty templates, spam, exact repeats, and Reeve's own edits       |
| Survive the cheap model      | ~170                | Off-topic and out of scope                                        |
| Reach `models` for triage    | ~170                | One call each                                                     |
| Reach `models` for translate | ~170                | One call per missing language — with two languages, one call each |
| Detection calls              | ~10                 | Only the threads scripts and profile could not separate           |

So roughly **350 calls on the model you chose, 300 on a cheap one, and 10 for
detection** — against 600 if every duty read every thread with the expensive
model and detected with one too.

The second month over the same threads costs the API reads and nothing else,
because the fingerprints already match.

Where this estimate is most likely wrong for you: the code-screening rate. A
project with a strict issue template screens far more than one with a blank box.
Run `dry-run: true` over a month of your own history — it produces every output
and spends only the model calls — and replace the middle column with your
numbers.

## Measuring it instead of estimating it

Every run writes what it actually spent to the job summary: requests, prompt
tokens and completion tokens, per stage and per model, with a total. That is the
column above, measured on your data rather than assumed.

Two things about those numbers. They are the provider's own `usage` field and
never Reeve's arithmetic, so a gateway that reports nothing produces a page that
says how many requests went uncounted rather than a total that cannot be
checked. And a request that failed and was rotated past is in the total, because
it is on the invoice.

## What Reeve will never do about cost

**It will not silently downgrade.** A run does not quietly switch to a worse model
to stay under a budget. Rotation happens because a model failed, and every
rotation is in the log.

**It will not batch several threads into one prompt to save tokens.** Putting two
strangers' text in one context is how one of them ends up steering the verdict on
the other.

**It will not cap the answer.** Input limits bound what is read from a thread;
nothing bounds what the model may write back, because a translation truncated
mid-sentence is worse than an expensive one.

Cost is a design constraint here, not a runtime negotiation. If a configuration
is too expensive, the fix is a cheaper model, screening, or fewer languages —
each of which you chose, and each of which shows up in a diff.

---

**Related:** [The sweep](sweep.md) · [Dry run](dry-run.md) · [Troubleshooting](troubleshooting.md)
**Next:** [Troubleshooting](troubleshooting.md) — what to check when a run does not do what you expected
