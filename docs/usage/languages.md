# Languages

Who wrote in what, who reads in what, and how Reeve works out the first without
spending anything.

> [!IMPORTANT]
> Reeve is on a `0.x` line. This page is a contract that can still change on a minor —
> see [what `0.x` and `1.0` mean](../development/releasing.md#what-0x-and-10-mean-here).

## The three roles

Every duty knows three things about language, and they are different things.

| Role                 | Whose                           | Where it comes from                                     |
| -------------------- | ------------------------------- | ------------------------------------------------------- |
| **Author language**  | The person who wrote the thread | Detected. Never configured, never asked for.            |
| **Project language** | Yours                           | Configured. What Reeve writes in when it addresses you. |
| **Reader languages** | Everyone who reads              | Configured. What `translate` produces.                  |

The distinction is the whole product. A duty that collapsed them would either
assume contributors write in your language — they do not — or answer a stranger
in a language they did not write in.

The design behind this is in
[the language layer](../development/language.md). This page is how you configure
it.

## `languages`

```yaml
with:
  languages: en, vi, zh
```

**This is what to translate _into_, and it says nothing about what an author may
write in.** Anyone may open an issue in anything. A language not on this list is
translated _out of_ rather than rejected.

Bare codes are enough. The label and the writing system are read off the
runtime's own CLDR data, so `vi` becomes **Tiếng Việt** and Reeve knows it is
written in Latin without you saying so.

Spell an entry out as `code:Label:Script` when you want a name of your own, or
when the runtime knows the code by no name at all. Use `+` between scripts for a
language written in several:

```yaml
languages: |
  en
  pt:Português (Brasil):Latin
  ja:日本語:Han+Hiragana+Katakana
```

**The script is load-bearing twice over.** It lets detection skip the model
entirely when your candidates already separate, and it is how a draft that came
back in the language it was supposed to leave gets thrown out before anything
ranks it.

## How detection works, and what it costs

Four steps, and most threads stop at the second.

**1. Blank the residue.** URLs, e-mail addresses, bare domains, and any token a
digit is standing in — `v1.2.3`, `HTTP 429`, `abc123` — are written the same in
every language. An identifier in any script proves nothing about the prose around
it, so it is removed before anything is measured. What is left is the _prose
residue_, and that is what gets detected.

**2. Narrow by script.** The residue is measured against the writing systems your
configured languages use, and candidates that cannot account for the scripts
present are eliminated. **One survivor means the answer is arithmetic and nothing
is called.** This is the common case for a project whose languages write
differently — `en` against `zh`, `en` against `ru`.

**3. Profile.** More than one survivor — `en` against `vi`, both Latin — and a
bundled byte-ngram profile is tried, restricted to the survivors. Still no
network, still nothing spent.

**4. Ask.** Only when the profile does not decide either, and only to choose
between the survivors. Never to answer an open question.

Detection is code, and steps 1–3 are free. That is not an optimisation; it is
[doctrine](../north-star.md#d1--no-duty-is-english-only). A language layer that
cost a model call per thread would be the first thing turned off on a large
repository, and every duty above it would go back to being English-first.

### Which languages the free step knows

Script narrowing works for any language there is a Unicode script name for,
because it is derived entirely from what you wrote in `languages`.

The **profile** step is not: it is a bundled dataset covering 60 languages, and
it is the only fixed list anywhere in Reeve.

```
am ar az be bg bn ca cs da de el en es et eu fa fi fr gu he hi hr hu hy is it
ja ka kn ko ku lo lt lv ml mr ms nl no or pa pl pt ro ru sk sl sq sr sv ta te
th tl tr uk ur vi yo zh
```

Two consequences worth configuring around:

- **A code outside that list disables the profile step for the whole run**, not
  just for that language. The step either identifies among all surviving
  candidates or declines; identifying among some of them would be a detector
  answering a different question than it was asked. So one exotic code moves
  every ambiguous thread to the model.
- **A regional tag is not its base language here.** `pt-BR` is not `pt`, and
  `zh-Hans` is not `zh`. If you want the regional identity visible, put it in the
  label rather than the code — `pt:Português (Brasil):Latin` keeps the free step
  and still reads the way you want.

Neither is a failure. Detection reaches the same answers; it reaches them by
spending a request where the scripts alone were not enough. If your languages
already write in different scripts, the profile step never runs and none of this
applies.

## `unknown` is an answer

A German issue in a repository configured for English, Vietnamese and Chinese has
no source language among your candidates. Reeve says so: `source-language` comes
back empty, and the thread is translated into all three, because there is nothing
to leave out.

That is the honest reading. The alternative — picking the nearest candidate — is a
detector that is confidently wrong exactly when it has the least evidence, and
every duty downstream would inherit the error.

Duties treat `unknown` as a real outcome rather than a failure. `triage` sorts on
the text it has. `translate` produces every configured language.

## What each duty does with it

| Duty        | Uses language for                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `translate` | Which languages to produce, which to skip, and which scripts a draft may not leak into.                                          |
| `triage`    | Nothing about _whether_ to sort — it sorts everything. Language is reported in the outputs, and it is what evaluation slices on. |

A triage verdict must be as good in Vietnamese as in English. That is not a hope:
the headline accuracy number for any duty is **the worst language, not the
average** ([D11](../north-star.md#d11--every-duty-ships-with-an-evaluation)), so a
duty that quietly degrades outside English fails its own gate.

## Configuring for a project with one maintainer language

The common case: contributors write in several languages, maintainers all read
one.

```yaml
- uses: ecoma-io/reeve/translate@v0.1
  with:
    languages: en, vi, zh, ja
    api-key: ${{ secrets.OPENAI_API_KEY }}
    models: gpt-5-mini
```

Every thread ends up carrying every language on that list except the one it was
written in. A maintainer reading English gets English on a Vietnamese report; the
Vietnamese author gets their own words kept intact and marked as the version the
project answers for.

You do not need a separate configuration for "the language my team reads" — it is
on the list like the others, and being on the list is what makes it appear.

## Open questions

Honest gaps, tracked rather than papered over:

- **A thread written in two languages at once** — an English title with a
  Vietnamese body is common and currently detected as one thing.
- **Many maintainers, many project languages** — the project language is
  currently one value.

Both are in [the north star](../north-star.md#9-open-questions). Neither has a
workaround worth documenting as though it were a design.
