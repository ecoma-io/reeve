# Migration

_Move an existing pre-1.0 configuration onto the warrant-only model. Prerequisites: [Installation](../getting-started/installation.md)._

Before 1.0, a workflow decided what a duty may do in two places: the warrant's
`capabilities:` block, and an `apply:` input on each duty's workflow step. 1.0
removed the second half. There is no `apply` input, no `languages` input, and
no `capabilities:` warrant key anymore — [the warrant's `duties:`
block](../reference/warrant-format.md) is the whole authority, and a duty runs
only through its leaf action
([the leaf-action table](../reference/root-action.md#the-leaf-actions)).

If your workflow does not use any of the removed inputs, you have nothing to
do — read [the warrant](warrant.md) and stop here. Everything below maps the
old shapes onto the new ones, one at a time.

## Where the old inputs went

Three things you may have written in a workflow step, and where each one lives
now.

### `apply:`

The old `apply:` input was the workflow's half of the authority, intersected
with the warrant's `capabilities:` grant — the narrower of the two won. There
is no second half of the gate anymore, so the file holds it all. Construct
the `duties:` entry from what a run was **effectively** allowed to do —
`narrow(grant, apply)`, never from either half blindly. Start from the
grant, then intersect it with what the workflow actually carried; a grant
the `apply:` input never named never reached a thread. The rows below give
each duty its pre-1.0 `apply:` default where the workflow never wrote the
input.

| Duty        | Old `apply:` default | Old effective authority (with a written `capabilities:` grant) | New `duties:` entry that preserves it                                                                                        |
| ----------- | -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `triage`    | `label`              | the grant ∩ `[label]`                                          | `triage: [label]`, or `triage: true` if the file granted exactly `[label]`                                                   |
| `translate` | `edit-body`          | the grant ∩ `[edit-body]`                                      | `translate: [edit-body]`, or `true` if the file granted exactly `[edit-body]`                                                |
| `lifecycle` | `label, comment`     | the grant ∩ `[label, comment]`                                 | `lifecycle: true` (its built-in default is `[label, comment]`)                                                               |
| `duplicate` | `none`               | `[]`                                                           | `duplicate: false` — or `[none]` — unless the old workflow did name `apply: comment` at the same time as the file granted it |
| `respond`   | `none`               | `[]`                                                           | `respond: false`, or `[none]`, unless the old workflow named `apply: comment` with the file granting it                      |
| `harmonise` | `none`               | `[]`                                                           | `harmonise: false`, or `[none]`, unless the old workflow named `apply: edit-file, open-pr` with the file granting both       |
| `dependa`   | `none`               | `[]`                                                           | `dependa: false`, or `[none]`, unless the old workflow named `apply: edit-file, open-pr` with the file granting both         |

The default-`none` row is the one a migration must write on purpose: with no
`duties:` block at all the duty keeps its own built-in default, and a duty
left out of a written block is denied everything — neither is the pre-1.0
`none` intent spelled out. `false` (or `[none]`) names the duty in the block
and grants it nothing, which is what the old `apply: none` meant. See
[duty entry values in the warrant guide](warrant.md#duties).

The workflow's half mattered even when it was not written, because the
input had a default. Only a consumer who wrote `apply: "label, close,
assign"` in the old workflow — and had that list granted in the file —
migrates to `triage: [label, close, assign]`. The list a file granted but
the step never applied stays out of the new entry.

The two exclusives, `record` and `propose`, worked through the same double
gate, and both are now granted by the `duties:` block alone — `triage: [label,
record]` or `triage: [label, propose]`, exactly like any other capability.
`record` needs `contents: write` on the token, `propose` needs `contents:
write` and `pull-requests: write`, unchanged from before. But the same
intersection rule applies: `record` only ever fired when the workflow's
`apply:` named it too, so a migration copies `record` into the `duties:`
entry only if the old `apply:` carried it. See
[the capabilities table](../reference/warrant-format.md#the-capabilities-table)
for what each capability requires.

Capabilities a migration may find in `apply:` — `label`, `comment`, `close`,
`assign`, `record`, `propose`, `edit-body`, `edit-file`, `open-pr` — are all
still available, now granted in the `duties:` entry of the duty that uses
them instead of on the workflow step. None of them was ever a knob the
warrant could not already state; the input was only ever the narrower-of-two
gate, and the gate is gone.

`none` is not `dry-run`. A `none` value always meant "decide, write every
output, change nothing" — the intent a migration now spells out by writing
the duty's entry as `false` or `[none]`. Rehearsing without writing is the
separate `dry-run: true` input, which still exists on the leaf actions. See
[the dry-run guide](dry-run.md).

### `languages:` and the `languages` input

The `languages` input on `translate` (and, before the input was folded into
the warrant, on `triage`) moved into the warrant file. The key is spelled the
same and keeps the same grammar. "Written here, it is the whole answer": once
`languages:` exists in the warrant, the duty's own documented default list is
not consulted at all, exactly as the input used to override the default. A
warrant without the key leaves each duty's own documented default in charge:
`triage`, `translate`, `duplicate` and `respond` default to `en, vi, zh`,
`harmonise` to `vi, zh`. See
[Languages](../guides/languages.md) for the grammar and the defaults, and
[the warrant guide's Languages section](warrant.md#languages) for
the precedence.

### `capabilities:` and everything else in the old warrant

The warrant's old block was spelled `capabilities:`. It is now spelled
`duties:`, with one behavioural difference: each duty entry can be an explicit
list, `true`, or `false` — before, an entry was always a list.

| Old warrant `capabilities:`                | New warrant `duties:`                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `capabilities: { triage: [label, close] }` | `duties: { triage: [label, close] }`                                                |
| (no `capabilities:` block at all)          | (no `duties:` block at all) — unchanged, every duty keeps its default               |
| —                                          | `duties: { triage: true }` — spells out `triage`'s own default without restating it |
| —                                          | `duties: { triage: false }` or `[none]` — the duty is enabled, granted nothing      |

The block's meaning is unchanged — a duty a written block does not name is
granted nothing at all, not its old default, once a block exists — and the
value shapes are enumerated the same way. But the move into `duties:` is not
a rename for the workflow: the file was never the whole authority before
1.0. Where the old file granted a list the workflow's `apply:` did not
name, the effective authority was narrower than the file row, and blindly
copying the file row into `duties:` widens the run. Migrate the file by
intersecting each row with what that workflow's `apply:` actually allowed —
see [the `apply:` mapping](#apply) for the per-duty effective values. See
[duty entry values in the warrant guide](warrant.md#duties) for the three
shapes an entry may take.

## Workflow steps change to leaf actions

A duty never ran from the root action; it ran from its own directory, and that
still holds. `uses: ecoma-io/reeve/triage@v0.6` is the same line, and the leaf
action table in [the root-action reference](../reference/root-action.md#the-leaf-actions)
is where each duty's `uses:` line is named.

What changed is what the step inputs do. A step that only named provider
settings — `api-key`, `models`, `base-url` — needs no change beyond removing
any removed input line (`apply:`, `languages:`). A step that carried an
`apply:` grant loses that line, because the grant now lives in the warrant;
see the mapping above.

```yaml
# Before — authority split between the step and the file
- uses: ecoma-io/reeve/triage@v0.6
  with:
    api-key: ${{ secrets.OPENAI_API_KEY }}
    models: gpt-5-mini
    apply: "label, close, assign"
# After — the step only runs; the grant is in the warrant
- uses: ecoma-io/reeve/triage@v0.6
  with:
    api-key: ${{ secrets.OPENAI_API_KEY }}
    models: gpt-5-mini
```

The root action — `uses: ecoma-io/reeve@v0.6` naming no duty — still
resolves and still runs no duty, and it has always failed red with the
corrected `uses:` line in the message, exactly as it does today. What 1.0
adds to that refusal is the explain surface: the run still fails red, but a
step-summary page now names the leaf action a duty actually ships from, and
a `leaf-action` output makes the corrected `uses:` line machine-readable.
`doctor: true` itself is unchanged — the same read-only configuration
report it has always been — and remains the way to verify a converted
warrant before the first real run. There is no form in which
`uses: ecoma-io/reeve@v0.6` runs a duty — a duty runs only through its leaf
action. See [the root action](../reference/root-action.md#what-it-does).

## A before-and-after warrant

The case where the workflow's `apply:` named the same list the file granted
is the clean migration — the effective authority and the file row agree, and
only the block's name changes. That is the shape shown here:

```yaml
# .github/workflows/reeve.yml — before
- uses: ecoma-io/reeve/triage@v0.6
  with:
    api-key: ${{ secrets.OPENAI_API_KEY }}
    models: gpt-5-mini
    apply: "label, close, assign"
```

```yaml
# .github/reeve.yml — before
version: 1
labels:
  - name: bug
    description: Something broken in a released version.
capabilities:
  triage: [label, close, assign]
  translate: [edit-body]
languages:
  - en
  - vi
```

```yaml
# .github/reeve.yml — after
version: 1
labels:
  - name: bug
    description: Something broken in a released version.
duties:
  triage: [label, close, assign]
  translate: [edit-body]
languages:
  - en
  - vi
```

The workflow gains nothing. `translate`'s row could equally be written
`translate: true` — its built-in default is exactly `[edit-body]`, so the
list and the shorthand name the same authority. `triage` is shown as the
list because that is the shape the workflow's `apply:` named; the only
consumer who may copy this `triage` row verbatim is one whose old workflow
did write `apply: "label, close, assign"`. If your workflow never wrote
that, this example is a widening, not a migration: `triage` ran at most
`[label]` until the step named more — write `triage: [label]`, or `true`
if the file granted exactly that.

Every old capability has a `duties:` entry to move into, so nothing a
pre-1.0 grant used to cover is unavailable on the new model. If you want
`triage` on its own default without restating it, rewrite that row as
`triage: true`; to keep the duty running but grant it nothing, write
`triage: false` instead of `triage: []` — an empty list is refused, on the
grounds that `[none]` is the explicit way to grant nothing.

## Verify the conversion with `doctor: true`

Before the first real run, verify the converted warrant against your
repository with
[`doctor: true`](../guides/doctor.md) on the root action:

```yaml
- uses: ecoma-io/reeve@v0.6
  with:
    doctor: true
```

`doctor` reads your warrant and this repository's labels and writes nothing —
no label, no comment, no commit. The job summary's three sections answer
exactly the three things a migrated configuration has to get right, in the
order `doctor` prints them:

- **`### Problems`** — anything that would refuse a duty at runtime: a warrant
  that will not parse, a label the taxonomy names that does not exist and
  cannot be created, a token the labels endpoint refuses. A green nothing here
  is the migration's green light.
- **`### Notes`** — the defaults in play. Every duty whose effective grant is
  exactly its own built-in default — because the file never wrote an opinion,
  or because you wrote `true` — is named in one aggregated green note, so
  "healthy" and "healthy because nothing is configured yet" never look the
  same. Missing labels marked `create: true` appear here too, as labels a duty
  granted `label` will create.
- **`### Effective authority`** — one row per duty, showing what its `duties:`
  entry effectively grants. This is where the conversion is read back: a duty
  that used to be `apply: "label, close"` and is now an exact list shows that
  exact list here, and a duty you wrote as `true` shows its own built-in
  default. A duty a written block leaves unnamed is shown as denied
  everything, which is the real answer of a migrated block, not a finding.

Set `duty:` alongside `doctor: true` to scope the report to one duty's row —
useful when a migration changed that one duty's entry. Add `problems != '0'`
as a job condition elsewhere, or let the step itself fail red (it does whenever
a finding would refuse a duty at runtime). See [the doctor
guide](../guides/doctor.md) for the full walkthrough and the exit table.

## What is simply no longer available

Be direct about it, so migration does not look for a knob that is gone:

- **No per-run capability override on the workflow.** The narrower-of-the-two
  rule is gone — the file is the authority and cannot be narrowed by a step. A
  workflow that ran the same duty with different `apply:` values on different
  triggers now needs the split written down: point the leaf's own `warrant:`
  input at a different file per workflow, or decide that all triggers run the
  one grant the file writes. Either way, the grant the file writes is the
  grant the run uses.
- **`edit-file` and `open-pr` grants.** These were already capabilities of the
  warrant before and after; on the new model they are granted exactly the same
  way, in the `duties:` entry for the duty that uses them (`harmonise`,
  `dependa`), and only there. Nothing else changed about them — still off by
  default, still needing the corresponding `contents: write` /
  `pull-requests: write` scopes.
- **The per-duty `languages` input is gone.** Translation targets come only
  from the warrant's `languages:` key or the duty's documented default.

---

**Related:** [The warrant](warrant.md) · [Doctor](doctor.md) · [The root action](../reference/root-action.md)
