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

| Role                 | What it is                                                                                                                       | Where it comes from                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Author language**  | What the person on the other end actually wrote in.                                                                              | Detected, per item, deterministically.                                                        |
| **Project language** | The language the project's own artefacts are in — its taxonomy, its docs, its issue titles as a maintainer expects to scan them. | The warrant's `languages:` key, or the duty's own documented default when the file is silent. |
| **Reader languages** | What the maintainers actually read. Often more than one, often not the project language.                                         | The warrant's `languages:` key, or the duty's own documented default when the file is silent. |

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
- **`lifecycle`** calls no model, and still consumes the layer at its cheapest:
  it reads `languages` and detects a thread's language only to pick which
  `say:` text a step posts — the built-in reminder text, or the per-language
  mapping a track's own step wrote.

This is the concept behind [Languages](../guides/languages.md)'s
configuration surface — the input and warrant keys on that page are how you
tell this layer what to work with; this page is why it is shaped the way it
is.

## Chrome: Reeve's own words, apart from a duty's

Everything above is about content — the thread's own text, and what a duty
decides or writes about it. Every duty that touches a thread also wraps that
content in a little of Reeve's own scaffolding: the boundary note above a
translation, the footer under a first reply, the line explaining a duplicate
proposal, a lifecycle reminder's own attribution. None of that is a duty's
judgement and none of it is a model's output — it is fixed English,
Vietnamese, and Chinese text, committed in `src/core/chrome.ts` and reviewed
in the diff the same as any other line of code.

**This is a different question from whether a duty can translate a thread's
content, and it is answered differently on purpose.** A thread's content
goes through detection and, where a duty calls for it, a model — because
what the author wrote is open-ended and the whole point is to handle
whatever language that turns out to be. Chrome is a fixed, short, known set
of sentences decided once by the people who maintain this project, so
translating it is a one-time reviewed pull request instead of a per-run
model call: zero model calls for any of it, deterministically, on every run,
forever — the same posture this project takes toward every cost that can be
paid once in review instead of repeatedly at runtime.

**Chrome follows the language of the block it wraps, at the moment that
block is published.** A block that already belongs to one language
throughout — a lifecycle comment resolved to the thread's own language, a
first reply, a duplicate proposal — gets its chrome in that same language. A
block that introduces several language sections at once — `translate`'s
boundary note above every translated section, and its footer below all of
them — is shared by every language the thread actually got translated into,
so it renders once per language present, English line first. Neither rule
picks one language to speak _about_ the others in. Chrome is not part of a
block's fingerprint: a block published before this table carried a language,
or before this version existed at all, keeps the chrome it was published
with — stale chrome is a smaller, quieter cost than re-editing every comment
this project has ever posted the moment a translation is added. It only
catches up the next time that block's own content changes and it re-renders.

**A language chrome has no row for falls back to English, deterministically
— never a guess, never a model call.** This is keyed by the language a
thread's content actually resolved to, detected per run for `respond`,
`duplicate`, and `lifecycle` (and per translated section for `translate`) —
not by the repository's configured `languages:` list. A repository configured
for only `languages: [vi]` still gets this note the first time a French
thread reaches a duty's chrome, because the fallback is about what a thread
turned out to be written in, not what a warrant expected. The first time a
run's chrome would have fallen back this way, the job summary says so once,
naming the language and what it fell back from, rather than silently reading
English scaffolding around content in a thread's own language forever.

**Adding a language to this table is one pull request, touching only
`src/core/chrome.ts`:** a new entry in the supported-language list, a full
row of translations for it added to every chrome string, and the file's own
completeness test — which checks every string against every configured
language — fails loudly at that same pull request if a single one was
missed.

---

**Related:** [Languages](../guides/languages.md) · [The authority model](authority-model.md) · [The warrant](../guides/warrant.md)
**Next:** [The authority model](authority-model.md) — the other concept every duty is built on
