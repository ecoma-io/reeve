# Writing a duty

_The mechanics of adding a duty: earning it, evaluating it, wiring it in. Prerequisites: [Duties and the core](../concepts/duties-and-the-core.md), [Architecture](architecture.md)._

What a duty is, what the core supplies, what a duty supplies back, and what
it may never reach for — that is the concept, and it lives in
[Duties and the core](../concepts/duties-and-the-core.md). Read that first;
this page assumes it and covers the mechanics of actually adding one.

## Adding one

### 1. Earn it

[D10](../doctrine/north-star.md#d10--a-duty-must-earn-its-place) is a strict gate and it
rejects most proposals on purpose. The work has to:

1. **recur** — a maintainer does it repeatedly, not once;
2. **be uniformly expensive today** — not merely occasionally annoying;
3. **already be work a maintainer stopped doing** — the honest test, because a
   duty that automates something nobody was doing anyway automates nothing;
4. **be harder on a project whose contributors do not share a language.**

If it fails (4) it might still be a good idea. It is not a good idea _here_, and
[the non-goals](../doctrine/north-star.md#8-non-goals) are where that gets argued.

### 2. Write the evaluation first

[D11](../doctrine/north-star.md#d11--every-duty-ships-with-an-evaluation): a duty ships
with a way to measure it or it does not ship. Write the fixture set before the
duty, in at least two languages, and decide up front what number would make you
withdraw the duty. See [evaluation](evaluation.md).

Writing it first is not discipline for its own sake. A fixture set written after
the implementation is a set of cases the implementation already handles.

### 3. Write the doc page

`docs/reference/duties/<name>.md`, before the code, following
[the reference template](../reference/duties/triage.md) another duty page
already uses. It forces the input contract to be something a stranger could
configure, and it is where you find out that two of your inputs mean the
same thing.

### 4. Write the duty

Four values, no I/O, no authority decisions. If it needs something the core does
not have, that is a change to the core in its own commit with its own scope — not
a private helper inside the duty that the next duty will duplicate.

### 5. Wire the action

`<name>/action.yml` declares every input and its default, and **it is the only
place they are declared.** A second list of names in the source is free to drift
from it.

An integration test reads `action.yml` back and fails when the names it declares
and the names the duty asks for stop matching. A rename in one place alone would
otherwise leave the duty reading an empty string on every run, silently.

Then add the entry point to `tools/build.mjs` and the duty's directory to the
archive step in `.github/workflows/release.yml`. Both are short lists naming
every duty, and a duty missing from the second one builds on your machine and is
absent from the release tree.

### 6. Add the commit scope

`commitlint.config.mjs` and `CONTRIBUTING.md`. A duty whose commits cannot name
it is a duty whose history cannot be read.

## The four inputs every duty shares

`github-token`, `base-url`, `api-key`, `models`. Same names, same defaults, same
meanings, everywhere.

A duty that needed `model` instead of `models`, or `token` instead of
`github-token`, would make a consumer relearn the core for each duty — which is
the whole thing one repository and one version line exist to avoid.

`dry-run` is the fifth. It is not optional: a duty a consumer cannot rehearse is a
duty they have to arm to evaluate.

## Testing a duty

Three tiers, and the middle one is where the value is.

**Unit** — the prompt shape, the parser, the scoring criteria. Pure functions,
so the tests are about behaviour rather than mocks. The parser deserves the most
hostile cases you can write: truncated JSON, a verdict wrapped in prose, a label
list containing an object, an answer that is entirely an apology.

**Integration** — the duty against a fake provider and a fake `Thread`. This is
where "the model misbehaved" is exercised, and it is the tier that decides whether
the duty is safe. Every branch that ends in "do nothing, loudly" needs a test that
proves it ends there.

**Contract** — `action.yml` against what the duty reads, and the invariants in
[Security](../security/security.md#invariants).

A duty is judged on what it does when the model misbehaves, not on what it does
when everything works. A pull request whose tests only cover the happy path is
not finished, and a reviewer will say so.

## Existing duties as references

| Duty        | Read it for                                                                                |
| ----------- | ------------------------------------------------------------------------------------------ |
| `translate` | Multi-draft scoring, refusal-vs-ranking, publishing under a marker, per-reply fingerprints |
| `triage`    | The warrant as an allowlist, the guardrail stage, screening before spending                |

Between them they exercise every part of the core. A third duty that needs
something neither of them does is worth a conversation before it is worth a
branch.

---

**Related:** [Duties and the core](../concepts/duties-and-the-core.md) ·
[Architecture](architecture.md) · [Evaluation](evaluation.md) ·
[The reference duty pages](../reference/duties/triage.md)
