# Warrant format reference

_Full warrant YAML schema. Prerequisites: [The warrant](../guides/warrant.md)._

<!-- Source of truth: src/core/warrant.ts (Capability type, CAPABILITIES const,
     Label and Warrant interfaces, parseWarrant/readLabels/readCapabilities
     validation). Keep this page in sync with that file by hand — there is no
     automated diff for it. -->

This page is the schema by itself, with no argument for why. For the reasoning
behind each field, see [The warrant](../guides/warrant.md).

## Top-level keys

| Key            | Required | Type                                    | What it does                                                                                                                                                                  |
| -------------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | number                                  | Must be `1`, the only version this build understands.                                                                                                                         |
| `labels`       | no       | list of label entries                   | The taxonomy. Absent is an empty taxonomy, not an error.                                                                                                                      |
| `capabilities` | no       | mapping of duty name to capability list | What each duty may do. Absent leaves every duty on its own default.                                                                                                           |
| `languages`    | no       | list of language entries                | What to translate into. Absent leaves the `languages` input on each duty in charge.                                                                                           |
| `pivot`        | no       | one language code                       | The language corrections bridge through for cross-language recall. Must name one of `languages`. Absent is the first-listed language, unchanged from before this key existed. |
| `memory`       | no       | mapping — see below                     | How much of the corrections store one run reads. Absent leaves each duty's own default in charge.                                                                             |
| `about`        | no       | text                                    | What this repository is about, in the maintainer's own words. Absent falls back to the `about` input every duty already reads.                                                |

### `memory` fields

| Field    | Required | What it does                                                                                                                                       |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall` | no       | A whole number of corrections put in front of a model. `0` is accepted and turns recall off. Absent leaves the duty's own default (`4`) in charge. |

## Label fields

| Field            | Required | What it does                                                                                                    |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `name`           | yes      | Must match a label that exists in the repository, exactly. Verified before anything is applied.                 |
| `description`    | yes      | When this label applies. Written as a boundary, not as a synonym for the name.                                  |
| `not`            | no       | When it does **not** apply, against the label it gets confused with most. The highest-value field on this page. |
| `examples`       | no       | Real titles from your own repository. Two or three; more is a corpus, and that is what memory is for.           |
| `owner`          | no       | Team or user assigned when this label is applied and the duty may assign.                                       |
| `exclusive_with` | no       | Labels that may not be applied alongside this one. Enforced in code, never requested of the model.              |
| `confidence`     | no       | This label's own floor, between 0 and 1, standing in for the run's `confidence` input for this label alone.     |

## Capabilities

| Capability  | What it permits                                                                                                                                    | Default            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `label`     | Add a label from the taxonomy. Never remove one.                                                                                                   | on for `triage`    |
| `edit-body` | Append Reeve's own block below its marker in a body.                                                                                               | on for `translate` |
| `comment`   | Post a rationale as a new comment.                                                                                                                 | off                |
| `close`     | Close as not planned, with a comment saying why.                                                                                                   | off                |
| `assign`    | Assign the `owner` the taxonomy names for a label.                                                                                                 | off                |
| `record`    | Commit the thread's current labels to the corrections store, on a labelled or unlabelled event from a human. Needs `contents: write` on the token. | off                |
| `none`      | Run everything, write every output, change nothing.                                                                                                | —                  |

`duplicate` and `respond` are the two exceptions with no default at all — not
even the cheapest one. See [Capabilities](../guides/warrant.md#capabilities)
for why.

## Validation

Checked when the file is read, before any model call:

- **The file parses and `version` is supported.**
- **Every `name` is unique.**
- **Every `name` exists as a label in the repository.** A taxonomy naming a label
  that was renamed produces an error naming both — rather than a verdict whose
  labels are all silently dropped later, which looks exactly like a model that
  never agreed with anything.
- **Every `exclusive_with` entry names a label in this same file.**
- **Every capability named is one a duty defines.** A misspelling is refused, not
  dropped: this list is the only thing standing between a verdict and your issue
  tracker, and a silently ignored `lablel` is worse than a failed run.
- **`owner`, if present, is a syntactically valid handle.** Whether it can
  actually be assigned is decided by the API at apply time; a non-assignable
  owner is a warning, not a failed run.

**An issue cannot be assigned to a team.** That is GitHub's rule, not Reeve's:
the assignees API takes users, and `@org/team` is not one. A team `owner` is
still worth writing — it says who a label belongs to, and the run report says so
— but a run with `assign` turned on warns about it once and carries on. It never
fails the run over it, because who owns a label is documentation and refusing to
label a thread over it would be the wrong trade.

---

**Related:** [The warrant](../guides/warrant.md) · [The authority model](../concepts/authority-model.md)
