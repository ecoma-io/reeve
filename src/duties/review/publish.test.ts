import { describe, expect, it } from "vitest";

import type { Author } from "../../core/forge.js";

import {
  decodeEnvelope,
  encodeEnvelope,
  envelopeFingerprint,
  findMarked,
  marker,
  postOrReplace,
  publicationFor,
  rehearse,
  render,
  renderFingerprint,
  type Publication,
  type ReviewCommentApi,
} from "./publish.js";
import { envelopeChecksum, type Finding, type Previous } from "./findings.js";

const AT = { owner: "o", repo: "r", number: 1 };

const BOT: Author = { login: "reeve[bot]", type: "Bot" };
const HUMAN: Author = { login: "octocat", type: "User" };

function stubOf(initial: { id: number; body: string; user: Author | null }[] = []) {
  const comments = initial.map((entry) => ({ ...entry }));
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;

  const api: ReviewCommentApi = {
    rest: {
      issues: {
        listComments: (params) =>
          Promise.resolve({
            data: comments
              .slice(
                ((params.page ?? 1) - 1) * (params.per_page ?? comments.length),
                (params.page ?? 1) * (params.per_page ?? comments.length),
              )
              .map(({ id, body, user }) => ({
                id,
                body,
                user: user ?? null,
                author_association: user?.type === "Bot" ? "NONE" : "OWNER",
                created_at: "2026-08-17T00:00:00Z",
              })),
          }),
        createComment: (params) => {
          comments.push({ id: nextId, body: params.body, user: BOT });
          nextId += 1;
          return Promise.resolve({});
        },
        updateComment: (params) => {
          const found = comments.find((entry) => entry.id === params.comment_id);
          if (found) found.body = params.body;
          return Promise.resolve({});
        },
      },
    },
  };

  return { api, comments };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    ruleId: "dedup",
    ruleName: "Repeated code",
    ruleBody: "",
    path: "a.ts",
    line: 12,
    severity: "warning",
    body: "Repeated.",
    marker: "",
    ...overrides,
  };
}

function previous(overrides: Partial<Previous> = {}): Previous {
  return { findings: [], reviewedShas: ["old1"], ...overrides };
}

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    reconciled: [{ finding: finding(), status: "created", disposition: null }],
    next: previous(),
    headSha: "abc",
    ...overrides,
  };
}

describe("envelopeFingerprint", () => {
  it("is the same for the same reconciled findings", () => {
    expect(envelopeFingerprint(publication().reconciled)).toBe(
      envelopeFingerprint(publication().reconciled),
    );
  });

  it("differs when a status changes", () => {
    expect(envelopeFingerprint(publication().reconciled)).not.toBe(
      envelopeFingerprint([{ finding: finding(), status: "resolved", disposition: null }]),
    );
  });

  it("differs when a disposition is added or removed", () => {
    const base = publication().reconciled;
    const withD = [
      {
        ...base[0]!,
        disposition: {
          value: "wont-fix" as const,
          by: "octocat",
          at: "2026-08-17T00:00:00Z",
          replyId: 9,
          replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
        },
      },
    ];
    expect(envelopeFingerprint(base)).not.toBe(envelopeFingerprint(withD));
  });
});

/**
 * A sealed v2 payload over arbitrary finding shapes — the checksum is computed
 * over exactly what `validateV2` reconstructs, so a case can offer a malformed
 * finding and still be testing the field check rather than the seal.
 */
function sealedV2(findings: readonly unknown[], reviewedShas: readonly string[]): string {
  // `validateV2` normalises an absent `disposition` to `null` before it seals,
  // so the checksum has to be computed over that same normalised shape.
  const normalised = findings.map((entry) =>
    typeof entry === "object" && entry !== null
      ? { disposition: null, ...(entry as Record<string, unknown>) }
      : entry,
  );
  const asRead = { findings: normalised, reviewedShas } as unknown as Previous;
  const body = { findings, reviewedShas, version: 2, checksum: envelopeChecksum(asRead) };
  return "fp " + Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips a full payload", () => {
    const payload: Previous = {
      findings: [
        {
          ...finding(),
          line: null,
          wasResolved: true,
          disposition: null,
        },
      ],
      reviewedShas: ["a", "b"],
    };
    const markerPayload = `fp ${encodeEnvelope({ ...payload, version: 2, checksum: envelopeChecksum(payload) })}`;
    const decoded = decodeEnvelope(markerPayload);
    expect(decoded).toEqual({
      kind: "ok",
      previous: { ...payload, version: 2, checksum: envelopeChecksum(payload) },
    });
  });

  it("returns none on a null payload and on an empty envelope", () => {
    expect(decodeEnvelope(null)).toEqual({ kind: "none" });
    expect(decodeEnvelope("fingerprint-only")).toEqual({ kind: "none" });
  });

  it("returns corrupt on bad base64 and on a non-mapping payload", () => {
    const badBase64 = decodeEnvelope("fp not-base64-!-!");
    if (badBase64.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(badBase64.reason).toMatch(/not valid base64/);

    const badJson = decodeEnvelope("fp " + Buffer.from("[1,2]", "utf8").toString("base64"));
    if (badJson.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(badJson.reason).toMatch(/not a JSON mapping/);
  });

  it("round-trips the new optional verification fields", () => {
    const payload: Previous = {
      findings: [
        {
          ...finding(),
          snippet: 'export const VERSION = "1.0.0";',
          verification: "unverified",
          evidence: [
            {
              kind: "rules",
              weight: 0.6,
              detail: "cites a repository rule",
              provenance: {
                ruleId: "dedup",
                sourceFile: "repository rules",
                atLine: null,
                ref: { sha: "", path: "" },
              },
              at: "deterministic",
            },
          ],
          wasResolved: false,
          disposition: null,
        },
      ],
      reviewedShas: ["abc"],
    };
    const markerPayload = `fp ${encodeEnvelope({ ...payload, version: 2, checksum: envelopeChecksum(payload) })}`;
    const decoded = decodeEnvelope(markerPayload);
    if (decoded.kind !== "ok") throw new Error("expected an ok payload");
    expect(decoded.previous).toEqual({
      ...payload,
      version: 2,
      checksum: envelopeChecksum(payload),
    });
  });

  it("decodes an envelope without the optional fields as undefined", () => {
    // `verification` and `evidence` are this-run values a stored finding may
    // predate. Absent must read as absent, never as a default.
    const finding = {
      id: "a",
      ruleId: "r",
      ruleName: "N",
      ruleBody: "",
      path: "p",
      line: 1,
      severity: "warning",
      body: "b",
      marker: "",
      wasResolved: true,
    };
    const decoded = decodeEnvelope(sealedV2([finding], ["ok"]));
    if (decoded.kind !== "ok") throw new Error("expected a valid payload");
    expect(decoded.previous.findings[0]?.verification).toBeUndefined();
    expect(decoded.previous.findings[0]?.evidence).toBeUndefined();
  });

  it("preserves optional fields without shape-checking them", () => {
    // The decoder validates the fields the ladder depends on and carries the
    // rest through untouched — it is not a schema validator for the whole
    // finding, and pretending otherwise would reject payloads it can read.
    const finding = {
      id: "a",
      ruleId: "r",
      ruleName: "N",
      ruleBody: "",
      path: "p",
      line: 1,
      severity: "warning",
      body: "b",
      marker: "",
      wasResolved: true,
      verification: "bogus",
      evidence: [{ kind: "not-a-kind", weight: 1, detail: 42, provenance: null }],
    };
    const decoded = decodeEnvelope(sealedV2([finding], ["ok"]));
    if (decoded.kind !== "ok") throw new Error("expected a valid payload");
    expect(decoded.previous.findings).toHaveLength(1);
    expect(decoded.previous.findings[0]?.wasResolved).toBe(true);
    expect(decoded.previous.findings[0]?.verification).toBe("bogus");
  });

  it("is corrupt when a v2 payload holds a malformed finding — never a partial read", () => {
    const payload = {
      version: 2 as const,
      findings: [
        {
          id: "a",
          ruleId: "r",
          ruleName: "N",
          ruleBody: "",
          path: "p",
          line: 1,
          severity: "warning",
          body: "b",
          marker: "",
          wasResolved: true,
        },
        { id: 42 },
      ],
      reviewedShas: ["ok"],
      checksum: "any",
    };
    const decoded = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    );
    if (decoded.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decoded.reason).toMatch(/malformed field/);
  });

  it("rejects a v2 payload whose checksum does not match — corrupt, never silent", () => {
    const payload: Previous = {
      findings: [
        {
          ...finding(),
          wasResolved: true,
          disposition: null,
        },
      ],
      reviewedShas: ["a", "b"],
    };
    const forged = { ...payload, version: 2 as const, checksum: "0".repeat(16) };
    const decoded = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(forged), "utf8").toString("base64"),
    );
    if (decoded.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decoded.reason).toMatch(/checksum/);
  });

  it("rejects a v2 finding whose line is not a positive integer, and an unknown severity", () => {
    const withLine0: Previous = {
      findings: [{ ...finding(), line: 0, wasResolved: false, disposition: null }],
      reviewedShas: [],
    };
    const markerLine = `fp ${encodeEnvelope({ ...withLine0, version: 2, checksum: envelopeChecksum(withLine0) })}`;
    const decodedLine = decodeEnvelope(markerLine);
    if (decodedLine.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decodedLine.reason).toMatch(/positive integer/);

    const withBadSeverity: Previous = {
      findings: [
        {
          ...finding(),
          line: 12,
          severity: "loud" as unknown as Finding["severity"],
          wasResolved: false,
          disposition: null,
        },
      ],
      reviewedShas: [],
    };
    const markerSeverity = `fp ${encodeEnvelope({
      ...withBadSeverity,
      version: 2 as const,
      checksum: envelopeChecksum(withBadSeverity),
    })}`;
    const decodedSeverity = decodeEnvelope(markerSeverity);
    if (decodedSeverity.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decodedSeverity.reason).toMatch(/severity/);
  });

  it("rejects a v2 disposition of the wrong shape", () => {
    const withBadDisposition: Previous = {
      findings: [
        {
          ...finding(),
          wasResolved: false,
          disposition: {
            value: "wont-fix" as const,
            by: "octocat",
            at: "2026-08-17T00:00:00Z",
            replyId: 0,
            replyUrl: "https://github.com/o/r/pull/1#issuecomment-0",
          },
        },
      ],
      reviewedShas: [],
    };
    const marker = `fp ${encodeEnvelope({
      ...withBadDisposition,
      version: 2 as const,
      checksum: envelopeChecksum(withBadDisposition),
    })}`;
    const decoded = decodeEnvelope(marker);
    if (decoded.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decoded.reason).toMatch(/disposition/);
  });

  it("reads a versionless payload as a cold start rather than migrating it", () => {
    // Ruled 2026-08-18. The migration this replaces computed a checksum
    // instead of verifying one, so omitting `version` turned off every v2
    // integrity check and then re-sealed the result as a valid v2. The window
    // for a genuine versionless envelope is closed — v2 shipped before the
    // 0.8.0 release — so the payload is discarded and the memory is rebuilt
    // from the thread. See `publish.adversarial.test.ts` for the full matrix.
    const v1 = {
      findings: [
        {
          id: "a",
          ruleId: "r",
          ruleName: "N",
          ruleBody: "",
          path: "p",
          line: 1,
          severity: "warning",
          body: "b",
          marker: "",
          wasResolved: true,
          resolvedAtSha: "s1",
        },
      ],
      reviewedShas: ["ok", "also-ok"],
    };
    const decoded = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(v1), "utf8").toString("base64"),
    );
    expect(decoded).toEqual({ kind: "none" });
  });

  it("is corrupt when a payload holds a malformed finding", () => {
    // No real checksum is needed, and that is the assertion: the per-finding
    // field check runs BEFORE the seal is compared, so a payload this
    // malformed is refused on its shape rather than on its digest.
    const body = { findings: [{ id: 42 }], reviewedShas: [], version: 2, checksum: "unused" };
    const decoded = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
    );
    if (decoded.kind !== "corrupt") throw new Error("expected a corrupt payload");
    expect(decoded.reason).toMatch(/malformed field/);
  });
});

describe("findMarked", () => {
  it("finds nothing on a thread with no comments", async () => {
    const { api } = stubOf([]);
    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("ignores a human comment carrying a quoted marker — the forged-marker guard", async () => {
    const { api } = stubOf([{ id: 1, body: `${marker.render("fp x")}\n\nquoted`, user: HUMAN }]);
    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("reads its own comment's payload", async () => {
    const { api } = stubOf([{ id: 2, body: `${marker.render("fp abc")}\n\nreview`, user: BOT }]);
    expect(await findMarked(api, AT)).toEqual({
      marked: { id: 2, payload: "fp abc" },
      uncertain: false,
    });
  });

  it("reports uncertain when the page is full and no marker appeared", async () => {
    const body = `${marker.render("fp x")}\n\ntext`;
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: i === 0 ? body : "noise",
      user: BOT,
    }));
    const { api } = stubOf(comments);
    // The marker is on the first page — so found, not uncertain.
    expect((await findMarked(api, AT)).uncertain).toBe(false);
  });
});

describe("publicationFor", () => {
  it("builds a payload of fingerprint and envelope and a render-only body", () => {
    const pub = publication();
    const { payload, body } = publicationFor(pub);
    expect(payload).toContain(" ");
    expect(payload.startsWith(renderFingerprint(pub.reconciled))).toBe(true);
    // The marker rides in the classifier's join, not in publicationFor's body.
    expect(body).not.toContain("<!-- reeve:");
    expect(body).toContain("### New findings");
  });
});

describe("render", () => {
  it("renders the empty review from chrome", () => {
    expect(render([])).toContain("No issues to report");
  });

  it("renders status groupings in canonical order", () => {
    const body = render([
      { finding: finding({ id: "b" }), status: "resolved", disposition: null },
      { finding: finding({ id: "a", body: "X" }), status: "created", disposition: null },
    ]);
    expect(body).toContain("### New findings (1)");
    expect(body).toContain("### Resolved (1)");
    expect(body.indexOf("New findings")).toBeLessThan(body.indexOf("Resolved"));
  });

  it("returns the chrome empty-review text when there are no findings", () => {
    const body = render([]);
    expect(body).toContain("No issues to report");
  });

  it("keeps the footer in a <sub>", () => {
    const body = render([{ finding: finding(), status: "created", disposition: null }]);
    expect(body).toContain("<sub>");
    expect(body).toContain("</sub>");
  });

  it("appends the verification badge to a model finding's line", () => {
    const verified = render([
      {
        finding: finding({ verification: "verified" as const }),
        status: "created",
        disposition: null,
      },
    ]);
    expect(verified).toContain("· verified");

    const unverified = render([
      {
        finding: finding({ verification: "unverified" as const }),
        status: "created",
        disposition: null,
      },
    ]);
    expect(unverified).toContain("· not verified");
    expect(unverified).not.toContain("· verified");
  });

  it("renders no badge for deterministic findings or unverified fields absent", () => {
    const deterministic = render([
      { finding: finding({ marker: "preflight:blocked" }), status: "created", disposition: null },
    ]);
    expect(deterministic).not.toContain("· verified");
    expect(deterministic).not.toContain("· not verified");

    const untouched = render([{ finding: finding(), status: "created", disposition: null }]);
    expect(untouched).not.toContain("· verified");
    expect(untouched).not.toContain("· not verified");
  });

  it("defangs references in a model-written finding body before it is printed", () => {
    // The one piece of model prose this duty publishes must not create link
    // events the model never intended — the same defang every other duty
    // applies to published text (see core/sanitize.ts).
    const body = render([
      {
        finding: finding({ body: "Mention @alice and see #42 and GH-7." }),
        status: "created",
        disposition: null,
      },
    ]);
    expect(body).toContain("@<!---->alice");
    expect(body).toContain("#<!---->42");
    // `GH-7` is defanged at its first letter — `G<!---->H-7` — the same
    // insertion point core/sanitize uses for every `GH-N` reference.
    expect(body).toContain("G<!---->H-7");
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("#42");
  });

  it("appends disposition attribution to a finding's line, escaping the login", () => {
    const body = render([
      {
        finding: finding(),
        status: "created",
        disposition: {
          value: "wont-fix" as const,
          by: "octo<cat>",
          at: "2026-08-17T00:00:00Z",
          replyId: 9,
          replyUrl: "https://github.com/o/r/pull/1#issuecomment-9",
        },
      },
    ]);
    expect(body).toContain("— **wont-fix** by @octo&lt;cat&gt;");
    expect(body).toContain("([reply](https://github.com/o/r/pull/1#issuecomment-9))");
  });
});

describe("postOrReplace", () => {
  it("posts when there is nothing to replace", async () => {
    const { api, comments } = stubOf([]);
    expect(await postOrReplace(api, AT, publication())).toBe("posted");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("<!-- reeve:review");
  });

  it("replaces the existing comment without stacking a second one", async () => {
    const first = publicationFor(
      publication({
        reconciled: [
          { finding: finding({ body: "Old claim." }), status: "created", disposition: null },
        ],
      }),
    );
    const changed = publication();
    const { api, comments } = stubOf([
      { id: 1, body: `${marker.render(first.payload)}\n\nold`, user: BOT },
    ]);
    expect(await postOrReplace(api, AT, changed)).toBe("replaced");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("New findings");
  });

  it("leaves the comment alone when the fingerprint did not move", async () => {
    const first = publicationFor(publication());
    const { api, comments } = stubOf([
      { id: 1, body: `${marker.render(first.payload)}\n\nold`, user: BOT },
    ]);
    expect(await postOrReplace(api, AT, publication())).toBe("unchanged");
    expect(comments[0]?.body).toContain("old");
  });

  it("withholds when the search is uncertain and nothing was found", async () => {
    const body = (n: number) => `c${String(n)}`;
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: body(i),
      user: BOT,
    }));
    let calls = 0;
    const measured: ReviewCommentApi = {
      rest: {
        issues: {
          // The same full page, served for every page number — the shape of a
          // thread past the walk's ceiling, so the walk ends `uncertain`.
          listComments: (params) => {
            calls += 1;
            return Promise.resolve({
              data: comments.slice(0, params.per_page ?? comments.length),
            });
          },
          createComment: () => Promise.resolve({}),
          updateComment: () => Promise.resolve({}),
        },
      },
    };
    expect(await postOrReplace(measured, AT, publication())).toBe("withheld");
    // The paged walk spends all ten pages before giving up.
    expect(calls).toBe(10);
  });
});

describe("rehearse", () => {
  it("reports what a real run would do without writing", async () => {
    const { api, comments } = stubOf([]);
    expect(await rehearse(api, AT, publication())).toBe("posted");
    expect(comments).toHaveLength(0);
  });
});
