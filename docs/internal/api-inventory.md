# Reeve public API inventory — Round 2

**Landed on main 2026-08-19 (final adversarial freeze). Baseline: main @ `1a4fd29`. Reconciled to post-#99 tree 2026-08-19 (final freeze audit): PR #99 `fa2709f` merged the round-2 refactor onto main, so the removals below that this header previously reclassified to INTERNAL-BUT-EXPORTED are now DONE as built.**

_The complete inventory of Reeve's exposed surface, classified for the pre-1.0
freeze. Round 2's rule: simplify the implementation, never the contract. This
document classifies every exposed surface so a change knows what it may touch.
Verified 2026-08-19 at `1a4fd29`; the frozen semantics are the behavior
contract's, this file is the surface map._

Legend: **REQUIRED** = the contract needs it · **INTENTIONAL** = deliberate
surface, kept · **INTERNAL-BUT-EXPORTED** = exported, consumed only internally,
shrink candidate · **LEGACY/DEAD** = removable before 1.0.

---

## 1. Action inputs (per `action.yml`)

### Root action — `REQUIRED`

| Input          | Default               | Frozen semantics                                             |
| -------------- | --------------------- | ------------------------------------------------------------ |
| `duty`         | `""`                  | Names the corrected leaf action to write; never runs a duty. |
| `doctor`       | `"false"`             | `true` = read-only warrant check; never writes.              |
| `github-token` | `${{ github.token }}` | Labels read for doctor.                                      |
| `warrant`      | `.github/reeve.yml`   | The authority file every leaf reads.                         |

Outputs: `leaf-action` (refusal mode), `problems` (doctor mode). `REQUIRED`.

### Every leaf — `REQUIRED`

`warrant` (default `.github/reeve.yml`), the provider cluster (`base-url`,
`api-key`, `models`, `screen-models`, `judge-models`, `endpoints`, `api-keys`,
`request-timeout`, `temperature`), `dry-run`, plus duty-specific inputs
(`number`, `sweep`, `limit`, `drafts`, `paths`, `rules-path`,
`packs-path`, `risk-path`, `show-attribution`,
`corrections-dir`, `state-branch`, `provenance-dir`, `glossary-dir`,
`confidence`, `max-body-chars`, `max-replies`, `chunk-chars`, `max-requests`,
`translate-replies`, `candidates`, `corpus-limit`, `corpus-since`,
`min-body-chars`, `labels`, `sweep-state`, `since`, `trigger`,
`max-diff-chars`, `max-context-chars`, `guidance`, `ecosystems`, `paths`,
`about`, `ignore`).
All `REQUIRED`; `sweep`+`number` together is refused (D4). `source-language`
is NOT a translate input — it is a translate OUTPUT
(`translate/action.yml` outputs, `main.ts:532`); harmonise does read a
`source-language` input (`harmonise/action.yml:51`). `about` and `ignore` are
duty-specific leaf inputs with frozen semantics in the behavior contract §1/§2:
`about` is read by triage (`triage/action.yml:173`) and respond
(`respond/action.yml:153`) and the warrant's `about:` key beats it; `ignore`
is read by harmonise (`harmonise/action.yml:190`) and preserves
`<!-- reeve:ignore-* -->`-marked sections as-is.

## 2. Configuration (warrant file)

The single canonical config (`REQUIRED`). `version: 1` + optional
`labels`, `languages`, `pivot`, `memory`, `about`, `lifecycle`, `propose`,
`dependa`, `duties`. Full schema in `docs/reference/warrant-format.md` and the
freeze doc §2. `INTENTIONAL` — no redesign warranted (verified: one file, one
reader, warrant-wins precedence, closed capability set).

## 3. Duty names and capabilities

Nine duties, `REQUIRED`: `triage`, `translate`, `duplicate`, `respond`,
`lifecycle`, `harmonise`, `dependa`, `review`, `remediation`.

Closed capability set (`REQUIRED`, `src/core/warrant.ts`): `label`,
`edit-body`, `comment`, `close`, `assign`, `record`, `propose`, `edit-file`,
`open-pr`. A capability string outside it is refused.

Per-duty default capabilities (`DEFAULT_CAPABILITIES` in each `capabilities.ts`):
triage `[label]`; translate `[edit-body]`; duplicate `[]`; respond `[]`;
lifecycle `[label, comment]`; harmonise `[]`; dependa `[]`; review `[]`;
remediation `[]` (reachable: the `*_CAPABILITIES` ladders). All `REQUIRED`.

## 4. Exported core symbols — INTERNAL-BUT-EXPORTED (shrink candidates)

The inventory (2026-08-19, reconciled post-#99) classifies the exposed surface
by current state. PR #99 `fa2709f` landed the round-2 deadcode refactor on
main, so the removals this section previously deferred are now DONE — each
row below records what PR #99 did to it. Anything still exported but consumed
only internally or by tests stays an INTERNAL-BUT-EXPORTED shrink candidate,
NOT frozen surface:

- `src/core/derive.ts` — `deriveLanguage`/`Derived` — **REMOVED in Round 2** (`fa2709f` deleted the module; `deriveLanguage` inlined module-private at `src/core/languages.ts:118`).
- `src/core/atlas.ts` — `EMPTY_ATLAS`, `ATLAS_MAX_PACKAGES` — **INTERNALIZED** (`fa2709f` made both `const` module-private, `atlas.ts:74,83`).
- `src/duties/harmonise/ignore.ts` — `_PLACEHOLDER`, `_SANITIZED_PLACEHOLDER` — **REMOVED in Round 2** (`fa2709f` deleted the `@internal` test-export stubs; only the module-private `PLACEHOLDER`/`SANITIZED_PLACEHOLDER` consts remain, `ignore.ts:41,49`).
- `src/refusal.ts` — `PLANNED` empty const — **REMOVED in Round 2** (`fa2709f` deleted the constant; `refusal()`'s `planned` param now defaults to `[]`, roadmap-tested).
- `src/duties/remediation/capabilities.ts` — `REMEDIATION_DEFAULTS` — **RENAMED to `DEFAULT_CAPABILITIES`** (`fa2709f`, `capabilities.ts:20`) for the per-duty `DEFAULT_CAPABILITIES` convention.
- `src/core/screen.ts` — `screen` — **INTERNAL-BUT-EXPORTED** (unchanged; single duty consumer triage, `triage/main.ts:115`; not frozen surface, may internalize or document as deliberately-core later).
- `src/duties/dependa/model.ts` — `Ecosystem`/`ECOSYSTEMS`/`UpdateType`/`UPDATE_TYPES` — **INTERNAL-BUT-EXPORTED** (still exported, `model.ts:25-28,142-151`); consumed by `core/warrant.ts:59-60` (the one core→duty import); not frozen; candidate to move the closed lists into core and re-export.

## 5. Output/result structures — `REQUIRED`

- Duty outputs (per `action.yml`): `outcome` (finding/skipped/failed), plus
  duty-specific (`proposed`, `translated`, `duplicate-of`, `responded`,
  `processed`, `synced`, `findings`, `language`, `problems`, and translate's
  `source-language`). Frozen semantics
  per duty in the behavior contract §3.
- Exit codes: red = maintainer-actionable failure; green = weather/denial/
  named no-op. Pinned by `eval/contract/exit-code*.test.ts`.
- The job-summary markdown (per-duty table + `| Language |` row for review) is
  asserted by eval fixtures — NOT byte-free — but the weight differs by duty:
  review/respond track the summary's verdict/disposition/language rows
  (`eval/runner.ts:504-511,995-1011`), while harmonise asserts only the duty's
  outputs (`classified`/`synced`/`conflicts`/`skipped`,
  `eval/runner.ts:201-224`) — a harmonise summary-string change does NOT break
  eval on byte content.

## 6. Anything accidentally exported? — Round 2 net

No new public surface added. **Removals landed via PR #99 `fa2709f`:**
`src/core/derive.ts`, the `refusal.ts` `PLANNED` const, and the harmonise
`_PLACEHOLDER`/`_SANITIZED_PLACEHOLDER` test stubs were removed; the atlas
`EMPTY_ATLAS`/`ATLAS_MAX_PACKAGES` consts and `deriveLanguage` were
internalized; `REMEDIATION_DEFAULTS` became `DEFAULT_CAPABILITIES`. None of
these is a consumer-facing contract. The remaining INTERNAL-BUT-EXPORTED
residue (`screen`, the dependa `Ecosystem`/`ECOSYSTEMS`/`UpdateType`/
`UPDATE_TYPES` closed lists) is the honest carry for a future pass.

---

## How to read a shrink candidate

"INTERNAL-BUT-EXPORTED" is not a bug — it is surface a refactor may remove
when evidence says nothing outside consumes it, per Round 2's rule
"do not preserve obsolete API merely because it existed in 0.x". Each removal
must: (1) verify reachability (grep consumers), (2) run the subtree tests,
(3) run contract + mutation + eval, (4) rebuild bundles byte-identically.
The behavior contract §"How to change a frozen row" governs any surface that
IS frozen.
