# Development documentation

_Portal for people changing Reeve. Prerequisites: [North star](../doctrine/north-star.md)._

For people changing Reeve. If you are installing it,
[Getting started](../getting-started/README.md) is the directory you want.
For the concepts behind this repository's design — the boundary, the
authority model, the language layer — see [`../concepts/`](../concepts/).
For the full input/output contract of a duty, see [`../reference/`](../reference/).

Everything here is downstream of [North star](../doctrine/north-star.md). Where
this directory explains _how_ something is built, the north star explains why it
is allowed to exist at all, and it wins any disagreement.

| Document                               | The question it answers                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)   | The pipeline stage by stage, what each stage is forbidden from doing, and where the line between core and duty runs. |
| [`duties.md`](duties.md)               | The mechanics of adding a duty: earning it, evaluating it, wiring it in.                                             |
| [`language.md`](language.md)           | Evaluating a duty's language handling, and what is still unresolved about the language layer.                        |
| [`evaluation.md`](evaluation.md)       | How a duty proves it works — the fixture set, the harness, and why the headline number is the worst language.        |
| [`releasing.md`](releasing.md)         | How a version is cut, why `dist/` is committed, and what the floating tag is allowed to deliver.                     |
| [`agent-runtime.md`](agent-runtime.md) | Direction for a bounded agent runtime in Reeve 2.x. Nothing on that page ships today — read the banner first.        |

These are normative and written ahead of the code, like
[North star](../doctrine/north-star.md). Where an implementation disagrees with a
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

---

**Related:** [North star](../doctrine/north-star.md) ·
[Concepts](../concepts/) · [Reference](../reference/) ·
[Threat model](../security/threat-model.md)
