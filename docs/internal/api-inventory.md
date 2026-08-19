# Reeve public API inventory — Round 2

**Landed on main 2026-08-19 (final adversarial freeze). Baseline: main @ `1a4fd29`. Round-2 refactor branches (`round2-deadcode`, `round2-duties`) unmerged; any "removed in Round 2" claims elsewhere are reclassified to INTERNAL-BUT-EXPORTED until they land.**

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
`max-diff-chars`, `max-context-chars`, `guidance`, `ecosystems`, `paths`).
All `REQUIRED`; `sweep`+`number` together is refused (D4). `source-language`
is NOT a translate input — it is a translate OUTPUT
(`translate/action.yml` outputs, `main.ts:532`); harmonise does read a
`source-language` input (`harmonise/action.yml:51`).

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

The inventory (2026-08-19) found these exported but consumed only internally or
by tests. No Round 2 removal or rename has landed on main: the round-2 refactor
branches (`round2-deadcode`, `round2-duties`) are unmerged, so every claim below
that an earlier draft marked "removed/renamed in Round 2" is reclassified
INTERNAL-BUT-EXPORTED — verified present on main @ `1a4fd29` — with the
removals deferred past the freeze. Each is a next pre-1.0 shrink candidate, NOT
frozen surface:

- `src/core/derive.ts` — `deriveLanguage`/`Derived` — **INTERNAL-BUT-EXPORTED** (still exported on main; single consumer `core/languages.ts`; removal deferred).
- `src/core/atlas.ts` — `EMPTY_ATLAS`, `ATLAS_MAX_PACKAGES` — **INTERNAL-BUT-EXPORTED** (still exported on main; internalization deferred).
- `src/duties/harmonise/ignore.ts` — `_PLACEHOLDER`, `_SANITIZED_PLACEHOLDER` — **INTERNAL-BUT-EXPORTED** (still exported on main; removal deferred).
- `src/refusal.ts` — `PLANNED` empty const — **INTERNAL-BUT-EXPORTED** (still exported on main); `refusal()`'s `planned` param kept (roadmap-tested).
- `src/duties/remediation/capabilities.ts` — `REMEDIATION_DEFAULTS` — **INTERNAL-BUT-EXPORTED** (still named `REMEDIATION_DEFAULTS` on main; rename deferred).
- `src/core/screen.ts` — `screen` — single duty consumer (triage); not frozen surface, may internalize or document as deliberately-core later.
- `src/duties/dependa/model.ts` — `Ecosystem`/`ECOSYSTEMS`/`UpdateType`/`UPDATE_TYPES` — consumed by `core/warrant.ts` (the one core→duty import); not frozen; candidate to move the closed lists into core and re-export.

## 5. Output/result structures — `REQUIRED`

- Duty outputs (per `action.yml`): `outcome` (finding/skipped/failed), plus
  duty-specific (`proposed`, `translated`, `duplicate-of`, `responded`,
  `processed`, `synced`, `findings`, `language`, `problems`, and translate's
  `source-language`). Frozen semantics
  per duty in the behavior contract §3.
- Exit codes: red = maintainer-actionable failure; green = weather/denial/
  named no-op. Pinned by `eval/contract/exit-code*.test.ts`.
- The job-summary markdown (per-duty table + `| Language |` row for review) is
  asserted by eval fixtures; NOT byte-free — a summary-string change breaks
  eval and is a contract breach.

## 6. Anything accidentally exported? — Round 2 net

No new public surface added. **No removals landed:** the round-2 refactor
branches (`round2-deadcode`, `round2-duties`) are unmerged, so nothing was
removed or renamed on main. The §4 INTERNAL-BUT-EXPORTED list is the honest
residue for a future pass; none of it is a consumer-facing contract.

---

## How to read a shrink candidate

"INTERNAL-BUT-EXPORTED" is not a bug — it is surface a refactor may remove
when evidence says nothing outside consumes it, per Round 2's rule
"do not preserve obsolete API merely because it existed in 0.x". Each removal
must: (1) verify reachability (grep consumers), (2) run the subtree tests,
(3) run contract + mutation + eval, (4) rebuild bundles byte-identically.
The behavior contract §"How to change a frozen row" governs any surface that
IS frozen.
