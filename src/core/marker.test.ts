import { describe, expect, it } from "vitest";

import { authorHalf, fingerprint, markerFor } from "./marker.js";

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

describe("authorHalf", () => {
  it("drops trailing whitespace, so a body with a newline and one without agree", () => {
    expect(authorHalf(`${OFFICIAL}\n\n  `)).toBe(OFFICIAL);
  });

  it("keeps every byte a reader or a parser sees", () => {
    const body = "Fixes #42\n\n- [x] reproduced\n\nCo-authored-by: Ai <ai@example.com>";
    expect(authorHalf(body)).toBe(body);
  });
});
