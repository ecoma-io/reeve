# Development documentation

For people changing Reeve. If you are installing it, [`../usage/`](../usage/README.md)
is the directory you want.

Everything here is downstream of [`../doctrine/north-star.md`](../doctrine/north-star.md). Where
this directory explains _how_ something is built, the north star explains why it
is allowed to exist at all, and it wins any disagreement.

| Document                                   | The question it answers                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)       | The pipeline stage by stage, what each stage is forbidden from doing, and where the line between core and duty runs.         |
| [`language.md`](language.md)               | The language layer: how the author's language, the project's language and the reader's languages are resolved and carried.   |
| [`duties.md`](duties.md)                   | How to add a duty: what the core supplies, what a duty supplies, and what it may never reach for.                            |
| [`security.md`](security.md)               | The threat model. Prompt injection from a stranger's thread, the write authority Reeve asks for, and the invariants.         |
| [`evaluation.md`](evaluation.md)           | How a duty proves it works — the fixture set, the harness, and why the headline number is the worst language.                |
| [`platform-limits.md`](platform-limits.md) | The platform behaviours that shape the design rather than being worked around, each marked documented, measured or inferred. |
| [`releasing.md`](releasing.md)             | How a version is cut, why `dist/` is committed, and what the floating tag is allowed to deliver.                             |

These are normative and written ahead of the code, like
[`../doctrine/north-star.md`](../doctrine/north-star.md). Where an implementation disagrees with a
page here, one of the two is a bug — and which one is a conversation, not an
assumption.

## Before you change anything

Three rules cause most of the review comments, and all three come from doctrine
rather than taste:

1. **A duty may not reach past the core.** If a duty constructs an HTTP client,
   reads a config file, or writes to the forge itself, the boundary broke — even
   if the code works. See [`architecture.md`](architecture.md#the-boundary).
2. **A capability is not shipped until the warrant can express it.** New effects
   need a warrant surface designed in the same pull request, and the check reads
   the file rather than the model's claim. (D2)
3. **A duty is not done when it works; it is done when it is measured, in every
   language it claims.** (D1, D11)

[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) covers the mechanics —
branches, commit scopes, hooks, and what CI will reject.
