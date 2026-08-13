import { describe, expect, it } from "vitest";

import { assemble } from "../../core/publish.js";
import {
  marker,
  publication,
  responseFingerprint,
  type Decision,
  type Responded,
} from "./publish.js";

// Nothing is mocked: this module renders strings from the values it is handed,
// and the one thing it borrows — the core's assembler — is what the posted
// comment actually goes through.

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";

function decision(over: Partial<Decision> = {}): Decision {
  return {
    confidence: 0.9,
    drafts: 3,
    decidedBy: "judges",
    votes: [
      { model: "judge-a", pick: "model-a" },
      { model: "judge-b", pick: "model-b" },
    ],
    ...over,
  };
}

function responded(over: Partial<Responded> = {}): Responded {
  return {
    language: "English",
    languageCode: "en",
    text: "Thanks for the report — could you share the version you're running?",
    model: "model-a",
    decision: null,
    fingerprint: "abc123",
    ...over,
  };
}

/** The comment a reader would see. */
function body(over: Partial<Responded> = {}, official = OFFICIAL): string {
  return assemble(official, marker, publication(responded(over)));
}

describe("marker", () => {
  it("is namespaced to this duty, so another duty's block is not read as ours", () => {
    expect(marker.render("abc123")).toBe("<!-- reeve:respond source=abc123 -->");
    expect(marker.duty).toBe("respond");
  });
});

describe("publication", () => {
  it("keeps the thread's own text first and byte-for-byte, since this posts as a new comment", () => {
    const author = "Fixes #42\n\n- [x] reproduced";
    expect(body({}, author).startsWith(author)).toBe(true);
  });

  it("carries the fingerprint in the marker, so a rerun can compare it", () => {
    expect(publication(responded({ fingerprint: "0123456789abcdef" })).fingerprint).toBe(
      "0123456789abcdef",
    );
    expect(body({ fingerprint: "0123456789abcdef" })).toContain(marker.render("0123456789abcdef"));
  });

  it("opens with an unconditional notice that this is machine-drafted, not a maintainer's words", () => {
    // Guard 6: no input can strip or disguise this.
    expect(body()).toContain("This reply was drafted by");
    expect(body()).toContain("not by a maintainer");
    expect(body()).toContain("A maintainer has not reviewed it");
  });

  it("carries the reply text", () => {
    expect(body({ text: "A specific, grounded answer." })).toContain(
      "A specific, grounded answer.",
    );
  });

  it("names the model that wrote the winning draft, always — attribution cannot be turned off", () => {
    expect(body({ model: "gpt-5" })).toContain("Drafted by `gpt-5`.");
  });

  it("says nothing about a contest that never happened", () => {
    const rendered = body({ decision: null });
    expect(rendered).not.toContain("Confidence");
    expect(rendered).not.toContain("decided by");
    expect(rendered).not.toContain("Votes:");
  });

  it("reports confidence, drafts and votes when there was a contest", () => {
    const rendered = body({ decision: decision() });

    expect(rendered).toContain("Confidence 0.90 of 1.00, best of 3 drafts, decided by judges.");
    expect(rendered).toContain("Votes: `judge-a`→`model-a`, `judge-b`→`model-b`.");
  });

  it("says a lone contested draft was decided without claiming it beat anything", () => {
    const rendered = body({ decision: decision({ drafts: 1, votes: [] }) });

    expect(rendered).toContain("Confidence 0.90 of 1.00, decided by judges.");
    expect(rendered).not.toContain("best of");
    expect(rendered).not.toContain("Votes:");
  });

  it("says which language the reply was written in, once, in the footer", () => {
    const rendered = body({ language: "Tiếng Việt" });
    expect(rendered).toContain("The thread was written in Tiếng Việt.");
    // The provenance line covers attribution — model, confidence, votes —
    // and never the language: that would repeat what the footer already says.
    expect(rendered).not.toContain("Written in Tiếng Việt.");
  });

  it("says English was used as a fallback when detection reached no answer", () => {
    const rendered = body({ language: null });
    expect(rendered).toContain("could not identify the thread's language");
    expect(rendered).not.toContain("Written in");
  });

  it("tells a reader this comment is the record of a once-only answer", () => {
    expect(body()).toContain("Reeve answers a thread once. This comment is the record of it.");
  });

  it("follows the reply's own language for the boundary note and footer", () => {
    const rendered = body({ language: "Tiếng Việt", languageCode: "vi" });
    expect(rendered).toContain("Phản hồi này do [Reeve]");
    expect(rendered).toContain("Chưa có maintainer nào xem xét phản hồi này");
    expect(rendered).toContain("Chủ đề này được viết bằng Tiếng Việt.");
    expect(rendered).toContain("Reeve chỉ trả lời mỗi chủ đề một lần.");
    expect(rendered).not.toContain("This reply was drafted by");
  });

  it("falls back to English chrome for a language code chrome has no row for", () => {
    const rendered = body({ language: "Latina", languageCode: "la" });
    expect(rendered).toContain("This reply was drafted by");
    expect(rendered).toContain("The thread was written in Latina.");
  });

  it("falls back to English chrome when languageCode is null even if language has a label", () => {
    // Detection reached no answer, so there is nothing for the reply's own
    // chrome to follow — both fields are null together, per publish.ts's doc
    // comment on Responded.languageCode, but this pins the fallback shape too.
    const rendered = body({ language: null, languageCode: null });
    expect(rendered).toContain("This reply was drafted by");
    expect(rendered).toContain("could not identify the thread's language");
  });

  it("escapes a model id, which arrives from a workflow file", () => {
    const rendered = body({ model: "a<b>c" });
    expect(rendered).toContain("a&lt;b&gt;c");
    expect(rendered).not.toContain("<b>c");
  });

  it("escapes a judge's model id in the detail line too", () => {
    const rendered = body({
      decision: decision({ votes: [{ model: "<b>j</b>", pick: "model-a" }] }),
    });

    expect(rendered).toContain("&lt;b&gt;j&lt;/b&gt;");
    expect(rendered).not.toContain("<b>j</b>");
  });

  it("renders no section at all when there is no text to post", () => {
    // The core refuses to publish an empty section list.
    expect(publication(responded({ text: "" }))).toEqual({ fingerprint: "abc123", sections: [] });
  });

  it("renders the same run to the same bytes", () => {
    expect(body()).toBe(body());
  });

  it("round-trips through the marker, so the next run reads back what it wrote", () => {
    expect(marker.split(body({ fingerprint: "cafe1234" }))).toEqual({
      official: OFFICIAL,
      fingerprint: "cafe1234",
    });
  });
});

describe("responseFingerprint", () => {
  it("is stable for the same title, body and language", () => {
    expect(responseFingerprint("Crash", "It crashes.", "en")).toBe(
      responseFingerprint("Crash", "It crashes.", "en"),
    );
  });

  it("changes when the author edits the text", () => {
    expect(responseFingerprint("Crash", "It crashes.", "en")).not.toBe(
      responseFingerprint("Crash", "It crashes on save.", "en"),
    );
  });

  it("changes when the detected language changes", () => {
    // A widened `languages` list that lets this run place a language it
    // could not place before is worth answering again, in that language.
    expect(responseFingerprint("Crash", "It crashes.", "en")).not.toBe(
      responseFingerprint("Crash", "It crashes.", "vi"),
    );
    expect(responseFingerprint("Crash", "It crashes.", null)).not.toBe(
      responseFingerprint("Crash", "It crashes.", "en"),
    );
  });

  it("is not affected by which model wrote it or how many drafts were asked for", () => {
    // The fingerprint deliberately says nothing about the model or `drafts` —
    // rotating past a failed model, or raising the quality knob, is not a
    // reason to answer a thread twice.
    expect(responseFingerprint("Crash", "It crashes.", "en")).toBe(
      responseFingerprint("Crash", "It crashes.", "en"),
    );
  });
});
