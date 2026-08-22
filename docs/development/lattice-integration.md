# Integrating Lattice

_Research note, not a shipped decision. Prerequisites: [Architecture](architecture.md)._

[Lattice](https://github.com/ecoma-io/lattice) is a deterministic architecture
governance system: a repository declares its projects, tags and allowed
dependencies as code, and `lattice check` turns every import in the tree into a
verdict with an exit code. It is Apache-2.0, published as `@ecoma-io/lattice`,
and it needs no build system — the native provider reads projects from
`git ls-files` and a `lattice.json` at the root.

Reeve already writes its architecture down in
[`architecture.md`](architecture.md#the-boundary): the core is the product, a
duty is a policy expressed against it, and a duty may not construct an HTTP
client, read a configuration file, write to the forge, or import `node:` modules
for I/O. That page calls the last one "the cheap mechanical test" — and today
nothing performs it. A boundary that is prose is a boundary that is enforced
during review, by whoever remembers it, which is exactly the shape D5 refuses
elsewhere: a rule that reports nothing is indistinguishable from a rule with
nothing to report.

This note records what integrating Lattice would actually cost, measured rather
than estimated. Everything below was run against this repository at commit
`29c290b` with `@ecoma-io/lattice@0.11.1`, in a scratch copy — nothing in this
repository is configured for Lattice yet.

## Two integrations, and they are independent

The name covers two different pieces of work, and conflating them is the first
mistake available:

| Axis                         | What it means                                                                          | Who runs Lattice            |
| ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| **A — Reeve governed by it** | This repository declares its core/duty boundary to Lattice; CI fails when it breaks.   | This repository's CI        |
| **B — Reeve fed by it**      | The `review` duty reads a Lattice verdict as evidence about a consumer's pull request. | The consumer's own workflow |

They share a vocabulary and nothing else. Axis A is a development gate; axis B
is product surface. Either can ship without the other, and A is the one with a
precondition.

## Axis A — Reeve under Lattice governance

### The model

Lattice's unit is a project with tags, and Reeve's directories map onto it
cleanly. Eleven projects, three layers:

| Root                | Name     | Tags                         |
| ------------------- | -------- | ---------------------------- |
| `src/core`          | `core`   | `layer:core`                 |
| `src/doctor`        | `doctor` | `layer:doctor`               |
| `src/duties/<duty>` | `<duty>` | `layer:duty`, `scope:<duty>` |

The constraint table is a direct transcription of
[`architecture.md`](architecture.md#the-boundary) — three rows, no invention:

```js
// module-boundaries.config.mjs
export const depConstraints = [
  {
    sourceTag: "layer:core",
    onlyDependOnLibsWithTags: ["layer:core"],
    description: "The core may not contain anything only one duty could use.",
  },
  {
    sourceTag: "layer:duty",
    onlyDependOnLibsWithTags: ["layer:core"],
    bannedExternalImports: ["node:*", "@actions/github", "@octokit/*"],
    description: "A duty's dependencies are the core's exported services and nothing else.",
  },
  {
    sourceTag: "layer:doctor",
    onlyDependOnLibsWithTags: ["layer:core"],
    description: "The doctor reads the core, never a duty.",
  },
];
```

`lattice.json` names those roots, points at `tsconfig.json`, and exempts from
coverage everything that is tracked, analyzable and owned by no project — the
committed `**/dist/**` bundles, `tools/`, `scripts/`, `eval/`, `dogfood/`, the
root config files, and `src/*.ts`. Coverage is not optional there: a tracked
analyzable file no project owns is exit 3, "could not look", never a pass.

That much works today. The run is clean, fast and complete: **1702 imports in
373 files across 11 projects, 62 files exempted**. The problem is what it
reports.

### The precondition: relative imports defeat the constraint table

Lattice inherits the `@nx/enforce-module-boundaries` model, and in that model a
cross-project import must be written as a package name or a path alias. A
relative one is reported by `noRelativeOrAbsoluteImportsAcrossLibraries` — and
that check fires **before** the constraint table is read. Its output says so in
as many words: `constraint  not driven by a depConstraints row`.

Reeve is one package. Every cross-directory import in it is relative. So the
first run reports:

| Message id                                   | Count |
| -------------------------------------------- | ----- |
| `noRelativeOrAbsoluteImportsAcrossLibraries` | 496   |
| `bannedExternalImportsViolation`             | 132   |
| `noRelativeOrAbsoluteExternals`              | 5     |
| **Total**                                    | 633   |

The 496 are not a finding about Reeve's architecture. They fire on
`triage → core` — which the table permits — exactly as they fire on
`core → dependa`, which it forbids. The verdict carries no information about
the boundary at all.

Suppressing that one message id is the obvious move and it is a trap. With
`noRelativeOrAbsoluteImportsAcrossLibraries` suppressed repository-wide, the run
drops to 32 violations and **not one of them is a tag-constraint violation**.
The `core → dependa` edge disappears entirely. The early return took the
constraint table with it: what is left is `bannedExternalImports`, which is
judged on a different path because its targets are external.

So the choice is real, and it is binary:

- **Suppress the rule** and Lattice enforces a banned-package list. That is
  useful, and it is not architecture governance. The core/duty layering — the
  thing this repository's doctrine is actually about — stays unenforced.
- **Make cross-project specifiers non-relative** and the constraint table comes
  alive.

The second was verified, not assumed. Adding
`"@reeve/core/*": ["./src/core/*"]` and `"@reeve/duties/*": ["./src/duties/*"]`
to `tsconfig.json`'s `paths` and rewriting `src/doctor`'s imports to use them —
ten files, mechanical — turns the doctor's edges into **18
`onlyTagsConstraintViolation`s** naming the rule and the reason:

```text
src/doctor/authority-agreement.test.ts:35:8  onlyTagsConstraintViolation
    A project tagged with "layer:doctor" can only depend on libs tagged with "layer:core"
  import      "@reeve/duties/dependa/capabilities.js" (static)  doctor → dependa
  constraint  sourceTag layer:doctor → onlyDependOnLibsWithTags [layer:core]
  rule        The doctor reads the core, never a duty.
```

`doctor → core` in the same file passes silently. That is the verdict the
boundary was written for, and the alias is what buys it.

The cost of buying it everywhere is roughly 500 import statements across ~180
files. It is mechanical and reviewable, but it is not small, and it changes
every file a contributor has a mental map of. It also has to survive
`tools/build.mjs` (esbuild resolves `paths` only with a plugin or a matching
`tsconfig`) and Node's `--experimental-strip-types` in `eval/`, both of which
resolve specifiers as written.

### What the first run already found

Three findings survive regardless of which branch above is taken, and all three
are real:

1. **`src/core/warrant.ts` imports `../duties/dependa/model.js`** (lines 59–60,
   one type-only, one value). The core reaching into one duty is the exact
   inversion [`architecture.md`](architecture.md#the-boundary) forbids: a helper
   in the core must be usable, unchanged, by a duty that does something
   unrelated, and `ECOSYSTEMS`/`UPDATE_TYPES` are dependa's vocabulary. Either
   those constants move into the core as a general concept, or the warrant's
   dependa block is parsed by dependa.

2. **Twenty-seven banned external imports in duty code**, tests excluded:
   eleven `@actions/github` (one in each duty's `main.ts`, plus
   `translate/text.ts` and `triage/record.ts`) and sixteen `node:` imports —
   `node:path` ×7, `node:fs/promises` ×6, and one each of `node:util`,
   `node:os`, `node:child_process`, concentrated in `review`. A duty's `main.ts`
   is its composition root and arguably earns the forge import; `review`
   reading the filesystem and spawning a child process is the boundary the doc
   calls the cheap mechanical test. Whichever way that argument lands, it should
   land in the config as either a constraint or a suppression with a reason —
   not in nobody's memory.

3. **Five `noRelativeOrAbsoluteExternals` on `../refusal.js`** — `src/main.ts`
   and `src/refusal.ts` sit above every project root, so an import of them
   crosses out of the model. Modelling `src/` as an `entry` project, or aliasing
   those two files, resolves it.

Note that finding 2's headline count is sensitive to how tests are treated. Test
files live beside their subject here, and a test reaching `node:fs` to build a
fixture is not a boundary break — 132 drops to 27 once
`**/*.test.ts` is suppressed for that message id alone.

### Staging

If axis A is wanted, it stages cleanly, and each stage is independently
valuable:

| Stage | What ships                                                                   | Cost                     |
| ----- | ---------------------------------------------------------------------------- | ------------------------ |
| 1     | `lattice.json` + config + CI job, relative-import rule suppressed            | Small; catches finding 2 |
| 2     | Fix findings 1 and 3; decide each suppression from stage 1 on the merits     | Small, real design work  |
| 3     | Path aliases repo-wide; drop the suppression; the constraint table goes live | ~500 imports, ~180 files |

Stage 1 must not be described as architecture enforcement in the repository's
own docs while stage 3 is outstanding. That is this repository's own D5 applied
to itself.

## Axis B — Lattice as evidence for the `review` duty

The seam already exists and is documented as such. `src/duties/review/architecture.ts`
carries an `ArchEvidence` record type with the comment: _"An external
architecture tool that already produces edges in the same shape can feed them
straight into `assess`."_ Today that check is a line-scanner over the proven
lines of a diff — no parser, no resolution, multiline imports missed by
construction, and blind to Go, Rust and Python entirely.

Lattice's `check --format json` emits a versioned envelope whose violation
records map onto the review duty's `Finding` without a translation layer worth
the name:

| Lattice violation field              | Reeve `Finding` field               |
| ------------------------------------ | ----------------------------------- |
| `sourceFile`                         | `path`                              |
| `line`                               | `line`                              |
| `messageId`                          | `ruleId`                            |
| `message` + `constraint.description` | `body`                              |
| `constraint.remediation`             | the fix line in the comment         |
| —                                    | `marker` (deterministic, non-model) |

The envelope also carries `coverage.complete`, `notAnalyzed` and `blindSpots` —
which is the part that matters most here. A review that says "no architecture
findings" is only worth reading if the tool could see the files; those fields
are what let the duty distinguish a clean verdict from a blind one and fail
closed the way D5 requires.

**Reeve must not run Lattice itself.** A duty may not shell out, and bundling a
tool that needs `typescript` as a peer into a committed esbuild bundle is not a
proposal anyone should make. The shape that fits the doctrine is an optional
input naming a report the consumer's own workflow already produced:

```yaml
- run: pnpm exec lattice check --format json --output lattice.json
  continue-on-error: true
- uses: ecoma-io/reeve/review@v0.9
  with:
    architecture-report: lattice.json
```

That keeps every existing property: the report is a file in the checkout, read
like the rules file and the packs, never fetched (D6); the duty gains no
capability; and the findings are deterministic, so they ride the existing
reconcile, marker and SARIF machinery unchanged.

The open question on this axis is scope, not feasibility: a whole-workspace
`check` reports violations across the entire repository, while a review comments
on a diff. Filtering the report to files the pull request touched is the obvious
answer and it is a decision, because a boundary broken elsewhere by this branch's
rename is precisely the finding a diff-scoped filter drops.

## What the exercise found in Lattice itself

Three findings, each reproduced on a workspace of four files rather than on this
one, so each stands without reading Reeve. Lattice is `0.11.1` throughout.
They are recorded here because they bound what axis A can promise: the first
one decides whether a green `lattice check` means anything in a repository
shaped like this one.

### 1. A suppression removes the checks that would have followed it

Two projects, `core` tagged `layer:core` and `feature` tagged `layer:feature`,
one rule — `layer:core` may only depend on `layer:core` — and one forbidden
import, `libs/core/index.ts` reaching into `libs/feature`. Three runs over the
same tree:

| run | how the import is spelled | suppressions                                     | verdict                                              |
| --- | ------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| 1   | `"../feature/index.js"`   | none                                             | `noRelativeOrAbsoluteImportsAcrossLibraries`, exit 1 |
| 2   | `"../feature/index.js"`   | that one message id, `path: "**"`, with a reason | **`✔ no boundary violations`, exit 0**               |
| 3   | `"@acme/feature"`         | none                                             | `onlyTagsConstraintViolation`, exit 1                |

Run 3 proves the edge really is forbidden. Run 2 is the same edge, still in the
tree, still counted by the run (`1 import in 2 files across 2 projects`), and
the envelope says `coverage.complete: true` with `blindSpots: []`.

The ordering itself is documented and deliberate — path spelling is judged
before the constraint table, and the reference page tells you that fixing the
reported problem makes the next id appear at the same line. The gap is that a
**suppression does not behave like a fix.** The policy schema says a suppression
"removes a verdict, never a failure" and that the file "is still fully
analyzed"; empirically it removes the verdict _and_ every check the site had
not reached yet. `waivers` cannot see the difference either — it reports the
row as "hiding 1 violation", when what the row actually costs is the whole
constraint table for every cross-project edge in the workspace.

For a repository that spells cross-project imports relatively — any
single-package repository, this one included — the documented, validated,
reason-bearing move is the one that turns the gate off in silence.

Either behaviour would close it: let a suppressed site fall through to the
checks below it, or record the skipped evaluations so `coverage.complete`
cannot read `true` while a declared rule went unevaluated.

### 2. A dead waiver is exit 3 in one form and silent in the other

A `coverage.exempt` row matching nothing refuses the run outright, and says
exactly why:

```text
lattice: lattice.json describes a workspace that does not match the tree:
  coverage.exempt: 'src/gone/**' matches no unclaimed file — either the files it
  covered are now owned by a project, or the path was never right
```

A `boundarySuppressions` row matching nothing does not reach `check` at all.
Only `waivers` — a descriptive command that never exits non-zero, and so never
runs in a gate — names it, as "covers nothing right now".

Both rows are the same kind of declaration: an accepted breach, written down
with a reason. The one that hides a verdict gets the weaker treatment. The
`messageId` field on the same row is already validated to the letter (a typo is
exit 3, listing all fifteen valid ids), so the shape of a suppression is
checked far more strictly than its effect.

### 3. A file `coverage.exempt` legitimises cannot be imported

`coverage.exempt` is the documented answer for a tracked, analyzable file that
sits outside every project root — the getting-started walkthrough uses it for
the boundary config itself. Exempt such a file and import it from a project,
and the run fails:

```text
libs/core/index.ts:1:25  noRelativeOrAbsoluteExternals
    External resources cannot be imported using a relative or absolute path
  import      "../version.js" (static)  core → (unresolved)
```

The file is tracked, inside the workspace, and named in `lattice.json`; calling
it an external resource is the one description that is not true of it. Nor is
there a configuration that makes the import legal: declaring a parent project
to own it is accepted — nested roots are allowed — but only converts the
finding into `noRelativeOrAbsoluteImportsAcrossLibraries`, which is finding 1's
wall from the other side. So the feature that answers the coverage question
creates a boundary question with no answer but a suppression.

This is not hypothetical here: `src/refusal.ts` holds the duty roster that
`src/core` and `src/doctor` both read, and it produced five of these.

## What this note does not decide

- Whether the ~500-import alias refactor is worth its review cost, and whether
  it happens before or after 1.0.
- Whether `main.ts`'s `@actions/github` import is a boundary break or the
  composition root's privilege. The config has to state one.
- Whether `doctor → duties` is a violation or a fourth layer. The doctor
  aggregates each duty's `capabilities.js` by design; the table above calls it a
  violation, which may be the table being wrong rather than the code.
- Whether axis B ships as a `review` input or waits for the 2.x evidence
  surface described in [`roadmap-2x.md`](roadmap-2x.md).

---

**Related:** [Architecture](architecture.md) · [Duties](duties.md) ·
[Development portal](README.md)
