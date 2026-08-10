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
maintainer's behalf, inside an authority the maintainer wrote down, and never
past it.**

Each job it does is a **duty**. Two exist today, inherited from the projects
Reeve consolidates:

| Duty        | Was       | Does                                                                 |
| ----------- | --------- | -------------------------------------------------------------------- |
| `translate` | Dragoman  | Puts every issue and pull request in the languages the project reads. |
| `triage`    | Winnow    | Sorts the backlog against a taxonomy the project wrote.               |

They are not two products that happen to share a repository. They are two duties
of one office, and they were always the same machine: an OpenAI-compatible
client with model fallback, several drafts filtered by deterministic scoring, a
sanitiser that assumes the thread is hostile, an allowlist checked in code, and
state kept as plain files in the user's own repository.

## 2. The end state

> A maintainer adds one file and one workflow. From then on, the recurring work
> of the project — the sorting, the translating, the answering-for-the-fourth-time,
> the noticing that a doc no longer matches the code — is done, continuously, by
> something whose authority they can read in full on one screen and revoke with
> one line.

Three things have to be true for that to count as reached:

1. **Adding the second duty is cheaper than the first.** The core is the
   product; a duty is a few hundred lines against it. If duty number six needs
   its own client, its own retry logic, its own sanitiser, the consolidation
   failed and Reeve is a monorepo of unrelated bots.
2. **A maintainer can state what Reeve may do without reading the source.** The
   warrant file is the whole answer. Not the docs, not the prompt, not the
   release notes.
3. **Turning it off leaves nothing behind but files.** No account to close, no
   service to migrate off, no data held anywhere the project cannot delete with
   `rm`.

## 3. Doctrine

These are load-bearing. Every one of them is a thing a competing tool does not
do, and each one costs us something real — that is how you can tell they are
doctrine and not preferences.

### D1 — Authority is granted, written, and bounded

Reeve does what the warrant names and nothing else. The check is in code,
against the file — never against the model's own claim about what it was
permitted to do. An unnamed label is not applied. An unnamed duty does not run.

_Costs us:_ every capability needs a warrant surface designed before it ships.

### D2 — The human's work is inviolable

Reeve adds; it does not overrule. It never rewrites a body someone wrote, never
removes a label a person applied, never reopens or reassigns or closes what a
maintainer decided. Where machine output and human text sit together, the human
text is kept byte-for-byte and marked as the version the project is answerable
for.

_Costs us:_ the tidy-the-backlog features that demo best are the ones we refuse.

### D3 — The work is priced before it is done

Most of a backlog is decided by code, or by a small model, for approximately
nothing. Only what survives screening reaches an expensive model. The cost of
reading an item well enough to act on it must not be paid uniformly across
every item — that uniform price is the reason maintainers stop.

_Costs us:_ every duty must be expressible as tiers, not as one big prompt.

### D4 — Failure is loud; it is never plausible

Model output that does not parse yields **no** verdict and a red run — not a
best-effort read of the parts that looked fine, because the shapes that fail to
parse are the ones an injection produced. A run that could not do its job never
reports an empty result in green, because that is indistinguishable from "there
was nothing to do."

_Costs us:_ red runs on other people's repositories, which look bad and are
correct.

### D5 — The repository is the database

Taxonomy, corrections, warrant, markers, memory — plain files, in the user's
repository, reviewed in a pull request like everything else. Reeve has no
hosted state, no account, no dashboard that knows something the repository does
not.

_Costs us:_ anything that genuinely needs cross-repository state is out of reach
until we can express it as files.

### D6 — Any endpoint, including the free ones

OpenAI-compatible is the only integration surface. Model fallback and
multi-draft scoring exist so that individually weak, operationally flaky, free
models are a **supported** configuration rather than a tolerated one: three
cheap attempts filtered deterministically cost calls instead of money.

_Costs us:_ no provider-specific feature — no structured-output API, no
fine-tuning, no caching primitive — may become load-bearing.

### D7 — Every thread is hostile

Input arrives from the internet, addressed to a process holding a write token.
Untrusted text is contained before it is published, and containment is a
property of the code path, not an instruction in a prompt. The allowlist is the
boundary; the prompt is a hint.

_Costs us:_ features that require trusting thread content are not built.

### D8 — Re-running is cheap and safe

A duty recognises its own previous output and stops. A no-op run costs one API
read. Backfilling several hundred threads is therefore affordable, and that is
what makes adoption possible at all — a tool you cannot safely re-run is a tool
you can only try on a repository you do not care about.

_Costs us:_ every duty needs an idempotency marker designed alongside it.

### D9 — A duty must earn its place

A candidate duty ships only if it is work that (a) recurs, (b) is uniformly
priced today, and (c) a maintainer has already stopped doing. Work that is
occasional, or cheap, or that a maintainer enjoys, is not Reeve's.

_Costs us:_ most feature requests.

### D10 — Every duty ships with an evaluation

A duty whose quality is claimed rather than measured is a duty we cannot change
without fear. Prompt and pipeline changes are judged against a fixed set with a
paired baseline, not against the last thing someone eyeballed.

_Costs us:_ a duty is not done when it works; it is done when it is measured.

## 4. Shape

```
reeve/
├── src/core/      the machine: provider + fallback, draft/score/judge,
│                  sanitiser, warrant loader + allowlist, forge client,
│                  repo-state store, idempotency markers, dry-run, failure
│                  semantics
├── src/duties/
│   ├── translate/
│   └── triage/
├── translate/action.yml      thin per-duty action contracts
└── triage/action.yml
```

GitHub resolves actions in subdirectories, so consolidation does not cost
callers their ergonomics:

```yaml
- uses: ecoma-io/reeve/translate@v1
- uses: ecoma-io/reeve/triage@v1
```

One repository, one core, one version line — and no duty carrying inputs that
mean nothing to it.

## 5. Roadmap

Stages, not dates. Each one names the thing that has to be true before the next
begins.

### Stage 0 — Consolidate

Both duties running off one core, at parity with Dragoman `v0.2` and Winnow's
shipped contract. Old repositories archived pointing here; their existing tags
keep working forever, because tags are immutable and nobody should be broken by
our reorganisation.

**Done when:** `translate` and `triage` share provider, sanitiser, allowlist and
state layers, and `v1` is published.

### Stage 1 — The warrant

One `.github/reeve.yml` declaring which duties are enabled and what each may do.
Today's per-duty inputs collapse into it; workflow YAML stops being where
authority is expressed.

**Done when:** a maintainer can answer "what may this thing do to my repo?" by
reading one file, and D1's check reads that file.

### Stage 2 — Memory

Winnow's correction store, generalised: any duty can retrieve the last few times
a human corrected this kind of case, from files committed to the repository. An
empty store works on the first run and works better on the hundredth.

**Done when:** memory is a core service, not a triage feature.

### Stage 3 — More duties

Each candidate passes D9 and ships with D10. The queue, in rough order of how
badly maintainers want it: duplicate detection, first response, staleness,
release notes, doc drift.

**Done when:** a duty is a few hundred lines and a week, not a project.

### Stage 4 — Scheduled upkeep

Reeve stops being purely event-driven. A scheduled sweep works the backlog that
already exists under the same warrant, with the same idempotency — because the
repositories that need this most are the ones with four thousand open issues,
none of which will ever fire an `opened` event again.

**Done when:** a backfill over a large tracker is routine and affordable.

## 6. Non-goals

Stated so that "why doesn't it..." has an answer that is not a shrug.

- **Not a hosted service.** No account, no dashboard, no data of yours anywhere
  we control. (D5)
- **Not a chatbot.** Reeve does not hold a conversation in your thread. It does
  a duty and stops.
- **Not a workflow engine.** It will not grow a DSL for arbitrary steps. Duties
  are written in TypeScript and reviewed.
- **Not a closer.** Closing, locking, and deleting stay off by default,
  permanently. (D2)
- **Not provider-differentiated.** No feature exists that only works on one
  vendor's endpoint. (D6)

## 7. Open questions

These are unresolved on purpose. Each one changes the shape of Stage 3 and
beyond, and guessing now would be worse than deciding later with evidence.

1. **Does Reeve ever write code?** Dependency PR triage is clearly a duty.
   Actually authoring the bump is a different kind of act — it puts Reeve in the
   position of proposing a diff, which D2 permits (proposing is not overruling)
   but which needs a warrant surface nobody has designed. Undecided.
2. **Does the core stay GitHub-shaped?** A forge abstraction is cheap now and
   expensive later, but it is also the classic premature generalisation. What
   would GitLab or Gitea support actually cost, and is anyone asking?
3. **Who reviews the memory?** Corrections committed to the repository are
   inputs to future decisions. That makes them a supply-chain surface, and it is
   not obvious whether they should be reviewed as code or trusted as data.
4. **One run, many duties?** Several duties firing on the same event means
   several checkouts and several model bills. Batching is obvious and couples
   duties that are currently independent.
5. **What is the relationship to the evaluation tooling in this
   organisation?** [`touchstone`][touchstone] and [`heuristic`][heuristic]
   already exist to prove agent behaviour with paired baselines. D10 either
   reuses them or duplicates them; it should not do both.

[touchstone]: https://github.com/ecoma-io/touchstone
[heuristic]: https://github.com/ecoma-io/heuristic
