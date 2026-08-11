# The agent runtime — direction, not a shipped feature

_Where a bounded agent runtime is headed for Reeve 2.x, and the ground rules it will be built against. Prerequisites: [North star](../doctrine/north-star.md), [Architecture](architecture.md), [Threat model](../security/threat-model.md)._

> [!IMPORTANT]
> **Nothing on this page ships today.** Reeve today runs exactly four duties —
> `triage`, `translate`, `duplicate`, `respond` — each a fixed pipeline of
> reviewed TypeScript, exactly as described in [Architecture](architecture.md).
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
workflow file can express as a fixed sequence. It runs a loop instead of a
pipeline:

```
observe ─► reason ─► plan ─► act ─► verify ─► stop
```

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
effects a duty may already produce — label, comment, edit-body, record —
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

### What Agent Mode may do

Bounded by whatever the warrant already grants the duties it is sequencing
— nothing more:

- Read any repository state a duty could already read.
- Propose and, once granted, execute any effect a duty already has a name
  for: `label`, `comment`, `edit-body`, `close`, `assign`, `record`.
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
  request can.
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

## Doctrine reconciliation

Four places where Agent Mode's shape and existing doctrine could be read as
being in tension. Each is settled here, not left open.

**Reconciling [D2](../doctrine/north-star.md#d2--authority-is-granted-written-and-bounded)
with a loop that "decides what to do."** D2 governs effects, not reasoning.
An agent may reason about anything it observes; it may never treat its own
reasoning as a grant. The Authority Kernel is D2 restated for a
multi-step run instead of a single decision, and it is checked in the same
code path — there is no separate, agent-flavoured enforcement stage that
could drift from the one duties already use.

**Reconciling [D5](../doctrine/north-star.md#d5--failure-is-loud-it-is-never-plausible)
with a loop that could otherwise retry or replan silently.** A verify
failure stops the loop and reports red or a loud warning, the same as a
duty's unparseable answer does today — it is never treated as a cue to
try a different plan without a human seeing that the first one failed.
Retrying inside a loop only ever means "the next scheduled run," never "the
same job, quietly, with a different plan."

**Reconciling [D8](../doctrine/north-star.md#d8--every-thread-is-hostile)
with an Observe stage that reads more of the repository than one thread at
a time.** Reading more does not mean trusting more. Every zone Observe
reads is exactly as untrusted as it is when a single duty reads it, framed
as data the same way, contained by the same code path rather than by an
instruction in a prompt — D8 does not have a "reasonable exception" for
volume.

**Reconciling [Reeve does not write code](../doctrine/north-star.md#9-settled-questions)
with an Act stage capable of executing a plan.** The settled answer does not
change: Reeve does not write code, in either mode. Agent Mode's Act stage
executes effects a duty already has a name for; it does not gain a new
category of effect by being agentic, and `code.write` is not a capability
this design leaves room to add later — see Non-goals.

## Non-goals

**This is not a general-purpose coding agent**, and Agent Mode existing does
not put one on the roadmap. Reeve does a duty and stops
([non-goals, north star §8](../doctrine/north-star.md#8-non-goals)); Agent
Mode sequences duties, it does not become one that writes software.
`code.write` is not a capability under design, under discussion, or planned
for a later warrant version — it is excluded from this direction the same
way it is excluded from Reeve today.

**This is not a standing service.** Every run starts, executes a bounded
plan, and stops, inside one GitHub Actions job. There is no memory that
persists outside the files [State](architecture.md#state) already
describes, and no session an agent resumes across runs beyond what a
fingerprint already lets a duty recognise.

**This is not a wider warrant by another name.** A repository that grants
Agent Mode nothing continues to get exactly what Explicit mode already
grants it — the change this direction describes is about sequencing what a
warrant already allows, never about allowing more.

---

**Related:** [North star](../doctrine/north-star.md) ·
[Architecture](architecture.md) · [Threat model](../security/threat-model.md) ·
[The authority model](../concepts/authority-model.md)
