# Evaluation

How a duty proves it works, why the headline number is the worst language, and
what a bad number is allowed to do to a release.

## Why this document exists at all

Almost nothing in this category publishes a number. Tools in adjacent spaces ship
accuracy claims with no method, or no claim at all, and a maintainer deciding
whether to install one is left with a demo and a feeling.

[D11](../north-star.md#d11--every-duty-ships-with-an-evaluation) makes that a
release blocker rather than a nice-to-have: **a duty ships with a way to measure
it, or it does not ship.**

The measurement being _public_ is most of the value. A number nobody outside the
project can reproduce is a marketing claim wearing a decimal point.

## The rule that shapes everything

**The headline number for a duty is its worst configured language, never the
average.**

A duty that scores 0.91 on English fixtures and 0.62 on Vietnamese ones reports
**0.62**.

The reason is not fairness in the abstract. An average hides exactly the failure
this project exists to prevent, and it hides it _more_ the more English-dominant
the fixture set is — so the metric would improve as the problem got worse. A
worst-language headline cannot be gamed by adding English cases.

Two consequences a contributor will feel:

- **A fixture set in one language does not count.** Two languages that use
  different writing systems is the floor; three is better, and one of them should
  share a script with another (`en` and `vi`) so the hard detection path is
  exercised.
- **An improvement that helps English and not Vietnamese moves the headline
  number by zero.** That is working as intended.

## What gets measured

### `triage`

A confusion matrix over your own taxonomy, per language.

| Number              | Means                                                      | Why it matters                                  |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| **Precision**       | Of the labels applied, how many were right                 | A wrong label is a maintainer's click, spent    |
| **Recall**          | Of the labels that should have been applied, how many were | A missed label is triage that did not happen    |
| **Refusal rate**    | How often the confidence floor stopped a correct verdict   | The cost of your `confidence` setting, in cases |
| **Confusion pairs** | Which two labels get swapped                               | This is what a `not` field is written against   |

The confusion matrix is the artefact worth having, not the headline number. It
tells a maintainer _which_ `not` to write, and it is the reason
[the warrant page](../usage/warrant.md#not-is-where-the-accuracy-is) tells people
to measure before they guess.

Precision and recall trade against each other through `confidence`, which is why
the number is published as a curve rather than a point. A project that would
rather label less and be right picks a different point on it than one drowning in
a backlog.

### `translate`

Prose cannot be scored the way a label can. What can be measured is everything
around it, and those are the failures that actually hurt:

| Number               | Means                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Code fidelity**    | Fenced blocks and inline spans carried across byte-for-byte                 |
| **Link fidelity**    | URLs unchanged                                                              |
| **Structure**        | Heading and list structure preserved                                        |
| **Leak rate**        | Drafts containing script from a language neither the source nor target uses |
| **Passthrough rate** | Drafts that returned the source unchanged                                   |
| **Refusal rate**     | Drafts thrown out before ranking, by reason                                 |

A `docker run` line with a translated flag is a command that silently does
something else, which is why code fidelity is weighted heaviest in scoring and
measured first here.

**Translation quality itself is not claimed.** It is _contained_ — the original is
kept, marked as the version the project answers for, and never replaced. Stating
that plainly is more useful than a BLEU score nobody can act on.

## Where it lives

In this repository, under `eval/`, in two halves worth keeping apart:

- **The fixtures** — `eval/fixtures/<duty>/`. Real threads, in several
  languages, each with the answer a maintainer would have given. Committed.
- **The harness** — `eval/`, run as `pnpm eval <duty>`. It runs a duty over the
  fixtures and produces the numbers.

Both are under the `eval` commit scope. Neither ships in the bundle a consumer
runs: they are development tooling, and putting them in `dist` would make every
consumer download the fixture set.

This is [settled](../north-star.md#8-settled-questions) — it was previously an
open question whether evaluation belonged in a repository of its own. It does
not. **Reeve stands on its own**, and a fixture set that lives elsewhere gets
updated on a different schedule than the duty it measures, at which point it
measures the wrong thing.

## Building a fixture set

**Use real threads.** Synthetic issues are written by someone who knows what
answer they want, and they are uniformly easier than the real thing. Pull them
from public repositories, keep the URL, and record who decided the expected
answer.

**Include the cases that should produce nothing.** An empty template, spam, a
thread already handled. A fixture set of only interesting cases measures a duty
on inputs it will rarely see, and it cannot catch a duty that lost its ability to
stay quiet.

**Write the same case in two languages where you can.** The pair is the most
valuable fixture there is: identical content, different language, and any gap
between the two results is the bug this project cares about most. It is also the
only way to measure cross-language duplicate detection when `duplicate` arrives.

**Record the expected answer, not the observed one.** A fixture whose expectation
was copied from a passing run measures nothing.

**Keep it small enough to run.** A few hundred threads is more than enough to
find a regression, and small enough that a contributor will actually run it.

## Running it

`pnpm eval` needs a provider, which means it needs a key or a keyless endpoint,
which means **it does not run in CI on a pull request.** A fork's PR has no
secrets, and a required check that cannot pass on a fork is a check that closes
the project to contributors.

So:

| When                          | What runs                                                              |
| ----------------------------- | ---------------------------------------------------------------------- |
| Every pull request            | Unit and integration tests, against fakes. No provider, no cost.       |
| Deliberately, by a maintainer | `pnpm eval <duty>` against a real provider, with the numbers recorded. |
| Before a duty's release       | `pnpm eval <duty>`, and the numbers go in the release notes.           |

The numbers are committed alongside the fixture set, so a change to a prompt shows
up as a diff in the results rather than as a claim in a pull request description.

## What a bad number does

**It blocks the release.** That is the entire point of D11 being doctrine rather
than a habit.

A duty whose worst-language number falls below what the previous release
published does not ship, and the options are: fix it, narrow the duty's scope
until the number is honest, or withdraw the duty. Publishing the lower number and
shipping anyway is not one of the options — a number that never blocks anything
is decoration.

**A duty can be withdrawn.** [D10](../north-star.md#d10--a-duty-must-earn-its-place)
cuts both ways: a duty that cannot be measured to work is a duty that has not
earned its place, whatever it looked like in a demo.

## For a consumer measuring their own taxonomy

The numbers this project publishes are about Reeve. They say nothing about whether
your taxonomy is any good, and a taxonomy with two overlapping labels will produce
bad results with a perfect duty.

The tooling is the same and the method is:

1. Take a hundred already-triaged threads from your own repository.
2. Run `triage` with `dry-run: true`.
3. Compare `proposed` against the labels a maintainer actually applied.
4. Read the confusion pairs, and write a `not` for the top one.
5. Repeat.

That loop is worth more than any `confidence` value copied from a document. It is
also the only way to pick one honestly:
[the input's default](../usage/duties/triage.md#inputs) is a starting point, not
a recommendation.
