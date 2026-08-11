# Using Reeve

For someone installing Reeve on a repository they maintain. If you are changing
Reeve itself, [`../development/`](../development/) is the other half.

> [!IMPORTANT]
> **Reeve is on a `0.x` line.** These pages are normative: a duty that behaves
> differently from what is written here is a bug in the duty, not a stale page.
> But the surface they describe is not frozen — an input can be renamed or
> collapsed into the warrant on any minor, and the release notes will say so.
> That settles at `1.0`, which arrives when
> [the roadmap](../north-star.md#7-roadmap) is finished — see
> [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## Start at level 0, climb when a rung earns it

Reeve is [a ladder](../north-star.md#3-the-ladder), not a mode you pick up
front. The five minutes below get a duty running with a single `uses:` line
and a provider — nothing else written down, nothing else to learn first. Every
page past that is a rung: read it the day its problem shows up on your own
repository, not before.

| Level | Page                                  | Read it when                                                                                  |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0     | [Installation](installation.md)       | Adding a duty to a workflow for the first time — triggers, permissions, versions.             |
| 1–2   | [The warrant](warrant.md)             | The implicit taxonomy is sorting worse than you'd like, and you want to write your own.       |
| 2     | [Languages](languages.md)             | Configuring who writes in what, and who reads in what.                                        |
| 3     | [The sweep](sweep.md)                 | Working a backlog that already exists, on a schedule, instead of one thread at a time.        |
| —     | [Cost](cost.md)                       | Working out what a backlog costs before you point it at one — including at zero.              |
| —     | [Troubleshooting](troubleshooting.md) | A run went red, went yellow, went green and did nothing, or did something you did not expect. |

## The duties

| Duty                               | Does                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| [`triage`](duties/triage.md)       | Sorts incoming work against a taxonomy you wrote, in the language it arrived in. |
| [`translate`](duties/translate.md) | Puts every thread in front of every reader, without rewriting anyone.            |

`duplicate` and `respond` are Stage 5 in
[the roadmap](../north-star.md#7-roadmap) and have no pages yet, because a page
about an input that does not exist is worse than no page.

## The shape of every duty

Read this once and the individual pages get shorter.

**One repository, several actions.** Each duty is its own action in a
subdirectory, so a workflow names the duty it wants:

```yaml
- uses: ecoma-io/reeve/triage@v0.1
- uses: ecoma-io/reeve/translate@v0.1
```

One version line covers all of them. They share a core — the provider client and
its rotation, the language layer, multi-draft scoring, the sanitiser, the
warrant — and each keeps its own inputs, so nothing you write is meaningless to
the thing you are configuring.

**Every duty takes the same four inputs**, and they mean the same thing
everywhere: `github-token`, `base-url`, `api-key`, `models`. Learn them once.

**Every duty has `dry-run`.** It runs the entire pipeline, writes every output,
and touches nothing. This is how you point a provider or a taxonomy at a real
backlog before it is allowed near it, and it is the right first step for every
page in this directory.

**A duty's failure mode is doing nothing, loudly.** A model that misbehaves, a
verdict that does not parse, a provider with no quota left — none of them produce
a half-result. They produce no result, a warning that says which, and outputs a
workflow can branch on. What fails the job red is a broken configuration and a
thread that cannot be read: things you can fix.

## What will never appear in this directory

A page about an account, a dashboard, a hosted API, a pricing tier, or a
migration off your own repository. Everything Reeve knows is a file you can read
in a pull request and delete with `rm`, and that is a
[doctrine commitment](../north-star.md#d6--the-repository-is-the-database)
rather than a current limitation.
