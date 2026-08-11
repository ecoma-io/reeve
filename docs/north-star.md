# North star

This document is the one the others answer to. It records what Reeve is for,
what it is never allowed to become, and the order the work happens in.

It is not a vision statement kept somewhere warm and ignored. A change that
contradicts this file is not merged until this file changes first, in its own
commit, with the argument written down. If the argument is good, the doctrine
was wrong and should move. If nobody can make the argument, the change was the
thing that was wrong.

---

## 1. What Reeve is

A reeve was the officer who ran an estate on the owner's behalf — the day-to-day
work, done without asking, inside an authority the owner had granted and could
withdraw. The owner stayed the owner.

**Reeve is the automation that keeps a repository's recurring work moving on the
maintainer's behalf — in whatever language the person on the other end wrote in
— inside an authority the maintainer wrote down, and never past it.**

Each job it does is a **duty**. Duties are not separate products sharing a
repository. They are jobs of one office, running on one machine: an
OpenAI-compatible client with model fallback, several drafts filtered by
deterministic scoring, a language layer that knows who wrote in what and who
reads in what, a sanitiser that assumes the thread is hostile, an allowlist
checked in code, and state kept as plain files in the user's own repository.

| Duty        | Status                | Does                                                                            |
| ----------- | --------------------- | ------------------------------------------------------------------------------- |
| `triage`    | ships                 | Sorts the backlog against a taxonomy the project wrote.                         |
| `translate` | ships                 | Puts every issue and pull request in the languages the project reads.           |
| `duplicate` | [Stage 4](#6-roadmap) | Finds the thread that already asked this — across the language it was asked in. |
| `respond`   | [Stage 4](#6-roadmap) | Gives a stranger a first, useful reply in the language they wrote to us in.     |

## 2. The end state

> A project is as easy to contribute to in Vietnamese, Japanese or Portuguese as
> it is in English — and no harder to maintain for it. A stranger opens an issue
> in their own language; it is understood, sorted, checked against everything
> already reported, and answered — in their language — while the maintainer
> reads all of it in theirs. Neither person had to accommodate the other, and
> neither had to trust anybody's server for it to happen.

Four things have to be true for that to count as reached:

1. **No duty is English-only.** A duty that works on an English tracker and
   degrades on a Vietnamese one has not shipped. This is the one condition that
   distinguishes Reeve from everything else in its category, and it is checked
   by evaluation, not by intention.
2. **Adding the second duty is cheaper than the first.** The core is the
   product; a duty is a few hundred lines against it. If duty number six needs
   its own client, its own retry logic, its own sanitiser, the consolidation
   failed and Reeve is a monorepo of unrelated bots.
3. **A maintainer can state what Reeve may do without reading the source.** The
   warrant file is the whole answer. Not the docs, not the prompt, not the
   release notes.
4. **Turning it off leaves nothing behind but files.** No account to close, no
   service to migrate off, no data held anywhere the project cannot delete with
   `rm`.

## 3. Where this sits

Doctrine invented in a closed room is preference with better formatting. This
section records what was true in the field when the doctrine was set, so that a
future reader can tell which parts were reasoned and which parts have expired.

**The boundary is table stakes, not a differentiator.** GitHub's own agentic
workflows ship [`safe-outputs`][gh-aw] — a declared allowlist of side effects,
enforced at runtime before the API call — and `min-integrity`, which filters
what an agent is even allowed to _see_ by the trust tier of whoever wrote it.
Independent policy-as-code specifications for repository agents exist in
numbers. Reeve's warrant is therefore correct and unremarkable: it is a
condition of being allowed near a repository, not a reason to choose one tool.

**Cost is not the pitch either.** The largest incumbent in maintainer
automation runs across tens of thousands of projects and is free, without
limits, for open source. An argument that begins "it is cheaper" loses to zero.

**The language axis is unoccupied.** Every serious competitor is English-first,
and the largest of them documents the gap itself: response quality varies by
language, and non-English projects see lower accuracy. The translation tools
that do exist post a comment underneath and stop; none of them carry language
through to sorting, to deduplication, or to a first reply. This is the gap
Reeve exists to close.

**Almost nobody measures.** The category sells on demonstration. An
organisation that already builds evaluation harnesses can afford to sell on
numbers instead, and should.

Three consequences, and they are load-bearing below: **interoperate on the
boundary rather than compete on it**; **do not argue about price**; **treat
language as the product, not as a feature of one duty**.

## 4. Doctrine

These are load-bearing. Each one costs us something real — that is how you can
tell they are doctrine and not preferences.

### D1 — No duty is English-only

Every duty operates across the language boundary or it does not ship. A duty
reads what the author actually wrote, decides in a way that does not depend on
the author having written in English, and explains itself to each reader in the
language that reader uses. Language is a core service every duty consumes, never
a duty of its own that the others ignore.

_Costs us:_ every duty's evaluation set has to cover more than one language,
every prompt has to survive translation, and duties that would be easy in one
language do not ship until they are honest in several.

### D2 — Authority is granted, written, and bounded

Reeve does what the warrant names and nothing else. The check is in code,
against the file — never against the model's own claim about what it was
permitted to do. An unnamed label is not applied. An unnamed duty does not run.

Where a platform or an established specification already expresses this, Reeve
speaks that vocabulary rather than shipping a rival one. Being one more
incompatible policy format helps nobody.

_Costs us:_ every capability needs a warrant surface designed before it ships,
and we inherit other people's vocabulary instead of designing our own.

### D3 — The human's work is inviolable

Reeve adds; it does not overrule. It never rewrites a body someone wrote, never
removes a label a person applied, never reopens or reassigns or closes what a
maintainer decided. Where machine output and human text sit together, the human
text is kept byte-for-byte and marked as the version the project is answerable
for.

_Costs us:_ the tidy-the-backlog features that demo best are the ones we refuse.

### D4 — The work is priced before it is done

Most of a backlog is decided by code, or by a small model, for approximately
nothing. Only what survives screening reaches an expensive model. The cost of
reading an item well enough to act on it must not be paid uniformly across every
item — that uniform price is the reason maintainers stop.

_Costs us:_ every duty must be expressible as tiers, not as one big prompt.

### D5 — Failure is loud; it is never plausible

Model output that does not parse yields **no** verdict and a red run — not a
best-effort read of the parts that looked fine, because the shapes that fail to
parse are the ones an injection produced. A run that could not do its job never
reports an empty result in green, because that is indistinguishable from "there
was nothing to do."

_Costs us:_ red runs on other people's repositories, which look bad and are
correct.

### D6 — The repository is the database

Taxonomy, corrections, warrant, markers, memory — plain files, in the user's
repository, reviewed in a pull request like everything else. Reeve has no hosted
state, no account, no dashboard that knows something the repository does not.

_Costs us:_ anything that genuinely needs cross-repository state is out of reach
until we can express it as files.

### D7 — Any endpoint, including the free ones

OpenAI-compatible is the only integration surface. Model fallback and
multi-draft scoring exist so that individually weak, operationally flaky, free
models are a **supported** configuration rather than a tolerated one: three
cheap attempts filtered deterministically cost calls instead of money.

_Costs us:_ no provider-specific feature — no structured-output API, no
fine-tuning, no caching primitive — may become load-bearing.

### D8 — Every thread is hostile

Input arrives from the internet, addressed to a process holding a write token.
Untrusted text is contained before it is published, and containment is a
property of the code path, not an instruction in a prompt. Text from a stranger
does not enter a decision at the same weight as text from someone the project
has already merged. The allowlist is the boundary; the prompt is a hint.

_Costs us:_ features that require trusting thread content are not built.

### D9 — Re-running is cheap and safe

A duty recognises its own previous output and stops. A no-op run costs one API
read. Backfilling several hundred threads is therefore affordable, and that is
what makes adoption possible at all — a tool you cannot safely re-run is a tool
you can only try on a repository you do not care about.

_Costs us:_ every duty needs an idempotency marker designed alongside it.

### D10 — A duty must earn its place

A candidate duty ships only if it is work that (a) recurs, (b) is uniformly
priced today, (c) a maintainer has already stopped doing, and (d) is harder on a
project whose contributors do not share a language. Work that is occasional, or
cheap, or that a maintainer enjoys, is not Reeve's. Work that is equally easy in
a monolingual project belongs to somebody else's tool.

_Costs us:_ most feature requests.

### D11 — Every duty ships with an evaluation

A duty whose quality is claimed rather than measured is a duty we cannot change
without fear. Prompt and pipeline changes are judged against a fixed set with a
paired baseline, not against the last thing someone eyeballed. Because of D1,
that fixed set is multilingual, and a duty's headline number is its worst
language, not its average.

_Costs us:_ a duty is not done when it works; it is done when it is measured, in
every language it claims.

## 5. Shape

```
reeve/
├── src/core/      the machine: provider + fallback, draft/score/judge,
│                  the language layer, sanitiser, warrant loader + allowlist,
│                  forge client, repo-state store, idempotency markers,
│                  dry-run, failure semantics
├── src/duties/
│   ├── translate/
│   └── triage/
├── translate/action.yml      thin per-duty action contracts
└── triage/action.yml
```

GitHub resolves actions in subdirectories, so consolidation does not cost
callers their ergonomics:

```yaml
- uses: ecoma-io/reeve/translate@v0.1
- uses: ecoma-io/reeve/triage@v0.1
```

One repository, one core, one version line — and no duty carrying inputs that
mean nothing to it.

Architecture is documented for contributors in
[`development/`](development/README.md); the configuration surface is documented
for users in [`usage/`](usage/README.md).

## 6. Roadmap

Stages, not dates. Each one names the thing that has to be true before the next
begins, and each says what of it already stands — because a roadmap that only
lists what is missing is one nobody can check.

**The version number is read off this list.** `0.x` is every release before the
list is finished: usable, dogfooded, and free to break its own input surface
between minors. `1.0` is the release where every stage below is done and every
number this document promises has been published. It is not a maturity feeling
and not a marketing moment — it is a state this file can be checked against.
[Releasing](development/releasing.md) has what that means for a pin.

### Stage 0 — One core, two duties · **landed**

`translate` and `triage` running off one core rather than two codebases.

**Was done when:** both duties share the provider, the sanitiser, the allowlist
and the state layer. They do: one client with model rotation, one nonce
boundary, one warrant reader, one summary. Each ships from its own directory
with its own `action.yml`, and this repository runs both on its own threads.

### Stage 1 — The language layer, and the number that proves it

Language stops being something `translate` does and becomes something the core
knows: the language the author wrote in, the language the project works in, the
languages its maintainers read. Every duty receives all three and is judged on
whether its decision survives the author not writing in English.

**Standing:** detection is the core's, it runs on the prose residue, it is free
before it is paid for, and `unknown` is a real answer rather than a default. A
verdict is told what it is reading, and the taxonomy is never translated.

**Missing:** the three roles as core state — today a duty is handed one
`languages` input and infers the rest. And the evaluation: there is no fixture
set and no harness in this repository, so every accuracy claim on these pages is
currently unbacked.

**Done when:** `triage`'s worst-language number is published, and anyone can
reproduce it from this repository.

### Stage 2 — The warrant is the whole answer

One `.github/reeve.yml` declaring which duties are enabled and what each may do.
Today's per-duty inputs collapse into it; workflow YAML stops being where
authority is expressed. Where the platform has its own allowlist vocabulary,
Reeve emits to it rather than around it.

**Standing:** the file is parsed, the taxonomy is an allowlist checked in code
against the parsed file, capabilities are granted per duty, and the narrower of
the file and the workflow wins. `triage` takes its authority from nowhere else.

**Missing:** `translate` does not read the file at all. The languages belong in
it and are not there. And a duty the file does not name still runs on its own
defaults, where D2 says an unnamed duty does not run — the code and the doctrine
disagree, and the doctrine is right.

**Done when:** a maintainer can answer "what may this thing do to my repo?" by
reading one file, and no duty takes authority from workflow YAML.

### Stage 3 — Memory

Any duty can retrieve the last few times a human corrected this kind of case,
from files committed to the repository. An empty store works on the first run
and works better on the hundredth. Corrections are stored in the language they
were made in and retrieved across languages.

**Standing:** retrieval is a core service rather than one duty's feature, ranks
lexically for nothing, and an empty store is the cold start rather than an
error.

**Missing:** nothing writes to the store — recording a correction is a commit
and needs `contents: write`. And the retrieval is lexical, so it matches within
one language, which is the half that makes memory worth having here.

**Done when:** a correction a maintainer made on an English thread changes the
verdict on the Vietnamese one describing the same thing.

### Stage 4 — The duties only a multilingual project needs

`duplicate` and `respond`. These are the proof of the whole thesis: finding that
an issue in Vietnamese is the one already answered in English is something no
competitor can do, because they match within a language. `respond` closes the
loop by answering the stranger in their own words.

Blocked on open question 1 in [the language layer](development/language.md#open)
— cross-language comparison needs a common representation, and which one is not
yet decided.

**Done when:** a project can point at a thread that was found, matched and
answered without any human reading either language.

### Stage 5 — Scheduled upkeep

Reeve stops being purely event-driven. A scheduled sweep works the backlog that
already exists under the same warrant, with the same idempotency — because the
repositories that need this most are the ones with four thousand open issues,
none of which will ever fire an `opened` event again.

A ceiling per sweep is part of the stage rather than a later refinement: four
thousand issues is four thousand requests unless something says otherwise, and
discovering that in a bill is not a supported experience.

**Done when:** a backfill over a large tracker is routine and affordable.

### Then `1.0`

Every stage above done, the numbers published, and the input surface frozen
under semver's promise. Nothing else is waiting on it.

## 7. Non-goals

Stated so that "why doesn't it..." has an answer that is not a shrug.

- **Not a coding agent.** Reeve reads and decides. It does not author diffs, run
  tests, or fix bugs. See §8.1.
- **Not a hosted service.** No account, no dashboard, no data of yours anywhere
  we control. (D6)
- **Not a chatbot.** Reeve does not hold a conversation in your thread. It does
  a duty and stops.
- **Not a workflow engine.** It will not grow a DSL for arbitrary steps. Duties
  are written in TypeScript and reviewed.
- **Not a closer.** Closing, locking, and deleting stay off by default,
  permanently. (D3)
- **Not provider-differentiated.** No feature exists that only works on one
  vendor's endpoint. (D7)
- **Not a policy standard.** The warrant is a configuration file, not a
  specification we are asking anyone else to adopt. (D2)

## 8. Settled questions

Recorded with the reasoning, because a decision without its argument gets
relitigated every six months.

### 8.1 — Does Reeve ever write code? No.

Authoring a diff needs a checkout, a sandbox, and a test run to be worth
anything, and every one of those contradicts the shape Reeve chose. It is also
the most crowded and best-funded part of the field. Reeve stays in the half of
maintenance that is reading and deciding — which is the half where language is
the hard problem, and therefore the half where Reeve has an argument.

### 8.2 — Does Reeve define its own policy format? No.

Enough repository-agent policy vocabularies exist, including the platform's own.
The warrant is Reeve's configuration; where an established allowlist exists,
Reeve emits to it. Adding one more incompatible format would cost real work and
win nothing.

### 8.3 — Where does evaluation live? In this repository.

The fixtures and the harness are committed here, under the `eval` commit scope,
and neither ships in the bundle a consumer downloads.

This reverses an earlier answer, and the argument that moved it is worth
keeping. Evaluation that lives in another repository is updated on a different
schedule than the duty it measures, and the gap between the two is invisible: a
prompt changes here, the fixture set does not, and the number keeps being
published as though it still meant something. Reeve also has to stand on its
own — a measurement that depends on a repository this one does not contain is a
measurement a contributor cannot run and a reader cannot reproduce.

The self-grading risk that argued for keeping it elsewhere is real and is
answered differently: the fixtures are real threads from public repositories
with their URLs kept, the expected answer is the one a maintainer actually gave,
and the results are committed so a change to a prompt shows up as a diff rather
than as a claim in a pull request description.

## 9. Open questions

Unresolved on purpose. Each changes the shape of Stage 4 and beyond, and
guessing now would be worse than deciding later with evidence.

1. **Does the core stay GitHub-shaped?** A forge abstraction is cheap now and
   expensive later, but it is also the classic premature generalisation. What
   would GitLab or Gitea support actually cost, and is anyone asking?
2. **What is "the project's language" when maintainers do not share one?** The
   two-pole model — author's language, project's language — is a simplification
   that a project with maintainers in three countries will break.
3. **Who reviews the memory?** Corrections committed to the repository are
   inputs to future decisions. That makes them a supply-chain surface, and it is
   not obvious whether they should be reviewed as code or trusted as data.
4. **One run, many duties?** Several duties firing on the same event means
   several checkouts and several model bills. Batching is obvious and couples
   duties that are currently independent.

[gh-aw]: https://github.github.com/gh-aw/
