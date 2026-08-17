# Rule packs

_Full schema for versioned, composable review-policy files. Prerequisites: [The `review` duty](duties/review.md) and [the warrant](../guides/warrant.md)._

Rule packs turn a repository's review rules into reusable, versioned, composable
units. A pack is a fragment of the same YAML grammar the rules file uses — the
same `rules`/`ignore`/`generated`/`blocked` fields, parsed by the same parser —
referenced by name and pinned by version from the repository's own rules file:

```yaml
# .github/reeve-rules.yml
version: 1
packs:
  - pack: security/owasp@1
  - pack: go/concurrency@1.2
  - pack: typescript/safety
```

The local rules file stays authoritative: everything it defines wins over
everything a pack defines, and a pack can never override the repository's own
words. Packs are repo-owned committed files — never fetched, never registered,
never hosted (D6). They describe review policy only, and they can never grant
authority: a pack has no field for capabilities, and the warrant stays the only
source a duty's permissions are read from (D2).

## Where packs live

`packs-path` (default `.github/reeve-packs`) holds `<namespace>/<name>.yml`.
A reference `security/owasp` resolves to `.github/reeve-packs/security/owasp.yml`
in the same checkout the rules file comes from — the workflow pins `ref:
base.ref`, so packs, like the rules file, are the base branch's own reviewed
text.

## The reference grammar

A `packs:` entry is a mapping with exactly one `pack:` key:

| Form                 | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `namespace/name`     | Unpinned. Resolves to whatever the checkout has.               |
| `namespace/name@1`   | Major pin. The pack's declared `version:` must have major `1`. |
| `namespace/name@1.2` | Exact pin. The pack's `version:` must be exactly `1.2`.        |

Both segments are lowercase letters, digits and hyphens, starting with a
letter. Anything else — `../`, uppercase, a trailing `.yml`, a third segment —
is structurally impossible and fails the run red. A reference to a pack that is
missing, unreadable, or does not match its pin also fails red, naming the pack:
a `pack:` reference is an explicit versioned choice, the same class as naming a
warrant path that is not there.

## The pack file

```yaml
# .github/reeve-packs/go/concurrency.yml
name: Go concurrency rules
description: Rules a review cites when the diff shows concurrency primitives.

version: 1.0

rules:
  - id: goroutine-leak
    name: Unbounded goroutine
    marker: goroutine
    body: Flag a goroutine spawned without a lifecycle bound or cancellation path.
    severity: warning

ignore:
  files: [vendor/gorums.md]
  paths: ["**/generated/go/**"]

generated: [".pb.go", ".sum"]

blocked:
  - phrase: TODO-FIXME
    severity: critical
    note: Resolve before merge.
```

### Top-level keys

| Key           | Required | What it does                                                                                                                                                                  |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | no       | Informational; never parsed further.                                                                                                                                          |
| `description` | no       | Informational; never parsed further.                                                                                                                                          |
| `version`     | no       | The pack's semantic version, pinned against by references. `1`, `1.0` and `"1.0"` all mean major 1 minor 0; a three-part version (`1.2.3`) or a non-numeric value is refused. |
| `rules`       | no       | Named rules a finding can cite, the same shape as the rules file's `rules:`. Absent means the pack adds no rules.                                                             |
| `ignore`      | no       | `files:` (exact path names) and `paths:` (globs) that never reach the model. Absent means nothing is ignored by this pack.                                                    |
| `generated`   | no       | Generated-file suffixes, the same shape as the rules file's `generated:`. Absent means nothing is added.                                                                      |
| `blocked`     | no       | Phrases the diff must not contain, the same shape as the rules file's `blocked:`. Absent means nothing is blocked.                                                            |

**Any other top-level key fails red, naming the key.** This is deliberately one
rung stricter than the rules file, where an unknown key only warns: a pack is a
single purpose, and a typo'd key would silently drop the whole policy somebody
pinned. In particular `duties:`, `capabilities:`, `warrant:` and `labels:` are
refused with a note that a rule pack describes review policy and cannot grant
authority (D2). `packs:` inside a pack is also refused — composition is exactly
one level, always from the local rules file, so the load order is a list and
deterministic (D9).

### Hard limits

- **`MAX_PACK_CHARS` (8,000)** — one pack file over it fails red. Truncation
  would silently drop the policy somebody pinned, so a pack that will not fit
  is refused instead.
- **Aliases refused** — a pack is parsed with YAML aliases and merge keys
  disabled, so a small pack cannot expand into a prompt flood. This is a
  property of the code path, not the parser's default (D8).
- **Composition budget** — the sum of the referenced packs, and the composed
  rules-and-blocked text, are both capped at `MAX_RULES_CHARS` (20,000). A
  composition over either budget fails red.

## Composition and precedence

Precedence, highest wins: **local rules file → pack[0] → pack[1] → … →
built-in defaults**. The order is the reference order in the local `packs:`
list — never a filesystem walk — so the same checkout always loads the same
policy (D9).

| Slot                            | Merge                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules`                         | **Id-keyed, first-definition-wins.** The local rules are inserted first, then each pack's rules in reference order; a later definition of an id already present is dropped with a warning naming both sources. A local rule with an id always beats a pack's rule with the same id; pack[0] beats pack[1]. |
| `blocked`                       | **Union, dedup by phrase.** A phrase is blocked if any source blocks it; the first definition's severity and note win.                                                                                                                                                                                     |
| `generated`                     | **Union of every non-empty list.** An empty union falls back to the built-in defaults (`.min.js`, `.min.css`, `.map`). With no packs this reproduces today exactly.                                                                                                                                        |
| `ignore.files` / `ignore.paths` | **Union.** A pack that must ignore `vendor/**` has to be able to say so. The existing `allShownIgnored` guard still fires on any composition: a diff whose every file the composed rules ignore is reported as `withheld`, never stamped clean.                                                            |

The built-in `dedup` rule is included exactly when **no source — local or any
pack — wrote a non-empty `rules:` list**. A pack that contributes rules makes
the pool explicit: a pack author who wants `dedup` lists `id: dedup` themselves.

## Security

- **A pack can never grant authority.** Composition produces only a `Rules`
  object — fields for rules, ignores, generated suffixes and blocked phrases.
  There is no field for capabilities and no code path from a pack to the
  warrant (D2). A pack carrying `duties:`, `capabilities:`, `warrant:` or
  `labels:` is refused red.
- **A pack is hostile by default (D8).** Unknown top-level keys, YAML aliases
  and merge keys, over-budget files, and compositions that exceed the budget
  all fail red — loud, never silently weakened (D5).
- **The diff is still framed as untrusted.** Packs are maintainer text from
  the pinned base-ref checkout, entering the model's prompt unwrapped like the
  rules file and the taxonomy. A pack's values are never authority on their
  own, and the pull request's own words stay behind the per-call nonce
  boundary regardless.

## The D2--guarantee

A rule pack describes review policy — what a review looks for and what it
skips. The warrant describes capabilities — what a run may do. These are
separate by construction: a pack file that tries to name a capability is
refused, and a pack can never modify, shadow or grant the warrant. No input,
no pack file, and no composition turns that on.

**Related:** [The `review` duty](duties/review.md) · [The warrant](../guides/warrant.md) ·
[The authority model](../concepts/authority-model.md) ·
[Threat model](../security/threat-model.md)
