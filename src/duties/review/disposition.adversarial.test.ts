/**
 * Human disposition, attacked.
 *
 * A disposition is the one thing on a review thread that speaks for a person.
 * Every case here asks how to make the run believe a maintainer said something
 * they did not — a stranger's reply, a bot's reply, the pull request author
 * triaging their own review, a mirrored disposition whose reply is gone, prose
 * that happens to contain the grammar — and pins the refusal.
 *
 * The counterpart is pinned too: what a maintainer really did write must not
 * be silently dropped. Where the code and its own doc comment disagree about
 * that, the disagreement is marked ADJUDICATE and current behaviour is pinned
 * rather than guessed at.
 */
import { describe, expect, it } from "vitest";

import {
  dispositionKey,
  isEligibleReply,
  mergeDispositions,
  parseDispositionLine,
  readDispositions,
  substantiatedDispositions,
  type ThreadReply,
} from "./disposition.js";
import type { Disposition, PreviousFinding } from "./findings.js";

const AT = { owner: "o", repo: "r", number: 7 };
const PR_AUTHOR = "contributor";

function reply(overrides: Partial<ThreadReply> = {}): ThreadReply {
  return {
    id: 11,
    login: "maintainer",
    isBot: false,
    association: "OWNER",
    createdAt: "2026-01-01T00:00:00Z",
    body: "12: wont-fix",
    ...overrides,
  };
}

function previous(overrides: Partial<PreviousFinding> = {}): PreviousFinding {
  return {
    id: "dedup:src/app.ts:12",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "src/app.ts",
    line: 12,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    wasResolved: false,
    disposition: null,
    ...overrides,
  };
}

const read = (replies: readonly ThreadReply[], findings: readonly PreviousFinding[]) =>
  readDispositions(replies, findings, AT, PR_AUTHOR);

describe("who may triage a finding", () => {
  it("a_stranger_cannot_triage_however_exactly_they_write_the_grammar", () => {
    for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "", "owner"]) {
      expect(read([reply({ association })], [previous()]).size).toBe(0);
    }
  });

  it("a_bot_cannot_triage_even_from_an_owner_account", () => {
    expect(read([reply({ isBot: true })], [previous()]).size).toBe(0);
  });

  it("the_pull_requests_own_author_cannot_triage_their_own_review", () => {
    // Self-triage would let an author dismiss every finding on their own PR.
    expect(read([reply({ login: PR_AUTHOR })], [previous()]).size).toBe(0);
  });

  it("a_reply_with_no_login_or_no_timestamp_or_a_non_positive_id_carries_nothing", () => {
    for (const over of [
      { login: "" },
      { createdAt: "" },
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
    ] as Partial<ThreadReply>[]) {
      expect(read([reply(over)], [previous()]).size).toBe(0);
    }
  });

  it("an_eligible_owner_collaborator_or_member_is_accepted", () => {
    for (const association of ["OWNER", "COLLABORATOR", "MEMBER"]) {
      expect(isEligibleReply(reply({ association }), PR_AUTHOR)).toBe(true);
    }
  });
});

describe("the grammar refuses everything it is not sure about", () => {
  it("prose_that_merely_mentions_a_line_and_a_word_is_not_a_disposition", () => {
    for (const body of [
      "I think 12: wont-fix is the right call",
      "please check line 12",
      "wont-fix",
      "12:",
      ": wont-fix",
      "12 wont-fix",
      "@maintainer what do you think",
      "12: approved",
      "12: verified-ish",
    ]) {
      expect(parseDispositionLine(body)).toBeNull();
    }
  });

  it("the_anchored_forms_are_accepted_with_their_documented_indulgences", () => {
    expect(parseDispositionLine("12: wont-fix")).toEqual({
      path: null,
      line: 12,
      value: "wont-fix",
    });
    expect(parseDispositionLine("  line 12 : REJECTED  ")).toEqual({
      path: null,
      line: 12,
      value: "rejected",
    });
    expect(
      parseDispositionLine("@reeve-bot src/app.ts:12: accepted-risk, because reasons"),
    ).toEqual({ path: "src/app.ts", line: 12, value: "accepted-risk" });
  });

  it("a_multi_line_reply_carries_no_disposition_at_all", () => {
    // ADJUDICATE — implementation vs. doc. `readDispositions`'s own doc comment
    // reads "Multiple matching lines in one reply each produce a disposition
    // for their own finding's identity", but the grammar is anchored with
    // `^`/`$` and no `m` flag and is applied to the WHOLE reply body once. So a
    // maintainer who writes two triage lines in one reply gets neither — not
    // one, not the first. Pinned as current behaviour; the fail-safe direction
    // (nothing is fabricated) is why this is reported rather than changed on a
    // guess.
    const body = "12: wont-fix\n20: rejected";
    expect(parseDispositionLine(body)).toBeNull();
    expect(read([reply({ body })], [previous(), previous({ line: 20 })]).size).toBe(0);
  });

  it("a_disposition_line_with_prose_above_it_is_also_refused", () => {
    expect(read([reply({ body: "Thanks for the review.\n12: wont-fix" })], [previous()]).size).toBe(
      0,
    );
  });
});

describe("a disposition is only ever attached to a finding that exists", () => {
  it("a_line_nobody_made_a_finding_at_invents_nothing", () => {
    expect(read([reply({ body: "99: rejected" })], [previous()]).size).toBe(0);
  });

  it("a_bare_line_form_is_refused_when_two_findings_share_that_line", () => {
    // Ambiguity is refused, not resolved by picking one: a maintainer saying
    // "12: rejected" about one of two claims has not said which.
    const findings = [previous(), previous({ ruleId: "other", id: "other:src/app.ts:12" })];
    expect(read([reply({ body: "12: rejected" })], findings).size).toBe(0);
  });

  it("the_path_form_disambiguates_where_the_bare_line_form_cannot", () => {
    const findings = [previous(), previous({ path: "src/other.ts" })];
    const out = read([reply({ body: "src/other.ts:12: rejected" })], findings);
    expect(out.size).toBe(1);
    expect(out.get(dispositionKey({ ruleId: "dedup", path: "src/other.ts" }))?.value).toBe(
      "rejected",
    );
  });

  it("a_path_form_naming_the_right_file_but_the_wrong_line_matches_nothing", () => {
    expect(read([reply({ body: "src/app.ts:99: rejected" })], [previous()]).size).toBe(0);
  });

  it("a_disposition_records_the_reply_that_made_it_so_a_reader_can_check", () => {
    const out = read([reply({ id: 42 })], [previous()]);
    expect(out.get(dispositionKey(previous()))).toEqual({
      value: "wont-fix",
      by: "maintainer",
      at: "2026-01-01T00:00:00Z",
      replyId: 42,
      replyUrl: "https://github.com/o/r/pull/7#issuecomment-42",
    });
  });

  it("a_later_eligible_reply_overrides_an_earlier_one_on_the_same_finding", () => {
    const out = read(
      [
        reply({ id: 1, body: "12: rejected" }),
        reply({ id: 2, login: "second", body: "12: verified" }),
      ],
      [previous()],
    );
    expect(out.get(dispositionKey(previous()))).toMatchObject({ value: "verified", by: "second" });
  });

  it("the_key_is_the_intention_so_a_moved_finding_keeps_its_triage", () => {
    expect(dispositionKey({ ruleId: "dedup", path: "src/app.ts" })).toBe(
      dispositionKey({ ruleId: "dedup", path: "src/app.ts" }),
    );
    expect(dispositionKey({ ruleId: "dedup", path: "src/app.ts" })).not.toBe(
      dispositionKey({ ruleId: "other", path: "src/app.ts" }),
    );
  });
});

describe("the envelope mirror cannot outlive the reply that made it", () => {
  const stored: Disposition = {
    value: "wont-fix",
    by: "maintainer",
    at: "2026-01-01T00:00:00Z",
    replyId: 11,
    replyUrl: "https://github.com/o/r/pull/7#issuecomment-11",
  };
  const mirrored = [previous({ disposition: stored })];

  it("a_mirror_whose_reply_is_still_there_and_still_theirs_survives", () => {
    const out = substantiatedDispositions(mirrored, [reply()], PR_AUTHOR);
    expect(out.get(dispositionKey(previous()))).toEqual(stored);
  });

  it("a_mirror_whose_reply_was_deleted_is_dropped", () => {
    expect(substantiatedDispositions(mirrored, [], PR_AUTHOR).size).toBe(0);
  });

  it("a_mirror_whose_reply_now_belongs_to_someone_else_is_dropped", () => {
    // The forged-envelope defence: a hostile envelope naming a real
    // maintainer against a reply id that is somebody else's cannot survive.
    const out = substantiatedDispositions(mirrored, [reply({ login: "mallory" })], PR_AUTHOR);
    expect(out.size).toBe(0);
  });

  it("a_mirror_whose_reply_became_ineligible_is_dropped", () => {
    for (const over of [{ isBot: true }, { association: "NONE" }, { login: PR_AUTHOR }]) {
      expect(substantiatedDispositions(mirrored, [reply(over)], PR_AUTHOR).size).toBe(0);
    }
  });

  it("a_finding_with_no_mirrored_disposition_contributes_nothing", () => {
    expect(substantiatedDispositions([previous()], [reply()], PR_AUTHOR).size).toBe(0);
  });
});

describe("merging the thread against the mirror", () => {
  const key = dispositionKey(previous());
  const fresh: Disposition = {
    value: "verified",
    by: "maintainer",
    at: "2026-02-01T00:00:00Z",
    replyId: 12,
    replyUrl: "u",
  };
  const mirror: Disposition = { ...fresh, value: "wont-fix", replyId: 11 };

  it("the_thread_wins_over_the_mirror_because_the_thread_is_the_durable_home", () => {
    const merged = mergeDispositions(new Map([[key, fresh]]), new Map([[key, mirror]]));
    expect(merged.get(key)).toEqual(fresh);
  });

  it("the_mirror_fills_a_gap_the_thread_no_longer_shows", () => {
    const merged = mergeDispositions(new Map(), new Map([[key, mirror]]));
    expect(merged.get(key)).toEqual(mirror);
  });

  it("merging_never_mutates_either_input", () => {
    const a = new Map([[key, fresh]]);
    const b = new Map([[key, mirror]]);
    mergeDispositions(a, b);
    expect(a.get(key)).toEqual(fresh);
    expect(b.get(key)).toEqual(mirror);
  });
});
