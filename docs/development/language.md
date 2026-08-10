# The language layer

This is the part of the core that the rest of the field does not have, and the
reason [D1](../north-star.md#d1--no-duty-is-english-only) is the first doctrine
rather than the tenth.

The claim it has to make true: **a duty's decision must not get worse because
the author did not write in English.**

## Three roles, not one setting

Most tools have a language setting. Reeve has three roles, and confusing them is
where every naive design fails.

| Role                 | What it is                                                                                                                       | Where it comes from                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Author language**  | What the person on the other end actually wrote in.                                                                              | Detected, per item, deterministically. |
| **Project language** | The language the project's own artefacts are in — its taxonomy, its docs, its issue titles as a maintainer expects to scan them. | The warrant.                           |
| **Reader languages** | What the maintainers actually read. Often more than one, often not the project language.                                         | The warrant.                           |

A tool with one setting can translate. It cannot decide, because deciding
requires knowing _whose_ language a given piece of output is for. A label
explanation is for a reader; a first reply is for the author; a title is for
both and belongs to neither.

**Decided:** these three roles are core state, resolved once per run at stage 4
and passed to every duty. A duty never detects a language itself.

## Detection is code, never a model

Detection runs at stage 4 — before anything untrusted has been near a provider.
That placement is not an optimisation; it is a containment property. Asking a
model "what language is this?" means handing a stranger's text to a model in
order to answer a question a library answers offline, for free, deterministically,
and identically on every re-run.

It also has to be idempotent. A detector that returns a different answer on the
second run turns [D9](../north-star.md#d9--re-running-is-cheap-and-safe) into a
lie, because the duty would produce different output for an unchanged thread.

**Decided:** language detection is a deterministic library call. No duty may
escalate a detection question to a model.

### What gets detected

Naive detection on an issue body is wrong more often than it is right, because
issue bodies are not prose. They are prose interleaved with stack traces, log
output, file paths, package names and command lines — nearly all of which look
like English to a detector, and none of which the author chose.

Detection therefore runs on the **prose residue**: the body with fenced blocks,
inline code, URLs, and quoted output removed. If what remains is too short to
decide on, the item is not guessed at — it is treated as language-unknown, and
each duty declares what it does with that. Guessing here is how a Japanese bug
report gets answered in English because it contained a long Java stack trace.

**Decided:** detection input is the prose residue, and "unknown" is a real
outcome that duties must handle rather than a value to be defaulted away.

## What each duty does with it

The layer is only worth having if duties actually consume it. Concretely:

- **`triage`** decides against a taxonomy the project wrote in the project
  language, from text the author wrote in theirs — and its explanation is
  rendered for the reader who will see it. The decision quality, not just the
  explanation, is what D11 measures per language.
- **`translate`** is the one duty whose output _is_ language, and it is the
  least interesting consumer: it turns author language into reader languages
  while keeping the original byte-for-byte.
- **`duplicate`** is the hard one. Matching happens across languages, which
  means comparison cannot be lexical. Two reports of the same crash, one in
  Vietnamese and one in English, have to land in the same place.
- **`respond`** writes to the author, in the author's language, about a project
  whose documentation is in the project's.

## Evaluation

Because of D11, a duty's evaluation set is multilingual and its headline number
is **the worst language it claims**, not the mean. An average hides exactly the
failure this project exists to remove: the tool that works, on average, because
it works in English.

A duty may claim fewer languages. It may not claim a language it has not
measured.

## Open

These are unresolved and marked so a reader does not mistake a sketch for a
decision.

1. **The pivot for cross-language comparison.** Matching Vietnamese against
   English requires a common representation. Translating both to a pivot
   language is simple and lossy and costs a model call per item; embedding both
   in a multilingual vector space is cheaper per comparison and introduces a
   dependency Reeve has so far avoided. Neither has been chosen, and the choice
   shapes Stage 4.
2. **Multi-language threads.** A body in Vietnamese with an English title, or a
   thread where the author switches after a maintainer replies. Per-item
   detection handles the common case and does not describe this one.
3. **Reader languages beyond two.** See open question 2 in the north star: the
   author/project two-pole model is a simplification, and a project with
   maintainers in three countries will break it.
4. **Script versus language.** Simplified and traditional Chinese, and the
   several Serbian and Punjabi cases, are one language and two scripts. Whether
   the warrant expresses script separately is undecided.
