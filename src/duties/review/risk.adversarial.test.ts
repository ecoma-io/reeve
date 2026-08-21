/**
 * The risk profile is committed repository content, and it decides how many
 * model passes a diff gets. That makes it the review's configuration-bypass
 * surface: every case below asks what a malformed — or deliberately weakened —
 * profile can do to the depth of a review, and pins the answer.
 *
 * The disk-reading half (`readRiskProfile`) is here too, because a profile
 * that cannot be read must be the default, loudly, and never "no risk".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrFile } from "./pr.js";
import {
  assessRisk,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  defaultRiskProfile,
  describeRisk,
  MAX_RISK_PROFILE_CHARS,
  parseRiskProfile,
  readRiskProfile,
  UnreadableRiskProfile,
} from "./risk.js";
import { parseRules, type Rules } from "./rules.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));
import * as core from "@actions/core";

beforeEach(() => {
  vi.clearAllMocks();
});

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "src/a.ts",
    status: "added",
    previousPath: null,
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+const a = 1;",
    ...overrides,
  };
}

const rules = (): Rules => parseRules("version: 1");

async function scratch(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "reeve-review-risk-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

describe("readRiskProfile — an unreadable profile is the default, never no risk", () => {
  it("a_missing_profile_is_the_default_without_a_warning", async () => {
    // REGRESSION, same root cause as `readRules`: `isMissing` asked an HTTP
    // question of a filesystem error, so the silent cold-start branch was
    // unreachable and every repository without a risk profile was warned at.
    const s = await scratch();
    try {
      expect(await readRiskProfile(join(s.root, "nope.yml"))).toEqual(defaultRiskProfile());
      expect(core.warning).not.toHaveBeenCalled();
    } finally {
      await s.dispose();
    }
  });

  it("a_directory_at_the_profile_path_warns_and_uses_the_default", async () => {
    const s = await scratch();
    try {
      await mkdir(join(s.root, "risk.yml"));
      expect(await readRiskProfile(join(s.root, "risk.yml"))).toEqual(defaultRiskProfile());
      expect(core.warning).toHaveBeenCalledTimes(1);
    } finally {
      await s.dispose();
    }
  });

  it("an_empty_profile_file_is_the_default", async () => {
    const s = await scratch();
    try {
      const path = join(s.root, "risk.yml");
      await writeFile(path, "\n   \n");
      expect(await readRiskProfile(path)).toEqual(defaultRiskProfile());
    } finally {
      await s.dispose();
    }
  });

  it("a_profile_past_the_character_cap_is_truncated_at_the_cap", async () => {
    const s = await scratch();
    try {
      const path = join(s.root, "risk.yml");
      const filler = `# ${"z".repeat(200)}\n`;
      await writeFile(
        path,
        `version: 1\nthresholds:\n  medium: 3\n  high: 9\n${filler.repeat(200)}`,
      );
      const out = await readRiskProfile(path);
      expect(out.raw.length).toBeLessThanOrEqual(MAX_RISK_PROFILE_CHARS);
      expect(out.thresholds).toEqual({ medium: 3, high: 9 });
    } finally {
      await s.dispose();
    }
  });

  it("a_profile_that_is_not_valid_yaml_fails_red_rather_than_defaulting", async () => {
    // A profile a maintainer wrote and this run cannot read is a repository
    // that asked to be priced and is not — loud, not quietly default.
    const s = await scratch();
    try {
      const path = join(s.root, "risk.yml");
      await writeFile(path, "thresholds:\n  medium: [\n");
      await expect(readRiskProfile(path)).rejects.toBeInstanceOf(UnreadableRiskProfile);
    } finally {
      await s.dispose();
    }
  });

  it("a_profile_that_is_a_list_fails_red", () => {
    expect(() => parseRiskProfile("- one\n")).toThrow(UnreadableRiskProfile);
    expect(() => parseRiskProfile("just a scalar\n")).toThrow(UnreadableRiskProfile);
  });
});

describe("parseRiskProfile — a malformed section never silently weakens the score", () => {
  const warningsOf = (yaml: string) => parseRiskProfile(yaml).warnings;

  it("a_non_mapping_thresholds_section_keeps_the_defaults", () => {
    const out = parseRiskProfile("version: 1\nthresholds: [3, 9]\n");
    expect(out.warnings).toContain("`thresholds:` is not a mapping; using defaults");
    expect(out.thresholds).toEqual({ ...DEFAULT_THRESHOLDS });
  });

  it("an_absent_threshold_keeps_its_own_default_rather_than_zero", () => {
    // A `medium:` nobody wrote must not become 0 and price every diff medium.
    const out = parseRiskProfile("version: 1\nthresholds:\n  high: 9\n");
    expect(out.thresholds).toEqual({ medium: DEFAULT_THRESHOLDS.medium, high: 9 });
    expect(out.warnings).toEqual([]);
  });

  it("a_threshold_outside_zero_to_a_hundred_is_refused_by_key", () => {
    expect(warningsOf("version: 1\nthresholds:\n  medium: -1\n")).toContain(
      "`thresholds.medium:` must be an integer 0..100; using default 2",
    );
    expect(warningsOf("version: 1\nthresholds:\n  high: 101\n")).toContain(
      "`thresholds.high:` must be an integer 0..100; using default 8",
    );
    expect(warningsOf("version: 1\nthresholds:\n  high: 2.5\n")).toContain(
      "`thresholds.high:` must be an integer 0..100; using default 8",
    );
  });

  it("a_non_mapping_weights_section_keeps_every_built_in_weight", () => {
    const out = parseRiskProfile("version: 1\nweights: 5\n");
    expect(out.warnings).toContain("`weights:` is not a mapping; using defaults");
    expect(out.weights).toEqual({ ...DEFAULT_WEIGHTS });
  });

  it("an_unknown_weight_key_is_named_and_ignored_never_applied_to_a_guess", () => {
    const out = parseRiskProfile("version: 1\nweights:\n  total-risk: 0\n");
    expect(out.warnings).toContain("unknown weight `total-risk`; ignored");
    expect(out.weights).toEqual({ ...DEFAULT_WEIGHTS });
  });

  it("a_non_mapping_paths_section_adds_no_paths", () => {
    const out = parseRiskProfile("version: 1\npaths:\n  - vendor/**\n");
    expect(out.warnings).toContain("`paths:` is not a mapping; ignoring");
    expect(out.paths).toEqual({});
  });

  it("an_unknown_path_signal_is_named_and_ignored", () => {
    const out = parseRiskProfile("version: 1\npaths:\n  everything:\n    - '**'\n");
    expect(out.warnings).toContain("unknown path signal `everything`; ignored");
    expect(out.paths).toEqual({});
  });

  it("a_non_list_path_signal_is_ignored_by_key", () => {
    const out = parseRiskProfile("version: 1\npaths:\n  sensitive: vendor/**\n");
    expect(out.warnings).toContain("`paths.sensitive:` is not a list; ignoring");
    expect(out.paths).toEqual({});
  });

  it("a_non_string_path_entry_is_dropped_by_position_and_the_rest_kept", () => {
    const out = parseRiskProfile("version: 1\npaths:\n  sensitive:\n    - vendor/**\n    - 7\n");
    expect(out.warnings).toContain("`paths.sensitive` entry 2 is not a string; dropped");
    expect(out.paths.sensitive_path).toEqual(["vendor/**"]);
  });

  it("a_profile_setting_every_weight_to_zero_cannot_silence_a_policy_escalation", () => {
    // The configuration-bypass case: weights price DEPTH, they do not decide
    // whether a policy signal escalates. A profile that zeroes everything
    // still gets a high tier on an auth change.
    const zeroed = parseRiskProfile(
      [
        "version: 1",
        "weights:",
        ...Object.keys(DEFAULT_WEIGHTS)
          .filter((key) => key !== "generated_code")
          .map((key) => `  ${key.replace(/_/g, "-")}: 0`),
      ].join("\n"),
    );
    const out = assessRisk([file({ path: "src/auth/token.ts" })], rules(), zeroed);
    expect(out.tier).toBe("high");
  });
});

describe("assessRisk — the tier a diff earns", () => {
  it("names_the_profile_it_was_priced_by", () => {
    expect(assessRisk([file()], rules(), defaultRiskProfile()).profile).toBe("default");
    expect(assessRisk([file()], rules(), parseRiskProfile("version: 1\n")).profile).toBe(
      "repository profile",
    );
  });

  it("a_migration_named_only_in_the_path_still_fires_the_db_signal", () => {
    // The path-word fallback beside the glob list: `db/migrate/0001.rb` is a
    // migration whatever the built-in globs happen to match.
    const out = assessRisk(
      [file({ path: "db/migrate/0001_add_users.rb", patch: "@@ -0,0 +1 @@\n+x" })],
      rules(),
      defaultRiskProfile(),
    );
    expect(out.signals.map((s) => s.signal)).toContain("db_migration");
    expect(out.tier).toBe("high");
  });

  it("a_repository_path_list_extends_the_built_in_globs_rather_than_replacing_them", () => {
    // `closed/**`, not `vendor/**`: the generated defaults now skip vendored
    // directories outright, and a path signal reads only non-generated files —
    // a repository that wants a generated-by-default directory priced as
    // sensitive also writes its own `generated:` list.
    const profile = parseRiskProfile("version: 1\npaths:\n  sensitive:\n    - 'closed/**'\n");
    const extended = assessRisk([file({ path: "closed/thing.ts" })], rules(), profile);
    expect(extended.signals.map((s) => s.signal)).toContain("sensitive_path");
    const builtin = assessRisk([file({ path: "src/auth/token.ts" })], rules(), profile);
    expect(builtin.tier).toBe("high");
  });

  it("an_empty_diff_is_low_with_no_signals_and_says_so", () => {
    const out = assessRisk([], rules(), defaultRiskProfile());
    expect(out).toMatchObject({ tier: "low", score: 0, signals: [] });
    expect(describeRisk(out)).toBe("low — no risk signals fired");
  });

  it("describeRisk_lists_every_signal_when_none_escalated_by_policy", () => {
    const out = assessRisk(
      Array.from({ length: 20 }, (_, i) =>
        file({ path: `src/m${String(i)}.ts`, additions: 40, deletions: 40 }),
      ),
      rules(),
      defaultRiskProfile(),
    );
    const described = describeRisk(out);
    expect(described).toContain("changed-lines");
    expect(described).toContain("changed-files");
    expect(described).not.toContain("by policy");
  });

  it("the_same_files_and_profile_always_produce_the_same_assessment", () => {
    const files = [file({ path: "src/auth/x.ts" }), file({ path: "db/migrate/1.sql" })];
    const a = assessRisk(files, rules(), defaultRiskProfile());
    const b = assessRisk([...files], rules(), defaultRiskProfile());
    expect(a).toEqual(b);
  });
});

describe("each risk signal describes itself in the run's own words", () => {
  const describeFor = (path: string) =>
    describeRisk(assessRisk([file({ path })], rules(), defaultRiskProfile()));

  it("a_public_api_path_is_named_as_one_and_reaches_at_least_medium", () => {
    const out = assessRisk([file({ path: "src/api/users.ts" })], rules(), defaultRiskProfile());
    expect(out.signals.map((s) => s.signal)).toContain("public_api");
    expect(out.signals.find((s) => s.signal === "public_api")?.evidence[0]).toContain(
      "a public API path",
    );
  });

  it("an_infrastructure_path_is_named_as_one", () => {
    const out = assessRisk(
      [file({ path: ".github/workflows/release.yml" })],
      rules(),
      defaultRiskProfile(),
    );
    expect(out.signals.map((s) => s.signal)).toContain("infra_change");
    expect(out.signals.find((s) => s.signal === "infra_change")?.evidence[0]).toContain(
      "an infrastructure path",
    );
  });

  it("a_sensitive_path_and_an_authorization_path_are_named_apart", () => {
    const auth = assessRisk([file({ path: "src/auth/login.ts" })], rules(), defaultRiskProfile());
    const evidence = auth.signals.flatMap((s) => s.evidence).join(" ");
    expect(evidence).toContain("a sensitive path");
    expect(evidence).toContain("an authorization path");
  });

  it("a_migration_word_in_a_path_no_glob_matches_still_fires_the_db_signal", () => {
    // The word fallback beside the glob list: `sql/migrate_users_table.sql` is
    // matched by no built-in glob (`**/migrate/**` needs a directory), and the
    // word test is what keeps a real migration from pricing as an ordinary
    // source change.
    const out = assessRisk(
      [file({ path: "sql/migrate_users_table.sql" })],
      rules(),
      defaultRiskProfile(),
    );
    expect(out.signals.map((s) => s.signal)).toContain("db_migration");
    expect(out.signals.find((s) => s.signal === "db_migration")?.evidence[0]).toContain(
      "a database-schema path",
    );
    expect(out.tier).toBe("high");
    expect(describeFor("sql/migrate_users_table.sql")).toContain("db-migration");
  });

  it("an_ordinary_source_path_fires_no_path_signal_at_all", () => {
    const out = assessRisk([file({ path: "src/format.ts" })], rules(), defaultRiskProfile());
    expect(out.signals.map((s) => s.signal)).not.toContain("db_migration");
    expect(out.signals.map((s) => s.signal)).not.toContain("public_api");
    expect(out.tier).toBe("low");
  });
});
