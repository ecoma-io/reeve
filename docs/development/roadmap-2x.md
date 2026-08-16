# The 2.x roadmap

_The phases between today's explicit duties and a bounded agent runtime, each
with what it delivers, what it guarantees, and what it deliberately does not
yet do. Prerequisites: [North star](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships),
[The agent runtime](agent-runtime.md)._

> [!IMPORTANT]
> **Nothing past Phase 0 on this page ships today.** This is the plan for the
> 2.x line, written before the code, the same way the
> [north star's roadmap](../doctrine/north-star.md#7-roadmap) was written
> before 1.x's — because a roadmap that only exists once the work is done is
> a changelog wearing a roadmap's name. Phases sequence by dependency, not by
> calendar: each names what must be true before the next begins, and no phase
> carries a date, because a date is a promise about the world and a
> dependency is a promise about the work.

## How to read this page

The 1.x roadmap lives in [the north star §7](../doctrine/north-star.md#7-roadmap)
and the version number is read off it — that rule does not move. This page
begins where that one ends: **`2.0` is read off this list the way `1.0` is
read off that one.** It is not a maturity feeling and not a marketing moment;
it is the release where every phase below is done, checkable against this
file.

Each phase states three things, and a phase missing any of them is not
finished being designed:

- **Delivers** — what exists at the end that did not at the start.
- **Compatibility** — what a consumer pinned to the previous surface is
  promised. Every phase carries one, because
  [the compatibility contract](agent-compatibility.md) is not a 2.0 launch
  document; it is a constraint on every step toward it.
- **Deliberately not yet** — what the phase could plausibly include and
  refuses to, so that scope creep has to argue against a written sentence
  rather than fill a silence.

## Why 1.x is already most of the design

The honest observation this roadmap is built on: **Reeve 1.x already contains
every load-bearing part of the agent architecture, under other names.** The
2.x line is a generalisation, not an invention, and each mapping below is an
argument that the hard trust decisions were already made — made, reviewed,
and dogfooded — in the 1.x line:

| 1.x, shipped today                                                                                                                            | 2.x generalisation                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The warrant — `.github/reeve.yml`, an allowlist checked in code ([D2](../doctrine/north-star.md#d2-authority-is-granted-written-and-bounded)) | `.reeve/authority.yaml` — the same grant, plus a `forbidden:` floor ([the governance tree](agent-governance.md))   |
| A duty — a fixed pipeline invoked by name                                                                                                     | A capability — the same pipeline, invocable by the agent as well as by a workflow line                             |
| A duty's proposed effects, checked by [`src/core/enforce.ts`](../../src/core/enforce.ts) before publish                                       | A capability request, checked by the Authority Kernel — the same module's job, given a name and a boundary         |
| The warrant's `duties:` block, the whole authority, checked in code                                                                           | The kernel's grant resolution — unchanged rule, more callers                                                       |
| Idempotency markers in the thread ([D9](../doctrine/north-star.md#d9-re-running-is-cheap-and-safe))                                           | The Verify stage — a loop step that reads the marker the publish step wrote                                        |
| The corrections store, plain files in the repository ([D6](../doctrine/north-star.md#d6-the-repository-is-the-database))                      | `.reeve/memory/` — the same files, relocated under the governance roof                                             |
| The taxonomy's `not:` fields — a project's own rulings, in prose                                                                              | `.reeve/duties/` — per-duty doctrine, same idea with room to grow                                                  |
| `dry-run`, a rehearsal that withholds every write                                                                                             | Agent Mode's report-only phase — the plan written to the summary, nothing executed                                 |
| The sweep — `sweep`, `since`, `limit` bounding a run over a backlog                                                                           | The Observe stage's enumeration — bounded the same way, for the same reason                                        |
| Weather ([D12](../doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)) — a starved roster delivers what finished       | A loop stop condition — an agent run out of provider delivers what it verified and names the remainder             |
| The job summary — what was decided per item, and what it cost                                                                                 | The plan-and-verify transcript — the same page, now also showing what the kernel refused                           |
| The `lifecycle:` policy — staleness tracks declared in the warrant, run in code against timestamps alone                                      | A scheduled capability — the same declared clocks, ticked by the agent's own loop instead of a cron line           |
| The atlas — a monorepo's own package layout, read as bounded evidence and never authority                                                     | The Observe stage's repository model — the same bounded read, feeding more capabilities than one                   |
| `propose` — drift delivered as one reviewable pull request Reeve can never merge                                                              | The governance tree's self-amendment boundary — `forbidden: [pull_request.merge]`: an agent drafts, a human merges |

Two of these rows carry the whole argument and are worth saying in one line
each. **The warrant is the seed of the Authority Kernel** — not its
inspiration, its ancestor: the kernel is `enforce.ts`'s job description with
more callers, and a consumer who trusts today's warrant check is trusting the
same check tomorrow. **The duties are the capability set** — Agent Mode
composes `triage`, `translate`, `duplicate`, `respond`, `lifecycle`,
`harmonise` and `dependa`; it
does not replace them, and a capability added later is added the way a duty
is added today, by [earning its place](../doctrine/north-star.md#d10--a-duty-must-earn-its-place).

## Phase 0 — the ground · **standing, and finishing**

The phase that is not proposed, because it exists. Named here so the rest of
the page is anchored to something checkable rather than to an idea of 1.x.

**Standing today:** seven duties ship —
[`triage`](../reference/duties/triage.md),
[`translate`](../reference/duties/translate.md),
[`duplicate`](../reference/duties/duplicate.md),
[`respond`](../reference/duties/respond.md),
[`lifecycle`](../reference/duties/lifecycle.md),
[`harmonise`](../reference/duties/harmonise.md) and
[`dependa`](../reference/duties/dependa.md). The first four are dogfooded
on this repository, the last two of those in report-only mode first, which
is the same discipline Phase 3 below borrows; `lifecycle` is the newest and
does not yet have a workflow of its own here.
The warrant is the whole answer for authority, with total enumeration once a
`duties:` block exists
([Stage 3](../doctrine/north-star.md#7-roadmap)). The sweep works a backlog
under `sweep`, `since` and `limit`; weather is not failure, and a
multi-endpoint roster rotates through providers and starves honestly
([D12 and its amendment](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration)).
Memory runs in both directions: corrections recorded as plain files in the
consumer's repository, recalled across the language boundary through the
pivot ([Stage 4](../doctrine/north-star.md#7-roadmap)).

**Finishing before any 2.x phase begins:** the remainder of
[the 1.x roadmap](../doctrine/north-star.md#7-roadmap) — above all
[Stage 6](../doctrine/north-star.md#7-roadmap), the evaluation harness and
the published worst-language number — and then `1.0` itself. The dependency
is not sentimental. Phase 1 below is a refactor whose entire proof of
correctness is "observable behaviour is identical", and that proof is only as
strong as the tests and evaluations it is checked against. Refactoring the
enforcement path before the evaluation stage exists would mean asserting the
most security-sensitive refactor in the project's history against the
thinnest evidence it will ever have. `1.0` first is what makes `2.x` honest.

**Compatibility:** trivially — this phase _is_ the surface everything later
is measured against.

**Deliberately not yet:** everything below. There is no agent code in
`src/`, no `.reeve/` reader, no kernel module. A present-tense sentence
about any of them, anywhere in these docs, is
[direction, not description](agent-runtime.md).

## Phase 1 — the kernel extracted, nothing new granted

The riskiest phase, done first and done cold: the enforcement path —
[`src/core/warrant.ts`](../../src/core/warrant.ts) reading the grant,
[`src/core/enforce.ts`](../../src/core/enforce.ts) checking every intended
effect against it — becomes a named component with a single interface: a
**capability request** in, a grant or a refusal out. Every existing duty's
effects are rerouted through that interface. No behaviour changes; that is
the point, and it is what makes the phase reviewable.

The argument for doing this before anything visible: the kernel is the one
component the whole 2.x line stands on, and a component like that must exist
and be exercised — by every duty, on real threads, through every dogfooded
run this repository already does — before the first line of agent code is
allowed to call it. A kernel born alongside the agent would be tested only by
the agent; a kernel extracted first is tested by the whole standing body of
explicit-mode behaviour that must not change under it.

**Delivers:** the kernel module; the capability-request shape; the five
duties registered as capabilities behind their existing names; the same tests
green before and after, plus new ones pinning the request boundary itself.

**Compatibility:** bit-for-bit. No input added, none removed, no default
moved, no summary line changed. A consumer diffing behaviour across this
phase should find nothing to diff.

**Deliberately not yet:** no `.reeve/` tree, no new grants, no loop. The
kernel refuses everything the warrant refuses and grants everything it
grants — it is a wall moved into position, not a door opened.

## Phase 2 — the governance tree, and `authority.yaml`

The `.reeve/` tree lands, specified in
[the governance tree](agent-governance.md): `authority.yaml` as the 2.x
spelling of the warrant plus the new `forbidden:` floor, `constitution.md`
and `policies/` as prose inputs to judgement that grant nothing,
`duties/` as per-duty doctrine, `memory/` as the corrections store's files
under the same roof. The lift from `.github/reeve.yml` is mechanical and
lossless — every 1.x key has exactly one 2.x spelling, documented on that
page — and it is **unforced**: the 1.x warrant keeps working, unchanged,
indefinitely. A repository with both files does not get a precedence rule;
it gets a red run naming both, because two files that can disagree about
authority is a configuration error, not a tie to break quietly
([D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible)).

This phase depends on Phase 1 because `authority.yaml` is read by the
kernel, and on the north star's amendment rule structurally: the doctrine
half of this direction moved into
[the north star](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships)
first, in its own commit, before this page could describe the tree as more
than a sketch.

**Delivers:** the tree reader; the `authority.yaml` schema and its
validation, refused-not-dropped like the warrant's
([D2](../doctrine/north-star.md#d2--authority-is-granted-written-and-bounded));
the `forbidden:` floor enforced in code; the documented, mechanical warrant
lift; the both-files-is-an-error check.

**Compatibility:** a repository that never creates `.reeve/` sees no change
at all. The warrant is not deprecated, does not warn, and reads exactly as
before. Explicit-mode duties honour `authority.yaml` where present the same
way they honour the warrant — same grants, new spelling, plus a floor that
can only narrow.

**Deliberately not yet:** no loop. `authority.yaml` at this phase governs the
same explicit runs the warrant governs. Shipping the grant surface one full
phase before the thing it will eventually bound means the file format gets
real-world review while the blast radius is still 1.x-shaped.

## Phase 3 — the loop, with its hands withheld

Agent Mode ships report-only: the full
observe → reason → plan → act → verify loop
([the agent runtime](agent-runtime.md)), with Act producing capability
requests that are checked by the kernel, recorded on the job summary — and
**not executed**. The summary shows what the agent observed, what it planned,
what the kernel would have granted, and what it refused and why.

This is not caution theatre; it is the discipline this repository has
already used twice. `duplicate` and `respond` both ran report-only on this
repository's own threads before either was allowed to write, and both
designs changed because of what those runs showed. An agent loop is strictly
more in need of that evidence, because its failure mode is not one wrong
comment — it is a wrong plan, executed competently.

**Delivers:** the loop runtime; the plan format; the Verify stage reading the
idempotency markers publish already writes; the plan-and-refusal transcript
on the summary; the agent's own evaluation set, written before the loop acts,
per [D11](../doctrine/north-star.md#d11--every-duty-ships-with-an-evaluation).

**Compatibility:** opt-in by a new workflow line; every existing workflow is
untouched. A repository that adds the agent workflow in this phase risks
exactly nothing written.

**Deliberately not yet:** no writes, from any path, under any input. The
acting loop is a release, not a flag, so that the decision to let it act is
made by this roadmap's gate and not by a workflow typo.

## Phase 4 — Agent Mode acts

The Act stage executes granted capability requests, one step at a time, each
verified before the next: effect performed, marker read back, plan and
outcome compared. A step that cannot be verified stops the loop
([D5, applied to a loop](agent-runtime.md#the-loop)); a starved roster
delivers what it verified and names the remainder
([D12](../doctrine/north-star.md#d12--capacity-is-weather-authority-is-configuration));
every run terminates — there is no standing agent, only a job with an end.

The gate into this phase is evidence, not appetite: the Phase 3 transcript
corpus from this repository's own dogfooding, and the agent evaluation from
Phase 3 showing plans that would have been correct — measured, per
[D11](../doctrine/north-star.md#d11--every-duty-ships-with-an-evaluation),
in the languages this project claims, not eyeballed in one.

**Delivers:** the acting loop; per-run budget bounds (steps and requests,
sitting on the workflow like every other operational knob, per
[the warrant/input line](../doctrine/north-star.md#3-the-ladder)); the full
transcript including executed effects; user-facing documentation for Agent
Mode, which per [the incumbent commitment](agent-runtime.md#what-landing-will-mean)
appears only now, when a repository can actually invoke it.

**Compatibility:** the superset guarantee in full, checkable at last:
no capability agent-only, explicit workflows unchanged, and everything
[the compatibility contract](agent-compatibility.md) commits to.

**Deliberately not yet — and not ever:** `code.write`, in any phase,
including this one. The floor is
[permanent](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships),
and Phase 4 completing does not begin an argument about it.

## Then `2.0`

Every phase above done, the agent's numbers published the way
[Stage 6](../doctrine/north-star.md#7-roadmap) publishes the duties', and the
2.x surface — kernel, tree, loop — under the same promise `1.0` put the
duties under. Nothing else is waiting on it, and nothing on this page is
waiting on a date.

---

**Related:** [The agent runtime](agent-runtime.md) ·
[The governance tree](agent-governance.md) ·
[The compatibility contract](agent-compatibility.md) ·
[North star](../doctrine/north-star.md)
