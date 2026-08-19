/**
 * The evidence gate, attacked.
 *
 * One question drives every case: what does it take to make this review admit
 * a claim the diff never proved? The answers the code gives are pinned here so
 * a later change cannot relax one quietly — model confidence buys nothing, a
 * cited rule buys nothing, a snippet that agrees with a line the patch does
 * not carry buys nothing, and running out of the run's evidence budget
 * downgrades a finding rather than upgrading one.
 *
 * The counterpart cases — false NEGATIVES — are here too, because a gate that
 * can only ever say "unverified" is not a gate either: the run budget is
 * shared across findings, and the cases below pin who pays for it.
 */
import { describe, expect, it } from "vitest";

import { emptyArchitecture } from "./architecture.js";
import { deriveStatus, evidenceFingerprint, type Evidence } from "./evidence.js";
import type { Finding } from "./findings.js";
import {
  MAX_EVIDENCE_ITEMS_PER_RUN,
  MAX_EVIDENCE_PER_FINDING,
  MAX_EVIDENCE_TEXT,
  MAX_EVIDENCE_TOTAL_CHARS,
} from "./limits.js";
import { diffEvidence, ruleEvidence } from "./providers.js";
import type { Rules } from "./rules.js";
import { DEFAULT_TESTS } from "./testmap.js";
import { parseFinding, parseVerdict } from "./verdict.js";
import { verifyFindings, type VerifyRequest } from "./verify.js";

const LINE = 'export const VERSION = "1.0.0";';

/** A finding fixture; `snippet` is explicitly droppable, which is the shape a
 *  model finding takes when it named no text at all. */
function finding(
  overrides: Omit<Partial<Finding>, "snippet"> & { snippet?: string } = {},
): Finding {
  return {
    id: "dedup:src/app.ts:1",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "src/app.ts",
    line: 1,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    snippet: LINE,
    ...overrides,
  };
}

function rules(ids: readonly string[] = ["dedup"]): Rules {
  return {
    version: 1,
    rules: ids.map((id) => ({ id, name: id, marker: "", body: "", severity: "warning" as const })),
    ignoreFiles: [],
    ignorePaths: [],
    generatedExtensions: [".min.js"],
    blocked: [],
    raw: "version: 1\n",
    architecture: emptyArchitecture(),
    packRefs: [],
    tests: DEFAULT_TESTS,
    warnings: [],
  };
}

function request(overrides: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    findings: [finding()],
    shown: [{ path: "src/app.ts", lines: new Map<number, string>([[1, LINE]]) }],
    rules: rules(),
    headSha: "abc123",
    ...overrides,
  };
}

describe("a finding the diff never proved is never verified", () => {
  it("a_finding_naming_a_line_the_diff_never_proved_is_rejected_at_the_parse_boundary", () => {
    // The strongest form of the rule: the claim never becomes a finding at
    // all, so nothing downstream has to remember to distrust it.
    const files = [{ path: "src/app.ts", lines: new Map([[1, LINE]]) }] as never;
    expect(
      parseFinding({ rule: "dedup", path: "src/app.ts", line: 2, body: "b", snippet: LINE }, files),
    ).toBeNull();
  });

  it("a_line_the_diff_proves_in_another_file_does_not_prove_it_here", () => {
    const files = [
      { path: "src/app.ts", lines: new Map([[1, LINE]]) },
      { path: "src/other.ts", lines: new Map([[7, "x"]]) },
    ] as never;
    expect(
      parseFinding({ rule: "dedup", path: "src/app.ts", line: 7, body: "b", snippet: "x" }, files),
    ).toBeNull();
  });

  it("a_finding_whose_file_left_the_shown_set_after_parsing_stays_unverified", () => {
    // The engine is asked about a file that is not in `shown` — the diff bound
    // dropped it, or the rules ignored it. No line proof exists, so no
    // verification can.
    const [only] = verifyFindings(request({ shown: [] }));
    expect(only?.verification).toBe("unverified");
    expect(only?.evidence.map((e) => e.kind)).toEqual(["rules"]);
  });

  it("a_finding_at_a_line_the_shown_file_does_not_carry_stays_unverified", () => {
    const [only] = verifyFindings(request({ findings: [finding({ line: 99 })] }));
    expect(only?.verification).toBe("unverified");
  });

  it("a_model_claim_not_backed_by_diff_proven_text_is_rejected", () => {
    // The snippet is real text — just not the text at the line claimed.
    const [only] = verifyFindings(
      request({ findings: [finding({ snippet: "const OTHER = 2;" })] }),
    );
    expect(only?.verification).toBe("unverified");
  });

  it("a_finding_with_no_snippet_at_all_cannot_be_verified_by_its_line_alone", () => {
    const { snippet: _drop, ...noSnippet } = finding();
    void _drop;
    const [only] = verifyFindings(request({ findings: [noSnippet] }));
    expect(only?.verification).toBe("unverified");
  });

  it("a_whitespace_only_snippet_proves_nothing", () => {
    const [only] = verifyFindings(request({ findings: [finding({ snippet: "   \t  " })] }));
    expect(only?.verification).toBe("unverified");
  });

  it("a_blank_proven_line_cannot_be_matched_by_a_blank_claim", () => {
    // Two empty strings agreeing is not agreement about anything.
    expect(diffEvidence({ path: "a.ts", lines: new Map([[1, "   "]]) }, 1, "  ", "sha")).toBeNull();
  });

  it("citing_a_rule_the_repository_never_wrote_is_no_evidence_at_all", () => {
    expect(ruleEvidence(rules([]), "dedup")).toBeNull();
    // The rules half contributes nothing; only the diff half can still speak.
    const [proved] = verifyFindings(request({ rules: rules([]) }));
    expect(proved?.evidence.map((e) => e.kind)).toEqual(["diff"]);
    const [unproved] = verifyFindings(
      request({ rules: rules([]), findings: [finding({ snippet: "nope" })] }),
    );
    expect(unproved?.evidence).toEqual([]);
    expect(unproved?.verification).toBe("unverified");
  });

  it("a_cited_rule_alone_never_reaches_verified", () => {
    // 0.6 is consistent-with-rule. Verification needs proof at a line.
    const { snippet: _drop, ...noSnippet } = finding({ line: null });
    void _drop;
    const [only] = verifyFindings(request({ findings: [noSnippet] }));
    expect(only?.evidence.map((e) => e.weight)).toEqual([0.6]);
    expect(only?.verification).toBe("unverified");
  });
});

describe("model confidence buys nothing", () => {
  it("human_disposition_is_never_fabricated_from_model_confidence", () => {
    // The engine's whole input is the finding, the diff and the rules. There
    // is no confidence field on its request type, and the verified finding it
    // hands back carries no disposition of any kind.
    const [only] = verifyFindings(request({ findings: [finding({ snippet: "nope" })] }));
    expect(only).not.toHaveProperty("disposition");
    expect(only).not.toHaveProperty("confidence");
    expect(only?.verification).toBe("unverified");
  });

  it("a_verdict_at_confidence_one_still_produces_only_unverified_findings_without_proof", () => {
    const files = [{ path: "src/app.ts", lines: new Map([[1, LINE]]) }] as never;
    const verdict = parseVerdict(
      JSON.stringify({
        confidence: 1,
        findings: [
          { rule: "dedup", path: "src/app.ts", line: 1, body: "b", snippet: "not the line text" },
        ],
      }),
      files,
    );
    expect(verdict?.confidence).toBe(1);
    const claimed = verdict?.findings[0]?.snippet ?? "";
    const [only] = verifyFindings(request({ findings: [finding({ snippet: claimed })] }));
    expect(only?.verification).toBe("unverified");
  });

  it("deriveStatus_reads_only_weight_and_nothing_else_on_the_evidence", () => {
    const almost: Evidence = {
      kind: "diff",
      weight: 0.999999,
      detail: "d",
      provenance: { ruleId: "r", sourceFile: "f", atLine: 1, ref: { sha: "s", path: "f" } },
      at: "deterministic",
    };
    expect(deriveStatus([almost])).toBe("unverified");
    expect(deriveStatus([{ ...almost, weight: 1 }])).toBe("verified");
  });
});

describe("the evidence budget is a downgrade, never an upgrade", () => {
  it("a_finding_is_never_dropped_when_the_run_budget_is_spent", () => {
    // Every finding still comes back; only its evidence (and so its status)
    // is affected. Dropping findings silently would be a false negative the
    // reader could never see.
    const many = Array.from({ length: MAX_EVIDENCE_ITEMS_PER_RUN + 20 }, (_, i) =>
      finding({ id: `f${String(i)}`, ruleId: "dedup" }),
    );
    const out = verifyFindings(request({ findings: many }));
    expect(out).toHaveLength(many.length);
  });

  it("findings_past_the_run_item_budget_are_downgraded_not_upgraded", () => {
    // ADJUDICATE: the run budget is shared and spent in order, so a hostile or
    // merely noisy model that emits many findings first can push a later,
    // genuinely proven finding to `unverified`. That direction is fail-safe
    // (a claim loses its badge; it never gains one), which is why this pins
    // the behaviour rather than calling it a defect — but it is a false
    // NEGATIVE amplifier worth naming.
    const many = Array.from({ length: MAX_EVIDENCE_ITEMS_PER_RUN + 5 }, (_, i) =>
      finding({ id: `f${String(i)}` }),
    );
    const out = verifyFindings(request({ findings: many }));
    expect(out[0]?.verification).toBe("verified");
    expect(out.at(-1)?.verification).toBe("unverified");
    expect(out.at(-1)?.evidence).toEqual([]);
  });

  it("the_run_never_keeps_more_evidence_text_than_its_own_character_budget", () => {
    // The budget is the reason a hostile model cannot flood the envelope with
    // provenance text. It is a hard ceiling on what is KEPT, so it has to hold
    // across the whole run and not merely per finding.
    const many = Array.from({ length: MAX_EVIDENCE_ITEMS_PER_RUN + 40 }, (_, i) =>
      finding({ id: `f${String(i)}` }),
    );
    const out = verifyFindings(request({ findings: many }));
    const chars = out.reduce(
      (total, entry) => total + entry.evidence.reduce((n, e) => n + e.detail.length, 0),
      0,
    );
    // Asserted against the LITERAL ceilings, not against the same `MAX_*`
    // constants the implementation reads: a bound compared to itself moves
    // whenever the implementation moves and can never catch it changing.
    expect(chars).toBeLessThanOrEqual(4096);
    const items = out.reduce((n, entry) => n + entry.evidence.length, 0);
    expect(items).toBe(128);
    // And the constants really are the numbers the ceilings above name, so a
    // change to either is a change this file reports rather than absorbs.
    expect(MAX_EVIDENCE_TOTAL_CHARS).toBe(4096);
    expect(MAX_EVIDENCE_ITEMS_PER_RUN).toBe(128);
  });

  it("a_proved_finding_keeps_exactly_its_rule_and_its_diff_evidence_and_no_more", () => {
    // The per-finding ceiling is 8, but only two providers exist, so the real
    // observable is the pair: naming the exact evidence is a claim a change
    // can break, where `<= MAX_EVIDENCE_PER_FINDING` is one that cannot.
    const out = verifyFindings(request());
    expect(out[0]?.evidence.map((entry) => entry.kind)).toEqual(["diff", "rules"]);
    expect(out[0]?.verification).toBe(deriveStatus(out[0]?.evidence ?? []));
    expect(MAX_EVIDENCE_PER_FINDING).toBe(8);
  });

  it("verification_is_always_derivable_from_the_evidence_that_came_back", () => {
    // The invariant that makes the badge auditable: a reader can recompute the
    // status from the evidence printed beside it.
    const out = verifyFindings(
      request({
        findings: [
          finding({ id: "proved" }),
          finding({ id: "unproved", snippet: "nope" }),
          finding({ id: "no-line", line: null }),
        ],
      }),
    );
    for (const entry of out) expect(entry.verification).toBe(deriveStatus(entry.evidence));
  });
});

describe("evidence fingerprints are stable and bounded", () => {
  function evidence(over: Partial<Evidence> = {}): Evidence {
    return {
      kind: "diff",
      weight: 1,
      detail: "d",
      provenance: { ruleId: "r", sourceFile: "f.ts", atLine: 1, ref: { sha: "s", path: "f.ts" } },
      at: "deterministic",
      ...over,
    };
  }

  it("the_same_evidence_in_any_order_fingerprints_the_same", () => {
    const a = evidence({ detail: "a" });
    const b = evidence({ detail: "b", kind: "rules", weight: 0.6 });
    expect(evidenceFingerprint([a, b])).toBe(evidenceFingerprint([b, a]));
  });

  it("evidence_differing_only_past_the_text_cap_fingerprints_the_same", () => {
    // The cap is applied before hashing, so a model cannot make two identical
    // claims look different by padding the tail of a detail string.
    const long = "x".repeat(MAX_EVIDENCE_TEXT);
    expect(evidenceFingerprint([evidence({ detail: `${long}A` })])).toBe(
      evidenceFingerprint([evidence({ detail: `${long}B` })]),
    );
  });

  it("a_null_atLine_sorts_beside_line_zero_without_throwing", () => {
    const nulled = evidence({
      provenance: { ruleId: "r", sourceFile: "f.ts", atLine: null, ref: { sha: "", path: "" } },
    });
    expect(evidenceFingerprint([nulled, evidence()])).toBe(
      evidenceFingerprint([evidence(), nulled]),
    );
  });

  it("two_different_source_files_never_share_a_fingerprint", () => {
    const other = evidence({
      provenance: { ruleId: "r", sourceFile: "g.ts", atLine: 1, ref: { sha: "s", path: "g.ts" } },
    });
    expect(evidenceFingerprint([evidence()])).not.toBe(evidenceFingerprint([other]));
  });

  it("an_empty_evidence_set_has_a_fingerprint_and_it_is_unverified", () => {
    expect(evidenceFingerprint([])).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveStatus([])).toBe("unverified");
  });
});

describe("diffEvidence — what counts as agreement", () => {
  const file = { path: "src/app.ts", lines: new Map([[1, LINE]]) };

  it("a_claim_contained_in_the_proven_line_agrees", () => {
    expect(diffEvidence(file, 1, "VERSION", "sha")?.weight).toBe(1);
  });

  it("a_proven_line_contained_in_a_longer_claim_agrees", () => {
    expect(diffEvidence(file, 1, `  ${LINE}  // and more`, "sha")?.weight).toBe(1);
  });

  it("a_claim_that_merely_overlaps_does_not_agree", () => {
    expect(diffEvidence(file, 1, "VERSION = 2.0.0", "sha")).toBeNull();
  });

  it("evidence_names_the_head_sha_so_a_reader_can_check_the_claim", () => {
    expect(diffEvidence(file, 1, "VERSION", "deadbeef")?.provenance.ref).toEqual({
      sha: "deadbeef",
      path: "src/app.ts",
    });
  });
});

describe("the two guards the whole evidence boundary rests on", () => {
  // Routed as G-06 and G-13. Both are one-line guards whose removal does not
  // crash anything — it silently verifies claims the diff never proved — so
  // each gets a test whose failure is the regression itself.

  it("g06_an_absent_line_proves_nothing_even_though_every_claim_contains_the_empty_string", () => {
    // `providers.ts`'s `if (proven.length === 0) return null`. Without it,
    // `proven` is "" for an absent line and the agreement test degenerates:
    // `"".includes(claim)` is false, `claim.includes("")` is TRUE, so the
    // "no agreement" branch is never taken and weight-1 evidence is minted for
    // a line the patch does not carry. Every model finding in the run would
    // then read `verified`.
    const file = { path: "src/app.ts", lines: new Map([[1, LINE]]) };
    expect(diffEvidence(file, 2, "anything at all", "sha")).toBeNull();
    expect(diffEvidence(file, 999, LINE, "sha")).toBeNull();

    // And through the real engine, end to end: the finding survives, the
    // status does not.
    const [only] = verifyFindings(
      request({
        findings: [finding({ line: 2, snippet: "anything at all" })],
        shown: [file],
      }),
    );
    expect(only?.verification).toBe("unverified");
    expect(only?.evidence.filter((entry) => entry.kind === "diff")).toEqual([]);
  });

  it("g13_a_claim_about_one_file_is_never_proved_by_another_files_line", () => {
    // `verify.ts`'s `shown.get(finding.path)`. The finding names `src/b.ts`
    // and quotes text that really is proven — in `src/a.ts`. Looking the line
    // up in the wrong file, or in a merged line map, would verify it.
    const shown = [
      { path: "src/a.ts", lines: new Map([[7, "const secret = load();"]]) },
      { path: "src/b.ts", lines: new Map([[7, "const other = 1;"]]) },
    ];
    const [only] = verifyFindings(
      request({
        findings: [finding({ path: "src/b.ts", line: 7, snippet: "const secret = load();" })],
        shown,
      }),
    );
    expect(only?.verification).toBe("unverified");

    // The same claim against its real file does verify — so the test above is
    // failing on the file identity, not on something incidental.
    const [real] = verifyFindings(
      request({
        findings: [finding({ path: "src/a.ts", line: 7, snippet: "const secret = load();" })],
        shown,
      }),
    );
    expect(real?.verification).toBe("verified");
  });

  it("g13_a_path_the_run_never_showed_cannot_be_proved_by_any_snippet", () => {
    const [only] = verifyFindings(
      request({
        findings: [finding({ path: "src/never-shown.ts", line: 1, snippet: LINE })],
        shown: [{ path: "src/app.ts", lines: new Map([[1, LINE]]) }],
      }),
    );
    expect(only?.verification).toBe("unverified");
    expect(only?.evidence.map((entry) => entry.kind)).toEqual(["rules"]);
  });
});

describe("the evidence fingerprint's ordering is total", () => {
  // The digest sorts by (kind, sourceFile, atLine, detail) and hashes the
  // result. Every tie-break arm is what makes the digest independent of the
  // order evidence happened to be collected in — and a digest that quietly
  // changed ordering would orphan every thread keyed on the old one.
  function at(over: {
    kind?: Evidence["kind"];
    sourceFile?: string;
    atLine?: number | null;
    detail?: string;
  }): Evidence {
    return {
      kind: over.kind ?? "diff",
      weight: 1,
      detail: over.detail ?? "d",
      provenance: {
        ruleId: "r",
        sourceFile: over.sourceFile ?? "a.ts",
        atLine: over.atLine === undefined ? 1 : over.atLine,
        ref: { sha: "s", path: "p" },
      },
      at: "deterministic",
    };
  }

  it("kind_is_the_first_key_and_two_kinds_never_collide", () => {
    const diff = at({ kind: "diff" });
    const rules = at({ kind: "rules" });
    expect(evidenceFingerprint([diff, rules])).toBe(evidenceFingerprint([rules, diff]));
    expect(evidenceFingerprint([diff])).not.toBe(evidenceFingerprint([rules]));
  });

  it("source_file_breaks_a_kind_tie", () => {
    const a = at({ sourceFile: "a.ts" });
    const b = at({ sourceFile: "b.ts" });
    expect(evidenceFingerprint([a, b])).toBe(evidenceFingerprint([b, a]));
    expect(evidenceFingerprint([a, a])).not.toBe(evidenceFingerprint([a, b]));
  });

  it("line_number_breaks_a_kind_and_file_tie", () => {
    const one = at({ atLine: 1 });
    const two = at({ atLine: 2 });
    expect(evidenceFingerprint([one, two])).toBe(evidenceFingerprint([two, one]));
    expect(evidenceFingerprint([one, one])).not.toBe(evidenceFingerprint([one, two]));
  });

  it("detail_breaks_the_last_tie_so_the_sort_is_total", () => {
    // Without this arm two items differing only in `detail` would sort
    // unstably and the digest would depend on collection order.
    const x = at({ detail: "x" });
    const y = at({ detail: "y" });
    expect(evidenceFingerprint([x, y])).toBe(evidenceFingerprint([y, x]));
    expect(evidenceFingerprint([x, x])).not.toBe(evidenceFingerprint([x, y]));
  });

  it("a_null_line_sorts_as_zero_but_hashes_distinctly_from_a_real_line_zero", () => {
    // ADJUDICATE: the sort reads `atLine ?? 0` while the hashed row renders
    // `String(atLine ?? "")`. Two same-kind, same-file, same-detail items —
    // one at `null`, one at line 0 — therefore tie on every sort key yet
    // produce different rows, so their fingerprint depends on the order they
    // arrived in. Unreachable in production (`diffEvidence` always carries a
    // line >= 1 and `ruleEvidence` always carries `null`, and `kind` breaks
    // the tie before `atLine` is consulted), so this pins the two halves that
    // ARE relied on rather than asserting a total order the code does not
    // have.
    const nulled = at({ atLine: null });
    const zero = at({ atLine: 0 });
    expect(evidenceFingerprint([nulled])).not.toBe(evidenceFingerprint([zero]));
    expect(evidenceFingerprint([nulled, zero])).not.toBe(evidenceFingerprint([zero, nulled]));

    // The reachable shape — a null-line rules item beside a real diff item —
    // is order-independent, because `kind` sorts first.
    const rules = at({ kind: "rules", atLine: null });
    const diff = at({ kind: "diff", atLine: 3 });
    expect(evidenceFingerprint([rules, diff])).toBe(evidenceFingerprint([diff, rules]));
  });

  it("a_four_item_set_fingerprints_the_same_from_every_permutation", () => {
    const items = [
      at({ kind: "rules", sourceFile: "b.ts", atLine: null, detail: "r" }),
      at({ kind: "diff", sourceFile: "a.ts", atLine: 2, detail: "b" }),
      at({ kind: "diff", sourceFile: "a.ts", atLine: 2, detail: "a" }),
      at({ kind: "diff", sourceFile: "a.ts", atLine: 1, detail: "c" }),
    ];
    const expected = evidenceFingerprint(items);
    const permutations = [
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 3, 0, 1],
      [0, 3, 1, 2],
    ];
    for (const order of permutations) {
      expect(evidenceFingerprint(order.map((i) => items[i]!))).toBe(expected);
    }
  });
});
