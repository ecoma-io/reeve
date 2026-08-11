<!-- source of truth: action.yml -->

# The root action

_The one action in this repository that does no work, and why it exists. Prerequisites: None._

There is an `action.yml` at the repository root, and it runs no duty. It
exists to be listed, and the code behind it exists to refuse.

## What it does

Nothing, on purpose. It fails red and says what to write instead.

## When to use it

Never on purpose. It exists so that the obvious, wrong thing a consumer might
write — `uses: ecoma-io/reeve@v0.1`, naming no duty — fails loudly instead of
resolving and running nothing.

## Why it exists

GitHub reads a Marketplace listing from an `action.yml` at the repository
root and from nowhere else, while every duty ships from its own subdirectory
so a workflow can name the one it wants — see
[one repository, several actions](../development/architecture.md#one-repository-several-actions).
That split leaves a hazard: `uses: ecoma-io/reeve@v0.1` is the obvious thing
for a consumer to write, it resolves, and it would otherwise run. This file
is what stands in that gap.

The one thing it may not do is succeed quietly. A green run that did nothing
is indistinguishable from a duty that found nothing to do, and
[D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible)
does not allow the two to look alike.

## Required permissions

None. It reads no thread and touches no repository state.

## Configuration

| Input  | Required | Default | What it does                                                                                                                                              |
| ------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duty` | no       | `""`    | The duty you meant to run. Naming one here does not run it — this action cannot run any duty — but it turns a puzzling red job into a line you can paste. |

## Outputs

None.

## Failure behavior

Every invocation fails red, naming the duty you meant to run — `duty`, when
set — and the corrected `uses:` line to write instead:
`uses: ecoma-io/reeve/<duty>@v0.1`. There is no green path.

## Dry-run behavior

Not applicable. This action performs no effect for `dry-run` to withhold.

## Cost

None. It calls no model and reads no thread.

## Security considerations

It reads no thread and calls no model, so none of the pipeline's guardrails
apply to it — there is nothing here for a prompt-injection attempt to reach.

## Related concepts

**Related:** [Architecture](../development/architecture.md) ·
[Platform limits](platform-limits.md)
