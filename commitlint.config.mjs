// Conventional Commits, enforced by lefthook's commit-msg hook and re-checked
// against the pull request title in CI (the squash subject never reaches the
// hook). Rules and examples: CONTRIBUTING.md.
//
// This repository is one package holding one core and several duties, so the
// scope carries routing information the type cannot: it says whether a change
// is to the machine every duty shares, or to one duty's own judgement. That
// distinction is the consolidation's whole point — a change scoped to a duty
// must not be a change to the core wearing a duty's name.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        // The core — shared by every duty. Doctrine D-numbers in
        // docs/north-star.md govern these.
        "action", // the per-duty action.yml contracts: inputs, outputs, defaults
        "provider", // the OpenAI-compatible client and model rotation
        "warrant", // the authority file, its parsing, and the allowlist check
        "score", // deterministic structural scoring of a draft
        "judge", // model tie-break among scored drafts
        "sanitize", // containment of model prose before it is published
        "memory", // the corrections store and retrieval over it
        "forge", // reading from and writing to the hosting platform
        "publish", // idempotency markers and the write path

        // The duties — one scope each. A new duty adds a scope here in the
        // commit that adds the duty.
        "translate",
        "triage",

        // Everything else.
        "eval", // evaluation sets and the harness over them
        "brand", // logo, banner, the assets under .github
        "docs",
        "workspace",
        "deps",
        "ci",
      ],
    ],
    "body-max-line-length": [0],
  },
};
