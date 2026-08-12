# Dry run

_Rehearse a run with nothing written. Prerequisites: [Installation](../getting-started/installation.md)._

```yaml
with:
  dry-run: true
```

Every duty runs its whole pipeline under `dry-run` — reads the thread, detects
the language, screens, drafts, scores, verifies — logs what it would have
done, writes every output, and touches nothing. Nothing about the pipeline is
skipped or stubbed; the only thing missing is the publish step at the very
end.

Run it that way against ten real threads first. It costs the model calls and
nothing else, and it is the only honest way to find out what a taxonomy or a
provider does on your repository rather than on somebody else's — before a
label lands wrong, a comment reaches a stranger, or a warrant capability turns
out to fire more often than you expected.

## Reading the result

A `dry-run` produces the same outputs a live run would have written: the
verdict, what was screened out, what a model refused, and — for a duty that
would have posted a comment — the text it would have posted. Nothing here is
a simulation of the pipeline; it is the pipeline, with the one side effect
removed.

## What it is for

**Before you write a warrant.** See how the implicit, level-0 taxonomy sorts
your actual backlog before deciding whether a written one earns its keep.

**Before you turn on a capability.** [The warrant](warrant.md#capabilities)
starts every duty at its cheapest, most reversible default. `dry-run` is how
you watch what a wider capability — `comment`, `close`, `assign` — would have
done before you grant it.

**Before a scheduled sweep.** [The sweep](sweep.md) can dry-run the same way a
single-thread run can, over the whole backlog `sweep` would otherwise touch —
the cheapest way to find out what a four-thousand-issue backlog actually
costs before committing to it.

**`dry-run` is not `none`.** [`none`](warrant.md#capabilities) is a permanent
configuration for a repository that reads Reeve's outputs and applies them
itself. `dry-run` is a rehearsal you turn off once you trust what you saw. The
outputs let a workflow tell the two apart.

---

**Related:** [The warrant](warrant.md) · [The sweep](sweep.md) · [Cost](cost.md)
**Next:** [The warrant](warrant.md) — decide what a duty may do once you trust what a dry run showed you
