# The 2.x compatibility contract

_What every 1.x consumer is promised across the whole 2.x line, phase by
phase and at `2.0` itself. Prerequisites: [The 2.x roadmap](roadmap-2x.md)._

> [!IMPORTANT]
> **This page constrains future work; it does not describe shipped
> behaviour.** The 2.x line it binds is
> [direction, not code](agent-runtime.md). It is written now, ahead of any of
> it, because a compatibility promise made after the incompatible thing is
> built is a negotiation, and one made before is a constraint. This page is
> the constraint.

## The one-sentence contract

**2.x is an architectural superset of 1.x: every 1.x workflow keeps working
unmodified, no capability becomes agent-only, and Explicit mode is neither
deprecated nor disadvantaged by Agent Mode existing.**

Everything below is that sentence, made specific enough to catch a violation
in review.

## What "superset" binds, concretely

**Every 1.x workflow keeps working unmodified.** A workflow that says
`uses: ecoma-io/reeve/triage@v2` with the inputs it uses today gets the
behaviour it gets today. No input is removed or renamed, no default moves,
and no summary line a maintainer might be parsing changes meaning — the
same tests [the breaking-change definition](releasing.md#what-a-breaking-change-is)
already implies, held across a major on purpose.

**No capability becomes agent-only.** Anything Agent Mode can do, a
maintainer can wire explicitly. This is not generosity; it is what keeps
Agent Mode honest. The moment a capability exists only behind the loop,
adopting the loop stops being a choice about orchestration and becomes the
price of a feature — and the
[ladder](../doctrine/north-star.md#3-the-ladder)'s whole design is that
nobody is priced into a rung. The agent composes duties; it never hoards
one.

**Explicit mode is not a legacy path.** It does not get slower, does not
grow an opt-out banner, and remains the mode most repositories should keep
using ([the agent runtime](agent-runtime.md#two-execution-modes-not-a-replacement)).
A repository that never wants more than `triage` and `translate` on a
schedule never has to read a page about agents.

**The warrant keeps working.** `.github/reeve.yml` reads exactly as it does
today, with no deprecation warning and no sunset;
[the governance tree](agent-governance.md#migration-how-a-warrant-lifts-into-authorityyaml)
is the 2.x spelling, not the 2.x requirement, and its lift is mechanical,
lossless and unforced. The one sharp edge is deliberate and loud: a
repository with both files fails red naming both, rather than getting a
precedence rule to memorise.

**The invariants hold in both modes.**
[Every invariant in Security](../security/security.md#invariants) — no
human text modified, no unwarranted label, no maintainer decision reverted,
no egress past `base-url` and the GitHub API — binds an agent-mode run
exactly as it binds an explicit one, and breaking one remains a breaking
change regardless of what any `action.yml` says. `code.write` sits below
even that, on
[the permanent floor](../doctrine/north-star.md#beyond-10-the-2x-line-direction-nothing-ships):
not a compatibility promise that a major could renegotiate, a line no
version may cross.

## Versioning: what `2.0` is for

`@v2` still resolves per duty, from the same subdirectories:

```yaml
- uses: ecoma-io/reeve/triage@v2
- uses: ecoma-io/reeve/translate@v2
```

One repository, one core, one version line — the
[shape](../doctrine/north-star.md#6-shape) does not change, and
[the floating-tag rules](releasing.md#floating-tags-and-why-v0-must-not-exist)
carry over: `v2` delivers features and fixes under semver's promise, the way
`v1` does.

The honest question is why a line this compatible is a major at all. The
answer is what a major is _for_: not "we broke things" but "the surface
grew a second load-bearing shape whose semantics you should read before
pinning." A consumer pinning `@v2` is pinning a world where an
`authority.yaml` can exist, where an agent workflow can be added beside
their explicit ones, and where the release notes assume both. None of that
breaks a `v1` workflow — which is why the contract above can be kept — but
all of it deserves the one signal semver reserves for "read before you
ride." A `1.x` minor that quietly introduced an agent runtime would be
technically defensible and honest with nobody.

**During the phases, the 0.x discipline repeats.** Pre-2.0 agent surface
ships under the same rule
[the 1.x line used](releasing.md#what-0x-and-10-mean-here): free to break
its own new inputs between releases while its
[roadmap phases](roadmap-2x.md) are open, with the 1.x surface held stable
underneath throughout. The superset contract binds from the first phase, not
from the release that finishes the last one.

## What this page does not promise

Stated so the contract cannot be read wider than it was written:

- **Not that Agent Mode is free.** An agent-mode run spends model calls
  reasoning and planning that an explicit run never spends. What is promised
  is that a repository which does not opt in spends nothing new.
- **Not that 2.x ships no breaking change ever.** It promises the 1.x
  surface survives the 2.0 major. A later `3.0` renegotiates the way majors
  do — against [the same definition](releasing.md#what-a-breaking-change-is).
- **Not a schedule.** [Phases sequence by dependency](roadmap-2x.md), and a
  promise about dates is not one this repository makes.

---

**Related:** [The 2.x roadmap](roadmap-2x.md) ·
[The agent runtime](agent-runtime.md) ·
[The governance tree](agent-governance.md) ·
[Releasing](releasing.md)
