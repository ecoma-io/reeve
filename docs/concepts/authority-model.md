# The authority model

_Understand capabilities, the warrant, and the ladder as one model. Prerequisites: None._

Reeve is not a tool you configure once and then trust. It is a tool whose
authority you can always read, in one file, and whose behaviour never exceeds
what that file — or its absence — says. This page is the shape of that idea,
one level above the how-to detail in [The warrant](../guides/warrant.md); read
it first if you want to know what you are agreeing to before you learn the
syntax for saying so.

## Nothing is granted by installing it

Wiring a duty into a workflow is not the moment Reeve becomes trusted with
your repository. It is the moment Reeve is trusted with exactly the narrowest
thing it knows how to do — sort issues against labels already sitting in your
repository settings, append a translated block below an issue body — and
nothing past that, until something in writing says otherwise. There is no
implicit escalation: a duty that could do more tomorrow than it does today
only gets there because a maintainer wrote a wider grant, reviewed it like any
other change, and merged it.

## A ladder, not a switch

Every project climbs from the same place, and how far it climbs is legible
from the warrant file alone — never from a setting, a flag, or a mode buried
in a workflow. Each rung is strictly more of the same file, not a different
way of using Reeve:

- **Nothing written down at all** is not an absence of a rule. It is the
  narrowest rule Reeve defines in code — read straight off the labels and
  descriptions a repository already has, so a first run costs nothing typed
  twice.
- **A taxonomy with no authority block** sharpens what gets decided without
  touching what is allowed to act. Writing down what a `bug` is and is not
  makes sorting more accurate; it does not, by itself, let a duty do anything
  it could not already do.
- **A written authority block** is the point where enumeration takes over
  completely. From the moment it exists, a duty's authority is read only from
  it — nothing older survives alongside it, not even as a fallback.
- **The top of the ladder** is where the highest-leverage behaviour lives —
  running against a whole backlog instead of one thread, writing corrections
  back into the repository, answering a stranger directly — each one opt-in,
  each one reached deliberately rather than by accident.

Climbing is always visible as a diff to the same file, reviewed the same way
a code change would be. There is no second file, no dashboard, and no rung
that works differently from the others.

## Capabilities are an allowlist, not a request

A duty does not ask permission at the moment it wants to act and hope for the
best. What it may do is resolved before a model is ever called, from the
warrant file alone, and handed to the duty as a fact. The model's own claims
about what it was told to do are irrelevant to that resolution — the check is
always "does the file say so," run in code against the parsed file. That is
what makes the model's output harmless to over-trust: text in a thread can
persuade a model to say almost anything, and none of it can edit a file it
was never given access to.

There is no second authority to be narrower than. The workflow file says when
a run happens and how the runtime operates — `dry-run`, `number`, provider
settings; it cannot grant a capability. The `duties:` block in the warrant is
the whole authority, and the absence of a block is a default written in code,
not a promise the workflow can quietly outrun. A workflow cannot widen what
the file grants, because it was never a second half of the gate to begin
with.

## Some doors have no handle

A few things are not behind any capability, at any level of the warrant.
Nothing you can write turns them on, because they are not policy choices —
they are boundaries the model itself does not participate in setting. Reeve
does not remove a label a person applied, reopen what a person closed,
reassign what a person assigned, rewrite a person's own words, apply a label
outside the taxonomy, or touch code, a pull request, or a test suite on your
behalf — except through the explicit capabilities the warrant grants. `edit-file`
and `open-pr` are grantable capabilities, not defaults, and they only govern
what the warrant names: `harmonise` writing a translated README, `dependa`
writing a dependency manifest. No duty can widen its own authority, and no
external metadata — a changelog, a release note, a registry response — can
become permission. The one bounded carve-out proves the rule:
[`lifecycle`'s clock-hand exception](../reference/duties/lifecycle.md#the-clock-hand-exception)
removes only a label its own actor applied as a track's declared clock-hand —
a label a person applied is still never touched. A maintainer who wants any of that has to do it themselves; no warrant
entry exists to ask for it, because the answer was decided once, for
everyone, rather than left open to be reasoned around by a well-crafted
prompt.

That is the whole model: nothing assumed at install, everything legible in
one file, the file the whole authority, and a small set of
actions no file can ever unlock.

---

**Related:** [The warrant](../guides/warrant.md) · [The warrant format reference](../reference/warrant-format.md) · [Duties and the core](duties-and-the-core.md)
**Next:** [The warrant](../guides/warrant.md) — write the file that puts this model into practice
