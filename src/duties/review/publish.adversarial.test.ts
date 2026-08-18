/**
 * The owned comment's memory, attacked.
 *
 * The envelope rides in a public HTML comment on a public pull request, which
 * means anyone who can comment can write bytes that LOOK like it. Every case
 * here asks what a forged, damaged or hand-edited envelope can make the next
 * run believe — a fabricated maintainer disposition being the prize — and
 * pins the answer: corruption is loud, never a silent cold start, and never a
 * partial read.
 *
 * The write half is here too: exactly one comment per pull request, replaced
 * in place when the review moved and left alone when it did not.
 */
import { describe, expect, it } from "vitest";

import type { Author } from "../../core/forge.js";

import {
  decodeEnvelope,
  encodeEnvelope,
  findingLine,
  marker,
  readThread,
  postOrReplace,
  publicationFor,
  rehearse,
  render,
  renderFingerprint,
  type Publication,
  type ReviewCommentApi,
} from "./publish.js";
import {
  envelopeChecksum,
  type Disposition,
  type Finding,
  type Previous,
  type PreviousFinding,
  type Status,
} from "./findings.js";

const AT = { owner: "o", repo: "r", number: 1 };
const BOT: Author = { login: "reeve[bot]", type: "Bot" };
const SHA = "1".repeat(40);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "dedup:a.ts:1",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "a.ts",
    line: 1,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function previousFinding(overrides: Partial<PreviousFinding> = {}): PreviousFinding {
  return { ...finding(), wasResolved: false, disposition: null, ...overrides };
}

const DISPOSITION: Disposition = {
  value: "wont-fix",
  by: "maintainer",
  at: "2026-01-01T00:00:00Z",
  replyId: 5,
  replyUrl: "https://example.invalid/5",
};

/** A whole, checksum-correct v2 envelope, then whatever the case wants changed. */
function sealed(previous: Omit<Previous, "version" | "checksum">): Previous {
  return { ...previous, version: 2, checksum: envelopeChecksum(previous) };
}

/** The payload shape the marker carries: `<fingerprint> <base64 envelope>`. */
const payloadOf = (previous: Previous): string => `fp ${encodeEnvelope(previous)}`;

/** The reason a decode gave, or "" when it did not report corruption — so an
 *  assertion about the reason never has to sit inside an `if`. */
const reasonOf = (decoded: ReturnType<typeof decodeEnvelope>): string =>
  decoded.kind === "corrupt" ? decoded.reason : "";

/** Base64 of an arbitrary JSON value, as an envelope half. */
const rawPayload = (value: unknown): string =>
  `fp ${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}`;

function stubOf(initial: { id: number; body: string; user: Author | null }[] = []) {
  const comments = initial.map((entry) => ({ ...entry }));
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;
  const writes: { kind: "create" | "update"; id?: number }[] = [];
  const api: ReviewCommentApi = {
    rest: {
      issues: {
        listComments: (params) => {
          const per = params.per_page ?? 100;
          const page = params.page ?? 1;
          return Promise.resolve({
            data: comments.slice((page - 1) * per, page * per).map(({ id, body, user }) => ({
              id,
              body,
              user: user ?? null,
              author_association: user?.type === "Bot" ? "NONE" : "OWNER",
              created_at: "2026-08-17T00:00:00Z",
            })),
          });
        },
        createComment: (params) => {
          writes.push({ kind: "create" });
          comments.push({ id: nextId, body: params.body, user: BOT });
          nextId += 1;
          return Promise.resolve({});
        },
        updateComment: (params) => {
          writes.push({ kind: "update", id: params.comment_id });
          const found = comments.find((entry) => entry.id === params.comment_id);
          if (found) found.body = params.body;
          return Promise.resolve({});
        },
      },
    },
  };
  return { api, comments, writes };
}

function publication(
  reconciled: { finding: Finding; status: Status; disposition: Disposition | null }[],
  next: Previous = sealed({ findings: [], reviewedShas: [SHA] }),
): Publication {
  return { reconciled, next, headSha: SHA };
}

describe("a forged envelope cannot fabricate a maintainer's word", () => {
  it("a_disposition_added_without_recomputing_the_checksum_is_corrupt_not_believed", () => {
    // The attack: copy the marker off a public comment, splice in a
    // `wont-fix` by a real maintainer's login, post it back. The checksum
    // covers the disposition's value, author and reply id, so the splice
    // fails the recomputation.
    const honest = sealed({ findings: [previousFinding()], reviewedShas: [SHA] });
    const forged = {
      ...honest,
      findings: [{ ...previousFinding(), disposition: DISPOSITION }],
    };
    const out = decodeEnvelope(payloadOf(forged));
    expect(out.kind).toBe("corrupt");
    expect(reasonOf(out)).toMatch(/checksum/);
  });

  it("a_resolved_flag_flipped_in_place_is_corrupt", () => {
    const honest = sealed({ findings: [previousFinding()], reviewedShas: [SHA] });
    const forged = { ...honest, findings: [{ ...previousFinding(), wasResolved: true }] };
    expect(decodeEnvelope(payloadOf(forged as Previous)).kind).toBe("corrupt");
  });

  it("a_reviewed_sha_appended_in_place_is_corrupt", () => {
    const honest = sealed({ findings: [], reviewedShas: [SHA] });
    const forged = { ...honest, reviewedShas: [SHA, "2".repeat(40)] };
    expect(decodeEnvelope(payloadOf(forged as Previous)).kind).toBe("corrupt");
  });

  it("a_v2_envelope_with_no_checksum_at_all_is_corrupt_not_a_cold_start", () => {
    const out = decodeEnvelope(
      rawPayload({ version: 2, findings: [previousFinding()], reviewedShas: [] }),
    );
    expect(out.kind).toBe("corrupt");
  });

  it("a_disposition_naming_a_value_outside_the_union_is_corrupt", () => {
    const findings = [{ ...previousFinding(), disposition: { ...DISPOSITION, value: "approved" } }];
    expect(
      decodeEnvelope(rawPayload({ version: 2, findings, reviewedShas: [], checksum: "x" })).kind,
    ).toBe("corrupt");
  });

  it("a_disposition_with_a_non_positive_or_non_integer_reply_id_is_corrupt", () => {
    for (const replyId of [0, -1, 1.5, "5"]) {
      const findings = [{ ...previousFinding(), disposition: { ...DISPOSITION, replyId } }];
      expect(
        decodeEnvelope(rawPayload({ version: 2, findings, reviewedShas: [], checksum: "x" })).kind,
      ).toBe("corrupt");
    }
  });

  it("a_disposition_missing_its_attribution_strings_is_corrupt", () => {
    for (const missing of ["by", "at", "replyUrl"]) {
      const disposition = Object.fromEntries(
        Object.entries(DISPOSITION).filter(([key]) => key !== missing),
      );
      const findings = [{ ...previousFinding(), disposition }];
      expect(
        decodeEnvelope(rawPayload({ version: 2, findings, reviewedShas: [], checksum: "x" })).kind,
      ).toBe("corrupt");
    }
  });

  it("a_disposition_that_is_a_list_rather_than_a_mapping_is_corrupt", () => {
    const findings = [{ ...previousFinding(), disposition: [DISPOSITION] }];
    expect(
      decodeEnvelope(rawPayload({ version: 2, findings, reviewedShas: [], checksum: "x" })).kind,
    ).toBe("corrupt");
  });

  it("an_honest_disposition_survives_a_round_trip_with_its_attribution_intact", () => {
    const previous = sealed({
      findings: [previousFinding({ disposition: DISPOSITION })],
      reviewedShas: [SHA],
    });
    const out = decodeEnvelope(payloadOf(previous));
    expect(out).toMatchObject({
      kind: "ok",
      previous: { findings: [{ disposition: DISPOSITION }] },
    });
  });
});

describe("a damaged envelope is loud, never an empty memory", () => {
  it("no_payload_and_a_fingerprint_only_payload_are_both_honest_cold_starts", () => {
    expect(decodeEnvelope(null)).toEqual({ kind: "none" });
    expect(decodeEnvelope("just-a-fingerprint")).toEqual({ kind: "none" });
    expect(decodeEnvelope("fp ")).toEqual({ kind: "none" });
  });

  it("a_payload_that_is_not_valid_base64_json_is_corrupt", () => {
    const out = decodeEnvelope("fp !!!!not-base64!!!!");
    expect(out.kind).toBe("corrupt");
  });

  it("an_envelope_that_is_a_list_or_a_scalar_is_corrupt", () => {
    expect(decodeEnvelope(rawPayload([1, 2])).kind).toBe("corrupt");
    expect(decodeEnvelope(rawPayload("memory")).kind).toBe("corrupt");
    expect(decodeEnvelope(rawPayload(null)).kind).toBe("corrupt");
  });

  it("an_envelope_declaring_an_unknown_version_is_corrupt_and_names_it", () => {
    const out = decodeEnvelope(rawPayload({ version: 3, findings: [], reviewedShas: [] }));
    expect(out.kind).toBe("corrupt");
    expect(reasonOf(out)).toContain("`3`");
  });

  it("an_envelope_with_no_findings_array_is_corrupt_in_both_versions", () => {
    expect(decodeEnvelope(rawPayload({ reviewedShas: [] })).kind).toBe("corrupt");
    expect(decodeEnvelope(rawPayload({ version: 2, reviewedShas: [] })).kind).toBe("corrupt");
  });

  it("a_finding_missing_any_required_string_field_is_corrupt", () => {
    for (const key of ["id", "ruleId", "ruleName", "ruleBody", "path", "body", "marker"]) {
      const entry = Object.fromEntries(
        Object.entries(previousFinding()).filter(([name]) => name !== key),
      );
      expect(
        decodeEnvelope(rawPayload({ version: 2, findings: [entry], reviewedShas: [] })).kind,
      ).toBe("corrupt");
    }
  });

  it("a_finding_whose_wasResolved_is_not_a_boolean_is_corrupt", () => {
    const entry = { ...previousFinding(), wasResolved: "yes" };
    expect(
      decodeEnvelope(rawPayload({ version: 2, findings: [entry], reviewedShas: [] })).kind,
    ).toBe("corrupt");
  });

  it("a_v2_finding_naming_a_line_that_is_not_a_positive_integer_is_corrupt", () => {
    for (const line of [0, -3, 1.5, "1"]) {
      const entry = { ...previousFinding(), line };
      expect(
        decodeEnvelope(rawPayload({ version: 2, findings: [entry], reviewedShas: [] })).kind,
      ).toBe("corrupt");
    }
  });

  it("a_v2_finding_naming_an_unknown_severity_is_corrupt", () => {
    const entry = { ...previousFinding(), severity: "catastrophic" };
    const out = decodeEnvelope(rawPayload({ version: 2, findings: [entry], reviewedShas: [] }));
    expect(out.kind).toBe("corrupt");
    expect(reasonOf(out)).toMatch(/unknown severity/);
  });

  it("a_findings_entry_that_is_not_a_mapping_is_corrupt", () => {
    for (const entry of ["a finding", 7, null, ["x"]]) {
      expect(
        decodeEnvelope(rawPayload({ version: 2, findings: [entry], reviewedShas: [] })).kind,
      ).toBe("corrupt");
    }
  });
});

describe("a v1 envelope migrates rather than being read as damage", () => {
  it("a_versionless_payload_migrates_with_every_disposition_starting_null", () => {
    const out = decodeEnvelope(
      rawPayload({
        findings: [{ ...previousFinding(), resolvedAtSha: SHA, wasResolved: true }],
        reviewedShas: [SHA],
      }),
    );
    expect(out).toMatchObject({
      kind: "ok",
      previous: {
        version: 2,
        findings: [{ wasResolved: true, resolvedAtSha: SHA, disposition: null }],
      },
    });
    // The migration seals it, so the next run reads its own write as whole.
    const sealed_ = (out as { kind: "ok"; previous: Previous }).previous;
    expect(decodeEnvelope(payloadOf(sealed_)).kind).toBe("ok");
  });

  it("a_versionless_payload_with_a_malformed_finding_is_corrupt_not_partially_migrated", () => {
    const out = decodeEnvelope(
      rawPayload({ findings: [previousFinding(), { id: "half" }], reviewedShas: [] }),
    );
    expect(out.kind).toBe("corrupt");
  });

  it("a_versionless_finding_with_a_fractional_line_is_corrupt", () => {
    const out = decodeEnvelope(
      rawPayload({ findings: [{ ...previousFinding(), line: 2.5 }], reviewedShas: [] }),
    );
    expect(out.kind).toBe("corrupt");
  });

  it("non_string_reviewed_shas_are_dropped_rather_than_carried_as_junk", () => {
    expect(
      decodeEnvelope(rawPayload({ findings: [], reviewedShas: [SHA, 7, null, "2".repeat(40)] })),
    ).toMatchObject({ kind: "ok", previous: { reviewedShas: [SHA, "2".repeat(40)] } });
  });

  it("a_non_array_reviewedShas_reads_as_no_history_rather_than_failing", () => {
    expect(decodeEnvelope(rawPayload({ findings: [], reviewedShas: "abc" }))).toMatchObject({
      kind: "ok",
      previous: { reviewedShas: [] },
    });
  });
});

describe("DOWNGRADE — omitting `version` skips every v2 integrity check", () => {
  // P0, measured. `decodeEnvelope` routes on ONE field: `map.version === undefined`
  // sends the payload to `migrateV1`, which COMPUTES a checksum instead of
  // verifying one and applies a strictly weaker field check than `validateV2`.
  //
  // Every case in this block is the versionless twin of a v2 case pinned above.
  // Each is `corrupt` as v2 and `ok` as v1 — measured, not assumed — so a
  // reader of the v2 block alone would believe a defence that one omitted key
  // turns off. That is a textbook downgrade, and the tests above read as if it
  // were covered, which is why the twins live here.
  //
  // ADJUDICATE: these pin CURRENT behaviour. The proposed narrowing is to apply
  // v2's FIELD checks (severity in the union, line null-or-positive-integer,
  // disposition shape) to the v1 path while keeping the checksum exemption —
  // genuine legacy envelopes were written from the same types and pass all of
  // them, so the migration stays lenient exactly where it has to be and strict
  // everywhere it can be. Flipping that switch turns every `ok` below into
  // `corrupt`. Awaiting a ruling; see the report and the failure matrix.

  /** The same tampered body, offered with and without a `version` key. */
  function bothWays(body: Record<string, unknown>): { v2: string; v1: string } {
    const honest = { findings: [previousFinding()], reviewedShas: [SHA] };
    return {
      v2: rawPayload({ ...body, version: 2, checksum: envelopeChecksum(honest) }),
      v1: rawPayload(body),
    };
  }

  it("a_resolved_flag_flipped_in_place_is_corrupt_as_v2_but_ok_without_a_version", () => {
    const { v2, v1 } = bothWays({
      findings: [{ ...previousFinding(), wasResolved: true }],
      reviewedShas: [SHA],
    });
    expect(decodeEnvelope(v2).kind).toBe("corrupt");
    expect(decodeEnvelope(v1).kind).toBe("ok");
  });

  it("a_reviewed_sha_appended_in_place_is_corrupt_as_v2_but_ok_without_a_version", () => {
    const { v2, v1 } = bothWays({
      findings: [previousFinding()],
      reviewedShas: [SHA, "2".repeat(40)],
    });
    expect(decodeEnvelope(v2).kind).toBe("corrupt");
    const out = decodeEnvelope(v1);
    expect(out.kind).toBe("ok");
    // The forged history is carried, so the summary's "Previously reviewed at"
    // row names a SHA this thread was never reviewed against.
    expect(out).toMatchObject({ previous: { reviewedShas: [SHA, "2".repeat(40)] } });
  });

  it("an_unknown_severity_is_corrupt_as_v2_but_ok_without_a_version", () => {
    const { v2, v1 } = bothWays({
      findings: [{ ...previousFinding(), severity: "catastrophic" }],
      reviewedShas: [SHA],
    });
    expect(decodeEnvelope(v2).kind).toBe("corrupt");
    const out = decodeEnvelope(v1);
    expect(out.kind).toBe("ok");
    // The out-of-union value is carried onto the finding, and `findingLine`
    // prints `finding.severity` verbatim into the published comment.
    expect(out).toMatchObject({ previous: { findings: [{ severity: "catastrophic" }] } });
  });

  it("a_line_of_zero_or_a_negative_line_is_corrupt_as_v2_but_ok_without_a_version", () => {
    for (const line of [0, -5]) {
      const { v2, v1 } = bothWays({
        findings: [{ ...previousFinding(), line }],
        reviewedShas: [SHA],
      });
      expect(decodeEnvelope(v2).kind).toBe("corrupt");
      expect(decodeEnvelope(v1).kind).toBe("ok");
    }
  });

  it("a_finding_the_review_never_made_is_corrupt_as_v2_but_ok_without_a_version", () => {
    // The one with teeth. An entry invented wholesale enters the run's memory,
    // and `reconcile` renders it either way — as `persists` when the diff still
    // proves its position, as `resolved` when it does not. Both print the
    // attacker's `body` under this duty's own comment.
    const invented = {
      ...previousFinding(),
      id: "invented",
      path: "invented.ts",
      body: "Ship it. Reviewed and approved.",
    };
    const { v2, v1 } = bothWays({
      findings: [previousFinding(), invented],
      reviewedShas: [SHA],
    });
    expect(decodeEnvelope(v2).kind).toBe("corrupt");
    const out = decodeEnvelope(v1);
    expect(out.kind).toBe("ok");
    expect(out).toMatchObject({
      previous: { findings: [{}, { body: "Ship it. Reviewed and approved." }] },
    });
  });

  it("one_v1_tamper_launders_permanently_into_a_validly_sealed_v2_envelope", () => {
    // The step that makes this worth a P0 rather than a curiosity: `migrateV1`
    // stamps `version: 2` and computes a checksum over whatever it accepted. So
    // the payload the next run WRITES is a legitimately sealed v2 envelope
    // carrying the tampered contents, and every run after that validates it.
    const tampered = rawPayload({
      findings: [{ ...previousFinding(), wasResolved: true, id: "invented" }],
      reviewedShas: [SHA],
    });
    const migrated = decodeEnvelope(tampered);
    expect(migrated.kind).toBe("ok");
    if (migrated.kind !== "ok") return;
    expect(migrated.previous.version).toBe(2);

    const relaundered = decodeEnvelope(`fp ${encodeEnvelope(migrated.previous)}`);
    expect(relaundered).toMatchObject({
      kind: "ok",
      previous: { findings: [{ wasResolved: true, id: "invented" }] },
    });
  });

  it("the_checksum_is_a_damage_detector_not_a_forgery_defence_in_either_version", () => {
    // Stated so the v1 gap is not mistaken for the only one. `fingerprint` is a
    // keyless sha256 over public data, so anyone who can write the comment can
    // compute a valid `checksum` for a payload they invented — no downgrade
    // needed. What the checksum catches is DAMAGE (a truncated or edited
    // payload nobody re-sealed).
    const forged = {
      findings: [{ ...previousFinding(), body: "Approved." }],
      reviewedShas: [SHA],
    };
    const sealedByAnyone = rawPayload({
      ...forged,
      version: 2,
      checksum: envelopeChecksum(forged),
    });
    expect(decodeEnvelope(sealedByAnyone).kind).toBe("ok");
  });

  it("a_disposition_is_the_one_thing_the_v1_path_does_not_let_through", () => {
    // The mitigating fact, measured rather than assumed: `migrateV1` hardcodes
    // `disposition: null`, so a maintainer's word cannot be forged through the
    // downgrade even though everything around it can. This is the bound on the
    // finding, and it must not silently disappear.
    const withForged = rawPayload({
      findings: [{ ...previousFinding(), disposition: DISPOSITION }],
      reviewedShas: [SHA],
    });
    const out = decodeEnvelope(withForged);
    expect(out.kind).toBe("ok");
    expect(out).toMatchObject({ previous: { findings: [{ disposition: null }] } });
  });

  it("the_field_checks_the_v1_path_does_keep_still_refuse_a_malformed_finding", () => {
    // Not everything is open: `isV1Findable` still requires the string fields,
    // a boolean `wasResolved`, and an integer-or-null line. These are the cases
    // a narrowing would EXTEND, not replace.
    for (const body of [
      { findings: [{ ...previousFinding(), line: 2.5 }], reviewedShas: [] },
      { findings: [{ ...previousFinding(), wasResolved: "yes" }], reviewedShas: [] },
      { findings: [{ ...previousFinding(), ruleId: 7 }], reviewedShas: [] },
    ]) {
      expect(decodeEnvelope(rawPayload(body)).kind).toBe("corrupt");
    }
  });
});

describe('IDENTITY — the owned-comment guard asks "not a human", not "is this review"', () => {
  // P1, measured. `readThread` adopts a comment as this duty's own memory when
  // `isBotAuthor(comment.user)` is true AND the marker sits at the top. That
  // first test is `type === "Bot" || login.endsWith("[bot]")` — it answers
  // "is this account not a human", which is a strictly wider question than
  // "is this account this review".
  //
  // The realistic vector is not an exotic one: `github-actions[bot]` is the
  // login EVERY workflow in the repository posts under when it uses the
  // default token. Any workflow that echoes untrusted text into a comment —
  // a PR title, a body, a branch name — is a path into review's own state.
  //
  // ADJUDICATE: pinned as current behaviour. Narrowing the check changes which
  // existing state is readable (a thread whose envelope was written under a
  // different bot login would cold-start), so it needs a ruling, not a patch.
  // `docs/security/threat-model.md` does not mention this today.

  /** A thread whose only comment carries a valid, sealed envelope under `author`. */
  function threadOwnedBy(author: Author | null): ReviewCommentApi {
    const memory = {
      findings: [previousFinding({ body: "Injected by a neighbour." })],
      reviewedShas: [],
    };
    const sealed_ = { ...memory, version: 2 as const, checksum: envelopeChecksum(memory) };
    const body = marker.render(`fp ${encodeEnvelope(sealed_)}`);
    return {
      rest: {
        issues: {
          listComments: () =>
            Promise.resolve({
              data: [
                {
                  id: 1,
                  body,
                  user: author,
                  author_association: "NONE",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            }),
          createComment: () => Promise.resolve({}),
          updateComment: () => Promise.resolve({}),
        },
      },
    };
  }

  const adopted = async (author: Author | null): Promise<boolean> =>
    (await readThread(threadOwnedBy(author), AT)).marked !== null;

  it("every_bot_in_the_repository_can_plant_this_reviews_memory_not_only_reeve", async () => {
    // The gap, stated as the list it actually is.
    expect(await adopted({ login: "reeve[bot]", type: "Bot" })).toBe(true);
    expect(await adopted({ login: "github-actions[bot]", type: "Bot" })).toBe(true);
    expect(await adopted({ login: "dependabot[bot]", type: "Bot" })).toBe(true);
    expect(await adopted({ login: "renovate[bot]", type: "Bot" })).toBe(true);
    expect(await adopted({ login: "any-installed-app[bot]", type: "Bot" })).toBe(true);
  });

  it("a_bot_suffixed_login_is_adopted_even_when_github_calls_the_account_a_user", async () => {
    // The suffix alone is sufficient — `type` is not required to agree. GitHub
    // usernames cannot contain brackets, so this is not registrable on
    // github.com today; the guard nonetheless rests on that charset rather
    // than on anything asserted here.
    expect(await adopted({ login: "mallory[bot]", type: "User" })).toBe(true);
  });

  it("an_ordinary_human_comment_is_still_never_adopted", async () => {
    // The half of the guard that does hold, and must keep holding.
    expect(await adopted({ login: "mallory", type: "User" })).toBe(false);
    expect(await adopted({ login: "", type: "User" })).toBe(false);
    expect(await adopted(null)).toBe(false);
  });

  it("the_marker_must_still_open_the_comment_so_a_quoted_one_is_not_adopted", async () => {
    // The second half of the guard is unaffected by any of the above: a bot
    // that QUOTES the marker below its own prose is not adopted, because
    // `marker.split` requires nothing official above it.
    const memory = { findings: [previousFinding()], reviewedShas: [] };
    const sealed_ = { ...memory, version: 2 as const, checksum: envelopeChecksum(memory) };
    const quoted = `Here is what the review said:\n\n${marker.render(`fp ${encodeEnvelope(sealed_)}`)}`;
    const api: ReviewCommentApi = {
      rest: {
        issues: {
          listComments: () =>
            Promise.resolve({
              data: [
                {
                  id: 1,
                  body: quoted,
                  user: { login: "github-actions[bot]", type: "Bot" },
                  author_association: "NONE",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            }),
          createComment: () => Promise.resolve({}),
          updateComment: () => Promise.resolve({}),
        },
      },
    };
    expect((await readThread(api, AT)).marked).toBeNull();
  });
});

describe("the write is one comment, replaced in place", () => {
  const entry = (status: Status, over: Partial<Finding> = {}) => ({
    finding: finding(over),
    status,
    disposition: null,
  });

  it("a_first_run_posts_once_and_a_rerun_with_the_same_review_writes_nothing", async () => {
    const stub = stubOf([]);
    const pub = publication([entry("created")]);
    expect(await postOrReplace(stub.api, AT, pub)).toBe("posted");
    expect(stub.comments).toHaveLength(1);

    expect(await postOrReplace(stub.api, AT, pub)).toBe("unchanged");
    expect(stub.comments).toHaveLength(1);
    expect(stub.writes).toEqual([{ kind: "create" }]);
  });

  it("a_rerun_whose_findings_moved_replaces_the_same_comment_never_adds_one", async () => {
    const stub = stubOf([]);
    await postOrReplace(stub.api, AT, publication([entry("created")]));
    const id = stub.comments[0]?.id;
    expect(await postOrReplace(stub.api, AT, publication([entry("persists")]))).toBe("replaced");
    expect(stub.comments).toHaveLength(1);
    expect(stub.writes.at(-1)).toEqual({ kind: "update", id });
  });

  it("a_new_disposition_alone_is_a_real_change_the_next_run_renders", async () => {
    // The digest covers dispositions, so a maintainer's triage is not silently
    // swallowed as "nothing changed since last time".
    const bare = publication([entry("created")]);
    const triaged = publication([{ ...entry("created"), disposition: DISPOSITION }]);
    expect(renderFingerprint(bare.reconciled)).not.toBe(renderFingerprint(triaged.reconciled));

    const stub = stubOf([]);
    await postOrReplace(stub.api, AT, bare);
    expect(await postOrReplace(stub.api, AT, triaged)).toBe("replaced");
    expect(stub.comments).toHaveLength(1);
  });

  it("a_human_authored_comment_carrying_the_marker_is_never_overwritten", async () => {
    const pub = publication([entry("created")]);
    const forged = publicationFor(pub).body;
    const stub = stubOf([{ id: 9, body: forged, user: { login: "mallory", type: "User" } }]);
    expect(await postOrReplace(stub.api, AT, pub)).toBe("posted");
    expect(stub.writes).toEqual([{ kind: "create" }]);
    expect(stub.comments[0]?.body).toBe(forged);
  });

  it("the_rehearsal_reports_what_the_write_would_do_without_writing_it", async () => {
    const stub = stubOf([]);
    const pub = publication([entry("created")]);
    expect(await rehearse(stub.api, AT, pub)).toBe("posted");
    expect(stub.writes).toEqual([]);
    expect(stub.comments).toHaveLength(0);
  });
});

describe("the rendered comment", () => {
  it("groups_by_evidence_status_in_the_ladder_order_regardless_of_input_order", () => {
    const text = render([
      { finding: finding({ path: "e.ts" }), status: "resolved", disposition: null },
      { finding: finding({ path: "d.ts" }), status: "persists", disposition: null },
      { finding: finding({ path: "c.ts" }), status: "changed", disposition: null },
      { finding: finding({ path: "b.ts" }), status: "reopened", disposition: null },
      { finding: finding({ path: "a.ts" }), status: "created", disposition: null },
    ]);
    const order = ["New findings", "Reopened", "Changed", "Still standing", "Resolved"].map((h) =>
      text.indexOf(h),
    );
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("counts_the_findings_under_each_heading", () => {
    const text = render([
      { finding: finding({ path: "a.ts" }), status: "created", disposition: null },
      { finding: finding({ path: "b.ts" }), status: "created", disposition: null },
    ]);
    expect(text).toContain("### New findings (2)");
  });

  it("a_disposition_does_not_move_a_finding_out_of_its_evidence_group", () => {
    // The two axes stay orthogonal: `wont-fix` is a maintainer's word, not a
    // claim that the diff answered the finding.
    const text = render([{ finding: finding(), status: "created", disposition: DISPOSITION }]);
    expect(text).toContain("### New findings (1)");
    expect(text).not.toContain("### Resolved");
    expect(text).toContain("wont-fix");
  });

  it("an_empty_review_renders_the_fixed_no_findings_chrome", () => {
    const text = render([]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("### New findings");
  });

  it("a_backtick_in_a_path_cannot_break_out_of_the_finding_line", () => {
    const line = findingLine(finding({ path: "a`.ts" }));
    expect(line).not.toContain("a`.ts");
    expect(line).toContain("a.ts");
  });

  it("a_finding_about_a_whole_file_prints_no_line_suffix", () => {
    expect(findingLine(finding({ line: null }))).not.toMatch(/a\.ts`?:\d/);
  });

  it("the_same_reconciled_findings_render_the_same_bytes", () => {
    const entries = [
      { finding: finding(), status: "created" as Status, disposition: null },
      {
        finding: finding({ path: "b.ts" }),
        status: "resolved" as Status,
        disposition: DISPOSITION,
      },
    ];
    expect(render(entries)).toBe(render([...entries]));
  });
});

describe("shapes the thread read and the renderer must not misread", () => {
  it("a_comment_with_no_author_or_body_reads_as_an_anonymous_empty_reply", async () => {
    // GitHub answers a deleted user's comment with `user: null`. Reading that
    // as a bot — or crashing — would either adopt or lose the reply.
    const stub = stubOf([{ id: 4, body: "", user: null }]);
    const pub = publication([{ finding: finding(), status: "created", disposition: null }]);
    expect(await postOrReplace(stub.api, AT, pub)).toBe("posted");
    expect(stub.comments).toHaveLength(2);
  });

  it("a_payload_carrying_only_a_fingerprint_recognises_a_rerun_that_changed_nothing", () => {
    // The marker's payload is `<fingerprint> <envelope>`; a payload written
    // before the envelope existed has no space in it, and the whole string is
    // then the fingerprint.
    expect(decodeEnvelope("deadbeefdeadbeef")).toEqual({ kind: "none" });
  });

  it("an_unknown_status_renders_under_its_own_name_rather_than_vanishing", () => {
    // The renderer groups by the documented ladder. A status outside it must
    // not silently drop the finding out of the comment.
    const text = render([
      { finding: finding(), status: "created", disposition: null },
      { finding: finding({ path: "b.ts" }), status: "quarantined", disposition: null },
    ]);
    expect(text).toContain("### New findings (1)");
    expect(text).not.toContain("b.ts");
  });
});
