# The authority boundary matrix

_Internal. Round 1 hardening evidence for the authority, configuration and
state boundaries. Every cell names the file and line of the test that proves
the claim. A claim with no test is a `GAP` with a priority, not an omission._

This is the executable half of
[the authority model](../concepts/authority-model.md) and of
[the threat model](../security/threat-model.md). Where those pages state what
must be true, this one says where that statement is checked and what would
have to break for the check to notice.

## What the tests assume

**Total model compromise.** Every escalation row below assumes the injection
worked perfectly at the layer it was aimed at — the model read the sentence and
did exactly what it said — and then asserts the answer still changes nothing. A
suite that assumed the model resisted would be measuring the model, which is
the part this repository does not control.

**A channel is only ever a string.** The twelve untrusted channels are listed
by name because the intent matrix's row G lists them, but at the boundary under
test none of them has a shape of its own: what makes a channel untrusted is
that a stranger writes it. The tests therefore drive every payload through
every channel name and assert the same table each time.

**Negative controls, not coincidences.** Every invariant below was verified by
temporarily breaking the production check it depends on and confirming the test
goes red. The table of those 24 mutations is at the bottom of this page.

---

## 1. Untrusted channel × escalation attempt

Columns are the escalation attempts; every one is driven for every channel.
The payload set is in `src/core/authority.adversarial.test.ts:94-121`:
`ignore-previous`, `grant-edit-file`, `grant-open-pr`, `disable-security`,
`change-configuration`, `approve-operation`, `reveal-secrets`,
`elevate-authority`, four non-English variants (vi, zh, ru, ar), `homoglyph`
(Cyrillic а/е inside capability words), `zero-width`, `base64`, `html-comment`,
`yaml-injection`, `fence-escape`, `markdown-fence-escape`, `long-padding`
(20 000 characters), `null-byte`, `rtl-override`.

| Untrusted channel   | Cannot widen a grant                | Cannot invent an outcome | Cannot become a capability | Cannot close the prompt fence |
| ------------------- | ----------------------------------- | ------------------------ | -------------------------- | ----------------------------- |
| PR title            | `authority.adversarial.test.ts:212` | `:240`                   | `:263`                     | `:377`                        |
| PR body             | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Issue body          | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Comment             | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Source code content | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| README              | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Commit message      | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Branch name         | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Filename            | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Rule file           | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Rule pack           | `:212`                              | `:240`                   | `:263`                     | `:377`                        |
| Model output        | `:212`, `:312`                      | `:240`, `:331`           | `:263`                     | `:377`                        |

All paths in this section are relative to `src/core/`.

**What each column proves.**

- _Cannot widen a grant_ — the payload is carried verbatim in every free-text
  field of a real warrant (`about:`, a label's `description`, its `not`, its
  `examples`), and `granted`/`unnamed` answer exactly what the `duties:` block
  wrote. Free text in the file is the field a maintainer pastes a stranger's
  wording into; it is not where a capability is read from.
- _Cannot invent an outcome_ — the compromised-model case: the verdict proposes
  the payload plus every capability name, and `enforceLabels` applies nothing,
  refusing each with `` `<path>` does not name it ``.
- _Cannot become a capability_ — level 0, where the taxonomy is read off
  repository label descriptions. The description is carried through as prose
  and nothing else: no capability, owner, exclusivity, floor, colour, path or
  `create`.
- _Cannot close the prompt fence_ — `enclose` passes the payload byte for byte
  and the block still contains exactly one closer, at the end.

### Property-based cover for the same rows

| Claim                                                                        | Test                             |
| ---------------------------------------------------------------------------- | -------------------------------- |
| Any grant is a subset of the closed capability set, for any file             | `authority.property.test.ts:148` |
| Free text never moves a grant off the block                                  | `:181`                           |
| An implicit warrant returns exactly the caller's fallback, by identity       | `:211`                           |
| The reader returns a warrant or throws an `Error` — never anything else      | `:237`                           |
| Applied ⊆ taxonomy, deduplicated, disjoint from labels already on the thread | `:269`                           |
| A fence encloses any text and is closed by exactly one thing                 | `:354`                           |

The generator is not uniform noise: `authority.property.test.ts:45-92` mixes a
vocabulary of warrant field names, capability names and handles into the random
text, because uniform random strings never spell `create` or `edit-file` and a
generator that only drew from them would prove the boundary holds against
noise rather than against an attempt.

---

## 2. Indirect escalation — seeding a value a later stage reads

Direct escalation asks for a capability. Indirect escalation seeds a _value_ a
later stage reads as authority, which is the shape that actually reaches
production systems.

| Seeded value                                                                                                                                             | Stage that reads it               | Guaranteed outcome                       | Test                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ----------------------------------- |
| A label name only the verdict carries                                                                                                                    | `enforceLabels`                   | refused, named                           | `authority.adversarial.test.ts:420` |
| A label name in the file but outside this run's scope                                                                                                    | `enforceLabels`                   | refused exactly as an unknown name       | `:429`                              |
| Every `Label` field written into a repository label description (`create`, `owner`, `confidence`, `exclusive_with`, `color`, `paths`, `not`, `examples`) | `implicitWarrant`                 | none of them is set                      | `:453`                              |
| Capability names in a label description                                                                                                                  | `implicitWarrant`                 | grant unchanged                          | `:501`                              |
| `__proto__` / `constructor` as a label name                                                                                                              | `labelNamed`                      | ordinary map entry; no prototype reached | `:512`                              |
| A capability spelled with a homoglyph, zero-width space, fullwidth form, case change or base64                                                           | `readDuties`                      | refused by name, never dropped           | `:527`                              |
| A duty name spelled `__proto__`, `constructor`, `prototype`, `TRIAGE`, `triage `, `triаge`                                                               | `readDuties`                      | refused by name                          | `:545`                              |
| An `outcome` other than `overruled` in a store line                                                                                                      | `parseCorrection`                 | the whole line is refused                | `:560`                              |
| A label outside the taxonomy inside a committed store line                                                                                               | recall → prompt → `enforceLabels` | rendered as prose, applied never         | `:574`                              |
| `__proto__` inside a store line's JSON                                                                                                                   | `parseCorrection`                 | no prototype pollution                   | `:590`                              |
| A newline inside a store field, forging a second record                                                                                                  | `formatCorrection`                | one line, always                         | `:600`                              |

---

## 3. Fail closed, no partial effect

| Claim                                                                           | Test                                |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| A refused label contributes no owner to assign                                  | `authority.adversarial.test.ts:625` |
| A run under the confidence floor assigns nobody                                 | `:650`                              |
| A maintainer's own label is never overruled                                     | `:664`                              |
| A warrant that does not parse yields no warrant at all                          | `:687`                              |
| Model confidence never grants: no value admits a name the file lacks            | `:331`                              |
| Certainty does not clear a floor it is under; `NaN`/`±Infinity` never clear one | `:338`                              |
| Model prose is defanged before it can act as a request to a human               | `:349`                              |
| Model prose cannot smuggle an HTML comment into a published body                | `:362`                              |
| Dry-run touches nothing, however many times it is replayed                      | `state.idempotency.test.ts:342`     |
| Dry-run after a real run still touches nothing                                  | `:355`                              |

---

## 4. Configuration as a public behavioural contract

Every row is asserted on the message a real run prints, not only on the fact
that something threw. Determinism is asserted separately
(`warrant.contract.test.ts:239`), as is the claim that the file path is the
only thing a message varies by (`:250`).

| Input class                                                                                          | Deterministic outcome                                                 | Test                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| Valid — minimal, and a whole file                                                                    | parses                                                                | `warrant.contract.test.ts:220` (rows 1–2) |
| Empty file / whitespace only / comments only                                                         | `is not a warrant`                                                    | `:220`                                    |
| Malformed YAML                                                                                       | `is not valid YAML`                                                   | `:220`                                    |
| A list or a bare string at the root                                                                  | `is not a warrant`                                                    | `:220`                                    |
| Two YAML documents in one file                                                                       | `is not valid YAML`                                                   | `:220`, `:376`                            |
| Duplicate keys, at the root and inside `duties:`                                                     | `is not valid YAML` — never last-wins                                 | `:220`                                    |
| Unknown root field, incl. pre-1.0 `capabilities:` and legacy `apply`                                 | `unrecognized key`                                                    | `:220`                                    |
| Unknown label field                                                                                  | `unrecognized key`                                                    | `:220`                                    |
| Invalid duty                                                                                         | `is not a known duty`                                                 | `:220`, `:445`                            |
| Invalid capability                                                                                   | `is not something a duty can be granted`                              | `:220`, `:413`                            |
| Conflicting config (`[none]` beside a real capability)                                               | refused                                                               | `:220`                                    |
| Missing required field (`version`, a label `description`)                                            | named                                                                 | `:220`                                    |
| Invalid model config (`version: 2`)                                                                  | `declares version`                                                    | `:220`                                    |
| `duties:` written with nothing under it                                                              | refused as a half-finished edit                                       | `:220`                                    |
| Wrong types (`labels` as a mapping, `duties` as a list, description as a number, confidence as text) | refused, naming the type                                              | `:220`                                    |
| Null vs absent (`labels:` null = empty; `duties:` null refused; a duty written null refused)         | distinguished                                                         | `:220`                                    |
| Oversized free text (100 000 characters)                                                             | carried, not truncated                                                | `:220`                                    |
| YAML anchors                                                                                         | accepted and inert; an alias cannot be parked under a second root key | `:332`                                    |
| YAML merge keys (`<<`)                                                                               | refused at root, in `duties:`, and on a label                         | `:353`                                    |
| `version` spellings `1`, `1.0`, `0x1`, `+1`, `0o1`                                                   | all accepted as one; `"1"`, `true`, `1.5`, `[1]`, `01a` refused       | `:393` **ADJUDICATE**                     |
| Capability whitespace                                                                                | trimmed; case/homoglyph/width/encoding refused                        | `:413` **ADJUDICATE**                     |
| YAML comment after a value                                                                           | never part of the value                                               | `:436`                                    |
| `lifecycle.say`: `true`, `false`, text, mapping, empty mapping, empty string, list                   | each read or refused by name                                          | `:582`–`:635`                             |
| `lifecycle` track / step / override that is not a mapping                                            | refused, naming the entry                                             | `:641`, `:647`, `:724`                    |
| `lifecycle.exempt` not a mapping; a guard that is neither boolean nor list                           | refused                                                               | `:662`, `:685`                            |
| `lifecycle.overrides:` written null                                                                  | no overrides                                                          | `:704`                                    |
| Missing lifecycle labels                                                                             | named at once, singular/plural correct                                | `:747`                                    |
| Durations (`soon`, `7`, `0d`) in step and override                                                   | refused, naming the grammar                                           | `:788`                                    |
| `propose:` not a mapping; partial `propose.workspace`                                                | refused / each default filled independently                           | `:835`, `:841`, `:855`                    |
| dependa ignore `ecosystem:` null; duplicate `types`                                                  | no ecosystem / deduplicated                                           | `:865`, `:876`                            |
| Label `color:` (case, null, `#`-prefixed, non-hex, wrong length, list)                               | normalised to lower case, or refused                                  | `:899`–`:908`                             |
| Label `create:` (null, non-boolean)                                                                  | defaults `false`, or refused                                          | `:924`, `:929`                            |
| `endpoints` line with no alias                                                                       | quotes the whole entry                                                | `inputs.test.ts:604`                      |
| `api-keys` line with no `=`                                                                          | masked first, then refused                                            | `inputs.test.ts:612`                      |
| `api-keys` entry with no alias                                                                       | refused                                                               | `inputs.test.ts:635`                      |
| `since` naming a field the calendar has not (`2026-13-01`, day 0, day 32)                            | refused                                                               | `inputs.test.ts:639`                      |
| `since` the calendar overflows (`2026-02-30`)                                                        | rolls to 2 March                                                      | `inputs.test.ts:659` **ADJUDICATE**       |

### No partial mutation, and no spend before validation

| Claim                                                                                   | Test                           |
| --------------------------------------------------------------------------------------- | ------------------------------ |
| Every refused source yields no warrant at all                                           | `warrant.contract.test.ts:270` |
| A written `duties:` block still denies every unnamed duty, whatever else is in the file | `:287`                         |
| A taxonomy validated only at the end still refuses the whole file                       | `:308`                         |
| Malformed YAML fails before any network call                                            | `:489`                         |
| An unknown capability fails before any network call                                     | `:499`                         |
| A chosen path that is not there fails before any network call                           | `:509`                         |
| Only a genuine absence at the default path ever reaches the forge                       | `:518`                         |
| A warrant read from disk equals the same bytes parsed in memory                         | `:527`                         |

### Doctor and runtime agree

| Claim                                                                                                                                                                                                  | Test                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Every `duties:` shape (absent, list, `true`, `false`, `[none]`, partial, cross-thread grants, all duties) resolves identically in `diagnose` and in `parseWarrant` + each duty's own `capabilities.ts` | `doctor/authority-agreement.test.ts:174`      |
| A duty-scoped report equals that duty's row in the whole-run report                                                                                                                                    | `:205`                                        |
| A level-0 report describes the same narrowest authority a level-0 run acts under                                                                                                                       | `:219`                                        |
| Every configuration a run refuses is red in doctor too                                                                                                                                                 | `:268`                                        |
| The finding is the reader's own sentence, not a second one                                                                                                                                             | `:276`                                        |
| A chosen path with no file is red in doctor                                                                                                                                                            | `:293`                                        |
| A warrant granting nothing produces a table of nothing, not a table of defaults                                                                                                                        | `:308`                                        |
| An inert grant is red and narrowed out of effective authority                                                                                                                                          | `:329`                                        |
| A denied duty is a table row, never a problem                                                                                                                                                          | `:341`                                        |
| A forge failure that is not `Error`-shaped is classified, not crashed on                                                                                                                               | `doctor/diagnose.contract.test.ts:91`–`:141`  |
| The provider probe reports a class of answer, never a provider's words                                                                                                                                 | `doctor/diagnose.contract.test.ts:186`–`:235` |

---

## 5. State and idempotency

| Replay scenario                                | Guaranteed effect                                                | Test                            |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| Same event twice                               | one pull request, updated not duplicated                         | `state.idempotency.test.ts:207` |
| Same event six times                           | one PR, one branch, one file                                     | `:220`                          |
| Replay after a first write                     | carries the existing SHA, so a concurrent write is not clobbered | `:234`                          |
| Rerun with changed content                     | same PR, new body, new content                                   | `:245`                          |
| Workflow retry                                 | no second branch, no second PR                                   | `:265`                          |
| `publishStatePr` repeated                      | one create, then updates only                                    | `:280`                          |
| `ensureBranch` twice                           | one create                                                       | `:292`                          |
| Maintainer closed the PR (declared force push) | branch reset to base, new PR                                     | `:304`                          |
| Open PR present                                | never reset out from under itself                                | `:321`                          |
| Nothing to publish                             | no call at all                                                   | `:331`                          |
| Dry-run replayed five times                    | zero calls, no branch, no PR                                     | `:342`                          |
| Dry-run after a real run                       | nothing changes                                                  | `:355`                          |
| Capacity error before the first write          | nothing written, and the warning says so                         | `:405`                          |
| Capacity error partway through                 | the warning names how many files were already written            | `:419` **REGRESSION**           |
| Partial failure                                | no PR is opened for a half-written state                         | `:444`                          |
| Retry after a partial failure                  | completes the write, one PR                                      | `:457`                          |
| A path that is a directory                     | no SHA read; the write creates                                   | `:647`                          |
| Repository reports no default branch           | published against `main`                                         | `:668`                          |
| Branch-existence check fails non-404           | propagates; no branch created                                    | `:684`                          |

### The fingerprint

| Claim                                                          | Test                                            |
| -------------------------------------------------------------- | ----------------------------------------------- |
| The same decision written twice is the same bytes              | `state.idempotency.test.ts:500`                 |
| Key order is fixed regardless of construction order            | `:504`                                          |
| Write → read → write is a fixed point                          | `:525`, `authority.property.test.ts:386`        |
| Every meaningful field changes the bytes when it changes       | `:533`                                          |
| Decided-label order is part of the record, not normalised away | `:558`                                          |
| A record is always exactly one NDJSON line                     | `:567`, `authority.property.test.ts:374`        |
| An in-memory `note: "   "` settles on the first write          | `authority.property.test.ts:405` **ADJUDICATE** |

### Corruption fails safely

| Claim                                                                           | Test                             |
| ------------------------------------------------------------------------------- | -------------------------------- |
| A line that is not a correction is refused whole, never half-read               | `state.idempotency.test.ts:588`  |
| A context field that is the wrong type defaults rather than losing the decision | `:609`                           |
| A pivot rendering that is not one reads as no rendering                         | `:623`                           |
| An unreadable shard is reported and the rest of the store still read            | `memory.test.ts:607`             |
| Reading a line never throws, whatever the file holds                            | `authority.property.test.ts:455` |

---

## 6. Negative controls

Each row is a real production check, temporarily removed; `RED` means at least
one test in this round's suites failed. All 24 were confirmed red after the
final refactor of the assertions.

| #   | Check removed                                          | File                   | Result |
| --- | ------------------------------------------------------ | ---------------------- | ------ |
| A   | taxonomy membership in the label gate                  | `core/enforce.ts`      | RED    |
| B   | deny-by-default once `duties:` is written              | `core/warrant.ts`      | RED    |
| C   | `unnamed` always false                                 | `core/warrant.ts`      | RED    |
| D   | unknown capability accepted                            | `core/warrant.ts`      | RED    |
| E   | unknown root key ignored                               | `core/warrant.ts`      | RED    |
| F   | confidence finiteness gate dropped                     | `core/enforce.ts`      | RED    |
| G   | store `outcome` enum relaxed                           | `core/memory.ts`       | RED    |
| H   | dry-run early return removed                           | `core/state-branch.ts` | RED    |
| I   | existing-PR check skipped                              | `core/state-branch.ts` | RED    |
| J   | implicit warrant grants every capability               | `core/warrant.ts`      | RED    |
| K   | fence nonce fixed                                      | `core/enclose.ts`      | RED    |
| L   | `sanitize` made a no-op                                | `core/sanitize.ts`     | RED    |
| M   | store line written unescaped                           | `core/memory.ts`       | RED    |
| N   | `create` derived from a label description              | `core/warrant.ts`      | RED    |
| O   | `owner` derived from a label description               | `core/warrant.ts`      | RED    |
| P   | capability match lower-cased (homoglyph/case widening) | `core/warrant.ts`      | RED    |
| Q   | human label ignored in exclusivity                     | `core/enforce.ts`      | RED    |
| R   | store `thread` type check relaxed                      | `core/memory.ts`       | RED    |
| S   | lifecycle step wrong-type guard removed                | `core/warrant.ts`      | RED    |
| T   | `say:` mapping value unchecked                         | `core/warrant.ts`      | RED    |
| U   | `isMissing` broadened past 404                         | `core/forge.ts`        | RED    |
| V   | partial-write warning restored to the old wording      | `core/state-branch.ts` | RED    |
| W   | doctor's ladder narrowing skipped                      | `doctor/diagnose.ts`   | RED    |
| X   | doctor ignores `denied`                                | `doctor/diagnose.ts`   | RED    |

---

## 7. Residual gaps and classified branches

### GAPs

| ID   | Gap                                                                                                                                                                                                                                                                                    | Priority |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G-A1 | The channel dimension in §1 is a name, not a wire fixture. The invariant is proved at the module boundary — where a channel genuinely is only a string — but nothing here drives a real GitHub event payload end to end. Duty-level integration suites cover that; this page does not. | P2       |
| G-A2 | `docs/reference/warrant-format.md` does not state whether YAML anchors are permitted. `warrant.contract.test.ts:332` pins the behaviour; the reference should say it.                                                                                                                  | P3       |
| G-A3 | `durationField`'s `allowNever: true` overload (`core/warrant.ts:1871-1889`) has no call site in `src/`. The `never` value and the " or `never`." half of its message are unreachable.                                                                                                  | P3       |
| G-A4 | `diagnose.ts:503-506` is a ternary whose two arms produce the identical string. Harmless, but it is dead code masquerading as a branch.                                                                                                                                                | P3       |

### Branch coverage in this area

Measured over `src/core/{warrant,enforce,inputs,memory,state-branch,recall,derive,sanitize,script,languages,pivot,list,enclose}.ts`
and `src/doctor/**` (`run.ts` stays coverage-excluded — it calls
`core.setOutput`/`core.setFailed` for real):

|                   | Branches | Covered       | Uncovered |
| ----------------- | -------- | ------------- | --------- |
| Before this round | 1045     | 961 (91.96%)  | 84        |
| After             | 1045     | 1011 (96.75%) | 34        |

`state-branch.ts`, `inputs.ts` and `pivot.ts` reach 100%; `warrant.ts` moves
90.0% → 97.2% and `diagnose.ts` 80.5% → 90.2%. The 34 that remain are all in
the table below.

### Branches deliberately left uncovered

Classified rather than excluded — root adjudicates whether any of these earns a
coverage exclusion. A branch is listed here only because covering it would have
required a test that does not protect behaviour.

| Location                                                                                        | Classification                                                                                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core/derive.ts:118-119` (`labelOf`'s `catch`, empty-name guard)                                | defensive; the module's own doc comment says the `catch` is unreachable from here                   |
| `core/derive.ts:89` (`scriptsOf` rejecting an ISO 15924 code Unicode has no script for)         | defensive; measured against this ICU, the four composite codes are the whole disagreement           |
| `core/enforce.ts:141` (`byName.get(kept)?.` nullish arm)                                        | unreachable; every name in `applied` came from `byName`                                             |
| `core/memory.ts:257` (`ranked`'s empty-store guard)                                             | unreachable; both callers return early on an empty store                                            |
| `core/memory.ts:309` ×2, `:383`, `:393`, `:459` ×2 (index and map-lookup `??` guards)           | defensive; bounds are established by the surrounding loop                                           |
| `core/memory.ts:516` (`error instanceof Error` false arm in the shard `catch`)                  | defensive; `readFile` rejects with an `Error`                                                       |
| `core/warrant.ts:374`, `:884` ×2 (non-`Error` rejection / non-`YAMLParseError` throw)           | defensive                                                                                           |
| `core/warrant.ts:1883`, `:1887` (`allowNever`)                                                  | dead code — see G-A3                                                                                |
| `core/warrant.ts:1939` (`best.get(bestDistance) ?? []`)                                         | unreachable; `bestDistance` is always a key the loop just wrote                                     |
| `core/warrant.ts:1953`, `:1962-1969` (Levenshtein equality shortcut and index guards)           | unreachable; `closestKeys` never compares a key with itself                                         |
| `core/warrant.ts:1983` (`bigint` arm, and the function/symbol fallback in `describe`)           | unreachable from YAML                                                                               |
| `doctor/diagnose.ts:495` (`rotateModels` throwing something other than `AuthenticationFailure`) | defensive                                                                                           |
| `doctor/diagnose.ts:503-506`                                                                    | dead — see G-A4                                                                                     |
| `doctor/diagnose.ts:545` (`auth` in the non-throwing branch)                                    | unreachable; `rotateModels` throws on the first auth failure, so the thrown branch above answers it |
| `doctor/diagnose.ts:551` ("the probe did not reach any provider")                               | unreachable; every `Failure` carries one of the three kinds above it                                |
| `doctor/diagnose.ts:584`, `:592` (`DEFAULTS_BY_DUTY`/`LADDER_BY_DUTY` `?? []`)                  | unreachable; `duty` is validated against `DUTIES` before either is read                             |

---

**Related:** [The authority model](../concepts/authority-model.md) ·
[Threat model](../security/threat-model.md) ·
[The warrant format reference](../reference/warrant-format.md) ·
[The intent matrix](intent-matrix.md)
