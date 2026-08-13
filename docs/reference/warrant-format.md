# Warrant format reference

_Full warrant YAML schema. Prerequisites: [The warrant](../guides/warrant.md)._

<!-- Source of truth: src/core/warrant.ts (Capability type, CAPABILITIES const,
     Label and Warrant interfaces, parseWarrant/readLabels/readCapabilities
     validation). Keep this page in sync with that file by hand — there is no
     automated diff for it. -->

This page is the schema by itself, with no argument for why. For the reasoning
behind each field, see [The warrant](../guides/warrant.md).

## Top-level keys

| Key            | Required | Type                                    | What it does                                                                                                                                                                                                                                          |
| -------------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | number                                  | Must be `1`, the only version this build understands.                                                                                                                                                                                                 |
| `labels`       | no       | list of label entries                   | The taxonomy. Absent is an empty taxonomy, not an error.                                                                                                                                                                                              |
| `capabilities` | no       | mapping of duty name to capability list | What each duty may do. Absent leaves every duty on its own default.                                                                                                                                                                                   |
| `languages`    | no       | list of language entries                | What to translate into. Absent leaves the `languages` input on each duty in charge.                                                                                                                                                                   |
| `pivot`        | no       | one language code                       | The language corrections bridge through for cross-language recall. Must name one of `languages`. Absent is the first-listed language, unchanged from before this key existed.                                                                         |
| `memory`       | no       | mapping — see below                     | How much of the corrections store one run reads. Absent leaves each duty's own default in charge.                                                                                                                                                     |
| `about`        | no       | text                                    | What this repository is about, in the maintainer's own words. Read only by `triage` and `respond`, the two duties that reason about content rather than only translate or judge it. Absent falls back to the `about` input those duties already read. |
| `lifecycle`    | no       | mapping — see below                     | The staleness policy `lifecycle` runs. Absent is a no-op — there is no built-in default track. Present but empty (`null`) is refused.                                                                                                                 |
| `propose`      | no       | mapping — see below                     | How `triage`'s `propose` capability chooses names and gates evidence. Absent takes the design's own defaults. Present but empty (`null`) is refused — write `workspace:` under it, or remove the key.                                                 |

### `memory` fields

| Field    | Required | What it does                                                                                                                                                                                                                    |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall` | yes      | A whole number of corrections put in front of a model. `0` is accepted and turns recall off. Required whenever the `memory:` block is present — omitting the whole block is what leaves the duty's own default (`4`) in charge. |

### `lifecycle` fields

Full behavioural contract: [the `lifecycle` duty](duties/lifecycle.md). Schema only, here:

| Field       | Required | What it does                                                                                                                                                         |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracks`    | yes      | Non-empty list of tracks — see below. A `lifecycle:` block with no tracks decides nothing and is refused.                                                            |
| `exempt`    | no       | The permanent escape hatch — see below. Defaults to `{milestones: true, assignees: true, taxonomy: true, drafts: true}` with empty `labels` and no `comments` floor. |
| `overrides` | no       | Per-label timing exceptions — see below.                                                                                                                             |
| `threads`   | no       | `issues`, `prs`, or `both` — which kind of thread this policy considers. Default `issues`.                                                                           |

**A track** (one entry of `tracks:`):

| Field    | Required | What it does                                                                                                                                                |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | yes      | Lowercase letters, digits and hyphens, starting with a letter. Unique within the file.                                                                      |
| `when`   | no       | A label whose application starts this track; its removal stops it. Absent makes this a plain inactivity track, timed from the thread's own silence instead. |
| `resets` | no       | `author` or `any` — whose activity resets the clock. Defaults to `author` for a `when:` track, `any` for an inactivity track.                               |
| `steps`  | yes      | Non-empty, ordered list of steps — see below.                                                                                                               |

**A step** (one entry of a track's `steps:`):

| Field   | Required | What it does                                                                                                                                                                                                                                   |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after` | yes      | A duration since the previous step fired — or, for the track's first step, since the clock last reset (`14d`). Cumulative, not parallel: see [the worked example](duties/lifecycle.md#the-lifecycle-policy). Whole days only; `0d` is refused. |
| `label` | no       | A label this step applies.                                                                                                                                                                                                                     |
| `say`   | no       | `true` for the built-in reminder text, a non-empty string for your own, a mapping of language code to text — or `false`, accepted as an explicit "no comment".                                                                                 |
| `close` | no       | `true` or `not_planned` to close the thread as not planned. Must be the track's own last step. `completed` is refused by name — Reeve closes only as `not_planned`.                                                                            |

At least one of `label`, `say`, `close` is required per step. An inactivity
track's first step may not carry `close` — a close with no prior warning is
refused.

**`exempt`** (permanent — a filter on what a due step may _do_, applied after
evaluation, not a gate that keeps a thread out of a track: an exempt thread's
clocks still run, and the removal of this duty's own stale clock-hand labels
deliberately survives every layer here, so a label its own actor applied does
not linger forever on a thread that later gained a milestone):

| Field        | Required | What it does                                                                                                                                                                 |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels`     | no       | Labels that exempt a thread from every due action. **Required non-empty the moment any track anywhere configures a `close` step** — the file is refused otherwise.           |
| `milestones` | no       | `true`/`false`, or a list of milestone names that exempt. Default `true` — any milestone exempts.                                                                            |
| `assignees`  | no       | `true`/`false`, or a list of logins that exempt. Default `true` — any assignee exempts.                                                                                      |
| `taxonomy`   | no       | Whether carrying any taxonomy label exempts a thread. A track's own `when:` label does not count — the label that starts a clock cannot also exempt from it. Default `true`. |
| `comments`   | no       | A whole number of comments that, once reached, blocks `close` steps only — reminders and labels still fire. Default no floor.                                                |
| `drafts`     | no       | Whether a draft pull request is exempt, when `threads:` includes pull requests at all. Default `true`.                                                                       |

**An override** (one entry of `overrides:`):

| Field   | Required | What it does                                                                                                                                                                                                     |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` | yes      | Which label, carried by a thread, makes this override apply to that thread.                                                                                                                                      |
| `after` | one of   | A different duration for the **first step of an inactivity track** — the only step an override's timing reaches. Ignored, deliberately, on `when:` tracks and later steps. Write exactly one of `after`/`never`. |
| `never` | one of   | `true` — no step of any track is ever due on this thread; stale clock-hand cleanup still runs. A separate boolean key, not an `after:` value. Write exactly one of `after`/`never`.                              |

When a thread carries several overridden labels, the longest `after` wins —
the most patient exception a maintainer wrote is the one honoured.

### `propose` fields

Full behavioural contract: [`triage`'s `propose` capability](duties/triage.md).
Schema only, here — everything sits under a `workspace:` sub-key:

| Field      | Required | What it does                                                                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | no       | A naming template with exactly one `{package}` placeholder. Default `area:{package}`.                                                                   |
| `except`   | no       | Glob patterns for package paths never proposed.                                                                                                         |
| `evidence` | no       | How many distinct open issues must mention a package before it is proposed. Minimum `1` — a floor of zero is no floor, and `0` is refused. Default `3`. |
| `window`   | no       | How far back an issue may date and still count as evidence, as a duration. Default `90d`.                                                               |
| `retire`   | no       | Whether an existing templated label with no packages left matching it is proposed for retirement. Default `false`.                                      |

## Label fields

| Field            | Required | What it does                                                                                                                                                                      |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | yes      | Must match a label that exists in the repository, exactly. Verified before anything is applied.                                                                                   |
| `description`    | yes      | When this label applies. Written as a boundary, not as a synonym for the name.                                                                                                    |
| `not`            | no       | When it does **not** apply, against the label it gets confused with most. The highest-value field on this page.                                                                   |
| `examples`       | no       | Real titles from your own repository. Two or three; more is a corpus, and that is what memory is for.                                                                             |
| `owner`          | no       | Team or user assigned when this label is applied and the duty may assign.                                                                                                         |
| `exclusive_with` | no       | Labels that may not be applied alongside this one. Enforced in code, never requested of the model.                                                                                |
| `confidence`     | no       | This label's own floor, between 0 and 1, standing in for the run's `confidence` input for this label alone.                                                                       |
| `paths`          | no       | Package paths (or path prefixes) this label already answers to. Evidence for `propose`'s coverage check, never authority — an empty list means this label answers to nothing yet. |
| `create`         | no       | `true` lets `checkLabelsExist` create this label in the repository when missing, instead of failing the run red. What `propose` sets on the entries it writes.                    |
| `color`          | no       | A 6-digit hex color with no `#`, used only when a missing `create: true` label is actually created. Absent takes GitHub's own neutral default.                                    |

## Capabilities

| Capability  | What it permits                                                                                                                                                                                                                                                                     | Default                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `label`     | Add a label from the taxonomy. Never remove one — except `lifecycle`'s own clock-hand labels, un-staled in code, and only when its own actor applied the one being removed.                                                                                                         | on for `triage`, `lifecycle` |
| `edit-body` | Append Reeve's own block below its marker in a body.                                                                                                                                                                                                                                | on for `translate`           |
| `comment`   | Post a rationale as a new comment.                                                                                                                                                                                                                                                  | on for `lifecycle`           |
| `close`     | Close as not planned, with a comment saying why.                                                                                                                                                                                                                                    | off                          |
| `assign`    | Assign the `owner` the taxonomy names for a label.                                                                                                                                                                                                                                  | off                          |
| `record`    | Commit the thread's current labels to the corrections store, on a labelled or unlabelled event from a human — or a human's reversal of Reeve's own prior action (a removed label, a reopen after a Reeve duplicate-close). Needs `contents: write` on the token.                    | off                          |
| `propose`   | Open or update a pull request adding or retiring taxonomy labels, from a monorepo's own package layout. `triage`-only, sweep-only. Needs `contents: write` and `pull-requests: write` on the token.                                                                                 | off                          |
| `open-pr`   | Open or update a draft PR for state files, when `state-branch` is set. Required alongside the duty's own write capability (`record` for `triage`, `edit-file` for `harmonise`) to write state to a branch instead of the default branch. Needs `pull-requests: write` on the token. | off                          |
| `none`      | Run everything, write every output, change nothing.                                                                                                                                                                                                                                 | —                            |

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
- **Every label `lifecycle:` names — a track's `when`, a step's `label`, an
  override's `label`, or an `exempt.labels` entry — exists in the
  repository.** Always red on missing: a clock-hand label that does not
  exist looks exactly like a clock that never ran, unlike a taxonomy label
  that can fall back to `create: true`.
- **A `lifecycle:` policy with any `close` step requires `exempt.labels` to
  be non-empty.** A permanent escape hatch must exist before closing may be
  configured at all.
- **`propose.workspace.name` names exactly one `{package}` placeholder.**
  Zero or more than one is refused.

**An issue cannot be assigned to a team.** That is GitHub's rule, not Reeve's:
the assignees API takes users, and `@org/team` is not one. A team `owner` is
still worth writing — it says who a label belongs to, and the run report says so
— but a run with `assign` turned on warns about it once and carries on. It never
fails the run over it, because who owns a label is documentation and refusing to
label a thread over it would be the wrong trade.

---

**Related:** [The warrant](../guides/warrant.md) · [The authority model](../concepts/authority-model.md) ·
[The `lifecycle` duty](duties/lifecycle.md) · [The `triage` duty](duties/triage.md)
