/**
 * A rule pack is repository content that becomes review policy. `packs.test.ts`
 * pins the happy grammar and the top-level whitelist; this file pins what a
 * malformed or hostile fragment can and cannot do to the policy that comes out
 * — because the parts a pack CAN write (rules, blocked phrases, ignore lists)
 * all end up either in a prompt or in a deterministic finding.
 *
 * The rule throughout: a structural mistake (a section that is not the shape
 * the grammar names) is RED, and a per-entry mistake is a warning and a drop.
 * Nothing is ever silently guessed into a meaning the pack did not write.
 */
import { describe, expect, it } from "vitest";

import { parsePack, UnreadablePacks } from "./packs.js";

const REF = "ns/pack@1.0";

const pack = (body: string) => parsePack(`version: 1.0\n${body}`, REF);

/** Runs `fn` and hands back the error it threw — so an assertion about the
 *  message never has to live inside a `catch`. */
function caught(fn: () => unknown): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

describe("a structurally wrong section is red, never a partial policy", () => {
  it("a_rules_key_that_is_not_a_list_is_refused_whole", () => {
    expect(() => pack("rules: everything\n")).toThrow(/`rules:` is not a list/);
    expect(() => pack("rules:\n  id: one\n")).toThrow(/`rules:` is not a list/);
  });

  it("an_ignore_key_that_is_not_a_mapping_is_refused_whole", () => {
    expect(() => pack("ignore:\n  - vendor/**\n")).toThrow(/`ignore:` is not a mapping/);
    expect(() => pack("ignore: vendor\n")).toThrow(/`ignore:` is not a mapping/);
  });

  it("a_blocked_key_that_is_not_a_list_is_refused_whole", () => {
    expect(() => pack("blocked: TODO\n")).toThrow(/`blocked:` is not a list/);
  });

  it("a_pack_that_is_not_valid_yaml_names_the_reference_and_the_parser_reason", () => {
    const thrown = caught(() => parsePack("rules: [\n", REF));
    expect(thrown).toBeInstanceOf(UnreadablePacks);
    expect(thrown?.message).toContain(REF);
    expect(thrown?.message).toContain("not valid YAML");
  });

  it("a_pack_that_is_a_list_or_a_scalar_is_refused", () => {
    expect(() => parsePack("- one\n", REF)).toThrow(/expected a YAML mapping/);
    expect(() => parsePack("just a string\n", REF)).toThrow(/expected a YAML mapping/);
    expect(() => parsePack("null\n", REF)).toThrow(/expected a YAML mapping/);
  });

  it("the_first_unknown_top_level_key_is_the_one_named_in_the_refusal", () => {
    // The message has to point at something a maintainer can delete.
    const thrown = caught(() => parsePack("duties:\n  review: [comment]\nsecrets: yes\n", REF));
    expect(thrown?.message).toContain("`duties`");
    expect(thrown?.message).toContain("cannot grant authority");
  });

  it("a_version_this_reader_cannot_locate_in_the_source_is_refused", () => {
    // The version is read from the file's own text so `1.10` survives; a
    // `version:` that is a mapping has no scalar source range to read.
    expect(() => parsePack("version:\n  major: 1\n", REF)).toThrow(
      /could not be read from the file/,
    );
  });

  it("a_version_outside_the_two_component_grammar_is_refused", () => {
    for (const value of ["1.2.3", "v1", "one", "1.", "-1"]) {
      expect(() => parsePack(`version: "${value}"\n`, REF)).toThrow(
        /must be a whole number or a two-component version/,
      );
    }
  });
});

describe("a per-entry mistake is a warning and a drop, never a guess", () => {
  it("a_rule_entry_that_is_not_a_mapping_is_dropped_by_position", () => {
    const out = pack("rules:\n  - just-a-string\n  - id: real\n  - [1]\n");
    expect(out.warnings).toEqual([
      `pack ${REF}: rule entry 1 is not a mapping; dropped`,
      `pack ${REF}: rule entry 3 is not a mapping; dropped`,
    ]);
    expect(out.fragment.rules.map((rule) => rule.id)).toEqual(["real"]);
  });

  it("a_rule_with_no_id_falls_back_to_its_position_rather_than_colliding_on_a_blank", () => {
    // Two unnamed rules must not become one id, or composition's
    // first-definition-wins would silently drop the second.
    const out = pack("rules:\n  - name: One\n  - name: Two\n");
    expect(out.fragment.rules.map((rule) => rule.id)).toEqual(["rule-1", "rule-2"]);
  });

  it("a_rule_may_name_itself_with_rule_and_a_non_string_id_falls_back_to_position", () => {
    expect(pack("rules:\n  - rule: legacy\n").fragment.rules[0]?.id).toBe("legacy");
    expect(pack("rules:\n  - id: 7\n").fragment.rules[0]?.id).toBe("rule-1");
    expect(pack("rules:\n  - id: [a]\n").fragment.rules[0]?.id).toBe("rule-1");
  });

  it("a_rule_missing_every_optional_field_gets_documented_defaults", () => {
    expect(pack("rules:\n  - id: bare\n").fragment.rules[0]).toEqual({
      id: "bare",
      name: "Unnamed rule",
      marker: "",
      body: "",
      severity: "warning",
    });
  });

  it("a_rule_severity_outside_the_union_falls_back_to_warning_never_escalates", () => {
    for (const severity of ["catastrophic", "CRITICAL", "7"]) {
      expect(
        pack(`rules:\n  - id: a\n    severity: ${severity}\n`).fragment.rules[0]?.severity,
      ).toBe("warning");
    }
    expect(pack("rules:\n  - id: a\n    severity: critical\n").fragment.rules[0]?.severity).toBe(
      "critical",
    );
  });

  it("a_non_list_string_section_warns_and_contributes_nothing", () => {
    const out = pack("generated: .min.js\nignore:\n  files: a.ts\n  paths: 'src/**'\n");
    expect(out.warnings).toEqual([
      `pack ${REF}: \`ignore.files:\` is not a list; ignoring`,
      `pack ${REF}: \`ignore.paths:\` is not a list; ignoring`,
      `pack ${REF}: \`generated:\` is not a list; ignoring`,
    ]);
    expect(out.fragment).toMatchObject({
      generatedExtensions: [],
      ignoreFiles: [],
      ignorePaths: [],
    });
  });

  it("a_non_string_entry_in_a_string_list_is_dropped_by_position", () => {
    const out = pack("generated:\n  - .min.js\n  - 7\n  - .map\n");
    expect(out.warnings).toEqual([`pack ${REF}: \`generated\` entry 2 is not a string; dropped`]);
    expect(out.fragment.generatedExtensions).toEqual([".min.js", ".map"]);
  });

  it("a_blocked_entry_may_be_a_bare_string_and_defaults_to_warning_with_no_note", () => {
    expect(pack("blocked:\n  - TODO\n").fragment.blocked).toEqual([
      { phrase: "TODO", severity: "warning", note: "" },
    ]);
  });

  it("a_blocked_entry_that_is_neither_string_nor_mapping_is_dropped_by_position", () => {
    const out = pack("blocked:\n  - [1]\n  - phrase: real\n  -\n");
    expect(out.warnings).toEqual([
      `pack ${REF}: \`blocked\` entry 1 is not a string or mapping; dropped`,
      `pack ${REF}: \`blocked\` entry 3 is not a string or mapping; dropped`,
    ]);
    expect(out.fragment.blocked.map((entry) => entry.phrase)).toEqual(["real"]);
  });

  it("a_blocked_mapping_with_non_string_phrase_or_note_falls_back_to_empty_strings", () => {
    // An empty phrase is inert at the firing side (`preflight` skips it), which
    // is what keeps this fallback from becoming a match-everything rule.
    const out = pack("blocked:\n  - phrase: 7\n    note: [x]\n    severity: critical\n");
    expect(out.fragment.blocked).toEqual([{ phrase: "", severity: "critical", note: "" }]);
  });

  it("a_blocked_severity_outside_the_union_falls_back_to_warning", () => {
    expect(pack("blocked:\n  - phrase: TODO\n    severity: nuclear\n").fragment.blocked[0]).toEqual(
      {
        phrase: "TODO",
        severity: "warning",
        note: "",
      },
    );
  });

  it("absent_sections_contribute_nothing_and_raise_no_warning", () => {
    const out = parsePack("version: 1\n", REF);
    expect(out.warnings).toEqual([]);
    expect(out.fragment).toEqual({
      rules: [],
      ignoreFiles: [],
      ignorePaths: [],
      generatedExtensions: [],
      blocked: [],
    });
  });

  it("a_section_written_as_null_is_the_same_as_absent", () => {
    const out = parsePack("version: 1\nrules:\nignore:\ngenerated:\nblocked:\n", REF);
    expect(out.warnings).toEqual([]);
    expect(out.fragment.rules).toEqual([]);
    expect(out.fragment.blocked).toEqual([]);
  });
});

describe("a pack cannot expand itself past its own size", () => {
  it("yaml_aliases_anchors_and_merge_keys_are_refused_outright", () => {
    // `maxAliasCount: 0`: a pack must not turn eight thousand characters into
    // a megabyte of prompt.
    expect(() => parsePack("version: 1\nbase: &a [x]\nrules: *a\n", REF)).toThrow(UnreadablePacks);
  });

  it("the_raw_text_is_carried_verbatim_so_the_composition_budget_measures_the_real_file", () => {
    const text = "version: 1.0\nrules:\n  - id: a\n";
    expect(parsePack(text, REF).raw).toBe(text);
  });

  it("the_reference_is_carried_on_the_pack_so_a_warning_can_name_its_source", () => {
    expect(parsePack("version: 1.0\n", REF).ref).toBe(REF);
  });
});
