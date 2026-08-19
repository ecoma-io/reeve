# Reeve public API inventory — Round 2

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
(`number`, `sweep`, `limit`, `drafts`, `paths`, `source-language`,
`rules-path`, `packs-path`, `risk-path`, `show-attribution`,
`corrections-dir`, `state-branch`, `provenance-dir`, `glossary-dir`,
`confidence`, `max-body-chars`, `max-replies`, `chunk-chars`, `max-requests`,
`translate-replies`, `candidates`, `corpus-limit`, `corpus-since`,
`min-body-chars`, `labels`, `sweep-state`, `since`, `trigger`,
`max-diff-chars`, `max-context-chars`, `guidance`, `ecosystems`, `paths`).
All `REQUIRED`; `sweep`+`number` together is refused (D4).

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
by tests. Round 2 already removed or internalized several (see below); the
remainder are the next pre-1.0 shrink candidates, NOT frozen surface:

- `src/core/derive.ts` — `deriveLanguage`/`Derived` — **REMOVED in Round 2** (inlined into `languages.ts`, module-private).
- `src/core/atlas.ts` — `EMPTY_ATLAS`, `ATLAS_MAX_PACKAGES` — **INTERNALIZED in Round 2**.
- `src/duties/harmonise/ignore.ts` — `_PLACEHOLDER`, `_SANITIZED_PLACEHOLDER` — **REMOVED in Round 2** (moved to test).
- `src/refusal.ts` — `PLANNED` empty const — **REMOVED in Round 2**; `refusal()`'s `planned` param kept (roadmap-tested).
- `src/duties/remediation/capabilities.ts` — `REMEDIATION_DEFAULTS` — **RENAMED to `DEFAULT_CAPABILITIES` in Round 2**.
- `src/core/screen.ts` — `screen` — single duty consumer (triage); not frozen surface, may internalize or document as deliberately-core later.
- `src/duties/dependa/model.ts` — `Ecosystem`/`ECOSYSTEMS`/`UpdateType`/`UPDATE_TYPES` — consumed by `core/warrant.ts` (the one core→duty import); not frozen; candidate to move the closed lists into core and re-export.

## 5. Output/result structures — `REQUIRED`

- Duty outputs (per `action.yml`): `outcome` (finding/skipped/failed), plus
  duty-specific (`proposed`, `translated`, `duplicate-of`, `responded`,
  `processed`, `synced`, `findings`, `language`, `problems`). Frozen semantics
  per duty in the behavior contract §3.
- Exit codes: red = maintainer-actionable failure; green = weather/denial/
  named no-op. Pinned by `eval/contract/exit-code*.test.ts`.
- The job-summary markdown (per-duty table + `| Language |` row for review) is
  asserted by eval fixtures; NOT byte-free — a summary-string change breaks
  eval and is a contract breach.

## 6. Anything accidentally exported? — Round 2 net

No new public surface added. Round 2 removed 4 internal-but-exported surfaces
and renamed 1 misnamed const. The remaining INTERNAL-BUT-EXPORTED list above is
the honest residue for a future pass; none of it is a consumer-facing contract.

---

## How to read a shrink candidate

"INTERNAL-BUT-EXPORTED" is not a bug — it is surface a refactor may remove
when evidence says nothing outside consumes it, per Round 2's rule
"do not preserve obsolete API merely because it existed in 0.x". Each removal
must: (1) verify reachability (grep consumers), (2) run the subtree tests,
(3) run contract + mutation + eval, (4) rebuild bundles byte-identically.
The behavior contract §"How to change a frozen row" governs any surface that
IS frozen.
