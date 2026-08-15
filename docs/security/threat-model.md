# Threat model

_The shape of what Reeve defends against, and why the defences are structured the way they are. Prerequisites: [Architecture](../development/architecture.md) — or "None," for the shape alone._

Every deployment of Reeve is the same shape, and it is not a comfortable one:
it holds a write token on somebody's repository, its input is written by
strangers, its reasoning is done by a model that can be instructed by that
input, and its output is written back into the repository the token belongs
to. The interesting question is never "does it work" — it is what Reeve does
when the model does what an attacker asked instead of what a maintainer
asked.

This page is the shape of the answer. [Security](security.md) is the
mechanism, stage by stage, invariant by invariant — read it for what is
actually checked in code. This page is for the reasoning that sits above
that: which doctrine commits Reeve to which posture, and why the posture
does not depend on any one defence working.

## Every thread is hostile

[D8](../doctrine/north-star.md#d8-every-thread-is-hostile) is the starting
assumption, not a conclusion reached after an incident: input from a stranger
does not enter a decision at the same weight as input from someone the
project has already merged, and untrusted text is contained by the code
path rather than by an instruction inside a prompt. A model reading a thread
is reading something written by someone who may be trying to make it do
something else. Nothing downstream is allowed to assume otherwise, including
on a repository that has never seen an attempt.

## The allowlist, not the transcript, is authority

The single idea the rest of the design defends is this: **authority is a
file, and the model's output is a claim about the world, never a grant of
permission over it.** A model can be persuaded that its instructions
changed, that a maintainer authorised something, that it is being tested.
None of that is checked against, because nothing downstream ever asks the
model what it is allowed to do — it asks the warrant, in code, against the
parsed file. An injection that fully succeeds — the model returns exactly
the label or the close the attacker wanted — still has to pass the same
enforcement stage a legitimate verdict does, and the same defanging a
legitimate verdict's stray `@mention` would.

That is why the prompt-boundary defences in [Security](security.md#prompt-injection)
— the per-call nonce, the untrusted-data framing — are described there as
reducing how often a model is fooled, not as the property that makes fooling
it safe. They are quality work. The warrant is the security property.

## Failure is loud, never a plausible empty answer

[D5](../doctrine/north-star.md#d5-failure-is-loud-it-is-never-plausible)
closes the gap an attacker would otherwise aim for: a shape that fails to
parse is treated as evidence of tampering, not as an unlucky format error to
work around. A best-effort parse of the parts of a malformed answer that
"looked fine" is exactly where an injection would try to survive, so Reeve
refuses the whole answer instead and turns the run red rather than green
with nothing in it. A maintainer can tell "there was nothing to do" apart
from "something went wrong" because the two are never allowed to render the
same way.

## Capacity failures are not authority failures

[D12](../doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
draws a line a threat model has to draw somewhere: a `429` from a free,
IP-rate-limited provider says nothing about whether Reeve was ever allowed
near the repository, and a run does not treat running out of quota as a
reason to loosen anything or to fail in a way that looks like a security
event. Weather ends in a warning. A warrant violation ends in a dropped
effect, visible in the outputs, every time — the two are never allowed to
look like the same kind of problem, because a reviewer investigating one
should never have to rule out the other first.

## Where the detail lives

- **The mechanism** — trust boundaries, what each pipeline stage buys, prompt
  injection, output sanitising, what is deliberately left undefended, and the
  ten checked invariants: [Security](security.md).
- **Reporting a vulnerability**, and how to verify a release's provenance:
  [Reporting](reporting.md) and [`SECURITY.md`](../../SECURITY.md).
- **Per-duty security considerations** — what each duty specifically will
  never do, however it is configured: the "Security considerations" section
  on [`triage`](../reference/duties/triage.md#security-considerations),
  [`translate`](../reference/duties/translate.md#security-considerations),
  [`duplicate`](../reference/duties/duplicate.md#security-considerations),
  [`respond`](../reference/duties/respond.md#security-considerations),
  [`harmonise`](../reference/duties/harmonise.md#security-considerations), and
  [`dependa`](../reference/duties/dependa.md#security-considerations).

- **Dependency-specific threats** — external registry metadata as an attack
  surface, prompt injection through release notes and changelogs, and why
  external content is evidence rather than authority:
  [the dependa duty's security considerations](../reference/duties/dependa.md#security-considerations).

---

**Related:** [Security](security.md) · [Reporting](reporting.md) ·
[The authority model](../concepts/authority-model.md) ·
[Architecture](../development/architecture.md)
