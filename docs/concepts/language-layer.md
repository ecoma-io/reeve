# The language layer

_Understand the three language roles and how detection reasons about them. Prerequisites: [Languages](../guides/languages.md)._

This is the part of the core that the rest of the field does not have, and the
reason [D1](../doctrine/north-star.md#d1--no-duty-is-english-only) is the first doctrine
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

## Detection is code first, and a model only as a closed question

Detection runs at stage 4, in the core, and the answer it produces is the one
every duty above it is handed. Two properties make that placement worth
defending.

The first is cost, and it is the reason the order is script narrowing, then a
bundled byte-ngram profile, then anything else. Both of those are library calls:
offline, free, deterministic, and identical on every re-run. Asking a model
"what language is this?" as the _first_ move would mean paying per thread to
answer a question a library already answers — and a language layer that costs a
call per thread is the first thing a large repository turns off, which takes
[D1](../doctrine/north-star.md#d1--no-duty-is-english-only) down with it.

The second is that an open question to a model is not the same object as a
closed one. "What language is this?" has no bounded answer set, so its result
cannot be checked; "which of these two configured languages is it?" has exactly
as many answers as there are survivors, and every one of them is a language the
project already named. That is why the last step, when both free steps leave more
than one candidate standing, is allowed: it is a choice between survivors, never
an open question, and its result is validated against the survivor set before
anything uses it. `unknown` is what comes back when nothing decides — a real
answer, not a default.

It also has to be idempotent. A detector that returns a different answer on the
second run turns [D9](../doctrine/north-star.md#d9--re-running-is-cheap-and-safe) into a
lie, because the duty would produce different output for an unchanged thread.
The free steps are idempotent by construction; the last step is bounded to the
survivor set, so the worst it can do is disagree between two languages the
project reads — and the fingerprint in the published marker is what keeps that
from re-spending on an unchanged thread.

**Decided:** detection is core's, resolved once per run in the order free → free
→ bounded choice. No duty may detect a language itself, and no step anywhere may
ask a model an open-ended "what language is this?".

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
  means comparison cannot be lexical on its own. **Decided:** the common
  representation is a pivot — translate both sides into the project's working
  language, then rank lexically over that, the same machinery already used
  within one language. See
  [the settled pivot decision](../doctrine/north-star.md#9-settled-questions) for the
  argument against multilingual embeddings instead. Two reports of the same
  crash, one in Vietnamese and one in English, land in the same place because
  both get read in the same language before anything ranks them.
- **`respond`** writes to the author, in the author's language, about a project
  whose documentation is in the project's.

This is the concept behind [Languages](../guides/languages.md)'s
configuration surface — the input and warrant keys on that page are how you
tell this layer what to work with; this page is why it is shaped the way it
is.

---

**Related:** [Languages](../guides/languages.md) · [The authority model](authority-model.md) · [The warrant](../guides/warrant.md)
**Next:** [The authority model](authority-model.md) — the other concept every duty is built on
