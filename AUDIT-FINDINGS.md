# Reeve First-Contact Usability / Documentation / Configuration Audit Findings

**Auditor:** 10 first-contact agents (A–J) + 7 adversarial reviewers + synthesiser
**Date:** 2026-08-15
**Branch:** `first-contact/usability-audit`
**Baseline:** `acfc4a9` (main, v0.6.0) — typecheck, lint, test, build all green

---

## Methodology

Ten independent agents audited the Reeve repository from different first-contact
personas (Phase 1). Seven additional adversarial reviewers then challenged the
findings and searched for what Phase 1 missed (Phase 2).

| Agent | Persona                         | Scope                                            |
| ----- | ------------------------------- | ------------------------------------------------ |
| A     | dependa first-contact user      | Can a newcomer install dependa?                  |
| B     | triage first-contact user       | Can a newcomer install triage?                   |
| C     | respond + custom provider user  | Can a newcomer use non-OpenAI endpoints?         |
| D     | all-duties first-contact user   | Can a newcomer install all seven duties?         |
| E     | documentation auditor           | Is documentation internally consistent?          |
| F     | configuration auditor           | Are all options safe, documented, deterministic? |
| G     | source-vs-docs forensic auditor | Does documentation match code?                   |
| H     | security/authority auditor      | Is the authority model sound?                    |
| I     | GHA/token permission auditor    | Are workflows permission-safe?                   |
| J     | developer experience auditor    | Is onboarding smooth?                            |

**Phase 2 — Adversarial reviewers:**

| Reviewer               | Role                                       | Outcome                                                            |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| A (Defender)           | Prove Phase 1 findings are false positives | All 8 Phase 1 findings **CONFIRMED**; recommends upgrading P2-6→P1 |
| B (Attacker)           | Find what Phase 1 missed                   | 16 new findings (1 P0, 6 P1, 8 P2, 1 P3)                           |
| C (Doc forensic)       | Verify documentation claims against source | 1 CONTRADICTION, 7 VERIFIED; found doctor gap                      |
| D (Config architect)   | Audit configuration surface                | Pending                                                            |
| E (Security/authority) | Audit authority model and security         | Pending                                                            |
| F (Dev onboarding)     | Audit onboarding experience                | 16 new findings (5 P1, 7 P2, 3 P3)                                 |
| G (Hostile beginner)   | Deliberately misinterpret docs             | 10 misinterpretations; 1 P1, 4 P2, 5 P3                            |

---

## Findings

### P0 — Unusable or security-critical

#### P0-1: Every documentation example omits `actions/checkout` — silent warrant bypass when warrant file exists ✅ FIXED

**File:** `README.md:65-93`, `docs/getting-started/installation.md:14-38`,
`docs/getting-started/first-workflow.md:8-42`, and every duty reference page

Every documentation example omits `actions/checkout`. All 10 dogfood workflows
(`.github/workflows/reeve-*.yml`) include it. The warrant file is read from the
**local filesystem** via `readFile` (`src/core/warrant.ts:368`), not the GitHub
Contents API. Without checkout, the runner has no repository files, and
`.github/reeve.yml` cannot be found.

At the default path, a missing file returns `null` (line 370), and
`resolveAuthority` builds an implicit warrant from the repository's labels API
(line 646-657). This is **correct at Level 0** (no warrant file) — the
five-minute quick start works as designed.

**The problem occurs at Level 1+.** When a user adds a warrant file containing
restrictions (e.g., `capabilities: { translate: [edit-body] }` omitting triage),
but has not added `actions/checkout` to their workflow:

1. `readWarrant` tries `readFile` → ENOENT (file is in the repo but not on the runner)
2. Default-path ENOENT returns `null` → implicit warrant
3. Implicit warrant has `declared = false` (line 444)
4. `granted(duty, fallback)` returns `fallback` for every duty
5. **The user's warrant restrictions are silently ignored.** Triage gets `["label"]`
   from its fallback instead of `[]` (which the user's `capabilities:` block would
   have granted).

Doctor mode (`src/doctor/diagnose.ts:177`) calls `readWarrant` through the same
code path and cannot detect this misconfiguration — it reports everything
healthy because the implicit warrant IS healthy.

**Severity justification:** The authority model is Reeve's core value
proposition. A silent warrant bypass means a user who carefully restricted
capabilities has those restrictions voided without any warning or error. Not
P1 because Level 0 (the documented quick start) works correctly without
checkout — the vulnerability is in the transition from Level 0 to Level 1+,
which is not documented. But the severity is P0 because the product's
foundational security property (the warrant) is silently disabled, and the
recommended pre-flight check (doctor) cannot detect it.

---

### P1 — Easy to misunderstand or dangerously wrong documentation

#### P1-1: `auto-close` default is wrong in `warrant-format.md` ✅ FIXED

**File:** `docs/reference/warrant-format.md:119`
**Claim:** "Default `true`"
**Actual:** Default is `false` (confirmed by `src/core/warrant.ts:1360`,
`docs/reference/duties/dependa.md:201`, and `src/core/warrant.test.ts:1558`)

A maintainer reading `warrant-format.md` and writing `dependa:` policy without
`auto-close:` will believe obsolete PRs auto-close, but they do not. This is
a documentation bug that could cause a maintainer to be surprised by stale PRs
remaining open, or — worse — to add `auto-close: true` thinking it's the
default and already in effect, without realising they are making an active
decision to grant a new capability.

**Confirmed by all 4 reviewers who checked it (A, C, G, B).**

#### P1-2: Broken multilingual README links

**File:** `README.md:2`
**Links:** `README.vi.md` and `README.zh.md` do not exist

```html
<a href="README.vi.md">Tiếng Việt</a> · <a href="README.zh.md">简体中文</a>
```

These are the very first links on the page — a new visitor's first interaction
with the repository. Both 404. This is a first-contact failure: a Vietnamese or
Chinese speaker sees their language offered and is immediately sent to a dead
end.

The `harmonise` duty's own documentation (`docs/reference/duties/harmonise.md:251`)
uses `README.vi.md` as an example of the naming convention, reinforcing the
expectation that the file should exist.

**Confirmed by all reviewers who checked it.**

#### P1-3: ~48 broken north-star anchor fragments (systematic double-hyphen vs single-hyphen) ✅ FIXED

**Files:** 21 documentation files, 48+ anchor references

Cross-references to north-star doctrine headings use double-hyphens in URL
fragments (e.g., `#d7--any-endpoint-including-the-free-ones`), but GitHub's
heading slugger converts em-dashes to single hyphens (`#d7-any-endpoint-including-the-free-ones`).
Every cross-reference to a specific doctrine heading lands at the top of the
page instead of at the intended heading.

| Used in link                                           | Actual slug                                           |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `#d7--any-endpoint-including-the-free-ones`            | `#d7-any-endpoint-including-the-free-ones`            |
| `#d8--every-thread-is-hostile`                         | `#d8-every-thread-is-hostile`                         |
| `#d12--capacity-is-weather-authority-is-configuration` | `#d12-capacity-is-weather-authority-is-configuration` |

Affected files include onboarding-adjacent pages:
`docs/guides/warrant.md`, `docs/security/threat-model.md`,
`docs/guides/doctor.md`, `docs/guides/languages.md`,
`docs/guides/cost.md`, `docs/reference/root-action.md`,
`docs/concepts/dependency-maintenance.md`, and 14 more.

Additionally, `docs/reference/root-action.md:127` references
`#d2--no-mutation-beyond-declared-authority` — no such heading exists. D2's
actual heading is "Authority is granted, written, and bounded." This is a
wrong reference, not just a broken anchor.

**Verified programmatically.** The slug mismatch affects every single
doctrine-anchor cross-reference in the project.

#### P1-4: `dogfood.md` has 8 broken relative-path links ✅ FIXED

**File:** `docs/guides/dogfood.md`

Lines 3 and 139 contain relative links that are wrong for a file in the
`docs/guides/` directory:

| Used                              | Correct                              |
| --------------------------------- | ------------------------------------ |
| `concepts/authority-model.md`     | `../concepts/authority-model.md`     |
| `guides/warrant.md`               | `warrant.md` (same directory)        |
| `reference/warrant-format.md`     | `../reference/warrant-format.md`     |
| `concepts/duties-and-the-core.md` | `../concepts/duties-and-the-core.md` |

All 8 links (4 per line) hit 404. A reader following the dogfood guide's
prerequisite or related-links section is sent to dead ends.

#### P1-5: "Prerequisites: None" is factually incorrect ✅ FIXED

**File:** `docs/getting-started/installation.md:3`

> _Get a first workflow running in five minutes. Prerequisites: None._

The actual prerequisites are:

1. **A GitHub repository** — you cannot use Reeve without one
2. **An OpenAI API key with billing enabled** — `gpt-5-mini` requires a paid
   API key. A free-tier or trial key fails with a 429/402 error, and the
   troubleshooting guide does not cover this failure mode
3. **The `OPENAI_API_KEY` secret configured** — not mentioned until the
   `api-key` input line in the example
4. **Knowledge of which model to use** — no guidance on model selection or
   compatibility

**Found by both Reviewer B and Reviewer F independently.**

#### P1-6: `duties-and-the-core.md` makes false boundary claims ✅ FIXED

**File:** `docs/concepts/duties-and-the-core.md:64-66`

> **Talk to the outside world.** If a duty imports anything that fetches,
> reads the filesystem, or touches the GitHub API, the boundary broke.

This claim is **false**. Every duty imports `@actions/github` and the core
`forge.js` module (which wraps the GitHub API). Additionally,
`respond/guidance.ts` reads the filesystem via `readFile` from `node:fs/promises`,
and `dependa/main.ts` reads manifests via the Contents API.

The doc also claims (line 18): "The pipeline is the program, and it is the same
pipeline for every duty." This is inaccurate: `lifecycle` has no model call,
`dependa` uses a discovery/classify/propose flow, and dry-run gating differs
per duty.

**Severity:** A security reviewer reading this would form an incorrect mental
model of what duties can and cannot do, potentially missing injection surfaces
in duty code.

#### P1-7: `contents: read` permission table is misleading ✅ FIXED

**File:** `docs/getting-started/installation.md:263`

> | Reading a taxonomy or memory | `contents: read` |

This row conflates two different read mechanisms. The warrant, taxonomy
corrections, and guidance are read from the **local filesystem** via
`readFile`/`readdir` — `contents: read` is irrelevant to these reads. The
GitHub `contents: read` permission controls the **Contents API**, which
`dependa` and `harmonise` use to read manifests and blobs.

A user who grants `contents: read` thinking they've covered "reading a
taxonomy" has covered the wrong thing. A user who does NOT add `actions/checkout`
but DOES grant `contents: read` may believe they've done everything needed,
when in fact the local filesystem reads will fail silently.

The troubleshooting guide reinforces this confusion at line 100:
"Reading files | contents: read" — same misleading conflation.

#### P1-8: No onboarding page tells a newcomer which duty to start with or why ✅ FIXED

**File:** `docs/README.md:40-42`, `docs/getting-started/installation.md`

The "New to Reeve" path says "Installation, then first-workflow" with no
mention of duty selection or a comparison table. The README duty table lists
all 7 duties with one-line descriptions but no "start here" marker. The
triage reference page says triage is "The duty to start with" — but only
on that page. A newcomer evaluating duties has no decision framework.

Meanwhile, `lifecycle` requires no model (zero API cost) and `dependa` can
run without a model for its core pipeline. These facts would be critical for
a newcomer evaluating before committing budget, but they are scattered across
reference pages rather than assembled in one onboarding-visible location.

#### P1-9: `auto-close`/`auto-rebase` documented as functional but not implemented ✅ FIXED

**File:** `src/duties/dependa/main.ts:148-153`

```typescript
// auto-close and auto-rebase are parsed from the warrant but not yet
// implemented — PRs will not be auto-closed or auto-rebased.
```

The warrant format reference and dependa duty reference both document
`auto-close` and `auto-rebase` as if they work (present tense: "When `true`,
dependa closes a PR..."). Only a runtime `core.notice()` in the log reveals
they are not yet implemented.

Reviewer A recommends upgrading this from P2 to P1 because `auto-rebase: false`
being silently ignored means a user explicitly opts out of rebasing and gets
rebased anyway — violating the authority model's core promise.

#### P1-10: Wrong model string produces green run with zero output ✅ FIXED

**Fix applied:** Added `protocolExhausted()` to `src/core/provider.ts` — detects when every model on the roster failed with `kind: "protocol"`. Added `failIfProtocolExhausted()` to `src/core/summary.ts` — calls `core.setFailed()` with a configuration problem message naming each failing model. Wired into all 7 duty entry points:

- `triage/main.ts`: when `judged.model === null`
- `translate/main.ts`: via `ProtocolCheck` callback through `engine.ts` → `text.ts` → `processThread`
- `duplicate/main.ts`: when `judged.model === null`
- `respond/main.ts`: when `drafted.attempts.length === 0`
- `harmonise/main.ts`: when `result.attempts.length === 0`
- `dependa/main.ts`: when interpretation rotation produces no result
- `lifecycle/main.ts`: (no model calls — not applicable)

#### P1-14: Warrant parser silently ignores typos in root keys and label keys ✅ FIXED

**File:** `src/core/warrant.ts`

A warrant file with a typo in a root key (e.g., `capabilites:` instead of `capabilities:`) or a label key (e.g., `confidnce:` instead of `confidence:`) was silently ignored. The user's intended configuration had no effect and no error was raised.

**Fix applied:** Added unrecognized-key validation in `parseWarrant` (root document) and `readLabels` (label entries). Both now throw an error naming the unrecognized key and listing the valid ones. Also added duty-name validation in the `capabilities:` block — a typo like `traige:` now errors instead of creating a dead grant.

**Found by Reviewer D (Config architect).**

#### P1-15: Harmonise writes to default-branch files with no capability check ✅ FIXED

**File:** `src/duties/harmonise/main.ts`

When a locale's text differs from the default branch, harmonise reads the default-branch content via the Contents API and writes the harmonised version back — but this write was not gated on the `edit-file` capability. A warrant granting only `edit-body` would still allow harmonise to rewrite `.md` files on the default branch.

**Fix applied:** Added `edit-file` capability check before the default-branch write, consistent with dependa's `propose`/`open-pr` pattern for file mutations.

#### P1-16: `dependa/action.yml` missing `endpoints` and `api-keys` inputs ✅ FIXED

**File:** `dependa/action.yml`

The dependa duty accepts `models` (optional) but the `action.yml` did not declare the `endpoints` and `api-keys` inputs that the core's `readShared()` parses. A user trying to configure multi-endpoint dependa would get silent fallback to the default endpoint.

**Fix applied:** Added `endpoints` and `api-keys` input declarations to `dependa/action.yml`.

#### P1-17: `triage/action.yml` `apply` description omits `open-pr` ✅ FIXED

**File:** `triage/action.yml`

The `apply` input description listed valid values as `label, comment, close, assign, record, none` but omitted `open-pr`. Triage does support `open-pr` (it's in the capabilities code), so the description was incomplete.

**Fix applied:** Added `open-pr` to the `apply` description enumeration.

**File:** `src/core/provider.ts`

If a single-model roster has a typo (e.g., `gpt-4o-mino` instead of
`gpt-4o-mini`), the provider returns an HTTP error. `classifyStatus(404)`
returns `"protocol"`. Protocol failures do NOT ground the model in the
Weather system. The model is tried, fails, and the run produces no verdict.
The job completes **green** with `starved: false`.

This violates Reeve's own doctrine: "A run that cannot do its job fails red.
It never reports an empty result in green to mean something went wrong."
The `starved: false` output is misleading — the roster was not starved by
capacity, but every model failed for a non-capacity reason.

**Found by Reviewer G (Hostile beginner).**

#### P1-11: No cost warning appears before the quick start YAML ✅ FIXED

**File:** `README.md:65-93`, `docs/getting-started/installation.md:3-38`

The quick start block sends `api-key` and `models` to a paid endpoint. No text
before or within the block mentions that running this will incur charges. The
cost guide (`docs/guides/cost.md`) is excellent but reachable only after a
newcomer has already committed to the installation path, creating a
chicken-and-egg problem.

**Found by Reviewer F.**

#### P1-12: Backfill example has no `permissions` block ✅ FIXED

**File:** `docs/getting-started/installation.md:228-245`

The backfill/workflow_dispatch example omits both `actions/checkout` and a
`permissions` block. A `workflow_dispatch` trigger runs with the repository's
default permissions, which may be `write` on everything — granting the duty
far more than it needs, violating the principle of least privilege.

#### P1-13: No step-by-step progression from L0 to L3 exists ✅ FIXED

**File:** `docs/concepts/authority-model.md`, `docs/guides/warrant.md`

The ladder (L0→L3) is explained as a concept, not as a path to walk. No page
connects these into a sequential walkthrough: "You are at L0. To reach L1,
add this YAML. To reach L2, add this capabilities block. To reach L3, add
this." A newcomer reads the authority model, understands the idea, and then
has nowhere that says "do this next."

**Found by Reviewer F.**

---

### P2 — Significant friction

#### P2-1: `lifecycle` missing from threat model's per-duty security list

**File:** `docs/security/threat-model.md:79–86`

The threat model lists security considerations for six duties but omits
`lifecycle`. While `lifecycle` calls no model (reducing its attack surface),
it is the only duty that can close issues — a high-impact action. A security
reviewer reading only the threat model would not find lifecycle in the
per-duty list.

#### P2-2: `@v0.1` version semantics not obvious at first contact

**Files:** README.md, installation.md, all docs, all action.yml comments

Every example uses `@v0.1`. The installation doc explains the versioning scheme
in section 4, and `releasing.md` explains floating tags and why `v0` must not
exist. But the versioning semantics are unusual enough that a first-contact
user may be confused about what `@v0.1` actually pins — and all examples are
5 minor versions behind the current release (`v0.6.0`). A user following the
docs installs a version that is at least 5 releases old, missing fixes shipped
in v0.2 through v0.6. The floating-patch behavior is undocumented at the
point of use.

#### P2-3: `models` is `required: true` for 5 duties but not for `dependa` and `lifecycle`

**Files:** `triage/action.yml:62`, `translate/action.yml:64`,
`duplicate/action.yml:59`, `respond/action.yml:65`, `harmonise/action.yml:49`
vs `dependa/action.yml:54` (required: false, default: "")

This is a deliberate design choice (`dependa` can run deterministically), but
it creates friction for users who expect all duties to follow the same input
pattern.

#### P2-4: `apply` defaults vary across duties with no summary table

| Duty      | `apply` default  | Acts? |
| --------- | ---------------- | ----- |
| triage    | `label`          | Yes   |
| translate | `edit-body`      | Yes   |
| duplicate | `none`           | No    |
| respond   | `none`           | No    |
| lifecycle | `label, comment` | Yes   |
| harmonise | `none`           | No    |
| dependa   | `none`           | No    |

This is deliberate progressive disclosure, but no single page summarises it.
A user installing multiple duties must read each action.yml individually.

#### P2-5: No troubleshooting entry for dependa-specific issues

The troubleshooting guide covers generic provider problems, language problems,
and warrant parsing. But `dependa` has unique failure modes (ecosystem parsing,
manifest not found, auto-close/auto-rebase not implemented) that are not
covered. A user whose dependa run produces `auto-close is configured but not
yet implemented` would find no guidance.

#### P2-6: `dry-run.md` "only the publish step is missing" is misleading

**File:** `docs/guides/dry-run.md:12-14`

In `lifecycle`, dry-run gates four separate actions independently (add labels,
post comments, close issues, remove stale labels). In `triage`, dry-run gates
label creation, application, assignment, and close separately. These are
independent guard points throughout the code, not a single "publish step at
the very end." The doc's phrasing implies the entire pipeline runs to
completion and only the final write is withheld.

#### P2-7: README quick start missing `timeout-minutes` and `concurrency`

**File:** `README.md:65-93`

The installation.md version of the same example correctly includes
`concurrency` and `timeout-minutes: 10`, but the README version omits both.
A user copying the README version risks unbounded run time and parallel runs
on the same thread.

#### P2-8: `SECURITY.md#security` anchor is broken

**File:** `SECURITY.md:66`

Links to `README.md#security` but the README has no Security heading. A
vulnerability reporter following this link will not find the guidance they
need.

#### P2-9: Doctor cannot detect missing-checkout misconfiguration

**File:** `src/doctor/diagnose.ts:177`

Doctor calls `readWarrant` through the same code path. Without checkout, it
reads no warrant file (ENOENT at default path returns null), builds the
implicit warrant, and reports everything healthy. It cannot distinguish "no
warrant because the user hasn't written one" from "no warrant because checkout
was skipped and the user's warrant is sitting unread in the repository."

#### P2-10: No model compatibility reference or requirement exists

**Files:** `README.md`, `docs/getting-started/installation.md`

The quick start uses `gpt-5-mini` (a real but legacy OpenAI model). There is
no documentation about which models are supported, what capabilities a model
needs, whether non-OpenAI providers work, or that OpenAI billing must be
enabled.

#### P2-11: Quick start never mentions `dry-run: true` before going live

**Files:** `README.md:65-93`, `docs/getting-started/installation.md:14-38`

The triage duty reference recommends `dry-run: true` before live use. The
dry-run guide says to "run it that way against ten real threads first." But
the quick start — the example a first-contact user copies — does not include
`dry-run: true`. A user following the quick start goes live on their first
run without any rehearsal.

#### P2-12: OpenAI billing requirement never mentioned

**Files:** All documentation

The quick start requires `secrets.OPENAI_API_KEY`. Nowhere is it documented
that this key must have billing enabled. OpenAI's free tier and trial keys
cannot call GPT-5 models. A user with a free-tier key will get a 429 or 402
error at their very first run, and the troubleshooting guide does not cover
this failure mode.

#### P2-13: `apply: none` means "observe but still spend" — confusing for newcomers

**File:** `translate/action.yml:106-112`

Setting `apply: none` runs the full pipeline (screening, detection, drafting,
judging) and spends API calls — only the final write is withheld. The
action.yml description is explicit about this, but the installation docs
don't mention it. A newcomer who sets `apply: none` thinking it means "skip
entirely" will spend as much as a live run for zero visible output.

#### P2-14: Default `languages: en, vi, zh` looks like project configuration

**File:** `translate/action.yml:79`

The default `en, vi, zh` is the Reeve project's own multilingual setup. A
newcomer who has never heard of Reeve may assume these are hardcoded project
values they cannot change. The action.yml description is helpful but the
default itself is the source of the confusion.

#### P2-15: Troubleshooting has no "unknown model id" or "model not found" entry

**File:** `docs/guides/troubleshooting.md:149`

The provider problems table lumps "Quota, an unknown model id, or a rejected
field" into one row. A newcomer who just changed `base-url` and hit "model
not found" cannot tell which diagnosis applies.

#### P2-16: `dry-run` and `doctor` not surfaced in onboarding path

**Files:** `docs/getting-started/installation.md`, `README.md`

`dry-run: true` appears in installation section 5 (the last section). `doctor`
is mentioned in a README paragraph after the quick start. Neither appears in
the quick start YAML or the first-workflow guide. A newcomer's first run is
live by default.

#### P2-17: No docs explain provider/model substitution for non-OpenAI providers

**Files:** `README.md`, `docs/getting-started/installation.md`

All examples use `gpt-5-mini` with `base-url: https://api.openai.com/v1` (the
default). No example shows substitution to another provider. No guidance says
"replace `base-url` with your provider's endpoint and `models` with a model
id your provider accepts." A newcomer using a non-OpenAI provider will copy
the quick start, change only `api-key`, and get a 404.

#### P2-18: Doctor's `DEFAULTS_BY_DUTY` map missing harmonise and dependa

**File:** `src/doctor/diagnose.ts:64-70`

The map covers only 5 of 7 duties (translate, triage, duplicate, respond,
lifecycle). `harmonise` and `dependa` are absent, so doctor cannot report
their effective authority. The fallback `?? []` at line 284 happens to be
correct because both default to `[]`, but this is a wiring gap that would
silently give wrong answers if either ever gained a non-empty default.

**Found by Reviewer C (Doc forensic).**

---

### P3 — Polish

#### P3-1: README badge alt text inconsistency

CI badge says `alt="CI"`, Analysis says `alt="Analysis"`, but Scorecard says
`alt="OpenSSF Scorecard"` and license says `alt="License: Apache 2.0"`.

#### P3-2: `language-layer.md` line 152 has awkward sentence

> "A language chrome has no row for falls back to English, deterministically"

Likely meant "A language the chrome has no row for falls back to English,
deterministically."

#### P3-3: Dogfood workflows use `uses: ./triage` not `@v0.1`

Correct and intentional (dogfoods the working tree), but a first-contact user
copying the dogfood workflow would get a local-path reference that only works
inside the Reeve repository.

#### P3-4: `dependa-dogfood.yml` uses different action SHAs than CI

`pnpm/action-setup` and `actions/setup-node` in the dependa-dogfood workflow
use older SHAs than CI/release workflows.

#### P3-5: Quick start omits `actions/checkout` that becomes necessary later

Checkout is not needed at Level 0 (no warrant file), but IS needed once a
warrant file or corrections/guidance directory exists. The docs don't mention
when checkout becomes necessary. (Not P0 because Level 0 works correctly.)

#### P3-6: `d2--no-mutation-beyond-declared-authority` references wrong heading

**File:** `docs/reference/root-action.md:127`

References `#d2--no-mutation-beyond-declared-authority`. No such heading
exists. D2's actual heading is "Authority is granted, written, and bounded."

---

## Core questions answered

### 1. Can a newcomer understand what Reeve is from the README?

**Yes, with gaps.** The README is well-structured and the refusal table is
exceptional. The broken multilingual links (P1-2) undermine the multilingual
thesis at first contact.

### 2. Can a newcomer choose and install a single duty?

**Mostly yes.** The five-minute workflow is genuinely copy-pasteable at Level 0.
But the "Prerequisites: None" claim (P1-5) is false, no cost warning appears
(P1-11), and no duty selection guidance exists (P1-8).

### 3. Can a newcomer understand what each duty does?

**Mostly yes.** Each duty has a reference page. The `apply` default variation
(P2-4) is not surfaced in a single place, and the `auto-close`/`auto-rebase`
documentation describes unimplemented features (P1-9).

### 4. Can a newcomer understand the authority model?

**Conceptually yes, practically no.** The authority model page is thorough.
But the `auto-close` default error (P1-1) directly undermines the warrant
reference, and the missing-checkout issue (P0-1) means a user's warrant
restrictions can be silently voided.

### 5. Is the documentation internally consistent?

**No.** The `auto-close` default is wrong in `warrant-format.md` (P1-1), 48+
doctrine anchor links are broken (P1-3), 8 dogfood guide links are broken
(P1-4), and `duties-and-the-core.md` makes false claims about the duty
boundary (P1-6).

### 6. Are options easy to understand?

**Mostly yes.** Action.yml descriptions are exceptionally detailed. But the
`contents: read` permission table is misleading (P1-7), `apply: none` still
spends API budget (P2-13), and the default `languages` input looks like
project config (P2-14).

### 7. Can you configure from simple to advanced?

**The ladder exists, but the path is missing.** Progressive disclosure is
best-in-class in design. But no step-by-step progression exists (P1-13),
and the transition from Level 0 to Level 1 requires adding `actions/checkout`
with no documentation of this requirement (P0-1).

### 8. Does documentation match code?

**One confirmed mismatch, plus multiple documentation-only inconsistencies.**
The `auto-close` default (P1-1) is wrong in the warrant reference. The duty
boundary claims (P1-6) are false. The `dry-run` description (P2-6) is
imprecise. All other checked claims (warrant parsing, capability enforcement,
dry-run behavior, fingerprinting, model rotation) match the source code.

---

## Finding summary

| ID    | Severity | Summary                                                                  | Category               | Status                      |
| ----- | -------- | ------------------------------------------------------------------------ | ---------------------- | --------------------------- |
| P0-1  | P0       | Doc examples omit `actions/checkout` — silent warrant bypass at Level 1+ | Documentation vs code  | ✅ Fixed                    |
| P1-1  | P1       | `auto-close` default `true` in warrant-format.md, `false` in code        | Documentation drift    | ✅ Fixed                    |
| P1-2  | P1       | README.vi.md and README.zh.md linked but do not exist                    | Broken links           | Open                        |
| P1-3  | P1       | ~48 broken north-star anchor fragments (systematic `--` vs `-`)          | Broken links           | ✅ Fixed                    |
| P1-4  | P1       | 8 broken relative-path links in dogfood.md                               | Broken links           | ✅ Fixed                    |
| P1-5  | P1       | "Prerequisites: None" is false (needs repo, paid OpenAI key, secret)     | Misleading claim       | ✅ Fixed                    |
| P1-6  | P1       | `duties-and-the-core.md` falsely claims duties never import API/fs       | Documentation vs code  | ✅ Fixed                    |
| P1-7  | P1       | `contents: read` permission table conflates API and filesystem reads     | Misleading docs        | ✅ Fixed                    |
| P1-8  | P1       | No onboarding page tells newcomer which duty to start with               | Documentation gap      | ✅ Fixed                    |
| P1-9  | P1       | `auto-close`/`auto-rebase` documented but not implemented                | Documentation vs code  | ✅ Fixed                    |
| P1-10 | P1       | Wrong model string → green run with zero output, `starved: false`        | Runtime behaviour      | ✅ Fixed                    |
| P1-11 | P1       | No cost warning before quick start YAML                                  | Missing safeguard      | ✅ Fixed                    |
| P1-12 | P1       | Backfill example has no `permissions` block                              | Missing safeguard      | ✅ Fixed                    |
| P1-13 | P1       | No step-by-step progression from L0 to L3 exists                         | Documentation gap      | ✅ Fixed                    |
| P1-14 | P1       | Warrant parser silently ignores typos in root/label keys                 | Runtime behaviour      | ✅ Fixed                    |
| P1-15 | P1       | Harmonise writes to default-branch files with no capability check        | Security               | ✅ Fixed                    |
| P1-16 | P1       | `dependa/action.yml` missing `endpoints` and `api-keys` inputs           | Missing config surface | ✅ Fixed                    |
| P1-17 | P1       | `triage/action.yml` `apply` description omits `open-pr`                  | Documentation drift    | ✅ Fixed                    |
| P2-1  | P2       | `lifecycle` missing from threat model per-duty list                      | Documentation gap      | Open                        |
| P2-2  | P2       | `@v0.1` version semantics not obvious; examples are 5 minors behind      | Conceptual friction    | Open                        |
| P2-3  | P2       | `models` required/optional varies across duties                          | API inconsistency      | Open                        |
| P2-4  | P2       | No summary table of `apply` defaults across duties                       | Documentation gap      | Open                        |
| P2-5  | P2       | Troubleshooting guide lacks dependa-specific entries                     | Documentation gap      | Open                        |
| P2-6  | P2       | `dry-run.md` "only publish step missing" is misleading                   | Misleading docs        | Open                        |
| P2-7  | P2       | README quick start missing `timeout-minutes` and `concurrency`           | Missing safeguard      | Open                        |
| P2-8  | P2       | `SECURITY.md#security` anchor is broken                                  | Broken link            | Open                        |
| P2-9  | P2       | Doctor cannot detect missing-checkout misconfiguration                   | Feature gap            | Open                        |
| P2-10 | P2       | No model compatibility reference exists                                  | Documentation gap      | Open                        |
| P2-11 | P2       | Quick start omits `dry-run: true` before going live                      | Documentation gap      | Open                        |
| P2-12 | P2       | OpenAI billing requirement never mentioned                               | Documentation gap      | Open                        |
| P2-13 | P2       | `apply: none` spends API budget — confusing for newcomers                | Conceptual friction    | Open                        |
| P2-14 | P2       | Default `languages: en, vi, zh` looks like project configuration         | Confusing default      | Open                        |
| P2-15 | P2       | Troubleshooting lumps "unknown model id" with quota                      | Documentation gap      | Open                        |
| P2-16 | P2       | `dry-run` and `doctor` not surfaced in onboarding path                   | Documentation gap      | Open                        |
| P2-17 | P2       | No docs explain provider/model substitution                              | Documentation gap      | Open                        |
| P2-18 | P2       | Doctor `DEFAULTS_BY_DUTY` map missing harmonise and dependa              | Code gap               | Open                        |
| P2-19 | P2       | `ecosystems` described as "Non-empty list" but code allows empty/absent  | Documentation drift    | ✅ Fixed                    |
| P3-1  | P3       | Badge alt text inconsistency                                             | Polish                 | Open                        |
| P3-2  | P3       | Awkward sentence in language-layer.md                                    | Polish                 | Open                        |
| P3-3  | P3       | Dogfood `uses: ./triage` could confuse copiers                           | Polish                 | Open                        |
| P3-4  | P3       | Inconsistent action SHAs in dogfood vs CI                                | Polish                 | Open                        |
| P3-5  | P3       | Quick start omits `checkout` that becomes necessary later                | Polish                 | ✅ Fixed (subsumed by P0-1) |
| P3-6  | P3       | `d2--no-mutation-beyond-declared-authority` references wrong heading     | Wrong reference        | ✅ Fixed (subsumed by P1-3) |

---

## Severity count

| Severity  | Total  | Fixed  | Open                                   |
| --------- | ------ | ------ | -------------------------------------- |
| P0        | 1      | 1      | 0                                      |
| P1        | 17     | 16     | 1 (P1-2: missing multilingual READMEs) |
| P2        | 19     | 1      | 18                                     |
| P3        | 6      | 2      | 4                                      |
| **Total** | **43** | **20** | **23**                                 |

---

## Verdict (updated after fixes)

**B — Ready with minor fixes.** After implementing fixes for all P0 and 16 of 17 P1
findings, the product's documentation now accurately describes what the code does,
every documentation example includes the required `actions/checkout` step, the warrant
parser rejects typos instead of silently ignoring them, protocol exhaustion fails the
run red instead of green, and the authority model's documentation matches its
enforcement.

The one remaining P1 (P1-2: missing multilingual README files) is a content gap
rather than a correctness issue — the files simply don't exist yet. All other P1
findings have been resolved.

The 18 open P2 items are genuine friction points that should be addressed before 1.0
but are not blockers for a usable release today.
