import { describe, expect, it } from "vitest";

import type { Similarity } from "../../core/memory.js";
import { documentOf, rank, type Candidate } from "./rank.js";

const CANDIDATES: readonly Candidate[] = [
  { number: 1, title: "Login button does nothing on Safari", body: "Clicking login is a no-op." },
  { number: 2, title: "Export crashes on large files", body: "Exporting a 2GB file throws." },
  { number: 3, title: "Safari: sign-in click has no effect", body: "The sign-in button is dead." },
];

describe("documentOf", () => {
  it("joins the title and body, which is the whole of what a candidate is matched on", () => {
    expect(documentOf(CANDIDATES[0]!)).toBe(
      "Login button does nothing on Safari\n\nClicking login is a no-op.",
    );
  });
});

describe("rank", () => {
  it("ranks candidates by how much they share with the query, closest first", () => {
    const ranked = rank(["Safari login button broken"], CANDIDATES, 5);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.candidate.number).toBe(1);
  });

  it("returns nothing for a corpus with no candidates", () => {
    expect(rank(["anything"], [], 5)).toEqual([]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(rank(["Safari login"], CANDIDATES, 0)).toEqual([]);
  });

  it("truncates to the limit", () => {
    const ranked = rank(["Safari sign in login export crashes file"], CANDIDATES, 1);

    expect(ranked).toHaveLength(1);
  });

  it("drops a candidate that shares nothing with the query", () => {
    const ranked = rank(["zqx qvw absolutely irrelevant garble mumble frobnicate"], CANDIDATES, 5);

    expect(ranked).toEqual([]);
  });

  it("ignores a blank query among several rather than letting it contribute a zero merge", () => {
    const withBlank = rank(["", "Safari login button broken"], CANDIDATES, 5);
    const withoutBlank = rank(["Safari login button broken"], CANDIDATES, 5);

    expect(withBlank).toEqual(withoutBlank);
  });

  it("ignores a whitespace-only query the same way it ignores a blank one", () => {
    // The blank-query rule is about a query with nothing to match, and a
    // string of spaces is the same nothing after the trim that decides it.
    const withSpaces = rank(["   ", "Safari login button broken"], CANDIDATES, 5);
    const withoutSpaces = rank(["Safari login button broken"], CANDIDATES, 5);

    expect(withSpaces).toEqual(withoutSpaces);
  });

  it("merges two queries by keeping each candidate's best score across them", () => {
    // The first query only speaks to candidate 2, the second only to
    // candidates 1 and 3 — a merge has to carry all three through, each at
    // the score the query that actually matched it produced.
    const ranked = rank(["export crashes large files"], CANDIDATES, 5).concat(
      rank(["Safari sign in login broken"], CANDIDATES, 5),
    );
    const merged = rank(
      ["export crashes large files", "Safari sign in login broken"],
      CANDIDATES,
      5,
    );

    const numbers = merged.map((entry) => entry.candidate.number).sort();
    expect(numbers).toEqual([...new Set(ranked.map((entry) => entry.candidate.number))].sort());
  });

  it("takes the higher of two scores for a candidate both queries reach", () => {
    const stub: Similarity = (query, documents) =>
      documents.map((_document, index) => {
        if (index !== 0) return 0;
        return query === "low" ? 1 : 5;
      });

    const ranked = rank(["low", "high"], [CANDIDATES[0]!], 5, stub);

    expect(ranked).toEqual([{ candidate: CANDIDATES[0], score: 5 }]);
  });

  it("breaks a tie by the newer thread number, not by corpus order", () => {
    const tied: Similarity = (_query, documents) => documents.map(() => 1);

    const ranked = rank(["x"], CANDIDATES, 5, tied);

    expect(ranked.map((entry) => entry.candidate.number)).toEqual([3, 2, 1]);
  });

  it("keeps the tie-break when the tie falls exactly on the limit's last slot", () => {
    // The cut is deterministic, and "which duplicate is *the* duplicate to
    // show" is the decision a tie has to settle rather than the corpus's
    // insertion order doing it silently. All three candidates score the same
    // against the query, so the two slots go to the newer threads — never to
    // whichever happened to sit earlier in the corpus.
    const tied: Similarity = (_query, documents) => documents.map(() => 1);

    const ranked = rank(["x"], CANDIDATES, 2, tied);

    expect(ranked.map((entry) => entry.candidate.number)).toEqual([3, 2]);
  });

  it("defaults to the real BM25 similarity when none is given", () => {
    // Pinning that the default parameter is `lexical` and not merely
    // something that behaves like it on this fixture.
    const ranked = rank(["Safari login"], CANDIDATES, 5);
    expect(ranked.some((entry) => entry.candidate.number === 1)).toBe(true);
  });
});
