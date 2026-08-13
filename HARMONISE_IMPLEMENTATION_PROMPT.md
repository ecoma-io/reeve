# Prompt: Implement and dogfood the `harmonise` duty for Reeve

## Context

You are implementing a new duty called `harmonise` for the Reeve repository upkeep tool at `/home/johnitvn/Desktop/workspaces/ecoma-io/reeve`. Reeve is a GitHub Actions-based automation that keeps a repository's recurring work moving on the maintainer's behalf. It currently ships five duties: `triage`, `translate`, `duplicate`, `respond`, and `lifecycle`. You are adding the sixth.

The `harmonise` duty is described in detail in GitHub issue #41: https://github.com/ecoma-io/reeve/issues/41

Read that issue first. Read it fully. Everything below assumes you have.

## What `harmonise` does

`harmonise` lets contributors edit repository documentation files in **any** configured language and keeps locale variants synchronised. It is NOT naive file translation — it is a version-control system for semantic changes across languages. When a contributor edits a locale file, `harmonise` classifies the diff and only propagates shared semantic changes to other locales, leaving translation corrections and locale-specific adaptations local.

## How this duty differs from `translate` — critical

`translate` and `harmonise` share core infrastructure but are separate duties because:

|                     | `translate` (thread)                    | `harmonise` (docs)                                            |
| ------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Input               | Issue/PR body — hostile, untrusted (D8) | Repo Markdown file — committed, trusted                       |
| Output              | Append translation to thread body       | Create/update files, open PR                                  |
| Stakes              | Low — bad translation = delete comment  | High — bad translation = wrong docs committed                 |
| Model tier          | Cheap OK (speed > accuracy)             | Careful preferred (accuracy > speed)                          |
| Capability          | `edit-body`                             | `edit-file`, `open-pr`                                        |
| Security            | Sanitiser assumes injection (D8)        | No thread sanitiser needed (input is committed)               |
| Provenance          | Not needed                              | Must track — docs have history, need sync                     |
| Diff classification | Not needed                              | Must classify: correction / semantic change / locale-specific |

DO NOT merge these into one duty. DO NOT add a mode switch. Doctrine §3 explicitly forbids mode enums: "There is no `mode: basic` or `mode: full` anywhere in this design."

## Step-by-step implementation order

Follow the order in `/home/johnitvn/Desktop/workspaces/ecoma-io/reeve/docs/development/duties.md` exactly:

### 1. Earn it (D10)

Verify the duty passes D10 before writing any code. The argument is already in issue #41. If you find the argument weak, say so — do not implement a duty that fails D10.

### 2. Write the evaluation first (D11)

Create multilingual evaluation fixtures BEFORE writing the duty code. At minimum EN + VI. The fixtures must cover:

- A shared semantic change (new section added to EN file → should propagate to VI)
- A translation correction (fixing a bad VI translation → should NOT propagate to EN)
- A locale-specific adaptation (VI-specific link or example → should NOT propagate)
- Idempotency (running again with no changes → no action)
- Conflict (human edit in target locale since last sync → report, do not overwrite)

### 3. Write the reference doc

Create `docs/reference/duties/harmonise.md` following the same structure as `docs/reference/duties/translate.md`. This is the contract — inputs, outputs, failure behavior, dry-run behavior, cost, security considerations. Write it BEFORE the code.

### 4. Write the duty

Create `src/duties/harmonise/` following the same structure as `src/duties/translate/`. Key files:

- `capabilities.ts` — default capabilities: `edit-file` and `open-pr` (NOT `edit-body`)
- `main.ts` — entry point
- Core duty logic — diff classification, provenance tracking, PR creation
- Tests — unit, integration, contract (see duties.md testing section)

### 5. Wire the action

Create `harmonise/action.yml` with every input and its default. This is the ONLY place inputs are declared. Add the entry point to `tools/build.mjs` and the duty's directory to the `duties` list in the archive step of `.github/workflows/release.yml`.

### 6. Add the commit scope

Update `commitlint.config.mjs` and `CONTRIBUTING.md` with the `harmonise` commit scope.

## Architecture constraints — read these or you will fail review

Read these files before writing any code:

1. **`/home/johnitvn/Desktop/workspaces/ecoma-io/reeve/docs/development/architecture.md`** — The boundary between core and duty. A duty may NOT construct HTTP clients, call providers directly, read config files, decide its own permissions, write to the forge, or import platform SDKs. A duty's dependencies are the core's exported services and nothing else.

2. **`/home/johnitvn/Desktop/workspaces/ecoma-io/reeve/docs/doctrine/north-star.md`** — All 12 doctrine items (D1–D12). The duty must satisfy every one. Pay special attention to:
   - D1: Must work across language boundary, not English-only
   - D2: New capabilities (`edit-file`, `open-pr`) need warrant surface designed in the same PR
   - D3: Never overwrite human edits — human work is inviolable
   - D5: Loud failure — never green on empty/broken result
   - D6: State as files in repo (`.reeve/harmonise-state.json`)
   - D9: Idempotent — re-run with no change = no action
   - D10: Must earn its place (recurs, uniformly expensive, maintainers stopped, harder multilingual)
   - D11: Ships with multilingual evaluation

3. **`/home/johnitvn/Desktop/workspaces/ecoma-io/reeve/docs/development/duties.md`** — The mechanics of adding a duty. Follow this exactly.

4. **`/home/johnitvn/Desktop/workspaces/ecoma-io/reeve/docs/concepts/duties-and-the-core.md`** — What a duty is, what the core supplies, what a duty supplies back.

## Diff classification design

This is the hardest part of the design. When a contributor edits a locale file, `harmonise` must classify the diff:

1. **Translation correction** — fixing a bad translation in one locale → NO propagation
2. **Shared semantic change** — new section, changed meaning, updated instructions → PROPAGATE delta to all other locales
3. **Locale-specific adaptation** — local link, local example, regional note → NO propagation

How to classify? The model must compare the diff against the source document's current state and the target's current state. If the diff changes something that exists in the source (aligning a translation with an existing source change), it's a correction. If the diff adds or changes meaning not present in the source, it's a semantic change. If the diff adds locale-only content (links, examples, legal notes), it's locale-specific.

This classification must be evaluated. Build fixtures for it.

## Provenance tracking

State file at `.reeve/harmonise-state.json` tracks per-document sync status:

```json
[
  {
    "id": "reeve-getting-started",
    "files": {
      "en": "docs/getting-started.md",
      "vi": "docs/getting-started.vi.md"
    },
    "source-revision": "abc123def456",
    "synced": {
      "vi": "abc123def456"
    },
    "stale": []
  }
]
```

When a source file changes (diff detected via git SHA), `harmonise` marks target locales as stale and opens a sync PR. The PR updates the stale locales. If a target locale has human edits since last sync, report conflict — DO NOT overwrite.

## File naming convention

Suffix pattern (NOT locale folders):

```text
docs/getting-started.md       ← EN (default, no suffix)
docs/getting-started.vi.md    ← VI
docs/getting-started.zh.md    ← ZH
README.md                     ← EN
README.vi.md                  ← VI
```

`harmonise` discovers locale variants by scanning for the suffix pattern. The base name (before locale suffix) is the document group key.

## Operating rules — non-negotiable

1. **Never commit directly to default branch.** Always open a PR.
2. **Never overwrite human edits.** If target locale has human edits since last sync, report conflict.
3. **Glossary-enforced.** Read `.reeve/glossary.yml` before every translation. Override = bug.
4. **Protect non-prose.** Code fences, CLI flags, API names, URLs, frontmatter — parse out before translation, restore after.
5. **Idempotent.** No change = no PR, no model call.
6. **Loud failure.** Model error or partial completion → red run or warning, never silent green.

## Capabilities

New warrant capabilities needed:

- `edit-file` — permission to create/modify repository files
- `open-pr` — permission to open pull requests

These are qualitatively different from `translate`'s `edit-body`. Design the warrant surface in the same PR as the duty implementation (D2).

At level 0 (no warrant file), `harmonise` should NOT run — unlike `translate` which defaults to `edit-body` at level 0. `edit-file` + `open-pr` is too much authority for zero-config. The duty should require explicit opt-in via warrant.

## What to reuse from core

`harmonise` should reuse the core's:

- Language layer (detection, resolution)
- Provider + model fallback + draft/score/judge pipeline
- Chunking logic (with code-fence protection)
- Glossary loading
- Meter (cost tracking)
- Summary writing

`harmonise` should NOT reuse:

- Thread sanitiser (input is trusted, not hostile)
- Thread-based idempotency marker (docs use git SHA, not thread markers)

## Dogfooding

After implementation, dogfood `harmonise` on the reeve repo itself:

1. Create multilingual versions of key docs using suffix convention:
   - `docs/getting-started.vi.md`
   - `docs/reference/duties/harmonise.vi.md`
   - Any other docs that make sense

2. Add `.reeve/glossary.yml` with reeve-specific terms (warrant, duty, checkpoint, etc.)

3. Add `.reeve/harmonise-state.json` with initial state

4. Configure a workflow to run `harmonise` on push to docs

5. Verify: edit an EN doc → `harmonise` opens PR updating VI. Edit VI translation fix → no propagation. Add locale-specific note → no propagation.

## Important warnings

- **Read existing duty code before writing.** Study `src/duties/translate/` and `src/duties/triage/` thoroughly. Follow their patterns exactly. If you need something the core doesn't provide, that's a core change in its own commit — not a private helper in the duty.

- **The core may not contain duty-specific logic.** If you add something to `src/core/` that only `harmonise` could use, it belongs in `src/duties/harmonise/`.

- **Tests with only happy paths are not finished.** A duty is judged on what it does when the model misbehaves, not on what it does when everything works.

- **0.x line: no backward-compat concerns.** If you need to rename an existing core function to make `harmonise` work cleanly, do it. But explain the rename in the commit message.

- **Every new capability needs a warrant surface.** `edit-file` and `open-pr` must be expressible in `.github/reeve.yml` and checked in code against the file — never against the model's claim (D2).

- **Ask before building something the core doesn't have.** "A third duty that needs something neither of them does is worth a conversation before it is worth a branch." (duties.md)
