# Using Reeve

For someone installing Reeve on a repository they maintain. If you are changing
Reeve itself, [`../development/`](../development/) is the other half.

> [!IMPORTANT]
> **Reeve is before `v1`.** These pages are the contract Stage 0 ships against,
> written before the code that meets them has landed in this repository. They
> are normative: a duty that behaves differently from what is written here is a
> bug in the duty, not a stale page. Nothing here is production advice yet.

## Start here

| Page                                  | Read it when                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| [Installation](installation.md)       | Adding a duty to a workflow for the first time — triggers, permissions, versions. |
| [The warrant](warrant.md)             | Deciding what Reeve is allowed to do to your repository, and writing it down.     |
| [Languages](languages.md)             | Configuring who writes in what, and who reads in what.                            |
| [Cost](cost.md)                       | Working out what a backlog costs before you point it at one — including at zero.  |
| [Troubleshooting](troubleshooting.md) | A run went red, went green and did nothing, or did something you did not expect.  |

## The duties

| Duty                               | Does                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| [`triage`](duties/triage.md)       | Sorts incoming work against a taxonomy you wrote, in the language it arrived in. |
| [`translate`](duties/translate.md) | Puts every thread in front of every reader, without rewriting anyone.            |

`duplicate` and `respond` are Stage 4 in
[the roadmap](../north-star.md#6-roadmap) and have no pages yet, because a page
about an input that does not exist is worse than no page.

## The shape of every duty

Read this once and the individual pages get shorter.

**One repository, several actions.** Each duty is its own action in a
subdirectory, so a workflow names the duty it wants:

```yaml
- uses: ecoma-io/reeve/triage@v1
- uses: ecoma-io/reeve/translate@v1
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
