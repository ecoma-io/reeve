# The agent runtime — direction, not a shipped feature

_The architecture of the 2.x agent runtime, and the entry point to the 2.x
documentation set. Prerequisites: [North star](../doctrine/north-star.md),
[Architecture](architecture.md), [Threat model](../security/threat-model.md)._

The 2.x direction is documented as a set, and this page is its front door —
the modes, the loop, the kernel, and the invariants. The rest divides by
question:

| Page                                                 | The question it answers                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [The 2.x roadmap](roadmap-2x.md)                     | In what order does this get built, and what does each phase refuse to do yet?         |
| [The governance tree](agent-governance.md)           | What is each `.reeve/` file for, who reviews it, and how does a warrant lift into it? |
| [The compatibility contract](agent-compatibility.md) | What is every 1.x consumer promised, phase by phase and at `2.0`?                     |

The doctrine half — the part that binds this repository rather than merely
describing a plan — lives where doctrine lives:
[the north star's 2.x entry](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships),
which moved first, in its own commit, per that document's own amendment
rule.

> [!IMPORTANT]
> **Nothing on this page ships today.** Reeve today runs seven duties —
> `triage`, `translate`, `duplicate`, `respond`, `lifecycle`, `harmonise`,
> `dependa` — each a fixed
> pipeline of reviewed TypeScript, exactly as described in
> [Architecture](architecture.md).
> There is no agent runtime in this repository's `src/`, no workflow can opt
> into one, and no warrant key turns one on. This page is direction for a
> 2.x line, written down now so that when the work starts, it starts inside
> rails that were decided in the open rather than improvised under a
> deadline. Treat every present-tense sentence below as "this is what it
> will do," not "this is what it does."

## Why write this down before building it

Doctrine does not soften for a feature that is more capable than a duty. If
anything the opposite: the more a piece of software is allowed to decide,
the earlier its limits need to be fixed in writing, because a limit added
after the software already has users is a limit someone has to be talked
into accepting. This page is that fixing, done ahead of the code the way
[D11](../doctrine/north-star.md#d11--every-duty-ships-with-an-evaluation)
already asks every duty's evaluation set to be written ahead of its
implementation.

## Two execution modes, not a replacement

Reeve 2.x does not retire what exists. It adds a second mode alongside it.

**Explicit mode** is every duty as it exists today, and it is preserved
forever: a fixed pipeline, one decision per invocation, wired into a
workflow a maintainer wrote and can read start to finish. A repository that
never wants anything more than `triage` and `translate` running on a
schedule never has to look at the rest of this page. Explicit mode does not
get slower, does not get an opt-out banner, and is not a legacy path kept
around out of politeness — it is the mode most repositories should keep
using, and the direction below does not change that default.

**Agent Mode** is a second, bounded shape for the cases Explicit mode is
structurally the wrong fit for — a backlog that needs several duties applied
in an order that depends on what the first one found, not an order a
workflow file can express as a fixed sequence. Worked example, the shape of
a run: an issue arrives → the agent observes it → searches the backlog →
finds a likely duplicate → asks the kernel for `comment` and `label` →
executes what was granted → verifies both landed → stops. Every step of
that is a duty Reeve already ships, sequenced rather than replaced.

## The loop

Agent Mode runs a loop instead of a pipeline:

```
observe ─► reason ─► plan ─► act ─► verify ─► stop
   ▲                                   │
   └────────────── repeat ─────────────┘
```

A verified step may loop back to observe — state changed, so it is read
again rather than assumed — and every path ends at stop.

**Observe.** Read repository state — the same untrusted zones every duty
already reads: threads, labels, an author's own words. Nothing here is
trusted by virtue of being read in this stage rather than another; the
trust boundary from [Security](../security/security.md#trust-boundaries)
does not move.

**Reason.** Decide what the observed state suggests is worth doing. This is
the model doing what a duty's drafting stage already does — producing a
candidate, not a verdict.

**Plan.** Sequence candidate actions against what the Authority Kernel will
actually allow, before any of them run. A plan is data, exactly the way a
duty's proposed effect is data before the enforcement stage checks it.

**Act.** Execute one step of the plan, restricted to the same category of
effects a duty may already produce — label, comment, edit-body, record,
edit-file, open-pr —
checked against the warrant the same way, in the same code, with no
separate, looser gate for the agentic path.

**Verify.** Check the effect actually happened and matches the plan before
continuing. A step that cannot be verified stops the loop rather than
continuing on an assumption — this is [D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible)
applied to a loop instead of a single pass.

**Stop.** Every loop terminates. There is no standing agent, no background
process, and no session that persists past the job that started it —
Agent Mode still runs as a GitHub Actions job with a start and an end, not
as a service.

## The Authority Kernel

**A repository agent that can decide what to do, but cannot decide what it
is allowed to do.**

That sentence is the whole design. Everything the loop above reasons and
plans is a candidate; the Authority Kernel is the code, wired in the same
place the enforcement stage already sits, that checks every candidate
effect against the warrant before Act is allowed to run it — exactly the
relationship [D2](../doctrine/north-star.md#d2--authority-is-granted-written-and-bounded)
already establishes between a duty and the warrant, extended to a loop that
may propose more than one effect per run instead of one.

The kernel does not get smarter as the model does. A better model produces
a better plan; it does not get a wider warrant. Widening what Agent Mode may
do is always a change to the warrant file, reviewed the way every other
warrant change is reviewed, never a change in what the model decided to ask
for.

The boundary, drawn as the channel it is:

```
GitHub event
     │
     ▼
┌──────────────┐  capability request  ┌──────────────────────┐
│  agent loop  │ ───────────────────► │   Authority Kernel   │
│  (observe,   │                      │  reads the written   │
│   reason,    │ ◄─────────────────── │  grant, and nothing  │
│   plan)      │  grant or refusal    │  a model produced    │
└──────────────┘                      └──────────┬───────────┘
                                                 │ granted effect only
                                                 ▼
                                   GitHub Actions sandbox
                                   (label, comment, edit-body, …)
```

**The capability request is the only channel.** There is no second path
from the loop to the repository — no shell the plan can reach, no API
client the reasoning stage holds, no effect that skips the kernel because
it looked harmless. The boundary is
`agent → capability request → kernel → sandboxed tool`, never
`agent → unrestricted shell or API` — which is the same statement
[Architecture](architecture.md#the-boundary) already makes about a duty
("a duty may not write to the forge"), promoted from a review rule to the
only interface that exists.

### What Agent Mode may do

Bounded by whatever the warrant already grants the duties it is sequencing
— nothing more:

- Read any repository state a duty could already read.
- Propose and, once granted, execute any effect a duty already has a name
  for: `label`, `comment`, `edit-body`, `close`, `assign`, `record`,
  `edit-file`, `open-pr`.
- Sequence more than one such effect within a single run, where Explicit
  mode would need a separate invocation per effect.

### What is permanently forbidden

This is a floor, not a default. No future warrant key, however it is
written, is permitted to grant any of the following — turning one of these
on is not a configuration change Reeve will ever read as valid, the same
way no `apply` value today can make `duplicate` skip its double gate:

- **`code.write` — writing, running, or modifying any code, workflow file,
  or CI configuration in the consumer's repository.** Permanently forbidden.
  See [Non-goals](#non-goals) below.
- Modifying the warrant file itself. An agent cannot grant itself a wider
  warrant; only a human editing `.github/reeve.yml` in a reviewed pull
  request can. Reeve may _draft_ that edit as a pull request — `triage`'s
  `propose` capability does exactly this today — because drafting is not the
  boundary; merging is, and no capability of Reeve's merges one.
- Any network egress beyond `base-url` and the GitHub API — the same egress
  invariant [Security](../security/security.md#egress) already holds duties
  to.
- Reverting a maintainer's own decision — the same invariant 5 in
  [Security](../security/security.md#invariants), unchanged by which mode
  produced the candidate.
- Running with no verify step, or continuing the loop past a step that
  failed to verify.

## GitHub Actions is the sandbox

Agent Mode does not introduce a new place for code to run. It runs as a
GitHub Actions job, on GitHub's own runner, with the same permissions model
every duty already runs inside — a token scoped by the workflow's
`permissions:` block, no ambient credential Reeve provisions for itself, and
no execution surface beyond what an Actions job already has. The sandbox is
not something this project builds; it is something this project inherits
by staying inside the platform duties already run on, which is also why
`code.write` being forbidden is enforceable rather than aspirational — there
is no path from a warrant-checked effect to an arbitrary shell on the
runner.

## Where the grant is written

The file the kernel reads, the `forbidden:` floor that makes widening
authority a loud diff, the rest of the `.reeve/` tree, and the mechanical
lift from today's warrant are all specified — at draft precision, clearly
marked — in [the governance tree](agent-governance.md). One sentence of it
is load-bearing enough to repeat here rather than only link: **of the whole
tree, `authority.yaml` is the only file the kernel reads, and the only file
that grants anything** — everything else is input to judgement, with
exactly the power persuasive prose in a hostile thread has where authority
is concerned: none.

## Doctrine reconciliation

Four places where Agent Mode's shape and existing doctrine could be read as
being in tension. Each is a ruling, settled here, not an open question.

**One authority file, still.** North-star's "one configuration file, ever"
discipline survives as "one _authority_ file." Of the `.reeve/` tree, only
`authority.yaml` is checked in code; `constitution.md`, `policies/` and
`memory/` are inputs to reasoning, not grants of permission, so the
discipline's point — a maintainer can read the whole of what Reeve may do
in one place — holds. And the sequencing is itself governed, and has begun
in the order the amendment rule requires: the north star moved first, in
its own commit —
[its 2.x entry](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships)
records the direction as doctrine — while the `.reeve/` tree itself still
lands only in
[its roadmap phase](roadmap-2x.md#phase-2--the-governance-tree-and-authorityyaml),
behind the kernel it depends on.

**[Open question §10.4](../doctrine/north-star.md#10-open-questions) has
its answer's direction.** "One run, many duties?" is answered by the agent
runtime: an agent-mode run may invoke several duties' capabilities inside
one observe–reason–plan–act cycle. An explicit-mode run remains one duty
per invocation, unchanged. The north star's entry now says the same and
moves the question into [§9](../doctrine/north-star.md#9-settled-questions)
only when the runtime lands — a question is settled by behaviour, not by a
plan agreeing with itself.

**"Not a workflow engine" holds.** The maintainer still writes no DSL.
Agent Mode composes duties that are shipped and reviewed as code — there is
no user-defined step graph, no conditional branching authored by the
maintainer, no orchestration language. What the maintainer writes is what
they already write: a warrant that grants, and a workflow line that invokes.

**[Settled question §9.1](../doctrine/north-star.md#9-settled-questions)
stands, unconditionally.** The authority-bounded invariant — Reeve modifies
repository state only through explicit capabilities — holds in both modes.
Agent Mode's Act stage executes effects a duty already has a name
for; it does not gain a new category of effect by being agentic, and
`code.write` sits permanently on the forbidden floor in
[`authority.yaml`](agent-governance.md#authorityyaml--the-grant) — not a
default that could be widened, a floor that cannot, and
[now doctrine](../doctrine/north-star.md#beyond-10--the-2x-line--direction-nothing-ships)
rather than only this page's ruling.

## Non-goals

**This is not a general-purpose coding agent**, and Agent Mode existing does
not put one on the roadmap. Reeve does a duty and stops
([non-goals, north star §8](../doctrine/north-star.md#8-non-goals)); Agent
Mode sequences duties, it does not become one that writes software.
`code.write` — authoring diffs, running tests, fixing bugs — is not a
capability under design, under discussion, or planned
for a later warrant version — it is excluded from this direction the same
way it is excluded from Reeve today. Repository file mutations through
`edit-file` and `open-pr` are a different boundary, already granted and
enforced today.

**This is not a standing service.** Every run starts, executes a bounded
plan, and stops, inside one GitHub Actions job. There is no memory that
persists outside the files [State](architecture.md#state) already
describes, and no session an agent resumes across runs beyond what a
fingerprint already lets a duty recognise.

**This is not a wider warrant by another name.** A repository that grants
Agent Mode nothing continues to get exactly what Explicit mode already
grants it — the change this direction describes is about sequencing what a
warrant already allows, never about allowing more.

## Compatibility

2.x is an architectural superset of 1.x. Every 1.x workflow keeps working
unmodified, no capability becomes agent-only, and Explicit mode is not
deprecated by Agent Mode's existence — committed to in writing, ahead of
any code that could be tempted to renegotiate it, and made specific enough
to catch a violation in review by
[the compatibility contract](agent-compatibility.md).

## What "landing" will mean

This page is direction, not doctrine, so it can change — and it will be
revised as the phases of [the 2.x roadmap](roadmap-2x.md) actually land, in
the pull requests that land them. User-facing documentation for Agent Mode
appears only once there is a real workflow to run: no installation page, no
reference page, and no guide will describe it before a repository can
actually invoke it — which [the roadmap](roadmap-2x.md#phase-4--agent-mode-acts)
places in its final phase, deliberately.

---

**Related:** [The 2.x roadmap](roadmap-2x.md) ·
[The governance tree](agent-governance.md) ·
[The compatibility contract](agent-compatibility.md) ·
[North star](../doctrine/north-star.md) ·
[Architecture](architecture.md) · [Threat model](../security/threat-model.md) ·
[The authority model](../concepts/authority-model.md)
