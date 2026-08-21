/**
 * The job summary is where a green run that quietly did less becomes visible
 * (`docs/development/failure-matrix.md`, "How to read a row"). Every case here
 * asserts that one such quietness reaches the page: a corrupt memory, a pass
 * that did not answer, an uncertain thread listing, an unverified finding, a
 * file the review never saw, a head SHA GitHub never gave.
 *
 * Each assertion is on the text a maintainer reads, not on the shape of the
 * renderer, so a row that stops being rendered fails here rather than
 * disappearing silently.
 */
import { describe, expect, it } from "vitest";

import type { Disposition, Finding, Status } from "./findings.js";
import type { RiskAssessment } from "./risk.js";
import { summarize, type Run } from "./summary.js";
import type { ThreadSync } from "./threads.js";

function run(overrides: Partial<Run> = {}): Run {
  return {
    number: 7,
    dryRun: false,
    headSha: "abc",
    note: null,
    previousSha: "",
    memoryNote: null,
    shown: [{ path: "a.ts" }],
    skipped: [],
    findings: [],
    confidence: 0.8,
    posted: null,
    permitted: ["comment" as const],
    spent: [],
    modelNames: new Map(),
    language: "en",
    warrant: ".github/reeve.yml",
    implicit: false,
    ungranted: null,
    malformedAnswers: 0,
    readRules: null,
    risk: null,
    passes: [],
    contextReadFiles: 0,
    threads: null,
    readTests: null,
    toolCalls: null,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "src/app.ts",
    line: 12,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function entry(
  over: Partial<{ finding: Finding; status: Status; disposition: Disposition | null }> = {},
) {
  return { finding: finding(), status: "created" as Status, disposition: null, ...over };
}

function risk(over: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    tier: "low",
    score: 0,
    signals: [],
    thresholds: { medium: 2, high: 8 },
    profile: "default",
    ...over,
  };
}

/** One fired signal, in the full shape `RiskAssessment` declares. */
function signal(
  name: RiskAssessment["signals"][number]["signal"],
  weight: number,
  evidence: readonly string[],
): RiskAssessment["signals"][number] {
  return { signal: name, weight, units: 1, contribution: weight, evidence, escalates: false };
}

function threads(over: Partial<ThreadSync> = {}): ThreadSync {
  return { created: 0, updated: 0, fallback: [], uncertain: false, ...over };
}

describe("the verdict table never hides what the run could not do", () => {
  it("a_head_sha_github_never_gave_reads_unknown_not_empty", () => {
    expect(summarize(run({ headSha: "" }))).toContain("unknown");
  });

  it("an_unidentified_language_says_so_rather_than_defaulting_to_english", () => {
    expect(summarize(run({ language: null }))).toContain("not identified");
  });

  it("an_unassessed_risk_says_not_assessed_rather_than_low", () => {
    // "low" and "never priced" are different answers, and conflating them
    // would read as a safe diff nobody scored.
    const text = summarize(run({ risk: null }));
    expect(text).toContain("not assessed");
    expect(text).not.toContain("| Risk | low");
  });

  it("an_unmeasured_confidence_says_not_measured_rather_than_zero", () => {
    const text = summarize(run({ confidence: null }));
    expect(text).toContain("not measured");
    expect(text).not.toContain("0.00");
  });

  it("a_run_that_granted_nothing_shows_no_granted_row", () => {
    expect(summarize(run({ permitted: [] }))).not.toContain("Granted");
  });

  it("discarded_unreadable_answers_are_counted_on_the_page", () => {
    expect(summarize(run({ malformedAnswers: 3 }))).toContain("3 answer(s) discarded");
  });

  it("a_pass_that_did_not_answer_is_named_beside_the_ones_that_did", () => {
    const text = summarize(
      run({
        passes: [
          {
            id: "correctness",
            name: "Correctness",
            answered: true,
            unreadable: false,
            failed: false,
            findings: 1,
          },
          {
            id: "second",
            name: "Second opinion",
            answered: true,
            unreadable: false,
            failed: false,
            findings: 2,
          },
          {
            id: "adversarial",
            name: "Adversarial",
            answered: false,
            unreadable: true,
            failed: false,
            findings: 0,
          },
        ],
      }),
    );
    expect(text).toContain("Correctness (1 finding)");
    expect(text).toContain("Second opinion (2 findings)");
    expect(text).toContain("Adversarial (did not answer)");
  });

  it("the_rules_and_tests_sources_are_named_when_they_were_read", () => {
    const text = summarize(
      run({ readRules: ".github/reeve-review.yml", readTests: "4 test files" }),
    );
    expect(text).toContain(".github/reeve-review.yml");
    expect(text).toContain("4 test files");
  });

  it("a_previously_reviewed_sha_is_shown_only_when_it_differs_from_this_head", () => {
    expect(summarize(run({ previousSha: "old" }))).toContain("reviewed at `old`");
    expect(summarize(run({ previousSha: "abc", headSha: "abc" }))).not.toContain("Previously");
    expect(summarize(run({ previousSha: "" }))).not.toContain("Previously");
  });

  it("the_verification_row_counts_verified_against_not_verified", () => {
    const text = summarize(
      run({
        findings: [
          entry({ finding: finding({ verification: "verified" }) }),
          entry({ finding: finding({ path: "b.ts", verification: "unverified" }) }),
          entry({ finding: finding({ path: "c.ts" }) }),
        ],
      }),
    );
    expect(text).toContain("1 verified · 1 not verified");
  });

  it("a_corrupt_memory_is_carried_onto_the_page_as_a_warning_never_silently", () => {
    const text = summarize(run({ memoryNote: "the envelope checksum did not match" }));
    expect(text).toContain("⚠️");
    expect(text).toContain("the envelope checksum did not match");
  });

  it("an_implicit_authority_explains_that_review_was_granted_nothing", () => {
    const text = summarize(run({ implicit: true, warrant: ".github/reeve.yml" }));
    expect(text).toContain("No `.github/reeve.yml`");
    expect(text).toContain("duties: { review: [comment] }");
  });

  it("a_dry_run_that_was_granted_nothing_still_says_it_wrote_nothing", () => {
    const text = summarize(run({ ungranted: "not granted", dryRun: true }));
    expect(text).toContain("dry run");
    expect(text).toContain("nothing was written");
  });
});

describe("the threads row reports the inline sync honestly", () => {
  it("a_sync_that_did_nothing_reads_none", () => {
    expect(summarize(run({ threads: threads() }))).toContain("| Threads | none |");
  });

  it("creates_updates_and_fallbacks_are_each_named", () => {
    const text = summarize(
      run({ threads: threads({ created: 2, updated: 1, fallback: ["k1", "k2", "k3"] }) }),
    );
    expect(text).toContain("2 inline");
    expect(text).toContain("1 updated");
    expect(text).toContain("3 to summary");
  });

  it("uncertain_listing_is_stated_beside_whatever_was_written", () => {
    // The one case where "none" alone would be a lie: nothing was written
    // BECAUSE the listing could not be trusted, not because there was nothing
    // to write.
    expect(summarize(run({ threads: threads({ uncertain: true }) }))).toContain(
      "none — listing uncertain",
    );
    expect(summarize(run({ threads: threads({ created: 1, uncertain: true }) }))).toContain(
      "1 inline — listing uncertain",
    );
  });

  it("no_threads_row_at_all_when_no_sync_ran", () => {
    expect(summarize(run({ threads: null }))).not.toContain("Threads");
  });
});

describe("the risk section", () => {
  it("is_absent_when_no_signal_fired_even_at_a_scored_tier", () => {
    expect(summarize(run({ risk: risk({ tier: "low", score: 0 }) }))).not.toContain("### Risk");
  });

  it("names_each_signal_its_weight_and_its_evidence", () => {
    const text = summarize(
      run({
        risk: risk({
          tier: "high",
          score: 9,
          signals: [
            signal("sensitive_path", 5, ["src/auth.ts"]),
            signal("db_migration", 4, ["migrations/1.sql"]),
          ],
        }),
      }),
    );
    expect(text).toContain("### Risk: high");
    expect(text).toContain("sensitive-path");
    expect(text).toContain("src/auth.ts");
    expect(text).toContain("3 review passes");
  });

  it("a_medium_tier_declares_two_passes_and_a_low_tier_one_pass_singular", () => {
    const withSignal = (tier: "low" | "medium") =>
      summarize(
        run({
          risk: risk({
            tier,
            score: tier === "medium" ? 3 : 1,
            signals: [signal("public_api", 1, ["src/api.ts"])],
          }),
        }),
      );
    expect(withSignal("medium")).toContain("2 review passes");
    expect(withSignal("low")).toContain("1 review pass.");
  });
});

describe("the findings and coverage tables", () => {
  it("a_finding_about_a_whole_file_prints_no_line_suffix", () => {
    const text = summarize(run({ findings: [entry({ finding: finding({ line: null }) })] }));
    expect(text).toContain("`src/app.ts`");
    expect(text).not.toContain("src/app.ts`:");
  });

  it("a_finding_the_engine_never_judged_prints_a_dash_not_a_verdict", () => {
    const text = summarize(run({ findings: [entry()] }));
    expect(text).toMatch(/\| — \| — \|/);
  });

  it("a_disposition_is_attributed_to_the_maintainer_who_made_it", () => {
    const text = summarize(
      run({
        findings: [
          entry({
            disposition: {
              value: "wont-fix",
              by: "maintainer",
              at: "2026-01-01T00:00:00Z",
              replyId: 5,
              replyUrl: "https://example.invalid/5",
            },
          }),
        ],
      }),
    );
    expect(text).toContain("wont-fix by @maintainer");
  });

  it("the_coverage_table_names_every_skipped_file_and_why", () => {
    const text = summarize(
      run({
        shown: [{ path: "a.ts" }],
        skipped: [
          { path: "big.ts", reason: "capped" },
          { path: "logo.png", reason: "binary" },
        ],
      }),
    );
    expect(text).toContain("### Coverage");
    expect(text).toContain("capped");
    expect(text).toContain("binary");
    expect(text).toContain("reviewed");
  });

  it("a_file_listed_twice_in_shown_appears_once_in_the_coverage_table", () => {
    const text = summarize(
      run({
        shown: [{ path: "a.ts" }, { path: "a.ts" }],
        skipped: [{ path: "b.ts", reason: "ignored" }],
      }),
    );
    expect(text.split("| a.ts |").length - 1).toBe(1);
    expect(text).toContain("| b.ts | ignored |");
  });

  it("no_coverage_section_at_all_when_nothing_was_skipped", () => {
    expect(summarize(run({ skipped: [] }))).not.toContain("### Coverage");
  });

  it("the_context_line_appears_only_when_workspace_files_were_read", () => {
    expect(summarize(run({ contextReadFiles: 0 }))).not.toContain("**Context:**");
    expect(summarize(run({ contextReadFiles: 4 }))).toContain(
      "4 workspace file(s) read for surrounding source",
    );
  });

  it("a_note_replaces_the_verdict_table_entirely_no_half_rendered_page", () => {
    const text = summarize(run({ note: "This pull request is closed." }));
    expect(text).toContain("This pull request is closed.");
    expect(text).not.toContain("| Findings |");
    expect(text).not.toContain("| Confidence |");
  });
});
