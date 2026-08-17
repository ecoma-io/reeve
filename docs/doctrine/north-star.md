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

| Duty          | Status | Does                                                                                                                                                                                                                                   |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`      | ships  | Sorts the backlog against a taxonomy the project wrote.                                                                                                                                                                                |
| `translate`   | ships  | Puts every issue and pull request in the languages the project reads.                                                                                                                                                                  |
| `duplicate`   | ships  | Finds the thread that already asked this — across the language it was asked in.                                                                                                                                                        |
| `respond`     | ships  | Gives a stranger a first, useful reply in the language they wrote to us in.                                                                                                                                                            |
| `lifecycle`   | ships  | Runs the staleness policy the project wrote — from timestamps and labels alone.                                                                                                                                                        |
| `harmonise`   | ships  | Synchronises documentation across languages and formats.                                                                                                                                                                               |
| `dependa`     | ships  | Maintains dependencies — discovers updates, assesses risk, opens reviewable PRs.                                                                                                                                                       |
| `review`      | ships  | Reviews a pull request — deterministic pre-checks plus one or more model passes by profile, with model findings verified against deterministic evidence before they are reported, kept as one owned comment across synchronize events. |
| `remediation` | ships  | Derives deterministic remediation proposals for the review's standing findings — proposal-only, never written to the repository.                                                                                                       |

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

## 3. The ladder

Reeve is not something you either install or don't. Everyone who wires an
`uses:` line into a workflow starts at the same place, and what happens next is
**exactly as much as they wrote down** — nothing more, and nothing that has to
be guessed at. Picture it as a ladder rather than a switch: each rung is more
of the warrant, never a different mode, and a maintainer climbs it only when
the rung below stopped being enough.

**Level 0 — zero config.** One `uses:` line, a provider, and nothing else. No
`.github/reeve.yml` at all. An absent warrant is not an absent restriction — it
is the narrowest one Reeve knows how to grant, enumerated in code: `triage` may
only `label`, against a taxonomy it did not have to be told, because it is the
labels the repository already has and the descriptions its own maintainers
already wrote for them in GitHub's own UI — data that exists before Reeve is
ever installed, so nobody types anything twice to get a sorted backlog on day
one. `translate` may only `edit-body`. Nothing else runs.

**Level 1 — the taxonomy.** The maintainer writes `.github/reeve.yml` and puts
the boundary between two labels into words a stranger's report can be checked
against — `description`, `not`, `examples`. Sorting gets sharply better,
because the confusion a general model was making was never about
intelligence; it was about a decision the project made that nothing in a
model's training could know. **A taxonomy-only warrant — labels and nothing
else — is a complete, legitimate Level 1 configuration, not a half-finished
one.** Every duty keeps its own narrow default capability, exactly as it did
at level 0: writing the file changes what gets decided, not what is allowed to
act. Nothing about authority moves until a maintainer says so explicitly,
which is the next rung, not this one.

**Level 2 — tuning authority.** Per-duty `duties:`, a label's `owner:`,
its `exclusive_with:`, and — since [Stage 3](#7-roadmap) landed —
`languages:`, all move into the warrant, reviewed the same way the taxonomy
is. **The
`duties:` block is where enumeration starts, and once it exists it is
total:** a duty the block does not name is granted nothing at all — not its
old default, not a smaller version of it. It runs, decides nothing, and says
so in its own summary, rather than silently keeping the authority it held
before the block was written. Writing `duties:` is therefore not
additive to a taxonomy-only warrant; from the moment that key exists, every
duty's authority is read out of it, and a duty a maintainer forgot to list
there is a duty switched off, whether or not that was the intention. This is
where a maintainer turns on the capability that was cheapest-but-not-safest by
default, having watched a `dry-run` say what the rate actually is first.

**Level 3 — the full office.** Sweep and backfill, memory's write path, and
the `duplicate`, `respond` and `review` duties. The sweep's own switches —
`sweep`, `since`, `limit` — are workflow inputs, not warrant keys, exactly as
§3's closing paragraph draws that line; they sit at this rung because a
scheduled sweep multiplies whatever the warrant already grants across a whole
backlog, not because turning them on grants anything by itself.
Every one of these is opt-in, and every one sits at the top rung on purpose:
they are the inputs and the duties that touch the most — a correction
committed to the repository, a sweep across the whole backlog, an answer sent
to a stranger — so they are the ones a maintainer reaches for last,
deliberately, never by accident.

**The discipline that keeps this from becoming knob soup is itself doctrine,
not a style preference: every new setting lives in the warrant; every absent
setting means today's behaviour; a "level" is not a mode.** It is simply how
much of the warrant a maintainer has written. There is no `mode: basic` or
`mode: full` anywhere in this design, and there will not be a second
configuration file sitting next to this one, ever — one file, read the same
way at every level, is what makes climbing the ladder something a `git diff`
can show a reviewer, rather than something a support thread has to explain.

This reshapes how [D2](#d2--authority-is-granted-written-and-bounded) reads: a
`duties:` block, once written, is not an optional tightening of a duty's
own defaults — it is the entire surface for what any duty may do — and the
absence of that block, whether because there is no file at all or because the
file stops at a taxonomy, is itself a stated, narrow authority rather than an
unstated wide one.

**The warrant and an input answer different questions, and confusing them
undoes the ladder.** The warrant is authority: what a duty is permitted to do
_to the repository_ — which label, which comment, which close, which write.
It is reviewed the way code is, because it grants power, and it is the one
file [D2](#d2--authority-is-granted-written-and-bounded) makes the whole
answer once a `duties:` block exists. An input on the workflow is not
that. It is how a duty already holding its authority is asked to operate —
how many threads a sweep considers, how long one request is allowed to run,
which endpoint carries a model, how much of a body gets read before it is
translated. None of those grant a duty anything it did not already have; they
shape the _how_ of work the warrant already permitted, and a maintainer
narrows or loosens them the same way they would any other step input, in the
workflow file, without a warrant review. This is why `endpoints`,
`api-keys`, `request-timeout`, `temperature`, `max-body-chars` and `limit`
live on the workflow rather than in `.github/reeve.yml`: none of them answer
"what may Reeve touch," and putting an operational knob in the warrant would
train a reviewer to read authority into a line that was never a permission.
The test is not whether a setting sounds important — a timeout can break a
run and a label cannot — it is whether turning it up changes what gets
**written to the repository or said to somebody**. Only that question belongs
in the warrant.

## 4. Where this sits

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

## 5. Doctrine

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
permitted to do. An unnamed label is not applied. A duty enumerated out of an
existing `duties:` block is granted nothing.

**Absence, silence, and enumeration are three different questions, and they
get three different answers.** No warrant file at all is read as the
narrowest authority Reeve defines in code — [level 0 of the
ladder](#3-the-ladder): `triage` may only `label`, against the repository's
own existing labels, and `translate` may only `edit-body`. A warrant that
exists but carries no `duties:` block leaves every duty on that same
narrow default — a taxonomy written to sharpen a verdict is not a claim about
who may act, and a taxonomy-only file is a complete, working [level
1](#3-the-ladder) configuration in its own right, not a half-finished [level
2](#3-the-ladder) one. Only once a `duties:` block exists does
enumeration become total: a duty the block does not name is granted nothing —
not its old default, not a smaller version of it — because **once a
maintainer begins enumerating who may act, the enumeration is the whole
answer, and the file's mere existence is not.** Writing the first entry into
`duties:` therefore does not add to what a taxonomy-only warrant already
granted; from that point on every duty's authority is read out of the block,
and a duty left out of it is a duty switched off, whether or not that was the
intention.

Where a platform or an established specification already expresses this, Reeve
speaks that vocabulary rather than shipping a rival one. Being one more
incompatible policy format helps nobody.

_Costs us:_ every capability needs a warrant surface designed before it ships,
and we inherit other people's vocabulary instead of designing our own.

### D3 — The human's work is inviolable

Reeve adds; it does not overrule. It never rewrites a body someone wrote, never
removes a label a person applied — with one bounded exception: a label the
warrant itself names as a lifecycle track's clock-hand is declared, by that
naming, to be machine-managed state, and `lifecycle` may remove exactly those
labels, only in the direction of un-staling, and only when its own actor is
the one who applied it last. It never reopens or reassigns or closes what a
maintainer decided. Where machine output and human text sit together, the human
text is kept byte-for-byte and marked as the version the project is answerable
for.

This holds even against Reeve's own past decision. A human who reopens a thread
Reeve closed as a duplicate, or removes a label Reeve applied, has just done the
same kind of work this doctrine already protects — and triage's enforce stage
refuses in code, not only in a prompt, to re-close a thread against a reversal
already on record: whatever a model proposes next, a human's reversal of
Reeve's own prior action is itself inviolable. See
[triage's own reference page](../reference/duties/triage.md#configuration)
for the mechanism.

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

### D12 — Capacity is weather, authority is configuration

A 429, a 5xx, or a timeout is weather: it says nothing about whether Reeve was
ever allowed near the repository, only that a provider could not serve this
particular request right now. A run that meets one rotates to the next model
on the list, and when every model on the list is exhausted, it does not fail —
it **delivers what it finished**, states exactly what remains in its outputs,
and ends in a warning, never red. The repositories Reeve most wants to serve
run on free, IP-rate-limited providers, where a 429 is nobody's fault, clears
on nobody's schedule, and will not clear again inside the same run no matter
how long the job waits for it. [The sweep](#7-roadmap) is what comes back for
whatever the weather left undone.

A 401 or a 403 is a different fact about the world, and gets the opposite
answer: it is **configuration**, not conditions, and it fails the run red,
immediately, on the first model that reports it. Waiting on a wrong key is
waiting forever — no amount of rotation or scheduling repairs a credential
that was never going to work — and a green run over a broken key is not a
successful run. It is a repository silently never served at all, which is a
worse outcome than a loud one.

**A model is never retried within one run**, whichever kind of failure it
reported. That is already doctrine ahead of this entry, and it still holds
here: a provider's capacity does not clear inside a single job, and a runner
minute spent finding that out twice is a runner minute somebody is paying for.

_Costs us:_ every provider error has to be classified correctly at the one
place it is received, because a 429 misread as configuration fails a run that
would have finished on the next scheduled sweep, and a 401 misread as weather
runs a repository's whole queue against a key that will never work.

**Amendment — many endpoints changes when "immediately" fires, not what
counts as configuration.** A run with more than one `endpoints` roster
configured is not one credential; it is several relationships with several
providers, and a wrong key on one endpoint says nothing about the key on
another. Failing the whole run red the moment the first endpoint's 401 or 403
arrives would punish rotation for exactly the case rotation exists to
survive: a stranger's free tier misconfigured, a paid key rotated at the
wrong time, one endpoint down while the rest are fine. So once more than one
endpoint is configured, an auth failure is recorded rather than thrown
immediately — the run keeps going, and every other endpoint is still tried —
and the run fails red only once **every** configured endpoint has ended up
auth-failed, checked once at the end of the run rather than on the first
miss. A single-endpoint run is unchanged by this: one endpoint auth-failing
is every endpoint auth-failing, so the original immediate failure still
fires, on the first model that reports it, exactly as before.

_Costs us:_ a run that would have failed fast on a single bad key now runs as
long as its slowest endpoint's rotation before it can say so, and every
duty's summary has to name which endpoints failed, not just that the run
did.

## 6. Shape

```
reeve/
├── src/core/      the machine: provider + fallback, draft/score/judge,
│                  the language layer, sanitiser, warrant loader + allowlist,
│                  forge client, repo-state store, idempotency markers,
│                  dry-run, failure semantics
├── src/duties/
│   ├── translate/
│   ├── triage/
│   ├── duplicate/
│   ├── respond/
│   ├── lifecycle/
│   ├── harmonise/
│   ├── dependa/
│   └── review/
├── translate/action.yml      thin per-duty action contracts
├── triage/action.yml
├── duplicate/action.yml
├── respond/action.yml
├── lifecycle/action.yml
├── harmonise/action.yml
├── dependa/action.yml
└── review/action.yml
```

GitHub resolves actions in subdirectories, so consolidation does not cost
callers their ergonomics:

```yaml
- uses: ecoma-io/reeve/translate@v0.6
- uses: ecoma-io/reeve/triage@v0.6
```

One repository, one core, one version line — and no duty carrying inputs that
mean nothing to it.

Architecture is documented for contributors in
[`development/`](../development/README.md); the configuration surface is documented
for users in [the documentation index](../README.md).

## 7. Roadmap

Stages, not dates. Each one names the thing that has to be true before the next
begins, and each says what of it already stands — because a roadmap that only
lists what is missing is one nobody can check.

**The version number is read off this list.** `0.x` is every release before the
list is finished: usable, dogfooded, and free to break its own input surface
between minors. `1.0` is the release where every stage below is done and every
number this document promises has been published. It is not a maturity feeling
and not a marketing moment — it is a state this file can be checked against.
[Releasing](../development/releasing.md) has what that means for a pin.

### Stage 0 — One core, two duties · **landed**

`translate` and `triage` running off one core rather than two codebases.

**Was done when:** both duties share the provider, the sanitiser, the allowlist
and the state layer. They do: one client with model rotation, one nonce
boundary, one warrant reader, one summary. Each ships from its own directory
with its own `action.yml`, and this repository runs both on its own threads.

### Stage 1 — The bottom rung · **landed**

Zero config became real. No `.github/reeve.yml` stopped being an error and
became [level 0 of the ladder](#3-the-ladder) — the narrowest authority Reeve
knows how to grant, enumerated in code rather than left to a duty's own
defaults: `triage` may only `label`, against a taxonomy built from the
repository's own labels and the descriptions their own maintainers already
wrote for them on GitHub. `translate` may only `edit-body`.

**Was done when:** a repository with no `.github/reeve.yml` gets its backlog
sorted against its own labels by adding two lines of workflow — one
`uses: ecoma-io/reeve/triage@v0.6`, a provider, and nothing else. It does: an
absent warrant file builds the implicit taxonomy from the repository's own
labels and their descriptions over the API, and caps capabilities at `label`
and `edit-body` with nothing configurable about either.

### Stage 2 — Weather, and the sweep · **landed**

[D12](#d12--capacity-is-weather-authority-is-configuration) stopped being a
paragraph and became behaviour: a 429, a 5xx or a timeout rotates to the next
model and, when the list runs out, delivers what finished and warns naming the
remainder, rather than failing red over conditions nobody configured. A 401 or
a 403 still fails red immediately — that half never changed. Every duty gained
`sweep:`, `since:` and `limit:` so a scheduled run can work through open
threads instead of one, bounded to what a run is willing to pay for, and a
thread it already handled is skipped for free the same way a re-run of one
thread already was.

**Was done when:** a four-thousand-issue backlog on a keyless provider
finishes over scheduled runs without a single red run and without a single
duplicated action. It does: the roster a sweep starves against is shared
run-wide across every thread it processes, so a `Weather` object exhausted on
thread one stops thread two from spending a call rather than retrying the
same dead end; `since` bounds by creation date, never by update, so a sweep's
own labelling or translating cannot push its own bound forward under it; and
[`.github/workflows/reeve-sweep.yml`](../../.github/workflows/reeve-sweep.yml)
runs both duties on a weekly schedule against this repository's own backlog,
the same dogfooding the per-thread workflows already did for Stage 0.

### Stage 3 — The warrant is the whole answer · **landed**

One `.github/reeve.yml` declaring the taxonomy and, once a maintainer writes a
`duties:` block, what each duty may do. Per [the
ladder](#3-the-ladder) and the corrected
[D2](#d2--authority-is-granted-written-and-bounded), the whole-answer
principle attaches to that block, not to the file's mere existence: a
taxonomy-only warrant leaves every duty on its own default, and a
`duties:` block, once written, grants a duty left out of it nothing at
all. `translate` now reads the file exactly as `triage` always has, and
`languages:` moved in alongside the taxonomy — landing as a breaking change on
a `0.x` minor, per
[what that means here](../development/releasing.md#what-0x-and-10-mean-here).

**Standing:** the file is parsed, the taxonomy is an allowlist checked in code
against the parsed file, and capabilities are granted per duty — from the
warrant alone. No action input grants a capability, and the workflow's `when`
is the only say it has over what a run does; the warrant is the whole
authority. Once a `duties:` block is written, enumeration is total —
a duty the block does not name is granted nothing at all, not its old
default, and says so in its own run report rather than guessing at a reason;
a taxonomy-only warrant, or no warrant at all, leaves every duty on its own
default exactly as [the ladder](#3-the-ladder) describes, which is the gap
this stage closed. `languages:`, once written in the file, is the whole
answer for what `translate` produces and what `triage` detects against; when
the file stays silent on it, each duty's own documented default answers, and
a run says once, by name, which of the two it read.
Detection itself — the free script-narrowing and profile steps that resolve
an author's language before any duty asks for it — was already core state
before this stage and did not have to change
([the language layer](../development/language.md)).

### Stage 4 — Memory, both directions

Any duty can retrieve the last few times a human corrected this kind of case,
from files committed to the repository, and — new at this stage — can write
one back. Recording a correction is a commit, needs `contents: write`, and is
an explicit, top-rung capability for exactly that reason. Retrieval starts
crossing the language boundary, using [the pivot](#9-settled-questions) rather
than staying lexical.

**Standing:** retrieval is a core service rather than one duty's feature, ranks
lexically for nothing in the ordinary case — no provider, no request — and an
empty store is the cold start rather than an error. Writing ships behind
`record`, a top-rung capability that needs `contents: write` for the reason
above: a labelled or unlabelled event from a human commits that thread's
taxonomy-filtered current labels to the store, through the Contents API and
with no checkout, replacing any earlier entry for the same thread rather than
piling up duplicates. Retrieval crosses the language boundary using [the
pivot](#9-settled-questions): a correction recorded in another language is
translated into the store's pivot language and kept alongside the original,
and a query in a third language is translated the same way before the two
renderings are ranked and merged — spending no extra request at all when the
thread and the store already share one language.

**Done when:** a correction a maintainer made on an English thread changes the
verdict on the Vietnamese one describing the same thing.

### Stage 5 — The duties only a multilingual project needs

`duplicate`, then `respond`. Both top-rung, both off by default, both the
proof of the whole thesis: finding that an issue in Vietnamese is the one
already answered in English is something no competitor can do, because
everything else in this category matches within a language. `respond` closes
the loop by answering the stranger in their own words.

**No longer blocked.** [The pivot](#9-settled-questions) is decided —
translation to the project's working language, then the same lexical ranking
already used within one language — so what used to hold this stage open is
settled rather than outstanding.

**Standing:** `duplicate` has landed — see
[the duty's own page](../reference/duties/duplicate.md). It ranks the open backlog
against the thread in front of it with the same BM25 [memory](#9-settled-questions)
retrieval already runs on, bridges the query through the pivot only when the
corpus actually holds a candidate the thread's own language would not reach,
and asks a judge to confirm or refuse the top candidates against the exact
shortlist it was shown — an answer naming anything outside that shortlist is
refused the same as one that failed to parse. Off by default on purpose:
posting the one comment it may ever write needs `duplicate: [comment]` in the
warrant's `duties:` block, because a wrong duplicate is
a claim about somebody else's report, not a label one click undoes. `respond`
has landed too — see [the duty's own page](../reference/duties/respond.md). It
writes the first reply itself, once, in the thread's own language, and never
speaks over a human or its own earlier marker; `DEFAULT_CAPABILITIES` for it
is empty, so nothing short of an explicit `respond: [comment]` in the warrant
ever lets it post.

**Done when:** a project can point at a thread that was found, matched and
answered across a language boundary with no human reading both.

### Stage 5b — Repository maintenance · **landed**

`lifecycle`, `harmonise`, and `dependa` — three duties that maintain the
repository itself rather than its threads. `lifecycle` runs a staleness policy
from timestamps and labels alone, calling no model. `harmonise` synchronises
documentation across languages, writing translated files through the `edit-file`
and `open-pr` capabilities the warrant must grant. `dependa` maintains
dependencies — discovers available updates, assesses risk from deterministic
facts and optional model interpretation, and opens reviewable PRs, again through
explicit capabilities.

The authority model is unchanged: `harmonise` and `dependa` both default to
empty capabilities at level 0, and both require an explicit grant of `edit-file`
and `open-pr` in the warrant before they write anything. This is the same
enforcement that every other duty passes through; the file-mutation duties do not
get a second, weaker path.

**Standing:** all three have landed — see each duty's own reference page:
[`lifecycle`](../reference/duties/lifecycle.md),
[`harmonise`](../reference/duties/harmonise.md),
[`dependa`](../reference/duties/dependa.md).
`dependa` supports five ecosystems (npm, GitHub Actions, Cargo, Go, Docker) and
groups updates by policy rules written in the warrant's `dependa:` key. External
metadata — changelogs, release notes, registry responses — is treated as
evidence, never as authority, and is enclosed before it reaches any model.

**Done when:** a maintainer can point at a dependency update PR that was
discovered, assessed, and opened entirely by Reeve, within the authority the
warrant granted.

### Stage 5c — Pull request review · **landed**

`review` — the useful half of what a review bot does, without the part that
makes review bots noise. It answers a pull request with exactly one comment,
idempotent under its marker, that tracks its findings across `synchronize`
events instead of reposting them — `created`, `persists`, `changed`, `resolved`
and `reopened`, the same ladder a human review leaves — and it never becomes a
coding agent. Like `duplicate` and `respond` before it, `review` is granted
nothing by default: `DEFAULT_CAPABILITIES` is empty, so nothing short of an
explicit `review: [comment]` in the warrant ever lets it write. Deterministic
pre-checks (an ignore list, generated-file suffixes, blocked phrases, and the
repository's own named rules) fire before any model is asked, the model's
findings are admitted only when the diff can prove them, and a truncated or
unparseable answer is discarded rather than read best-effort.

**Standing:** landed — see [the duty's own page](../reference/duties/review.md).
The comment renders the repository's rules and the diff, never edits code,
and the machine-written notice is unconditional.

**Done when:** a maintainer can point at a pull request that was reviewed once
— findings tracked, not reposted — within the authority the warrant granted,
with the review comment visibly written by a model.

### Stage 6 — The number

A small paired-fixture evaluation, committed here: the same case written in two
languages, a few dozen pairs rather than a few hundred singles, measuring the
worst-language gap directly instead of inferring it from two separate
averages. `pnpm eval <duty>`, fixtures committed, results committed — the one
number the whole thesis rests on, published from this repository and
reproducible by anyone who clones it.

**Committed and CI-gated:** the fixture set and harness live in `eval/` —
`eval/harness.ts` plus 30 `.expected.json` fixtures across `triage`, `respond`
and `harmonise` — and CI runs `pnpm eval all` on every push, so the
fail-closed contract is exercised rather than this number resting on a
hand-run.

**Done when:** the worst-language number is published and reproducible from
this repository.

### Then `1.0`

Every stage above done, the numbers published, and the input surface frozen
under semver's promise — issue maintenance, documentation synchronisation,
and dependency maintenance all landing under one authority model.
Nothing else is waiting on it.

### Beyond `1.0` — the 2.x line · **direction, nothing ships**

None of this paragraph is behaviour. It is recorded here, ahead of any code,
because this file's own first rule demands it: a 2.x line that changed what
Reeve is allowed to become would be a change this document has to make first,
in the open, with the argument written down — not one discovered in a diff.
The full treatment lives in
[the 2.x roadmap](../development/roadmap-2x.md) and
[the agent runtime](../development/agent-runtime.md); what belongs _here_ is
the part that is doctrine rather than design.

**Reeve 2.x adds a second execution mode, not a second product.** Explicit
mode — a duty invoked by name from a workflow line, deciding one thing and
stopping — is preserved forever, unchanged, undeprecated. Agent Mode is a
bounded loop that observes repository state, decides which of the duties the
warrant already grants are worth running, runs them, and verifies the result
before continuing or stopping. The relationship is a superset: no capability
becomes agent-only, no explicit workflow changes meaning, and a repository
that never opts in never notices
([the compatibility contract](../development/agent-compatibility.md)).

**The principle that governs it: autonomy is not authority.** A repository
agent that can decide what to do, but cannot decide what it is allowed to do.
The half being added is judgement about _which_ granted thing to do next; the
half that stays exactly where [D2](#d2--authority-is-granted-written-and-bounded)
put it is what is granted at all. The Authority Kernel — the component that
checks every candidate effect against the written grant before it runs — is
not a new idea needing new trust: it is the warrant's own enforcement stage,
the direct descendant of the check that already runs in code against the
parsed file, extended to a loop that may propose several effects per run
instead of one. A better model produces a better plan; it never produces a
wider warrant.

**[Settled question §9.1](#91--does-reeve-modify-repository-state-only-within-explicit-authority) stands in both
modes, unconditionally.** The authority-bounded invariant — Reeve modifies
repository state only through explicit capabilities granted in the warrant —
holds regardless of execution mode. No warrant key, no authority file, and no
future version of this roadmap may grant a capability that bypasses the
enforcement stage. An agent that sequences duties does not thereby become one
that can widen its own authority, and the moment that sentence needs weakening
is the moment this section has failed and must be argued down in its own commit,
like everything else in this file.

## 8. Non-goals

Stated so that "why doesn't it..." has an answer that is not a shrug.

- **Not a coding agent.** Reeve does not author diffs, run
  tests, or fix bugs. It modifies repository files only through explicit
  capabilities granted in the warrant. See §9.1.
- **Not a hosted service.** No account, no dashboard, no data of yours anywhere
  we control. (D6)
- **Not a chatbot.** Reeve does not hold a conversation in your thread. It does
  a duty and stops.
- **Not a workflow engine.** It will not grow a DSL for arbitrary steps. Duties
  are written in TypeScript and reviewed.
- **Not a closer.** Closing, locking, and deleting stay off by default,
  permanently. (D3)
- **Not a self-amending authority.** Reeve proposes warrant changes only by
  pull request, and no capability merges one. (D2, D3)
- **Not provider-differentiated.** No feature exists that only works on one
  vendor's endpoint. (D7)
- **Not a policy standard.** The warrant is a configuration file, not a
  specification we are asking anyone else to adopt. (D2)

## 9. Settled questions

Recorded with the reasoning, because a decision without its argument gets
relitigated every six months.

### 9.1 — Does Reeve modify repository state? Only within explicit authority.

Reeve does not grant itself authority. Reeve does not treat model output as
permission. Reeve modifies repository state only through explicit capabilities
(`edit-file`, `open-pr`) that a maintainer granted in the warrant, and every
mutation passes through deterministic enforcement before it reaches the
repository. Dependency updates are reviewable proposals; model output is
evidence, never permission; and no run can widen its own grant.

This replaces an earlier boundary that said "Reeve does not write code." The
older line was simpler but incomplete: `harmonise` already writes documentation
files, and `dependa` writes dependency manifests. The invariant that actually
holds — and that the enforcement code checks — is not about what _kind_ of file
is modified, but about whether the modification was authorised. A capability
granted for `edit-file` does not care whether the file is Markdown or TOML; it
cares that the warrant said yes. That is the stronger boundary, because it
covers every file mutation the same way, with no special case for code versus
non-code.

### 9.2 — Does Reeve define its own policy format? No.

Enough repository-agent policy vocabularies exist, including the platform's own.
The warrant is Reeve's configuration; where an established allowlist exists,
Reeve emits to it. Adding one more incompatible format would cost real work and
win nothing.

### 9.3 — Where does evaluation live? In this repository.

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

### 9.4 — Does cross-language comparison use embeddings? No — a pivot language and lexical ranking.

Matching a Vietnamese report against an English one — for memory recall, and
for `duplicate` — uses **translation to a pivot language, the project's own
working language, followed by the same lexical ranking that already runs
within one language.** Not multilingual embeddings.

The argument is availability, not accuracy. Pivot-and-rank runs on every
OpenAI-compatible `/chat/completions` endpoint, keyless ones included, because
it needs nothing an ordinary chat completion does not already give it. An
embeddings approach needs an `/embeddings` endpoint, and that is precisely
what the cheapest, keyless, IP-rate-limited providers are least likely to
serve — which would make cross-language memory and `duplicate`, the flagship
proof of [D1](#d1--no-duty-is-english-only), the one feature a free-tier
project cannot have. That contradicts
[the non-goal](#8-non-goals) against anything provider-differentiated
([D7](#d7--any-endpoint-including-the-free-ones)) as surely as if it called a
vendor's proprietary API directly.

**This sits behind the existing retrieval seam, not in front of it:** a better
representation can replace pivot-and-rank later without a format break,
because nothing downstream of retrieval knows how the ranking was produced,
only what it returned.

## 10. Open questions

Unresolved on purpose. Each changes the shape of the roadmap's later stages,
and guessing now would be worse than deciding later with evidence.

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
   duties that are currently independent. _An answer now has a direction, not
   yet code: [the 2.x line](#beyond-10--the-2x-line--direction-nothing-ships)
   sequences several duties' capabilities inside one agent-mode run, while an
   explicit-mode run stays one duty per invocation. This question closes into
   [§9](#9-settled-questions) when that lands, not before._

[gh-aw]: https://github.github.com/gh-aw/
