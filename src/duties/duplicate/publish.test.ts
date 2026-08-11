import { describe, expect, it } from "vitest";

import type { Author } from "../../core/forge.js";
import {
  findMarked,
  marker,
  postOrReplace,
  proposalFingerprint,
  rehearse,
  type CommentApi,
  type Proposal,
} from "./publish.js";

const AT = { owner: "acme", repo: "widgets", number: 42 };

/** A comment authored by Reeve's own bot — the only kind `findMarked` will ever match. */
const BOT: Author = { type: "Bot" };
/** A comment authored by a person — never a candidate for replacement, whatever its body says. */
const HUMAN: Author = { type: "User", login: "alice" };

interface StoredComment {
  id: number;
  body: string;
  user?: Author;
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
        listComments: (params) => {
          // A real page has a ceiling — `per_page` — so a stub seeded with
          // more comments than that has to actually stop there too, the same
          // way GitHub's own listing would, for the pagination tests below.
          const perPage = params.per_page ?? comments.length;
          return Promise.resolve({
            data: comments
              .slice(0, perPage)
              .map(({ id, body, user }) => ({ id, body, user: user ?? null })),
          });
        },
        createComment: (params) => {
          // Whatever this stub posts is Reeve's own — the same as a real
          // token authenticated as the workflow's bot identity.
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
    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("finds nothing among comments that carry no marker", async () => {
    const { api } = stubOf([{ id: 1, body: "just a comment" }]);
    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("finds this duty's own marked comment and reads its fingerprint", async () => {
    const { api } = stubOf([
      { id: 1, body: "unrelated", user: HUMAN },
      {
        id: 2,
        body: `${marker.render("abc123 duplicate-of=7")}\n\nPossible duplicate of #7.`,
        user: BOT,
      },
    ]);

    expect(await findMarked(api, AT)).toEqual({
      marked: { id: 2, fingerprint: "abc123 duplicate-of=7" },
      uncertain: false,
    });
  });

  it("ignores another duty's marker", async () => {
    const { api } = stubOf([
      { id: 1, body: "<!-- reeve:translate source=abc123 -->\n\ntext", user: BOT },
    ]);

    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("ignores a comment carrying the marker when its author is not a bot", async () => {
    // A human forging the tag outright, or simply typing it, is never a
    // rerun target — only Reeve's own bot identity ever authored the
    // original.
    const { api } = stubOf([
      {
        id: 1,
        body: `${marker.render("abc123 duplicate-of=7")}\n\nPossible duplicate of #7.`,
        user: HUMAN,
      },
    ]);

    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it('recognises a `[bot]`-suffixed login the same as `type: "Bot"`', async () => {
    const { api } = stubOf([
      {
        id: 1,
        body: `${marker.render("abc123 duplicate-of=7")}\n\nPossible duplicate of #7.`,
        user: { login: "reeve-app[bot]" },
      },
    ]);

    expect(await findMarked(api, AT)).toEqual({
      marked: { id: 1, fingerprint: "abc123 duplicate-of=7" },
      uncertain: false,
    });
  });

  it("ignores a bot comment where the marker is quoted mid-body rather than opening it", async () => {
    // A bot could in principle quote another comment's text — the marker has
    // to sit at position 0, the exact shape `postOrReplace` itself always
    // writes, not merely appear somewhere in the body.
    const { api } = stubOf([
      {
        id: 1,
        body: `Quoting the earlier note:\n\n${marker.render("abc123 duplicate-of=7")}`,
        user: BOT,
      },
    ]);

    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("reports `uncertain` when a full page carries no marker — there may be one past it", async () => {
    // Exactly `COMMENT_PAGE` (100) comments, none of them this duty's own —
    // GitHub's own signal that a search stopping here cannot tell "no
    // comment" from "a comment on a page this search never reached".
    const filler: StoredComment[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${String(index + 1)}`,
      user: HUMAN,
    }));
    const { api } = stubOf(filler);

    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: true });
  });

  it("is certain, not `uncertain`, when a short page carries no marker", async () => {
    const { api } = stubOf([{ id: 1, body: "just a comment", user: HUMAN }]);

    expect(await findMarked(api, AT)).toEqual({ marked: null, uncertain: false });
  });

  it("is certain even on a full page, once the marker is actually found on it", async () => {
    const filler: StoredComment[] = Array.from({ length: 99 }, (_, index) => ({
      id: index + 1,
      body: `comment ${String(index + 1)}`,
      user: HUMAN,
    }));
    const marked: StoredComment = {
      id: 100,
      body: `${marker.render("abc123 duplicate-of=7")}\n\nPossible duplicate of #7.`,
      user: BOT,
    };
    const { api } = stubOf([...filler, marked]);

    expect(await findMarked(api, AT)).toEqual({
      marked: { id: 100, fingerprint: "abc123 duplicate-of=7" },
      uncertain: false,
    });
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

  it("leaves a stranger's comment quoting the marker untouched and posts a fresh one instead", async () => {
    // A human quoting Reeve's own comment back — to disagree with it, to
    // report it, anything — carries the exact marker text without being
    // this duty's own write. Overwriting it would destroy that person's
    // comment on the next run.
    const stray = `Someone else wrote:\n\n> ${marker.render("stale duplicate-of=3")}\n\nI disagree.`;
    const { api, comments } = stubOf([{ id: 1, body: stray, user: HUMAN }]);

    const result = await postOrReplace(api, AT, proposal(), "fp1");

    expect(result).toBe("posted");
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toBe(stray);
    expect(comments[1]?.body).toContain(marker.render("fp1 duplicate-of=7"));
  });

  it("replaces a bot-authored comment whose marker opens the body, in place", async () => {
    const { api, comments } = stubOf([
      {
        id: 5,
        body: `${marker.render("stale duplicate-of=3")}\n\nPossible duplicate of #3.`,
        user: BOT,
      },
    ]);

    const result = await postOrReplace(api, AT, proposal({ duplicateOf: 7 }), "fp1");

    expect(result).toBe("replaced");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(5);
    expect(comments[0]?.body).toContain("Possible duplicate of #7.");
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

  it("fences a bare issue reference in the rationale that is not the target, so GitHub does not autolink it", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(
      api,
      AT,
      proposal({ duplicateOf: 7, rationale: "Similar to what #55 turned out to be." }),
      "fp1",
    );

    expect(comments[0]?.body).toContain("`#55`");
    expect(comments[0]?.body).not.toMatch(/[^`]#55[^`]/);
  });

  it("leaves the target's own number live in the rationale, not fenced", async () => {
    const { api, comments } = stubOf([]);

    await postOrReplace(
      api,
      AT,
      proposal({ duplicateOf: 7, rationale: "Both describe the same failure as #7." }),
      "fp1",
    );

    expect(comments[0]?.body).toContain("Both describe the same failure as #7.");
    expect(comments[0]?.body).not.toContain("`#7`");
  });

  it("withholds the comment on a full page carrying no marker, rather than risk a duplicate", async () => {
    // B1's fail-closed answer to a thread this duty cannot fully search: a
    // hundred comments, none this duty's own within reach, so whether it
    // already commented is genuinely unknown. Posting on that unknown would
    // risk exactly the stacked-comment failure the marker exists to prevent.
    const filler: StoredComment[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${String(index + 1)}`,
      user: HUMAN,
    }));
    const { api, comments } = stubOf(filler);

    const result = await postOrReplace(api, AT, proposal(), "fp1");

    expect(result).toBe("withheld");
    expect(comments).toHaveLength(100);
  });
});

describe("rehearse", () => {
  it("reads the same disposition `postOrReplace` would reach, without writing anything", async () => {
    const { api, comments } = stubOf([]);

    const result = await rehearse(api, AT, proposal(), "fp1");

    expect(result).toBe("posted");
    expect(comments).toHaveLength(0);
  });

  it("reads `replaced` for a fingerprint that moved past this duty's own comment, without writing", async () => {
    const { api, comments } = stubOf([
      {
        id: 5,
        body: `${marker.render("stale duplicate-of=3")}\n\nPossible duplicate of #3.`,
        user: BOT,
      },
    ]);

    const result = await rehearse(api, AT, proposal({ duplicateOf: 7 }), "fp1");

    expect(result).toBe("replaced");
    expect(comments[0]?.body).toContain("Possible duplicate of #3."); // unchanged
  });

  it("reads `unchanged` when the fingerprint already matches, without writing", async () => {
    const payload = "fp1 duplicate-of=7";
    const { api, comments } = stubOf([
      { id: 5, body: `${marker.render(payload)}\n\nPossible duplicate of #7.`, user: BOT },
    ]);

    const result = await rehearse(api, AT, proposal({ duplicateOf: 7 }), "fp1");

    expect(result).toBe("unchanged");
    expect(comments).toHaveLength(1);
  });

  it("never mistakes a stranger's comment quoting the marker for this duty's own", async () => {
    const stray = `Someone else wrote:\n\n> ${marker.render("stale duplicate-of=3")}\n\nI disagree.`;
    const { api } = stubOf([{ id: 1, body: stray, user: HUMAN }]);

    expect(await rehearse(api, AT, proposal(), "fp1")).toBe("posted");
  });

  it("reads `withheld` on a full page carrying no marker, the same fail-closed answer a real run reaches", async () => {
    const filler: StoredComment[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${String(index + 1)}`,
      user: HUMAN,
    }));
    const { api, comments } = stubOf(filler);

    const result = await rehearse(api, AT, proposal(), "fp1");

    expect(result).toBe("withheld");
    expect(comments).toHaveLength(100);
  });
});
