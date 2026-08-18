/**
 * Malicious rule packs, and the on-disk composition path that loads them.
 *
 * A rule pack is repository content — it arrives in a pull request the same
 * way source does — so the only interesting question about it is what it can
 * make the review DO. This file answers that from the loading side
 * (`readPackedRules`, which `packs.test.ts` never reaches because it parses
 * text rather than reading a checkout) and from the firing side (`preflight`,
 * the one place a pack's contents become findings with no model in the loop
 * and therefore no verification pass to catch them).
 *
 * Named after what an attacker would try: grant authority, escape the packs
 * directory, flood the diff with critical findings, or make the review claim
 * something the diff never proved.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnreadablePacks } from "./packs.js";
import {
  MAX_RULES_CHARS,
  parseRules,
  preflight,
  readPackedRules,
  readPackRefs,
  readRules,
  UnreadableRules,
  type Rules,
} from "./rules.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));
import * as core from "@actions/core";

beforeEach(() => {
  vi.clearAllMocks();
});

/** A checkout with a rules file and a `packs/` tree, torn down per case. */
async function checkout(
  rules: string,
  packs: Readonly<Record<string, string>> = {},
): Promise<{ rulesPath: string; packsPath: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "reeve-review-packs-"));
  const rulesPath = join(root, "reeve-review.yml");
  const packsPath = join(root, "packs");
  await writeFile(rulesPath, rules);
  for (const [rel, text] of Object.entries(packs)) {
    const at = join(packsPath, rel);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, text);
  }
  return { rulesPath, packsPath, dispose: () => rm(root, { recursive: true, force: true }) };
}

/** Runs `fn` and hands back the `UnreadableRules` it threw, so an assertion
 *  about its warnings never has to live inside a `catch`. */
function caught(fn: () => unknown): UnreadableRules | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as UnreadableRules;
  }
}

/** A one-file diff snapshot, shaped the way `preflight` reads it. */
function snapshot(lines: Readonly<Record<number, string>>, path = "src/app.ts") {
  return {
    shown: [{ path, lines: new Map(Object.entries(lines).map(([n, t]) => [Number(n), t])) }],
  };
}

describe("preflight — a rule pack cannot flood the review", () => {
  it("malicious_rule_pack_cannot_flood_every_line_with_an_empty_blocked_phrase", () => {
    // REGRESSION. `text.includes("")` is true of every line, so a `blocked:`
    // entry whose `phrase:` is absent (a mapping with only `severity:`, which
    // both readers accept and fill with "") fired a `critical` finding on
    // every line of every shown file, capped only by MAX_BLOCKED_PER_PHRASE.
    // Preflight findings are the ones that never reach `verifyFindings` —
    // they are trusted BECAUSE they are deterministic — so a phrase that
    // matches everything is a way to publish forty critical claims per file
    // that no evidence gate would ever have admitted.
    const rules = parseRules(
      ["version: 1", "blocked:", "  - severity: critical", "    note: gotcha"].join("\n"),
    );
    expect(rules.blocked[0]?.phrase).toBe("");

    const findings = preflight(snapshot({ 1: "const a = 1;", 2: "const b = 2;" }), rules);
    expect(findings.filter((f) => f.kind === "blocked")).toEqual([]);
  });

  it("an_empty_blocked_phrase_written_as_a_bare_string_is_also_inert", () => {
    const rules = parseRules(["version: 1", "blocked:", '  - ""'].join("\n"));
    expect(rules.blocked).toHaveLength(1);
    expect(preflight(snapshot({ 1: "anything at all" }), rules)).toEqual([]);
  });

  it("a_real_blocked_phrase_still_fires_at_the_line_the_patch_proves", () => {
    // The guard above must not have turned the feature off.
    const rules = parseRules(["version: 1", "blocked:", "  - phrase: TODO"].join("\n"));
    const findings = preflight(snapshot({ 1: "ok", 2: "// TODO: later" }), rules);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "blocked", line: 2, path: "src/app.ts" });
  });
});

describe("readPackedRules — the on-disk composition path", () => {
  it("composes a referenced pack's rules onto the local file", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/concurrency@1.0"].join("\n"), {
      "go/concurrency.yml": ["version: 1.0", "rules:", "  - id: race", "    body: no races"].join(
        "\n",
      ),
    });
    try {
      const composed = await readPackedRules(c.rulesPath, c.packsPath);
      expect(composed.rules.map((r) => r.id)).toContain("race");
    } finally {
      await c.dispose();
    }
  });

  it("malicious_rule_pack_cannot_grant_authority", async () => {
    // A pack carrying `duties:` is refused whole — it cannot be partially
    // applied, and it cannot be ignored into a silent success.
    const c = await checkout(["version: 1", "packs:", "  - pack: evil/grant"].join("\n"), {
      "evil/grant.yml": ["version: 1", "duties:", "  review: [comment, edit-file]"].join("\n"),
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(UnreadablePacks);
    } finally {
      await c.dispose();
    }
  });

  it("malicious_rule_pack_cannot_supply_an_architecture_or_tests_section", async () => {
    // `architecture:` and `tests:` drive findings and a filesystem walk. They
    // are local-file-only by construction: a pack naming either is refused as
    // an unknown top-level key, and composition reads them from the local file
    // regardless.
    const c = await checkout(["version: 1", "packs:", "  - pack: evil/arch"].join("\n"), {
      "evil/arch.yml": ["version: 1", "architecture:", "  layers:", "    core: ['**']"].join("\n"),
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(
        /unknown top-level key/,
      );
    } finally {
      await c.dispose();
    }
  });

  it("a_pack_reference_can_never_escape_the_packs_directory", () => {
    // Traversal is refused by the reference grammar, before any path is
    // built — so there is no join for a `../` to survive.
    for (const value of [
      "../../etc/passwd",
      "go/../../secrets",
      "/etc/passwd",
      "go/concurrency.yml",
      "GO/Concurrency",
      "go/concurrency@1.2.3",
      "go\\concurrency",
    ]) {
      expect(() => readPackRefs([{ pack: value }])).toThrow(UnreadablePacks);
    }
  });

  it("a_referenced_pack_that_is_not_on_disk_names_the_reference_and_the_path", async () => {
    // REGRESSION, same root cause as `readRules` above: the ENOENT branch that
    // says "referenced by the rules file but no file is at <path>" was
    // unreachable through `isMissing`, so a maintainer who typoed a pack
    // reference got a raw `ENOENT: no such file or directory` instead of the
    // sentence that tells them what to fix. Red either way — the defect is the
    // diagnostic, and a dead branch nobody could reach.
    const c = await checkout(["version: 1", "packs:", "  - pack: go/missing"].join("\n"));
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(/no file is at/);
    } finally {
      await c.dispose();
    }
  });

  it("a_version_pin_that_does_not_match_the_pack_fails_red", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/concurrency@2"].join("\n"), {
      "go/concurrency.yml": ["version: 1.0", "rules:", "  - id: race"].join("\n"),
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(
        /pinned at version 2/,
      );
    } finally {
      await c.dispose();
    }
  });

  it("a_pinned_pack_that_declares_no_version_fails_red", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/concurrency@1"].join("\n"), {
      "go/concurrency.yml": ["rules:", "  - id: race"].join("\n"),
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(/declares no/);
    } finally {
      await c.dispose();
    }
  });

  it("an_empty_pack_file_fails_red_rather_than_composing_nothing", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/empty"].join("\n"), {
      "go/empty.yml": "   \n",
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(/is empty/);
    } finally {
      await c.dispose();
    }
  });

  it("an_oversized_pack_is_refused_whole_and_never_truncated", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/huge"].join("\n"), {
      "go/huge.yml": `version: 1\nrules:\n  - id: big\n    body: ${"x".repeat(9000)}\n`,
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(/character pack cap/);
    } finally {
      await c.dispose();
    }
  });

  it("packs_that_individually_fit_but_together_blow_the_budget_fail_red", async () => {
    const body = "y".repeat(7500);
    const refs = ["a", "b", "c"];
    const packs = Object.fromEntries(
      refs.map((n) => [`ns/${n}.yml`, `version: 1\nrules:\n  - id: ${n}\n    body: ${body}\n`]),
    );
    const c = await checkout(
      ["version: 1", "packs:", ...refs.map((n) => `  - pack: ns/${n}`)].join("\n"),
      packs,
    );
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(
        /composition budget|character budget/,
      );
    } finally {
      await c.dispose();
    }
  });

  it("a_rules_file_with_no_packs_key_never_touches_the_packs_directory", async () => {
    const c = await checkout(["version: 1", "rules:", "  - id: only-local"].join("\n"));
    try {
      const out = await readPackedRules(c.rulesPath, join(c.packsPath, "does-not-exist"));
      expect(out.rules.map((r) => r.id)).toEqual(["only-local"]);
    } finally {
      await c.dispose();
    }
  });
});

describe("readRules — the local file's failure semantics", () => {
  it("a_missing_rules_file_is_the_cold_start_without_a_warning", async () => {
    // REGRESSION. `readRules` classified its `readFile` failure with
    // `forge.ts`'s `isMissing`, which asks whether an HTTP error carried
    // `status === 404`. A Node `ENOENT` carries `.code`, never `.status`, so
    // the "missing is the cold start, not an error" branch this function
    // documents was unreachable and every repository without a rules file —
    // the overwhelming majority — got a "could not read rules file" warning on
    // every single run. `respond/guidance.ts:55-60`, the sibling this doc
    // comment names, checks `code !== "ENOENT"`; `warrant.ts:392-395` does the
    // same for its own optional read.
    const root = await mkdtemp(join(tmpdir(), "reeve-review-rules-"));
    try {
      const out = await readRules(join(root, "nope.yml"));
      expect(out.rules.length).toBeGreaterThan(0);
      expect(out.raw).toBe("");
      expect(out.packRefs).toEqual([]);
      expect(core.warning).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a_directory_where_the_rules_file_should_be_warns_and_cold_starts", async () => {
    // EISDIR is not ENOENT: the read failed for a reason that is not "missing",
    // which warns and carries on rather than failing the run.
    const root = await mkdtemp(join(tmpdir(), "reeve-review-rules-"));
    try {
      await mkdir(join(root, "as-a-dir.yml"));
      const out = await readRules(join(root, "as-a-dir.yml"));
      expect(out.raw).toBe("");
      expect(core.warning).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("an_empty_rules_file_is_the_cold_start", async () => {
    const c = await checkout("\n\n   \n");
    try {
      expect((await readRules(c.rulesPath)).raw).toBe("");
    } finally {
      await c.dispose();
    }
  });

  it("a_rules_file_past_the_character_cap_is_truncated_at_the_cap_not_refused", async () => {
    // Documented behaviour: the local file truncates (it is the maintainer's
    // own), while a PACK past its cap is refused. Pinned so the asymmetry is
    // deliberate rather than discovered.
    const filler = `# ${"z".repeat(200)}\n`;
    const text = `version: 1\nrules:\n  - id: kept\n    body: b\n${filler.repeat(200)}`;
    expect(text.length).toBeGreaterThan(MAX_RULES_CHARS);
    const c = await checkout(text);
    try {
      const out: Rules = await readRules(c.rulesPath);
      expect(out.rules.map((r) => r.id)).toContain("kept");
      expect(out.raw.length).toBeLessThanOrEqual(MAX_RULES_CHARS);
    } finally {
      await c.dispose();
    }
  });

  it("a_truncated_rules_file_warns_so_the_dropped_tail_is_not_silent", async () => {
    // REGRESSION. `MAX_RULES_CHARS`' own doc says "truncation keeps a bounded
    // prompt while the warning keeps the decision to drop the tail visible",
    // and `readPackedRules` reads "truncation-warn kept" — but `readRules`
    // sliced the text and warned about nothing. A rules file over 20k
    // characters therefore lost every rule past the cap in silence: the
    // maintainer who wrote those rules had no way to learn they never ran.
    //
    // The sibling this cap's doc names, `respond/guidance.ts`, does emit the
    // warning on the identical decision — so the code had diverged from both
    // its own doc and its stated model.
    const filler = `# ${"z".repeat(200)}\n`;
    const dropped = "dropped-past-the-cap";
    const text = [
      "version: 1",
      "rules:",
      "  - id: kept",
      "    body: b",
      filler.repeat(200),
      `  - id: ${dropped}`,
      "    body: never runs",
    ].join("\n");
    expect(text.length).toBeGreaterThan(MAX_RULES_CHARS);
    const c = await checkout(text);
    try {
      const out = await readRules(c.rulesPath);
      // The tail really is gone — the rule past the cap never reaches the run.
      expect(out.rules.map((rule) => rule.id)).toContain("kept");
      expect(out.rules.map((rule) => rule.id)).not.toContain(dropped);

      // ...and the run says so, naming the cap and the file.
      expect(core.warning).toHaveBeenCalledTimes(1);
      const said = vi.mocked(core.warning).mock.calls[0]?.[0];
      expect(String(said)).toContain(c.rulesPath);
      expect(String(said)).toContain(String(MAX_RULES_CHARS));
    } finally {
      await c.dispose();
    }
  });

  it("a_rules_file_inside_the_cap_warns_about_nothing", async () => {
    // The other side of the same gate: the warning must mark a real decision,
    // not fire on every ordinary run.
    const c = await checkout("version: 1\nrules:\n  - id: small\n");
    try {
      await readRules(c.rulesPath);
      expect(core.warning).not.toHaveBeenCalled();
    } finally {
      await c.dispose();
    }
  });
});

describe("a malformed rules file degrades to warnings, never to a silent guess", () => {
  /** Parse and return the warning list, which is what a maintainer actually sees. */
  const warningsOf = (yaml: string): readonly string[] => parseRules(yaml).warnings;

  it("an_unknown_top_level_key_is_named_not_silently_dropped", () => {
    expect(warningsOf("version: 1\nduties: [comment]\n")).toContain(
      "unknown top-level key `duties`; ignored",
    );
  });

  it("a_rules_file_that_is_not_valid_yaml_fails_red_and_carries_the_reason", () => {
    // The message is fixed; the parser's own explanation rides on `warnings`
    // so a caller reports the cause without re-parsing an error string.
    expect(() => parseRules("version: 1\n  bad: [\n")).toThrow(UnreadableRules);
    expect(caught(() => parseRules("version: 1\n  bad: [\n"))?.warnings[0]).toMatch(
      /not valid YAML/,
    );
  });

  it("a_rules_file_that_is_a_list_or_a_scalar_fails_red", () => {
    for (const text of ["- one\n- two\n", "just a string\n"]) {
      expect(caught(() => parseRules(text))?.warnings).toEqual([
        "expected a YAML mapping of rules",
      ]);
    }
  });

  it("an_unsupported_version_is_treated_as_one_and_said_so", () => {
    expect(warningsOf("version: 7\n")).toContain("unsupported version 7; treating as 1");
    expect(warningsOf("version: ok\n")).toContain("`version` is not a number; treating as 1");
    expect(warningsOf("rules:\n  - id: a\n")).toContain("no `version:`; assuming 1");
  });

  it("a_non_list_rules_key_keeps_the_built_in_defaults_rather_than_reviewing_by_nothing", () => {
    const out = parseRules("version: 1\nrules: not-a-list\n");
    expect(out.warnings).toContain("`rules:` is not a list; keeping the built-in default");
    expect(out.rules.length).toBeGreaterThan(0);
  });

  it("a_rules_list_of_only_malformed_entries_falls_back_to_the_defaults", () => {
    const out = parseRules("version: 1\nrules:\n  - just-a-string\n  - [1, 2]\n  -\n");
    expect(out.warnings.filter((w) => w.includes("is not a mapping"))).toHaveLength(3);
    expect(out.rules.length).toBeGreaterThan(0);
  });

  it("a_rule_entry_missing_every_field_gets_positional_defaults_never_an_invented_meaning", () => {
    const out = parseRules("version: 1\nrules:\n  - {}\n");
    expect(out.rules).toEqual([
      { id: "rule-1", name: "Unnamed rule", marker: "", body: "", severity: "warning" },
    ]);
  });

  it("a_rule_id_that_is_not_a_string_falls_back_to_its_position", () => {
    const out = parseRules("version: 1\nrules:\n  - id: 42\n    name: n\n");
    expect(out.rules[0]?.id).toBe("rule-1");
  });

  it("a_rule_may_name_itself_with_rule_as_well_as_id", () => {
    expect(parseRules("version: 1\nrules:\n  - rule: legacy\n").rules[0]?.id).toBe("legacy");
  });

  it("an_unknown_severity_falls_back_to_warning_rather_than_to_critical", () => {
    // The direction matters: an unreadable severity must never escalate.
    expect(
      parseRules("version: 1\nrules:\n  - id: a\n    severity: catastrophic\n").rules[0]?.severity,
    ).toBe("warning");
  });

  it("a_non_mapping_ignore_section_is_warned_and_ignored", () => {
    const out = parseRules("version: 1\nignore: [src]\n");
    expect(out.warnings).toContain("`ignore:` is not a mapping; ignoring");
    expect(out.ignorePaths).toEqual([]);
    expect(out.ignoreFiles).toEqual([]);
  });

  it("a_non_list_ignore_files_is_warned_and_the_other_half_still_reads", () => {
    const out = parseRules("version: 1\nignore:\n  files: nope\n  paths:\n    - 'src/**'\n");
    expect(out.warnings).toContain("`ignore.files:` is not a list; ignoring");
    expect(out.ignorePaths).toEqual(["src/**"]);
  });

  it("a_non_string_entry_in_a_string_list_is_dropped_by_position", () => {
    const out = parseRules("version: 1\nignore:\n  paths:\n    - 'src/**'\n    - 7\n");
    expect(out.warnings).toContain("`ignore.paths` entry 2 is not a string; dropped");
    expect(out.ignorePaths).toEqual(["src/**"]);
  });

  it("a_non_list_generated_key_keeps_the_built_in_suffixes", () => {
    const out = parseRules("version: 1\ngenerated: dist\n");
    expect(out.warnings).toContain("`generated:` is not a list; ignoring");
    expect(out.generatedExtensions.length).toBeGreaterThan(0);
  });

  it("a_non_list_blocked_key_blocks_nothing_rather_than_blocking_everything", () => {
    const out = parseRules("version: 1\nblocked: TODO\n");
    expect(out.warnings).toContain("`blocked:` is not a list; ignoring");
    expect(out.blocked).toEqual([]);
  });

  it("a_blocked_entry_that_is_neither_string_nor_mapping_is_dropped", () => {
    const out = parseRules("version: 1\nblocked:\n  - [1]\n  - phrase: real\n");
    expect(out.warnings).toContain("`blocked` entry 1 is not a string or mapping; dropped");
    expect(out.blocked.map((b) => b.phrase)).toEqual(["real"]);
  });

  it("a_blocked_note_is_appended_to_the_finding_body_only_when_there_is_one", () => {
    const withNote = parseRules("version: 1\nblocked:\n  - phrase: TODO\n    note: use an issue\n");
    const bare = parseRules("version: 1\nblocked:\n  - TODO\n");
    const shownFile = { shown: [{ path: "a.ts", lines: new Map([[1, "// TODO"]]) }] };
    expect(preflight(shownFile, withNote)[0]?.body).toBe(
      'The diff contains the blocked text "TODO" use an issue',
    );
    expect(preflight(shownFile, bare)[0]?.body).toBe('The diff contains the blocked text "TODO"');
  });
});

describe("a malformed architecture section drops the part it cannot read", () => {
  const archOf = (yaml: string) => parseRules(`version: 1\narchitecture:\n${yaml}`);

  it("a_non_mapping_architecture_is_warned_and_empty", () => {
    const out = parseRules("version: 1\narchitecture:\n  - core\n");
    expect(out.warnings).toContain("`architecture:` is not a mapping; ignoring");
    expect(out.architecture.layers).toEqual({});
  });

  it("non_mapping_layers_and_aliases_and_a_non_list_edges_are_each_warned", () => {
    const out = archOf("  layers: [core]\n  edges: not-a-list\n  aliases: [x]\n");
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        "`architecture.layers:` is not a mapping; ignoring",
        "`architecture.edges:` is not a list; ignoring",
        "`architecture.aliases:` is not a mapping; ignoring",
      ]),
    );
  });

  it("a_layer_with_no_glob_list_or_a_non_list_one_is_dropped_by_name", () => {
    const out = archOf("  layers:\n    core:\n    ui: src/ui\n    good:\n      - 'src/core/**'\n");
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        "`architecture.layers.core:` has no glob list; dropped",
        "`architecture.layers.ui:` is not a list; dropped",
      ]),
    );
    expect(Object.keys(out.architecture.layers)).toEqual(["good"]);
  });

  it("a_layer_whose_globs_are_all_unusable_is_dropped_entirely", () => {
    const out = archOf("  layers:\n    core:\n      - 7\n      - ''\n");
    expect(out.warnings).toContain(
      "`architecture.layers.core` entry 1 is not a non-empty string; dropped",
    );
    expect(out.architecture.layers).toEqual({});
  });

  it("an_edge_missing_from_or_to_is_dropped_by_position", () => {
    const out = archOf("  edges:\n    - from: ui\n    - to: core\n    - 7\n");
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        "`architecture.edges` entry 1 is missing `from`/`to`; dropped",
        "`architecture.edges` entry 2 is missing `from`/`to`; dropped",
        "`architecture.edges` entry 3 is not a mapping; dropped",
      ]),
    );
    expect(out.architecture.edges).toEqual([]);
  });

  it("an_edge_with_an_unknown_severity_is_kept_at_warning_and_said_so", () => {
    const out = archOf("  edges:\n    - from: ui\n      to: core\n      severity: nuclear\n");
    expect(out.warnings).toContain(
      "`architecture.edges` entry 1 has unknown severity `nuclear`; using warning",
    );
    expect(out.architecture.edges[0]).toMatchObject({ severity: "warning", note: "" });
  });

  it("an_alias_that_is_not_a_non_empty_string_is_dropped_by_prefix", () => {
    const out = archOf("  aliases:\n    '@app': ''\n    '@lib': 7\n    '@ok': src/lib\n");
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        "`architecture.aliases.@app:` is not a non-empty string; dropped",
        "`architecture.aliases.@lib:` is not a non-empty string; dropped",
      ]),
    );
    expect(out.architecture.aliases).toEqual({ "@ok": "src/lib" });
  });
});

describe("pack references and pins", () => {
  it("a_packs_key_that_is_not_a_list_fails_red", () => {
    expect(() => readPackRefs("go/concurrency")).toThrow(UnreadablePacks);
  });

  it("a_packs_entry_that_is_not_a_mapping_or_lacks_a_pack_key_fails_red", () => {
    expect(() => readPackRefs(["go/concurrency"])).toThrow(/must be mappings/);
    expect(() => readPackRefs([{ name: "go/concurrency" }])).toThrow(/must carry a `pack:` string/);
    expect(() => readPackRefs([{ pack: 7 }])).toThrow(/must carry a `pack:` string/);
  });

  it("an_absent_packs_key_is_a_no_op_not_an_empty_pack_set_error", () => {
    expect(readPackRefs(undefined)).toEqual({ refs: [], warnings: [] });
    expect(readPackRefs(null)).toEqual({ refs: [], warnings: [] });
  });

  it("a_duplicate_reference_loads_once_and_says_so", () => {
    const out = readPackRefs([{ pack: "go/concurrency" }, { pack: "go/concurrency" }]);
    expect(out.refs).toHaveLength(1);
    expect(out.warnings).toContain("pack `go/concurrency` referenced more than once; loaded once");
  });

  it("an_exact_minor_pin_that_disagrees_only_on_the_minor_fails_red", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/c@1.2"].join("\n"), {
      "go/c.yml": ["version: 1.3", "rules:", "  - id: race"].join("\n"),
    });
    try {
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(
        /pinned at version 1\.2 but declares 1\.3/,
      );
    } finally {
      await c.dispose();
    }
  });

  it("a_major_only_pin_accepts_any_minor_of_that_major", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/c@1"].join("\n"), {
      "go/c.yml": ["version: 1.9", "rules:", "  - id: race"].join("\n"),
    });
    try {
      expect((await readPackedRules(c.rulesPath, c.packsPath)).rules.map((r) => r.id)).toContain(
        "race",
      );
    } finally {
      await c.dispose();
    }
  });

  it("an_unreadable_pack_that_is_a_directory_reports_the_read_failure_by_reference", async () => {
    const c = await checkout(["version: 1", "packs:", "  - pack: go/c"].join("\n"));
    try {
      await mkdir(join(c.packsPath, "go", "c.yml"), { recursive: true });
      await expect(readPackedRules(c.rulesPath, c.packsPath)).rejects.toThrow(
        /pack `go\/c` could not be read at/,
      );
    } finally {
      await c.dispose();
    }
  });
});

describe("composition precedence", () => {
  it("a_pack_rule_cannot_redefine_a_local_rule_id_and_the_clash_is_named", async () => {
    const c = await checkout(
      [
        "version: 1",
        "rules:",
        "  - id: shared",
        "    body: local wins",
        "packs:",
        "  - pack: ns/p",
      ].join("\n"),
      { "ns/p.yml": ["version: 1", "rules:", "  - id: shared", "    body: pack loses"].join("\n") },
    );
    try {
      const out = await readPackedRules(c.rulesPath, c.packsPath);
      expect(out.rules.filter((r) => r.id === "shared")).toHaveLength(1);
      expect(out.rules.find((r) => r.id === "shared")?.body).toBe("local wins");
      expect(out.warnings).toContain(
        "rule `shared` is defined more than once; the first definition wins",
      );
    } finally {
      await c.dispose();
    }
  });

  it("a_pack_that_only_ignores_paths_does_not_erase_the_built_in_rules", async () => {
    // A pack contributing no `rules:` must not empty the effective rule set —
    // that would be a one-line way to turn the review off.
    const c = await checkout(["version: 1", "packs:", "  - pack: ns/p"].join("\n"), {
      "ns/p.yml": ["version: 1", "ignore:", "  paths:", "    - 'vendor/**'"].join("\n"),
    });
    try {
      const out = await readPackedRules(c.rulesPath, c.packsPath);
      expect(out.rules.length).toBeGreaterThan(0);
      expect(out.ignorePaths).toEqual(["vendor/**"]);
    } finally {
      await c.dispose();
    }
  });

  it("a_pack_generated_list_unions_with_the_local_one_and_never_empties_it", async () => {
    const c = await checkout(
      ["version: 1", "generated:", "  - .pb.go", "packs:", "  - pack: ns/p"].join("\n"),
      { "ns/p.yml": ["version: 1", "generated:", "  - .min.js"].join("\n") },
    );
    try {
      const out = await readPackedRules(c.rulesPath, c.packsPath);
      expect(out.generatedExtensions).toEqual([".pb.go", ".min.js"]);
    } finally {
      await c.dispose();
    }
  });

  it("a_blocked_phrase_defined_by_both_keeps_the_local_severity", async () => {
    const c = await checkout(
      [
        "version: 1",
        "blocked:",
        "  - phrase: TODO",
        "    severity: info",
        "packs:",
        "  - pack: ns/p",
      ].join("\n"),
      {
        "ns/p.yml": ["version: 1", "blocked:", "  - phrase: TODO", "    severity: critical"].join(
          "\n",
        ),
      },
    );
    try {
      const out = await readPackedRules(c.rulesPath, c.packsPath);
      expect(out.blocked).toHaveLength(1);
      expect(out.blocked[0]?.severity).toBe("info");
    } finally {
      await c.dispose();
    }
  });
});
