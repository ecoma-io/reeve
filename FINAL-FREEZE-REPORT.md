# FINAL-FREEZE-REPORT — Reeve 1.0 Architecture/API Freeze Decision

**Date:** 2026-08-19 · **Audited tree:** `main` @ `2e4b7de` + freeze fixes to `752ff8e`
**Method:** Final adversarial freeze round — 7 parallel domain audits (Phase 1), P0/P1 remediation with mandatory independent adversarial re-review per PR (Phase 2), and 3 fresh-eyed Level-2 reviewers with zero prior audit context auditing the post-fix tree against the 9 freeze questions (Phase 3). Fresh reviewers did not implement any fix they audited.

**Baseline verified at `2e4b7de`:** unit coverage 96.5/90.92/98.49/97.58 · contract suite 34/34 · eval pin 60 finding / 0 failed / 0 skipped · mutation table 70/70 KILLED (fast 47/47) · all CI gates green including `ci-gate` (fail-closed) and `analysis-gate`.

---

## Result

# VERDICT: READY FOR ARCHITECTURE/API FREEZE ✅

No P0 or P1 findings remain open. All three known pre-freeze gaps are closed with regression tests and independent adversarial approval. Remaining items are P2/P3, documented with owners, none of which block the freeze.

---

## Q1. Are there any remaining P0/P1?

**CLEAR — no remaining P0/P1.**

Two P1-class findings were found this round and have been **fixed, adversarially re-reviewed, and merged**:

| ID                        | Severity                                  | Evidence                                                                                                                                                                                                                    | Impact                                                                                                                                      | Fix                                                                                                                      | Test                                                                                             | Status                                                                  |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| RUNTIME-01                | P1                                        | `reeve-dogfood.yml:662,665,705` — 3 fabricated action SHAs (verified via `git ls-remote`, all HTTP 422/nonexistent)                                                                                                         | Dogfood conformance row dead on arrival; silently hard-fails at cron                                                                        | Repinned to real digests, relocked release-please to commit SHA                                                          | Existing CI (Verify/Mutation green)                                                              | ✅ FIXED #100 (`79485df`)                                               |
| SEMANTIC-01 / §10 GAP-2   | P1                                        | `review/main.ts:550-705` — review never called `failIfProtocolExhausted`; all-protocol-rot failed diff exited green                                                                                                         | Frozen §8 "protocol exhaustion = red" unenforced at a duty boundary                                                                         | Guard `shown>0 && readablePassCount===0` calls `failIfProtocolExhausted` before every green return                       | 3 integration tests: RED all-protocol, GREEN capacity, GREEN partial                             | ✅ FIXED #103 (`79adbb2`)                                               |
| TESTGATE-01               | P1                                        | `tools/mutation.mjs:1219` — `killed = status !== 0`, no causality check                                                                                                                                                     | Shared-target pre-existing failure reports KILLED for an untouched seam → gate green over ungated invariant                                 | KILLED now requires mutated-fail AND pristine-pass; pristine cached per target-set                                       | `verdict()` 4-cell pure function tests                                                           | ✅ FIXED #105 (`2e4b7de`)                                               |
| TESTGATE-02               | P1                                        | `tools/mutation.mjs:1095-1102` — comment-only disambiguated `from` re-targeted to wrong copy                                                                                                                                | Deleting a comment silently ungates seam A's invariant                                                                                      | `commentOnlyAnchor` STALEs match-only-in-comment rows; re-anchored 2 rows                                                | Whole-table no-comment-anchor assertion                                                          | ✅ FIXED #105                                                           |
| DETERMIN-01/02/05/08      | P1                                        | `testmap.ts:236` readdir order; bare `localeCompare` at 9 sites; `record.ts` `new Date()`; `walkFrom` cap                                                                                                                   | Same input could emit different bytes/decisions across environments                                                                         | Byte-sort, injectable clock, byte-order comparators                                                                      | 4 regression tests (flip-order, collation-invariance, fixed-clock identity)                      | ✅ FIXED #104 (`c39d2be`)                                               |
| FINAL-Q4-01 / FINAL-Q7-01 | **P1 (freeze-blocker, found this round)** | `rules.ts:317` `readStringList` + `pr.ts:332` `endsWith("")` + `packs.ts:200` `readPackStringList` — `generated: [""]` marks every path generated → `shown=[]` → review posts empty "No issues" GREEN on an unreviewed diff | Stamps a diff nobody read as clean — the exact contract §6 invariant the guard was built to prevent; exploitable via rules file **or pack** | Shared `trim().length===0` guard on BOTH `readStringList` and `readPackStringList` (both `generated` and `ignore` lists) | Exploit integration test + control `.lock`-only-green test + pack-path E2E + whitespace variants | ✅ FIXED #107 (`752ff8e`), caught by independent review, re-reviewed ✅ |

**False-positive dismissed this round (documented):** SEMANTIC-02 (lifecycle protocol exhaustion) — lifecycle calls `detectLanguage` with 2 args, no pick, imports no provider; "never a model" is its pinned contract (`lifecycle.md:219`). Misattributed from triage which already wires the guard. No fix. Also TESTGATE-06 / Stage-6 worst-language — a _documented deliberate measurement register_ (contract §10), not a CI gate; reclassification confirmed honest.

---

## Q2. Is the public API fully inventoried and classified (STABLE / INTERNAL / ACCIDENTAL / UNDECIDED)?

**CLEAR.** The inventory (`docs/internal/api-inventory.md`) classifies every surface; the two doc-vs-tree drift findings are fixed.

| ID           | Severity   | Finding                                                                                                                                                                                                                    | Evidence                                                                                                                               | Status                                                                         |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| FINAL-Q2-01  | P2         | Inventory claimed round-2 removals "unmerged/INTERNAL-BUT-EXPORTED" — but #99 (`fa2709f`) had MERGED the refactor; derive.ts, `PLANNED`, `_PLACEHOLDER`, `EMPTY_ATLAS`, `REMEDIATION_DEFAULTS` all removed/renamed on main | `git show main:src/core/derive.ts` → gone; `refusal.ts` `PLANNED` grep 0                                                               | ✅ FIXED #106 (`93bf505`) — docs reconciled to post-#99 tree with dated header |
| FINAL-Q2-02  | P2         | Inventory §1 omitted public leaf inputs `about` (triage/respond) and `ignore` (harmonise)                                                                                                                                  | `triage/action.yml:173`, `respond/action.yml:153`, `harmonise/action.yml:190`, all read by their mains + warrant-wins (`resolveAbout`) | ✅ FIXED #106                                                                  |
| FINAL-Q2-03  | P2         | Inventory §5 "summary asserted by eval, not byte-free" overstated for harmonise (eval asserts only 4 outputs)                                                                                                              | `eval/runner.ts:201-224` `harmoniseLine` never reads `run.summary`                                                                     | ✅ FIXED #106                                                                  |
| DOCUCON-01   | P0 (state) | Freeze docs not on main at audit start                                                                                                                                                                                     | `git show main:docs/internal/*` absent at `1a4fd29`                                                                                    | ✅ FIXED (#101, `6dc7b7c`)                                                     |
| APIFREEZE-01 | P2         | `source-language` misclassified as translate input; it is an OUTPUT                                                                                                                                                        | `translate/action.yml:300-301`, `main.ts:532`                                                                                          | ✅ FIXED #101                                                                  |

Remaining honest INTERNAL-BUT-EXPORTED residue (documented, NOT frozen surface, shrink candidates for post-freeze): `screen.ts` `screen` (single duty consumer); dependa `Ecosystem`/`UpdateType`/`ECOSYSTEMS`/`UPDATE_TYPES` (consumed by core/warrant — one core→duty import candidate to move into core).

---

## Q3. Is the architectural intent clear?

**CLEAR.** Structure matches the frozen model: warrant file = sole authority (`warrant.ts resolveAuthority`, single reader shared by doctor + runtime); provider = weather (`provider.ts` starved/protocolExhausted; `Effects` adds-only `forge.ts`); duties are closed contracts with per-duty default capability constants. The one stale register row (review "not yet wired") was fixed in #106.

---

## Q4. Are authority boundaries enforced at runtime?

**CLEAR after #107.** The closed 9-capability set is fully consumed; denied ops fail closed (lifecycle whole-step withhold, dependa `mayPublish` double-gate); dry-run is gated at every mutation call site; `record` reachable only via explicit grant (implicit warrant hardcodes `granted=fallback`); doctor is reads-only; review has no `edit-file`/`open-pr` path. The `generated: [""]` false-clean hole (the one warning this round) is closed at both parse boundaries. No path found, in this or prior rounds, by which model output, rules/pack text, or repo content widens actual write authority. Residual CAPENV-01/08 (P2, port-shape risks that only materialize if a future refactor lengthens a port) and the documented test-gap "no single integration test asserts review never calls edit-file/open-pr machinery" are tracked, non-blocking.

---

## Q5. Can the test/gates be bypassed?

**CLEAR.** The gate stack withstood targeted attack this round:

- **Mutation harness:** KILLED now requires causality (mutated-fail ∧ pristine-pass), signal-killed runs throw, `commentOnlyAnchor` flags comment-disambiguated rows, TABLE_FLOOR stays. Pre-flight checks the whole table on every run.
- **Coverage:** `test:tools` pins the coverage-config rejects and thresholds; CI's `pnpm test` enforces the 90% floor; eval contract runs its own suite.
- **eval:** missing `.expected.json` throws red; empty expected requires a non-commenting clean stop; shadow dirs refused.
- **ci-gate:** `needs:[verify,mutation]` + inverted fail-close (`if: always()`), survives all merges; only named "safe" state passes.
- **Known limit (documented, P2 TESTGATE-11):** no test asserts every job id ⊆ its gate's `needs`; the reviewers recommend a `duties.test.ts`-style text check at the 1.0 release when branch-protection is configured.
- **No committer defeats a gate by editing only the pin — the gate and its self-test change together** (deliberate, documented).

---

## Q6. Is the runtime/release contract consistent?

**CONSISTENT.** Node 24 + pnpm ≥11 agree across `.node-version`, `engines`, `packageManager`, CI/release/dogfood `setup-node` + `pnpm/action-setup`, all 10 `action.yml` `runs.using: node24`, `tools/build.mjs` outfiles. Bundles verified deterministic (clean-install rebuild is byte-identical, `git status --porcelain` empty, zero `../../../node_modules` leaks). `ci-gate` + `analysis-gate` fail-closed. All action SHA pins verified real post-#100. The Stage-6 worst-language 100% (3 providers) is honestly labeled a _documented human-gated measurement register_, not a CI check (contract §10, `eval/README.md`, `evaluation.md`). Two P2 notes: the committed Stage-6 number is a snapshot with no clock (FINAL-Q6-01 — re-measure and diff at the 1.0 release); the mutation-split comment predates the causality re-run (FINAL-Q6-02).

---

## Q7. Are there any dangerous false-negatives converting unsound state → success/clean/allowed?

**CLEAR after #103/#107.** Duty-by-duty protocol-exhaustion: all seven model-calling duties invoke `failIfProtocolExhausted` (dependa, duplicate, harmonise, respond, translate, triage, review); lifecycle + remediation never call a model (verified). Mixed capacity+protocol stays green per contract. Malformed outputs are never success; NaN/Infinity confidence refused; forged markers/dispositions refused whole; `duplicate_of` must name an offered candidate. **The one dangerous false-negative found this round (`generated: [""]` → clean stamp) is closed at both parse boundaries (#107).** Two P2 residuals (non-blocking, tracked): `listPrFiles`/`readEvents` return silently at their page ceilings with no `uncertain` signal (FINAL-Q7-02); `dependa` `readFile` swallows non-404 to `null`, so an unreadable lockfile is treated as absent rather than surfaced as `partial` (FINAL-Q7-03).

---

## Q8. Is any behavior not characterized (unpinned) by a test?

**CLEAR with two tracked P2s.** Every frozen contract row now has executable evidence after this round's merges (mutation rows + contract suite + integration + eval fixtures). Two behaviors worth an explicit decision before/at 1.0, neither a current blocker:

- **FINAL-Q8-01 (P2):** review **write-after-red** (all-protocol exhaustion ∧ deterministic findings present → `setFailed` red AND the run still posts the comment) is unpinned — the #103 tests cover all-protocol-without-deterministic, capacity, and partial, but not red-plus-write. Adjudication needed: should a red review still post its deterministic findings? Nothing currently asserts either way.
- **FINAL-Q1-01 (P2):** same interaction — deterministic findings present + all-protocol → red run that posts comments + a green-looking summary is untested.

Both are the _same_ adjudication: decide and pin whether a red (all-protocol) review run may still post deterministic preflight findings. Recommend a single integration test + one contract row at the freeze-by date.

---

## Q9. Is any refactor with contract-break risk not locked by a test?

**CLEAR with two tracked P2s.**

- **FINAL-Q9-01 (P2):** the #103 guard's _placement_ (before comment-denied and dry-run returns, at `review/main.ts:658-663`) is contract-load-bearing but pinned only by integration tests — no mutation row targets it. A future refactor could silently move it. Add one mutation row or keep the 3 integration tests as the guard.
- **FINAL-Q6-03 (P3):** the mutation causality pristine re-run uses unbounded `spawnSync` (no per-row timeout) — a hung run reads as a red `ci-gate`. Wrap it in the same signal-killed handling as the rest of the loop at the split.

---

## Summary of this round's freeze-relevant work

| What                                                                                     | Where                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 6 P1 fixes + 1 P1 freeze-blocker found and fixed                                         | #100 pins, #103 review-exhaustion, #104 determinism, #105 mutation-causality |
| Freeze docs landed on main (was P0 audit-state)                                          | #101 (`6dc7b7c`)                                                             |
| Freeze docs reconciled to post-#99 tree (was P2 drift)                                   | #106 (`93bf505`)                                                             |
| `generated`/pack empty-suffix false-clean stamp closed (P1)                              | #107 (`752ff8e`)                                                             |
| False-positive findings dismissed (no fix)                                               | SEMANTIC-02; TESTGATE-06/Stage-6                                             |
| Every fix independently adversarially reviewed; 1 fix went through BLOCKED→fix→re-review | #105, #107                                                                   |

## Known non-blocking items (P2/P3) to fold into the 1.0 release checklist

- [ ] Adjudicate + pin review write-after-red (FINAL-Q1-01/FINAL-Q8-01).
- [ ] Add one mutation row for the review red-guard placement (FINAL-Q9-01).
- [ ] Re-measure `eval/live.ts` and diff the committed Stage-6 table at release (FINAL-Q6-01).
- [ ] Job-id ⊆ gate-needs text check for both gates at branch-protection setup (TESTGATE-11).
- [ ] `listPrFiles`/`readEvents` `uncertain` signal at page ceilings (FINAL-Q7-02); `dependa` non-404 read-error `partial` (FINAL-Q7-03).
- [ ] Extract a shared empty-suffix helper if a third list consumer appears (minor drift risk); document `/`/`.` suffix limitation (FINAL-Q4-01 minor).
- [ ] Pristine re-run per-row timeout (FINAL-Q6-03); mutation-split comment refresh (FINAL-Q6-02).
- [ ] 0.8.1 release-please PR (#102) is HOLDING for the freeze verdict; regenerate/merge after 1.0 prep.
- [ ] Verify branch-protection ruleset lists `ci-gate` + `analysis-gate` at release setup (Q6 skip note).
