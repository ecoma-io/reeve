# Reeve Adversarial Review — Reviewer B: THE ATTACKER

**Reviewer:** Reviewer B (adversarial)
**Date:** 2026-08-15
**Branch:** `first-contact/usability-audit`
**Baseline:** `acfc4a9` (main, v0.6.0)
**Scope:** Findings Phase 1 missed, verified against source code

---

## Methodology

Phase 1 audited the repository through ten first-contact personas and found
12 findings (P1-1 through P3-4). This review assumes Phase 1's findings are
correct and does not duplicate them. Instead, it attacks the areas Phase 1
treated lightly or missed entirely:

1. **Action.yml defaults vs documentation** — traced every default to code
2. **Doc cross-links** — walked every inter-document link, including fragments
3. **Example workflows** — compared every doc example against every dogfood
   workflow, looking for missing required steps
4. **Model references** — verified the quick-start model exists and is current
5. **Failure mode analysis** — traced code paths for common misconfigurations
6. **"Five minutes, no prerequisites"** — verified the claim end-to-end
7. **Surprising defaults** — compared action.yml defaults against what a
   newcomer would expect
8. **Duty-specific hidden requirements** — traced what each duty actually
   imports and calls

Source code was read extensively. Every finding below includes the file and
line number of the evidence.

---

## Findings

### P0-1: Every documentation example omits `actions/checkout`, creating a silent warrant bypass

**Severity: P0**

**Affected files (38 uses, zero checkouts):**

| File                                     | Lines   | Example type          |
| ---------------------------------------- | ------- | --------------------- |
| `README.md`                              | 79–83   | Quick start triage    |
| `README.md`                              | 87–91   | Quick start translate |
| `docs/getting-started/installation.md`   | 34      | Five-minute triage    |
| `docs/getting-started/installation.md`   | 237–244 | Backfill translate    |
| `docs/getting-started/first-workflow.md` | 28      | Two-duty triage       |
| `docs/getting-started/first-workflow.md` | 37      | Two-duty translate    |
| `docs/reference/duties/triage.md`        | 64      | Minimal triage        |
| `docs/reference/duties/triage.md`        | 185     | Record triage         |
| `docs/reference/duties/translate.md`     | 61      | Minimal translate     |
| `docs/reference/duties/respond.md`       | 71      | Minimal respond       |
| `docs/reference/duties/lifecycle.md`     | 57      | Minimal lifecycle     |
| `docs/reference/duties/harmonise.md`     | 65      | Minimal harmonise     |
| `docs/reference/duties/dependa.md`       | 88      | Minimal dependa       |
| `docs/reference/duties/duplicate.md`     | 59      | Minimal duplicate     |

`actions/checkout` appears zero times across all documentation. It appears in
every single dogfood workflow (`.github/workflows/reeve-*.yml`, 12 workflows),
always as the first step before the duty.

**Why this matters — the silent warrant bypass:**

The warrant file (`.github/reeve.yml`) is read from the **local filesystem**
via Node's `readFile` (`src/core/warrant.ts:368`). When a workflow lacks
`actions/checkout`, the runner has no copy of the repository on disk. The
warrant file cannot be found. Because it is at the default path,
`readWarrant()` returns `null` (`src/core/warrant.ts:370`), and
`resolveAuthority()` builds the **implicit warrant** instead
(`src/core/warrant.ts:646-657`).

In the implicit warrant, every duty gets its **full fallback defaults**:

```
granted: (_duty, fallback) => fallback   // warrant.ts:612
unnamed: () => false                      // warrant.ts:613
```

Contrast with a parsed warrant that has a `capabilities:` block:

```
granted: (duty, fallback) => capabilities.get(duty) ?? (declared ? [] : fallback)  // warrant.ts:444
unnamed: (duty) => declared && !capabilities.has(duty)                               // warrant.ts:445
```

When `declared` is true (warrant file was read), duties not named in
`capabilities:` get `[]` — they are denied. When the warrant is silently
bypassed, `declared` is false and every unnamed duty gets its fallback
instead. A maintainer who writes:

```yaml
capabilities:
  translate: [edit-body]
```

intending to deny `triage` any authority, will find triage still running
with `["label"]` — its fallback default — because the warrant was never read.

**This is P0 because:**

- It affects every user who follows the documentation (all of them)
- The failure is **silent** — no error, no warning, no log line. The duty
  runs normally under the implicit warrant, and the maintainer never knows
  their restrictions were ignored
- It directly undermines the authority model, which is the product's core
  thesis ("the warrant is the whole answer")
- The dogfood workflows all include checkout, so the maintainers have never
  experienced this failure mode themselves — it is invisible to them
- A level-0 user with no warrant file is unaffected (implicit warrant is
  correct for them). The danger emerges **exactly when** a user advances to
  level 1+ and writes a warrant — the exact moment they believe they are
  **adding** restrictions, those restrictions are silently voided
- `doctor: true` cannot detect this: `diagnose.ts` calls `readWarrant`
  through the same code path, which also reads from the local filesystem
  (`src/doctor/diagnose.ts:177`)

**Mitigation path:** Either add `actions/checkout` to every example workflow,
or (if the maintainers want level-0 to work without checkout) add a runtime
check that logs a warning when a warrant file is absent at the default path
but the checkout directory is empty/missing.

---

### P1-3: ~110 broken north-star anchor fragments across 15+ files

**Severity: P1**

**Root cause:** The `north-star.md` headings use em-dashes:

```markdown
### D12 — Capacity is weather, authority is configuration
```

GitHub's heading slugger converts em-dashes (and any non-alphanumeric
characters) to single hyphens, producing:

```
#d12-capacity-is-weather-authority-is-configuration
```

But every cross-reference in the codebase uses **double hyphens**:

```
[north-star.md#d12--capacity-is-weather-authority-is-configuration]
```

These double-hyphen anchors do not match any heading. Every single
cross-reference to a D-number doctrine heading is broken.

**Scope:** There are 110 references to `north-star.md#` across markdown
files and TypeScript source comments. The unique broken anchors include:

| Used in docs                                                             | Intended heading                                      | Actual GitHub slug                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `#d1--no-duty-is-english-only`                                           | D1 — No duty is English-only                          | `#d1-no-duty-is-english-only`                                           |
| `#d2--authority-is-granted-written-and-bounded`                          | D2 — Authority is granted, written, and bounded       | `#d2-authority-is-granted-written-and-bounded`                          |
| `#d3--the-humans-work-is-inviolable`                                     | D3 — The human's work is inviolable                   | `#d3-the-humans-work-is-inviolable`                                     |
| `#d4--the-work-is-priced-before-it-is-done`                              | D4 — The work is priced before it is done             | `#d4-the-work-is-priced-before-it-is-done`                              |
| `#d5--failure-is-loud-it-is-never-plausible`                             | D5 — Failure is loud; it is never plausible           | `#d5-failure-is-loud-it-is-never-plausible`                             |
| `#d6--the-repository-is-the-database`                                    | D6 — The repository is the database                   | `#d6-the-repository-is-the-database`                                    |
| `#d7--any-endpoint-including-the-free-ones`                              | D7 — Any endpoint, including the free ones            | `#d7-any-endpoint-including-the-free-ones`                              |
| `#d8--every-thread-is-hostile`                                           | D8 — Every thread is hostile                          | `#d8-every-thread-is-hostile`                                           |
| `#d9--re-running-is-cheap-and-safe`                                      | D9 — Re-running is cheap and safe                     | `#d9-re-running-is-cheap-and-safe`                                      |
| `#d10--a-duty-must-earn-its-place`                                       | D10 — A duty must earn its place                      | `#d10-a-duty-must-earn-its-place`                                       |
| `#d11--every-duty-ships-with-an-evaluation`                              | D11 — Every duty ships with an evaluation             | `#d11-every-duty-ships-with-an-evaluation`                              |
| `#d12--capacity-is-weather-authority-is-configuration`                   | D12 — Capacity is weather, authority is configuration | `#d12-capacity-is-weather-authority-is-configuration`                   |
| `#91--does-reeve-modify-repository-state-only-within-explicit-authority` | 9.1 — Does Reeve modify repository state? ...         | `#91-does-reeve-modify-repository-state-only-within-explicit-authority` |
| `#beyond-10--the-2x-line--direction-nothing-ships`                       | Beyond 1.0 — the 2.x line · direction, nothing ships  | `#beyond-10-the-2x-line-direction-nothing-ships`                        |

Additionally, `#d2--no-mutation-beyond-declared-authority`
(`docs/reference/root-action.md:127`) does not correspond to any heading
at all. D2's heading is "Authority is granted, written, and bounded," not
"No mutation beyond declared authority." This is a wrong reference, not
just a broken anchor.

**Affected files** (non-exhaustive — 15+ files contain these anchors):

- `docs/guides/warrant.md` (8 references)
- `docs/security/threat-model.md` (3)
- `docs/security/security.md` (1)
- `docs/reference/root-action.md` (3, including wrong-reference)
- `docs/guides/doctor.md` (1)
- `docs/guides/languages.md` (4)
- `docs/guides/cost.md` (1)
- `docs/guides/sweep.md` (1)
- `docs/concepts/dependency-maintenance.md` (4)
- `docs/development/architecture.md` (1)
- `docs/development/duties.md` (2)
- `docs/README.md` (1)
- `src/doctor/diagnose.ts` (1)
- `src/duties/respond/guidance.ts` (1)
- `src/core/warrant.ts` (1+)

**Severity justification:** The doctrine document is the foundation of every
security and authority claim in the project. Every link to it is broken. A
reader who clicks any "[D8]" or "[D12]" reference lands at the top of the
page, not at the heading they need. This is P1 because it makes the
project's doctrinal foundation unreachable via navigation, and the volume
(110 references) makes it a systemic problem rather than an isolated typo.

---

### P1-4: `dogfood.md` has 8 broken relative-path links

**Severity: P1**

**File:** `docs/guides/dogfood.md`

Line 3 and line 139 contain relative links that are wrong for a file in the
`docs/guides/` directory:

| Used                              | Resolves to                                         | Correct                              |
| --------------------------------- | --------------------------------------------------- | ------------------------------------ |
| `concepts/authority-model.md`     | `docs/guides/concepts/authority-model.md` (404)     | `../concepts/authority-model.md`     |
| `guides/warrant.md`               | `docs/guides/guides/warrant.md` (404)               | `warrant.md`                         |
| `reference/warrant-format.md`     | `docs/guides/reference/warrant-format.md` (404)     | `../reference/warrant-format.md`     |
| `concepts/duties-and-the-core.md` | `docs/guides/concepts/duties-and-the-core.md` (404) | `../concepts/duties-and-the-core.md` |

All 8 links (4 on line 3, 4 on line 139) hit 404. A reader following the
dogfood guide's prerequisite links or related-links section is sent to dead
ends.

**Severity justification:** The dogfood guide is the entry point for
understanding how Reeve runs on itself — a critical trust-building page.
All its navigation links are broken.

---

### P1-5: "Prerequisites: None" is factually incorrect

**Severity: P1**

**File:** `docs/getting-started/installation.md:3`

> _Get a first workflow running in five minutes. Prerequisites: None._

The actual prerequisites are:

1. **A GitHub repository** — you cannot use Reeve without one
2. **An OpenAI API key with billing enabled** — the `models` input defaults
   to `gpt-5-mini` which requires a paid OpenAI API key. A free-tier OpenAI
   key or a key without billing will fail with a 429/402 error, and the
   troubleshooting guide does not mention this failure mode
3. **The `OPENAI_API_KEY` secret configured in the repository** — not
   mentioned until the `api-key` input line in the example
4. **`actions/checkout`** (see P0-1 above)

"Prerequisites: None" is the very first thing a new user reads. When their
first run fails because they don't have an OpenAI key with billing, or
haven't configured the secret, the promise is already broken.

**Severity justification:** The "no prerequisites" claim is the hook that
draws a user in. It is false. A user who trusts it and attempts the
five-minute install will fail at step one. This is P1 because it directly
undermines the first-contact promise at the moment of highest intent.

---

### P1-6: `duties-and-the-core.md` makes false boundary claims

**Severity: P1**

**File:** `docs/concepts/duties-and-the-core.md:64-66`

> **Talk to the outside world.** If a duty imports anything that fetches,
> reads the filesystem, or touches the GitHub API, the boundary broke.

This claim is **false**. Every duty imports `@actions/github` and the core
`forge.js` module (which wraps the GitHub API):

```
src/duties/triage/main.ts:     imports @actions/github, forge.js
src/duties/translate/main.ts:   imports @actions/github, forge.js
src/duties/respond/main.ts:     imports @actions/github, forge.js
src/duties/lifecycle/main.ts:   imports @actions/github, forge.js
src/duties/harmonise/main.ts:   imports @actions/github, forge.js
src/duties/dependa/main.ts:     imports @actions/github, forge.js
src/duties/duplicate/main.ts:   imports @actions/github, forge.js
```

Additionally, `respond/guidance.ts` directly reads the filesystem via
`import { readFile } from "node:fs/promises"`.

The doc also claims (line 18): "The pipeline is the program, and it is the
same pipeline for every duty." This is inaccurate: `lifecycle` has no model
call at all, `dependa` uses a discovery/classify/propose flow rather than
screen/draft/score, and dry-run gating differs per duty (lifecycle gates
labels, comments, close, and un-stale separately; triage gates label
creation, application, assignment, and close separately).

**Severity justification:** This page is the conceptual foundation for
understanding the duty/core boundary. A security reviewer reading it would
form an incorrect mental model of what duties can and cannot do. The claim
that duties never import the GitHub API or read the filesystem would lead a
reviewer to not look for injection surfaces in duty code — when they
actually exist.

---

### P1-7: `contents: read` permission table is misleading

**Severity: P1**

**File:** `docs/getting-started/installation.md:263`

> | Reading a taxonomy or memory | `contents: read` |

This row implies that the `contents: read` permission is what lets a duty
read the warrant file, the taxonomy (labels), and the corrections/memory
directory. But the warrant, taxonomy, corrections, and guidance are all read
from the **local filesystem** via Node's `readFile`/`readdir`
(`src/core/warrant.ts:368`, `src/core/memory.ts:502-514`,
`src/duties/respond/guidance.ts:52`). The `contents: read` GitHub permission
controls the **Contents API** (`GET /repos/{owner}/{repo}/contents/...`),
which is a different mechanism entirely.

The actual duty that uses the Contents API is `dependa` (reads manifests
via `readContentsFile` in `src/duties/dependa/main.ts:194`), and `harmonise`
(reads blobs via `readBlob`). A user who grants `contents: read` thinking
they've covered "reading a taxonomy" has not — the taxonomy is read from
labels via the Issues/Labels API, not the Contents API.

Meanwhile, a user who _does not_ add `actions/checkout` but _does_ grant
`contents: read` may believe they've done everything needed, when in fact
the local filesystem reads will still fail silently (see P0-1).

The troubleshooting guide reinforces this confusion at line 100:
"Reading files | contents: read" — same misleading conflation.

**Severity justification:** The permission model is how a user controls what
Reeve can do. If the permission table misleads about what each permission
controls, a user cannot make informed decisions. This is P1 because it
directly undermines the user's ability to correctly configure permissions.

---

### P1-8: Backfill example has no `permissions` block

**Severity: P1**

**File:** `docs/getting-started/installation.md:228-245`

```yaml
on:
  workflow_dispatch:
    inputs:
      number:
        description: Issue or pull request number
        required: true

jobs:
  reeve:
    runs-on: ubuntu-latest
    steps:
      - uses: ecoma-io/reeve/translate@v0.1
        with:
          number: ${{ inputs.number }}
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
```

This example is missing both `actions/checkout` (see P0-1) and a
`permissions` block. The five-minute example and the issues/PR trigger
examples all include `permissions`, but the backfill example does not.
A `workflow_dispatch` trigger runs with the repository's default
permissions, which may be `write` on everything — granting the duty far more
than it needs, violating the principle of least privilege that the
documentation itself advocates.

**Severity justification:** The backfill example is the one a user is most
likely to copy for a production run against a specific thread. It grants
excessive permissions by omission. P1 because it directly contradicts the
project's own security doctrine.

---

### P2-7: `dry-run.md` claims "only the publish step is missing" — misleading

**Severity: P2**

**File:** `docs/guides/dry-run.md:12-14`

> Nothing about the pipeline is skipped or stubbed; the only thing missing
> is the publish step at the very end.

In `lifecycle`, dry-run gates four separate actions independently:

- Adding labels (`if (!dryRun) await effects.addLabels(...)`) — `main.ts:354`
- Posting comments (`if (!dryRun) { await effects.addComment(...) }`) — `main.ts:359`
- Closing issues (`if (!dryRun) await effects.closeAsNotPlanned()`) — `main.ts:372`
- Removing stale labels (`if (!dryRun) await effects.removeLabel(...)`) — `main.ts:380`

In `triage`, dry-run gates:

- Creating labels (`if (dryRun) { ... return; }`) — `main.ts:1148`
- Applying labels
- Assignment
- Close

These are separate guard points throughout the code, not a single "publish
step at the very end." The doc's phrasing implies the entire pipeline runs
to completion and only the final write is withheld, when in reality multiple
side effects are independently gated at the point of each effect.

**Severity justification:** A user relying on this description might assume
that dry-run exercises all code paths, including the side-effect code
(creating labels, closing issues). In reality, those code paths are skipped
entirely, meaning bugs in the side-effect code would not surface in dry-run.

---

### P2-8: README quick start missing `timeout-minutes` and `concurrency`

**Severity: P2**

**File:** `README.md:65-93`

The README quick-start workflow is missing both `timeout-minutes` and
`concurrency`, while the same example in `installation.md:14-38` includes
both. A user copying the README version risks unbounded run time (a stuck
model call can burn credits indefinitely) and parallel runs on the same
thread (wasting model calls and producing conflicting outcomes).

The installation.md version correctly includes:

```yaml
concurrency:
  group: reeve-issue-${{ github.event.issue.number }}
  cancel-in-progress: true

timeout-minutes: 10
```

**Severity justification:** The README is the most-copied example. Missing
these guardrails means most first-contact users run without them.

---

### P2-9: All examples pin `@v0.1` but the current release is `v0.6.0`

**Severity: P2**

**Files:** All documentation examples and action.yml comments

Every example uses `@v0.1`:

```yaml
- uses: ecoma-io/reeve/triage@v0.1
```

But `package.json` says `0.6.0`, and the repository has tags through `v0.6.0`.
Phase 1 noted the versioning semantics were confusing (P2-2), but missed that
the examples are 5 minor versions behind the latest release. A user following
the docs installs a version that is at least 5 releases old, missing any
fixes or improvements shipped in v0.2 through v0.6.

The `releasing.md` doc explains that `v0.1` is a floating patch ref that
auto-updates, but this is not mentioned anywhere in the quick start or any
example. A first-contact user sees `@v0.1` and reasonably assumes they are
installing version 0.1.

**Severity justification:** Users install an outdated version by default.
The floating-patch behavior is undocumented at the point of use.

---

### P2-10: `SECURITY.md#security` anchor is broken

**Severity: P2**

**File:** `SECURITY.md:66`

```markdown
[the README says not to](README.md#security)
```

The README has no heading containing "Security" — `grep -i '^##.*security' README.md`
returns no results. The link navigates to the top of the README, not to any
security section.

**Severity justification:** This is a security document linking to a
non-existent security section. A vulnerability reporter following this link
will not find the guidance they need.

---

### P2-11: `doctor: true` cannot detect the missing-checkout misconfiguration

**Severity: P2**

**File:** `src/doctor/diagnose.ts:177`

The doctor mode calls `readWarrant()` through the same code path as every
duty's `main.ts`. When `actions/checkout` is missing, doctor reads no
warrant file (ENOENT at default path returns null), builds the implicit
warrant, and reports that everything is healthy — because the implicit
warrant _is_ healthy. It has no way to distinguish "no warrant file because
the user hasn't written one" from "no warrant file because checkout was
skipped and the user's carefully crafted warrant is sitting unread in the
repository."

Doctor is documented as the way to verify your configuration before going
live. It cannot detect the most common misconfiguration.

**Severity justification:** Doctor is explicitly recommended in the README
as a pre-flight check. Its inability to detect missing checkout means a
user who follows the recommended workflow (write warrant, run doctor, go
live) will pass doctor with flying colors while their warrant is being
silently ignored.

---

### P2-12: No model compatibility reference or requirement exists

**Severity: P2**

**Files:** `README.md`, `docs/getting-started/installation.md`

The quick start uses `gpt-5-mini` as the default model. `gpt-5-mini` is a
real OpenAI model (confirmed via developers.openai.com), but it belongs to
the legacy GPT-5 generation. The current generation is GPT-5.6 (Sol/Terra/
Luna). There is no documentation about:

- Which models are supported or recommended
- What capabilities a model needs (tool use? structured output?)
- What happens if you use a model that lacks required capabilities
- Whether non-OpenAI providers work and what their requirements are
- That OpenAI billing must be enabled (a free-tier key will fail)

A user who tries a model from the current generation, or who switches
providers, has no guidance on what will work.

**Severity justification:** The model is the most expensive and most
important runtime dependency. No compatibility documentation exists.

---

### P2-13: Quick start never mentions `dry-run: true` before going live

**Severity: P2**

**Files:** `README.md:65-93`, `docs/getting-started/installation.md:14-38`

The triage duty reference (`docs/reference/duties/triage.md:76`) recommends
running with `dry-run: true` before live use. The dry-run guide
(`docs/guides/dry-run.md`) says to "run it that way against ten real threads
first." But the quick start — the example a first-contact user copies —
does not include `dry-run: true`. The README even says (line 98-99):

> Before granting a capability for real, check what your warrant would
> actually do with `uses: ecoma-io/reeve@v0.1` and `doctor: true`

But `dry-run` is never mentioned in the quick start flow. A user following
the quick start goes live on their first run without any rehearsal.

**Severity justification:** The product's own documentation recommends
dry-run as essential before live use, but the quick start omits it. A
first-contact user's very first run labels real issues in production.

---

### P2-14: OpenAI billing requirement never mentioned

**Severity: P2**

**Files:** All documentation

The quick start requires `secrets.OPENAI_API_KEY`. Nowhere is it documented
that this key must have billing enabled. OpenAI's free tier and trial keys
cannot call GPT-5 models. A user with a free-tier key will get a 429 or
402 error at their very first run, and the troubleshooting guide does not
cover this failure mode.

The cost guide (`docs/guides/cost.md`) discusses pricing per token but never
mentions the prerequisite that billing must be active on the API key.

**Severity justification:** The most common first-contact failure for any
OpenAI-powered tool is "my key doesn't have billing." Not documenting this
means every user who hits it is stuck.

---

### P3-5: `d2--no-mutation-beyond-declared-authority` references a non-existent heading

**Severity: P3**

**File:** `docs/reference/root-action.md:127`

```markdown
[D2](../doctrine/north-star.md#d2--no-mutation-beyond-declared-authority)
```

No heading in `north-star.md` reads "D2 — No mutation beyond declared
authority." The actual D2 heading is "D2 — Authority is granted, written,
and bounded." This is not just a broken anchor (like P1-3) — the text
itself is wrong. D2 is about authority being granted and bounded, not
specifically about "no mutation." That concept exists but is distributed
across multiple doctrines.

---

## Finding summary (new findings only)

| ID    | Severity | Summary                                                              | Category              |
| ----- | -------- | -------------------------------------------------------------------- | --------------------- |
| P0-1  | P0       | Every doc example omits `actions/checkout` — silent warrant bypass   | Documentation vs code |
| P1-3  | P1       | ~110 broken north-star anchor fragments (double-hyphen vs single)    | Broken links          |
| P1-4  | P1       | 8 broken relative-path links in `dogfood.md`                         | Broken links          |
| P1-5  | P1       | "Prerequisites: None" is false (needs repo, paid OpenAI key, secret) | Misleading claim      |
| P1-6  | P1       | `duties-and-the-core.md` falsely claims duties never import API/fs   | Documentation vs code |
| P1-7  | P1       | `contents: read` permission table conflates API and filesystem reads | Misleading docs       |
| P1-8  | P1       | Backfill example has no `permissions` block                          | Missing safeguards    |
| P2-7  | P2       | `dry-run.md` "only publish step missing" is misleading               | Misleading docs       |
| P2-8  | P2       | README quick start missing `timeout-minutes` and `concurrency`       | Missing safeguards    |
| P2-9  | P2       | All examples pin `@v0.1` but current release is `v0.6.0`             | Stale references      |
| P2-10 | P2       | `SECURITY.md#security` anchor is broken                              | Broken link           |
| P2-11 | P2       | Doctor cannot detect missing-checkout misconfiguration               | Feature gap           |
| P2-12 | P2       | No model compatibility reference exists                              | Documentation gap     |
| P2-13 | P2       | Quick start omits `dry-run: true` before going live                  | Documentation gap     |
| P2-14 | P2       | OpenAI billing requirement never mentioned                           | Documentation gap     |
| P3-5  | P3       | `d2--no-mutation-beyond-declared-authority` references wrong heading | Wrong reference       |

---

## Combined severity count (Phase 1 + Phase 2)

| Severity  | Phase 1 | Phase 2 | Total  |
| --------- | ------- | ------- | ------ |
| P0        | 0       | 1       | 1      |
| P1        | 2       | 6       | 8      |
| P2        | 6       | 8       | 14     |
| P3        | 4       | 1       | 5      |
| **Total** | **12**  | **16**  | **28** |

---

## Revised verdict

**C — Needs work before release.** Phase 1's "B — Ready with minor fixes"
was too generous, primarily because it did not trace the code path from
example workflow to warrant bypass. The missing-checkout issue (P0-1) is
not a minor fix: it affects every user who follows the documentation, it
silently voids the authority model, and doctor cannot detect it. Combined
with the systemic broken-anchor problem (P1-3), the false boundary claims
(P1-6), and the misleading permission table (P1-7), the documentation
presents a confident picture that does not hold up when traced against
source code.

The product's design is sound. The authority model is well-conceived. The
progressive disclosure is best-in-class. But the documentation does not
accurately describe what the code actually does, and in one critical case
(omitting checkout) it leads every user into a misconfiguration that
silently undermines the entire security model.

**What would move this back to B:**

1. Add `actions/checkout` to every example workflow (or add a runtime
   warning when the checkout directory is empty)
2. Fix all 110 north-star anchor fragments (replace `--` with `-`)
3. Fix the 8 broken relative paths in `dogfood.md`
4. Remove "Prerequisites: None" or replace with accurate prerequisites
5. Correct the false boundary claims in `duties-and-the-core.md`
6. Correct the `contents: read` permission table to distinguish API reads
   from filesystem reads
7. Add `permissions` to the backfill example
8. Add OpenAI billing requirement and model compatibility notes

Items 1-4 are essential. Items 5-8 are strongly recommended.
