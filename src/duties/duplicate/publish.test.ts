import { describe, expect, it } from "vitest";

import {
  findMarked,
  marker,
  postOrReplace,
  proposalFingerprint,
  type CommentApi,
  type Proposal,
} from "./publish.js";

const AT = { owner: "acme", repo: "widgets", number: 42 };

interface StoredComment {
  id: number;
  body: string;
}

function stubOf(initial: readonly StoredComment[] = []): {
  api: CommentApi;
  comments: StoredComment[];
} {
  const comments = initial.map((entry) => ({ ...entry }));
  let nextId = Math.max(0, ...comments.map((c) => c.id)) + 1;

  const api: CommentApi = {
    rest: {
      issues: {
        listComments: () =>
          Promise.resolve({ data: comments.map(({ id, body }) => ({ id, body })) }),
        createComment: (params) => {
          comments.push({ id: nextId, body: params.body });
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

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    duplicateOf: 7,
    confidence: 0.9,
    lexicalScore: 4.2,
    rationale: "Both describe the same login failure on Safari.",
    model: "Quick",
    attribution: "none",
    ...overrides,
  };
}

describe("proposalFingerprint", () => {
  it("is the same for the same source text and candidate list", () => {
    expect(proposalFingerprint("x", [1, 2])).toBe(proposalFingerprint("x", [1, 2]));
  });

  it("differs when the source text differs", () => {
    expect(proposalFingerprint("x", [1, 2])).not.toBe(proposalFingerprint("y", [1, 2]));
  });

  it("differs when the candidate shortlist differs — a grown corpus re-asks", () => {
    expect(proposalFingerprint("x", [1, 2])).not.toBe(proposalFingerprint("x", [1, 2, 3]));
  });

  it("is order-insensitive on the candidate list — `fingerprint`'s own keys are sorted", () => {
    // The same set reached by a different ranking order is still the same
    // shortlist as far as "did the candidates this run saw change" is
    // concerned, which is the question this fingerprint answers.
    expect(proposalFingerprint("x", [1, 2])).toBe(proposalFingerprint("x", [2, 1]));
  });
});

describe("findMarked", () => {
  it("finds nothing on a thread with no comments", async () => {
    const { api } = stubOf([]);
    expect(await findMarked(api, AT)).toBeNull();
  });

  it("finds nothing among comments that carry no marker", async () => {
    const { api } = stubOf([{ id: 1, body: "just a comment" }]);
    expect(await findMarked(api, AT)).toBeNull();
  });

  it("finds this duty's own marked comment and reads its fingerprint", async () => {
    const { api } = stubOf([
      { id: 1, body: "unrelated" },
      { id: 2, body: `${marker.render("abc123 duplicate-of=7")}\n\nPossible duplicate of #7.` },
    ]);

    expect(await findMarked(api, AT)).toEqual({ id: 2, fingerprint: "abc123 duplicate-of=7" });
  });

  it("ignores another duty's marker", async () => {
    const { api } = stubOf([{ id: 1, body: "<!-- reeve:translate source=abc123 -->\n\ntext" }]);

    expect(await findMarked(api, AT)).toBeNull();
  });
});

describe("postOrReplace", () => {
  it("posts a fresh comment when none exists yet", async () => {
    const { api, comments } = stubOf([]);

    const result = await postOrReplace(api, AT, proposal(), "fp1");

    expect(result).toBe("posted");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(marker.render("fp1 duplicate-of=7"));
    expect(comments[0]?.body).toContain("Possible duplicate of #7.");
  });

  it("carries the duplicate target machine-readably in the marker itself, not only in the prose", async () => {
    // Future attribution ("Reeve closed this as a duplicate of #N") reads this
    // straight off the tag rather than parsing the rationale sentence, which
    // is translated, reworded, or absent depending on `show-attribution` and
    // the thread's own language.
    const { api, comments } = stubOf([]);

    await postOrReplace(api, AT, proposal({ duplicateOf: 42 }), "fp1");

    expect(comments[0]?.body).toMatch(/<!-- reeve:duplicate source=fp1 duplicate-of=42 -->/);
  });

  it("leaves an unchanged proposal alone rather than re-posting it", async () => {
    const { api, comments } = stubOf([]);
    await postOrReplace(api, AT, proposal(), "fp1");
    const before = comments[0]?.body;

    const result = await postOrReplace(api, AT, proposal(), "fp1");

    expect(result).toBe("unchanged");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(before);
  });

  it("replaces its own comment in place when the fingerprint moved", async () => {
    const { api, comments } = stubOf([]);
    await postOrReplace(api, AT, proposal({ duplicateOf: 7 }), "fp1");
    const firstId = comments[0]?.id;

    const result = await postOrReplace(api, AT, proposal({ duplicateOf: 9 }), "fp2");

    expect(result).toBe("replaced");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(firstId);
    expect(comments[0]?.body).toContain("Possible duplicate of #9.");
  });

  it("never touches a comment without this duty's own marker", async () => {
    const { api, comments } = stubOf([{ id: 1, body: "a maintainer's own comment" }]);

    await postOrReplace(api, AT, proposal(), "fp1");

    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe("a maintainer's own comment");
  });

  it("always includes the machine-attribution floor, even at attribution none", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(api, AT, proposal({ attribution: "none" }), "fp1");

    expect(comments[0]?.body).toContain("Proposed by a model, not decided by a maintainer");
    expect(comments[0]?.body).not.toContain("Quick");
  });

  it("names the model at attribution model", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(api, AT, proposal({ attribution: "model" }), "fp1");

    expect(comments[0]?.body).toContain("Suggested by `Quick`.");
    expect(comments[0]?.body).not.toContain("Confidence");
  });

  it("adds confidence and lexical score at attribution detail", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(
      api,
      AT,
      proposal({ attribution: "detail", confidence: 0.85, lexicalScore: 3.14159 }),
      "fp1",
    );

    expect(comments[0]?.body).toContain("Suggested by `Quick`.");
    expect(comments[0]?.body).toContain("Confidence 0.85 of 1.00, lexical match 3.14.");
  });

  it("omits the rationale line entirely when there is none", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(api, AT, proposal({ rationale: "" }), "fp1");

    expect(comments[0]?.body).not.toMatch(/\n\n\n/);
  });

  it("escapes a model name that carries HTML-significant characters", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(api, AT, proposal({ attribution: "model", model: "A & <B>" }), "fp1");

    expect(comments[0]?.body).toContain("A &amp; &lt;B&gt;");
  });
});
