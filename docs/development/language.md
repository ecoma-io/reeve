# The language layer

_Evaluating and extending the language layer. Prerequisites: [The language layer](../concepts/language-layer.md)._

The three roles a language plays, why detection runs in code before it ever
reaches a model, and what each duty does with the result — that is the
concept, and it lives in [The language layer](../concepts/language-layer.md).
This page is what is left once you already know that: how a duty's language
handling is measured, and what is still unresolved.

## Evaluation

Because of [D11](../doctrine/north-star.md#d11--every-duty-ships-with-an-evaluation),
a duty's evaluation set is multilingual and its headline number is **the
worst language it claims**, not the mean. An average hides exactly the
failure this project exists to remove: the tool that works, on average,
because it works in English.

A duty may claim fewer languages. It may not claim a language it has not
measured. See [Evaluation](evaluation.md) for the harness this runs against.

## Open

These are unresolved and marked so a reader does not mistake a sketch for a
decision.

1. **Multi-language threads.** A body in Vietnamese with an English title, or a
   thread where the author switches after a maintainer replies. Per-item
   detection handles the common case and does not describe this one.
2. **Reader languages beyond two.** See
   [open question 2 in the north star](../doctrine/north-star.md#10-open-questions):
   the author/project two-pole model is a simplification, and a project with
   maintainers in three countries will break it.
3. **Script versus language.** Simplified and traditional Chinese, and the
   several Serbian and Punjabi cases, are one language and two scripts. Whether
   the warrant expresses script separately is undecided.

---

**Related:** [The language layer](../concepts/language-layer.md) ·
[Evaluation](evaluation.md) · [North star](../doctrine/north-star.md)
