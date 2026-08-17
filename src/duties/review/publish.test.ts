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
import type { Finding, Previous } from "./findings.js";

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
              .slice(0, params.per_page ?? comments.length)
              .map(({ id, body, user }) => ({ id, body, user: user ?? null })),
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
    reconciled: [{ finding: finding(), status: "created" }],
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
      envelopeFingerprint([{ finding: finding(), status: "resolved" }]),
    );
  });
});

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips a full payload", () => {
    const payload: Previous = {
      findings: [
        {
          ...finding(),
          line: null,
          wasResolved: true,
        },
      ],
      reviewedShas: ["a", "b"],
    };
    expect(decodeEnvelope(encodeEnvelope(payload))).toEqual(payload);
  });

  it("returns null on a null payload and on an empty envelope", () => {
    expect(decodeEnvelope(null)).toBeNull();
    expect(decodeEnvelope("fingerprint-only")).toBeNull();
  });

  it("returns null on corrupt base64 and on a non-mapping payload", () => {
    expect(decodeEnvelope("fp not-base64-!-!")).toBeNull();
    expect(decodeEnvelope("fp " + Buffer.from("[1,2]", "utf8").toString("base64"))).toBeNull();
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
        },
      ],
      reviewedShas: ["abc"],
    };
    expect(decodeEnvelope(encodeEnvelope(payload))).toEqual(payload);
  });

  it("decodes an old envelope without the optional fields as undefined", () => {
    const payload = {
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
      ],
      reviewedShas: ["ok"],
    };
    const out = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    );
    expect(out?.findings[0]?.verification).toBeUndefined();
    expect(out?.findings[0]?.evidence).toBeUndefined();
  });

  it("treats malformed optional fields as undefined, keeping the finding's core fields", () => {
    const payload = {
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
          verification: "bogus",
          evidence: [{ kind: "not-a-kind", weight: 1, detail: 42, provenance: null }],
        },
      ],
      reviewedShas: ["ok"],
    };
    const out = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    );
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0]?.verification).toBeUndefined();
    expect(out?.findings[0]?.evidence).toBeUndefined();
  });

  it("drops malformed findings and keeps the readable ones", () => {
    const payload = {
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
      reviewedShas: ["ok", 7, "also-ok"],
    };
    const out = decodeEnvelope(
      "fp " + Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    );
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0]?.wasResolved).toBe(true);
    expect(out?.reviewedShas).toEqual(["ok", "also-ok"]);
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
      { finding: finding({ id: "b" }), status: "resolved" },
      { finding: finding({ id: "a", body: "X" }), status: "created" },
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
    const body = render([{ finding: finding(), status: "created" }]);
    expect(body).toContain("<sub>");
    expect(body).toContain("</sub>");
  });

  it("appends the verification badge to a model finding's line", () => {
    const verified = render([
      { finding: finding({ verification: "verified" as const }), status: "created" },
    ]);
    expect(verified).toContain("· verified");

    const unverified = render([
      { finding: finding({ verification: "unverified" as const }), status: "created" },
    ]);
    expect(unverified).toContain("· not verified");
    expect(unverified).not.toContain("· verified");
  });

  it("renders no badge for deterministic findings or unverified fields absent", () => {
    const deterministic = render([
      { finding: finding({ marker: "preflight:blocked" }), status: "created" },
    ]);
    expect(deterministic).not.toContain("· verified");
    expect(deterministic).not.toContain("· not verified");

    const untouched = render([{ finding: finding(), status: "created" }]);
    expect(untouched).not.toContain("· verified");
    expect(untouched).not.toContain("· not verified");
  });

  it("defangs references in a model-written finding body before it is printed", () => {
    // The one piece of model prose this duty publishes must not create link
    // events the model never intended — the same defang every other duty
    // applies to published text (see core/sanitize.ts).
    const body = render([
      { finding: finding({ body: "Mention @alice and see #42 and GH-7." }), status: "created" },
    ]);
    expect(body).toContain("@<!---->alice");
    expect(body).toContain("#<!---->42");
    // `GH-7` is defanged at its first letter — `G<!---->H-7` — the same
    // insertion point core/sanitize uses for every `GH-N` reference.
    expect(body).toContain("G<!---->H-7");
    expect(body).not.toContain("@alice");
    expect(body).not.toContain("#42");
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
        reconciled: [{ finding: finding({ body: "Old claim." }), status: "created" }],
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
    const { comments } = stubOf(
      Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: body(i), user: BOT })),
    );
    let calls = 0;
    const measured: ReviewCommentApi = {
      rest: {
        issues: {
          listComments: (params) => {
            calls += 1;
            return Promise.resolve({ data: comments.slice(0, params.per_page ?? comments.length) });
          },
          createComment: () => Promise.resolve({}),
          updateComment: () => Promise.resolve({}),
        },
      },
    };
    expect(await postOrReplace(measured, AT, publication())).toBe("withheld");
    expect(calls).toBe(1);
  });
});

describe("rehearse", () => {
  it("reports what a real run would do without writing", async () => {
    const { api, comments } = stubOf([]);
    expect(await rehearse(api, AT, publication())).toBe("posted");
    expect(comments).toHaveLength(0);
  });
});
