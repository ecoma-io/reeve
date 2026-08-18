import { describe, expect, it } from "vitest";

import {
  authorHalf,
  closeMarkerFor,
  fingerprint,
  isReeveProposalPr,
  markerFor,
  proposeEntryMarker,
  readProposeEntryMarkers,
} from "./marker.js";

// Nothing is mocked: there is nothing project-internal here. The digest comes
// from `node:crypto`, which is the platform rather than a collaborator.

const translate = markerFor("translate");
const triage = markerFor("triage");

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";

describe("markerFor", () => {
  it("names the duty in the marker it renders", () => {
    expect(translate.render("abc123")).toBe("<!-- reeve:translate source=abc123 -->");
  });

  it("keeps the duty it was built for, so a caller can say which block it owns", () => {
    expect(translate.duty).toBe("translate");
  });

  it.each([["Translate"], ["trans late"], ["3translate"], [""], ["translate/x"], ["-x"]])(
    "refuses `%s`, which is not a duty name",
    (name) => {
      // A marker built from a bad name would publish a block no run could find
      // again, so the failure belongs at construction rather than in a thread.
      expect(() => markerFor(name)).toThrow(/is not a duty name/);
    },
  );

  it("accepts a hyphenated name, which a duty is allowed to have", () => {
    expect(markerFor("close-stale").render("a")).toContain("reeve:close-stale");
  });
});

describe("split", () => {
  it("returns the whole body as the author's on a thread never published to", () => {
    expect(translate.split(OFFICIAL)).toEqual({ official: OFFICIAL, fingerprint: null });
  });

  it("returns an empty body as an empty official half rather than failing", () => {
    expect(translate.split("")).toEqual({ official: "", fingerprint: null });
  });

  it("keeps only the text before the marker as the author's", () => {
    // Reading the whole body would feed last run's output back in, and the run
    // after that would work on that.
    const body = `${OFFICIAL}\n\n${translate.render("aaaa")}\n\nThe app crashes.`;
    expect(translate.split(body).official).toBe(OFFICIAL);
  });

  it("reads back the fingerprint the marker carries", () => {
    expect(translate.split(`text\n\n${translate.render("0f0f0f0f")}\n\nmore`).fingerprint).toBe(
      "0f0f0f0f",
    );
  });

  it("gives the same author text whether or not the body ended in whitespace", () => {
    // `split` and the assembler must agree on this to a byte. If they disagree
    // the same text fingerprints differently on consecutive runs, and every
    // edit re-spends the whole budget before the identical-bytes check catches
    // it.
    expect(translate.split(`${OFFICIAL}   \n\n${translate.render("a")} `).official).toBe(
      translate.split(OFFICIAL).official,
    );
  });

  it("takes the first marker when a body somehow carries two", () => {
    // A body with two is one someone edited by hand. The author's text is above
    // both, so the first is what keeps it rather than promoting published
    // output into it.
    const body = `author\n\n${translate.render("first")}\n\nx\n\n${translate.render("second")}\n\ny`;
    expect(translate.split(body)).toEqual({ official: "author", fingerprint: "first" });
  });

  it("treats a marker with no closer as never having published", () => {
    // A truncated body. Republishing is right; leaving a half-written marker in
    // place forever is not.
    expect(translate.split("author\n\n<!-- reeve:translate source=abc")).toEqual({
      official: "author",
      fingerprint: null,
    });
  });

  it("does not mistake a mention of the marker's name for the marker", () => {
    const body = "See the reeve:translate marker in the docs.";
    expect(translate.split(body)).toEqual({ official: body, fingerprint: null });
  });
});

describe("a marker per duty", () => {
  it("does not find another duty's block", () => {
    // The property the whole namespacing exists for: two duties publish into
    // one body, and neither may read the other's block as its own.
    const body = `${OFFICIAL}\n\n${triage.render("t1")}\n\nlabels`;

    expect(translate.split(body)).toEqual({ official: body, fingerprint: null });
    expect(triage.split(body).fingerprint).toBe("t1");
  });

  it("keeps a body's author half above whichever marker comes first", () => {
    const body = `${OFFICIAL}\n\n${triage.render("t1")}\n\nlabels\n\n${translate.render("x1")}\n\ntext`;

    expect(triage.split(body).official).toBe(OFFICIAL);
    // `translate`'s own official half runs to *its* marker, which is what makes
    // a body carrying two blocks readable by each duty and correct for neither
    // to rewrite. The caller — the publish stage — is what keeps the halves
    // apart; this only proves each duty finds its own.
    expect(translate.split(body).fingerprint).toBe("x1");
  });
});

describe("fingerprint", () => {
  it("is stable for the same text and the same keys", () => {
    expect(fingerprint(OFFICIAL, ["en", "zh"])).toBe(fingerprint(OFFICIAL, ["en", "zh"]));
  });

  it("changes when the author edits the text", () => {
    // The one case that must always redo the work: the text no longer means
    // what the published block says it means.
    expect(fingerprint(OFFICIAL, ["en"])).not.toBe(fingerprint(`${OFFICIAL} Again.`, ["en"]));
  });

  it("changes when a key is added to the list", () => {
    expect(fingerprint(OFFICIAL, ["en"])).not.toBe(fingerprint(OFFICIAL, ["en", "zh"]));
  });

  it("ignores the order the keys were configured in", () => {
    // Reordering the input changes which section comes first, and that is not
    // worth re-spending a provider's budget on every thread in the repository.
    expect(fingerprint(OFFICIAL, ["en", "zh"])).toBe(fingerprint(OFFICIAL, ["zh", "en"]));
  });

  it("ignores how a key was cased", () => {
    expect(fingerprint(OFFICIAL, ["EN"])).toBe(fingerprint(OFFICIAL, ["en"]));
  });

  it("distinguishes a key list from text that happens to contain the keys", () => {
    // A digest over concatenated fields is only sound if no two different
    // inputs join to the same string.
    expect(fingerprint("a", ["en"])).not.toBe(fingerprint("a en", []));
  });

  it("is short enough to sit in a body a human reads", () => {
    expect(fingerprint(OFFICIAL, ["en"])).toHaveLength(16);
  });
});

describe("isReeveProposalPr", () => {
  const propose = markerFor("propose");

  it("is true for a pull request whose body carries the propose marker", () => {
    const body = `Reeve is proposing changes.\n\n${propose.render("abc123")}`;
    expect(isReeveProposalPr({ isPullRequest: true, body })).toBe(true);
  });

  it("is false for an issue, even one that somehow carries the marker text", () => {
    const body = `Reeve is proposing changes.\n\n${propose.render("abc123")}`;
    expect(isReeveProposalPr({ isPullRequest: false, body })).toBe(false);
  });

  it("is false for a pull request with no propose marker in its body", () => {
    expect(isReeveProposalPr({ isPullRequest: true, body: "An ordinary pull request." })).toBe(
      false,
    );
  });

  it("does not mistake another duty's marker for the propose one", () => {
    const triage = markerFor("triage");
    const body = `notes\n\n${triage.render("t1")}`;
    expect(isReeveProposalPr({ isPullRequest: true, body })).toBe(false);
  });
});

describe("closeMarkerFor", () => {
  const triageClose = closeMarkerFor("triage");

  it("renders the target it was given", () => {
    expect(triageClose.render(7)).toBe("<!-- reeve:triage:closed duplicate-of=7 -->");
  });

  it.each([["Triage"], ["tri age"], ["3triage"], [""], ["triage/x"], ["-x"]])(
    "refuses `%s`, which is not a duty name",
    (name) => {
      expect(() => closeMarkerFor(name)).toThrow(/is not a duty name/);
    },
  );

  it("finds the target inside a comment carrying other text", () => {
    const body = `Closed as a duplicate of #7.\n\n${triageClose.render(7)}`;
    expect(triageClose.find(body)).toBe(7);
  });

  it("finds nothing in a body that never carried the marker", () => {
    expect(triageClose.find("Closed as a duplicate of #7.")).toBeNull();
  });

  it("does not find another duty's marker", () => {
    const duplicateClose = closeMarkerFor("duplicate");
    expect(triageClose.find(duplicateClose.render(7))).toBeNull();
  });

  it("finds the most recent of two markers in the same body", () => {
    // `attributedClose` in `duties/triage/outcome.ts` scans a thread's replies
    // newest-first and stops at the first match, so within a single reply this
    // only ever needs to answer with one target — the first one written —
    // but a body carrying two should still parse cleanly.
    const body = `${triageClose.render(7)}\n\n${triageClose.render(9)}`;
    expect(triageClose.find(body)).toBe(7);
  });

  it.each([
    ["a leading zero", "07"],
    ["a plus sign", "+7"],
    ["a minus sign", "-7"],
    ["a decimal", "7.5"],
    ["letters", "abc"],
    ["nothing", ""],
  ])("refuses a payload with %s rather than trusting it", (_label, digits) => {
    expect(triageClose.find(`<!-- reeve:triage:closed duplicate-of=${digits} -->`)).toBeNull();
  });

  it("treats a marker with no closer as not found", () => {
    expect(triageClose.find("<!-- reeve:triage:closed duplicate-of=7")).toBeNull();
  });

  it("does not mistake a mention of the marker's name for the marker", () => {
    expect(triageClose.find("See the reeve:triage:closed marker in the docs.")).toBeNull();
  });
});

describe("authorHalf", () => {
  it("drops trailing whitespace, so a body with a newline and one without agree", () => {
    expect(authorHalf(`${OFFICIAL}\n\n  `)).toBe(OFFICIAL);
  });

  it("keeps every byte a reader or a parser sees", () => {
    const body = "Fixes #42\n\n- [x] reproduced\n\nCo-authored-by: Ai <ai@example.com>";
    expect(authorHalf(body)).toBe(body);
  });
});

describe("proposeEntryMarker / readProposeEntryMarkers", () => {
  it("renders one entry marker per action and name, in the documented grammar", () => {
    expect(proposeEntryMarker("add", "area:billing")).toBe(
      "<!-- reeve:propose:entry add:area:billing -->",
    );
    expect(proposeEntryMarker("retire", "area:billing")).toBe(
      "<!-- reeve:propose:entry retire:area:billing -->",
    );
  });

  it("reads every entry marker a body carries, add and retire alike", () => {
    const body = [
      "Some prose a maintainer wrote.",
      proposeEntryMarker("add", "area:billing"),
      proposeEntryMarker("retire", "area:legacy"),
      "More prose.",
    ].join("\n");
    expect([...readProposeEntryMarkers(body)].sort()).toEqual([
      "add:area:billing",
      "retire:area:legacy",
    ]);
  });

  it("round-trips a name carrying spaces, colons and punctuation", () => {
    // A label name may contain almost anything except a newline, which is why
    // the marker is bounded by its own closer rather than by whitespace.
    const name = "area:billing & invoicing (v2)";
    const found = readProposeEntryMarkers(proposeEntryMarker("add", name));
    expect([...found]).toEqual([`add:${name}`]);
  });

  it("reads nothing from a body with no entry markers", () => {
    expect(readProposeEntryMarkers("").size).toBe(0);
    expect(readProposeEntryMarkers("no markers here at all").size).toBe(0);
  });

  it("refuses an action outside add/retire — a forged verb names nothing", () => {
    expect(readProposeEntryMarkers("<!-- reeve:propose:entry apply:area:billing -->").size).toBe(0);
    expect(readProposeEntryMarkers("<!-- reeve:propose:entry area:billing -->").size).toBe(0);
  });

  it("refuses a marker with no closer — a truncation is not a record", () => {
    expect(readProposeEntryMarkers("<!-- reeve:propose:entry add:area:billing").size).toBe(0);
  });

  it("never lets a marker span a newline into the next line's text", () => {
    // The closer is matched without crossing a line break, so a body that
    // opens a marker and never closes it cannot swallow the rest of the PR.
    const body = "<!-- reeve:propose:entry add:area:billing\nretire:area:legacy -->";
    expect(readProposeEntryMarkers(body).size).toBe(0);
  });

  it("de-duplicates the same entry marker written twice", () => {
    const one = proposeEntryMarker("retire", "area:legacy");
    expect([...readProposeEntryMarkers(`${one}\n${one}`)]).toEqual(["retire:area:legacy"]);
  });
});
