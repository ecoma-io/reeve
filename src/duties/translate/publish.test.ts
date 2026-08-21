import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import { assemble } from "../../core/publish.js";
import {
  marker,
  publication,
  translationFingerprint,
  type Decision,
  type Posted,
  type Translated,
} from "./publish.js";

// Nothing is mocked: this module renders strings from the values it is handed,
// and the one thing it borrows — the core's assembler — is what the published
// body actually goes through. Rendering the sections without it would test a
// half nobody reads.

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const chinese: Language = { code: "zh", label: "中文", scripts: ["Hani"] };
// French has no row in chrome.ts's committed table — unlike `chinese` above,
// which chrome does have a row for as of the language it added.
const latin: Language = { code: "la", label: "Latina", scripts: ["Latin"] };

const OFFICIAL = "Ứng dụng bị lỗi khi tôi bấm nút.";

function posted(to: Language, text = `A ${to.label} translation.`, model = "model-a"): Posted {
  return { to, text, model };
}

/** A translation that won a contest, for the cases that render one. */
function decided(to: Language, text?: string, over: Partial<Decision> = {}): Posted {
  return {
    ...posted(to, text),
    decision: {
      score: 0.9,
      drafts: 3,
      decidedBy: "judges",
      votes: [
        { model: "judge-a", pick: "model-a" },
        { model: "judge-b", pick: "model-b" },
      ],
      ...over,
    },
  };
}

function translated(over: Partial<Translated> = {}): Translated {
  return {
    from: vietnamese,
    posted: [posted(english)],
    skipped: [],
    truncated: false,
    fingerprint: "abc123",
    attribution: "none",
    // Off in the default fixture, so every case below reads the block a
    // translation actually renders rather than the chrome around it. The cases
    // about the line turn it on themselves.
    branding: false,
    ...over,
  };
}

/** The logo URL the branding line publishes — pinned, and pinned to a tag. */
const LOGO = "https://raw.githubusercontent.com/ecoma-io/reeve/v0.8.0/.github/assets/logo.png";

/** The body a reader would see: what the core writes from what this duty renders. */
function body(over: Partial<Translated> = {}, official = OFFICIAL): string {
  return assemble(official, marker, publication(translated(over)));
}

describe("marker", () => {
  it("is namespaced to this duty, so another duty's block is not read as ours", () => {
    expect(marker.render("abc123")).toBe("<!-- reeve:translate source=abc123 -->");
    expect(marker.duty).toBe("translate");
  });
});

describe("publication", () => {
  it("keeps the author's text first and byte-for-byte", () => {
    // Everything GitHub reads out of a body — `Fixes #42`, a task list, a
    // trailer — survives only because this half is never rewritten.
    const author = "Fixes #42\n\n- [x] reproduced\n\nCo-authored-by: Ai <ai@example.com>";
    expect(body({}, author).startsWith(author)).toBe(true);
  });

  it("carries the fingerprint in the marker, so the next run can compare it", () => {
    expect(publication(translated({ fingerprint: "0123456789abcdef" })).fingerprint).toBe(
      "0123456789abcdef",
    );
    expect(body({ fingerprint: "0123456789abcdef" })).toContain(marker.render("0123456789abcdef"));
  });

  it("renders no section at all when no language produced a translation", () => {
    // The core refuses to publish an empty section list, so rendering nothing is
    // the whole of "a run that translated nothing writes nothing".
    expect(publication(translated({ posted: [], skipped: [english] }))).toEqual({
      fingerprint: "abc123",
      sections: [],
    });
  });

  it("says the text above is the original and the text below is a machine translation", () => {
    // A reader has to know which half a project is answerable for before they
    // read a word of either.
    expect(body()).toContain("The text above is the original");
    expect(body()).toContain("the version this project answers for");
    expect(body()).toContain("machine translation");
  });

  it("keeps each section's boundary note inside that section's own <details>", () => {
    // The whole point of the layout: what sits outside the sections never grows
    // with the language count, so ten languages are ten collapsed lines rather
    // than ten copies of the same two sentences stacked above and below them.
    const rendered = body({ posted: [posted(english), posted(chinese)] });
    const englishSummary = rendered.indexOf("<b>English</b>");
    const chineseSummary = rendered.indexOf("<b>中文</b>");
    const englishNote = rendered.indexOf("The text above is the original");
    const chineseNote = rendered.indexOf("上面的文本是原文");
    expect(englishNote).toBeGreaterThan(englishSummary);
    expect(englishNote).toBeLessThan(chineseSummary);
    expect(chineseNote).toBeGreaterThan(chineseSummary);
  });

  it("puts nothing between sections and nothing after the last, so the visible block stays compact", () => {
    const rendered = body({ posted: [posted(english), posted(chinese)] });
    expect(rendered).toContain("</details>\n\n<details>");
    expect(rendered.endsWith("</details>")).toBe(true);
  });

  it("opens the only translation, so a reader is not made to click for it", () => {
    expect(body()).toContain("<details open>");
  });

  it("collapses every translation once there is more than one to choose between", () => {
    const rendered = body({ posted: [posted(english), posted(chinese)] });
    expect(rendered).not.toContain("<details open>");
    expect(rendered.split("<details>")).toHaveLength(3);
  });

  it("names the language whatever the reader was told about the machinery", () => {
    for (const attribution of ["none", "model", "detail"] as const) {
      expect(body({ attribution })).toContain("<b>English</b>");
    }
  });

  it("keeps the model id out of a body nobody asked to debug", () => {
    expect(
      body({ posted: [posted(english, "Text.", "gpt-5")], attribution: "none" }),
    ).not.toContain("gpt-5");
  });

  it("names the model that wrote the winning draft when asked to", () => {
    expect(body({ posted: [posted(english, "Text.", "gpt-5")], attribution: "model" })).toContain(
      "<code>gpt-5</code>",
    );
  });

  it("keeps how the draft won out of the summary a reader clicks", () => {
    const rendered = body({ posted: [decided(english)], attribution: "model" });
    expect(rendered).not.toContain("Scored");
    expect(rendered).not.toContain("Votes:");
  });

  it("says how the winning draft won when asked for the detail", () => {
    const rendered = body({ posted: [decided(english)], attribution: "detail" });
    expect(rendered).toContain("Translated by `model-a`.");
    expect(rendered).toContain("Scored 0.90 of 1.00, best of 3 drafts, decided by judges.");
    expect(rendered).toContain("Votes: `judge-a`→`model-a`, `judge-b`→`model-b`.");
  });

  it("puts the detail under the translation, where it is read second", () => {
    const rendered = body({
      posted: [decided(english, "A translation.")],
      attribution: "detail",
    });
    expect(rendered.indexOf("A translation.")).toBeLessThan(rendered.indexOf("Translated by"));
  });

  it("says nothing about a contest that never happened", () => {
    // One draft and no judges: the winner won by being alone, and dressing that
    // up as a verdict would claim a comparison the run did not make.
    const rendered = body({
      posted: [posted(english, "Text.", "gpt-5")],
      attribution: "detail",
    });
    expect(rendered).toContain("Translated by `gpt-5`.");
    expect(rendered).not.toContain("Scored");
    expect(rendered).not.toContain("decided by");
  });

  it("says a lone draft was scored without claiming it beat anything", () => {
    const rendered = body({
      posted: [decided(english, "Text.", { drafts: 1, votes: [] })],
      attribution: "detail",
    });
    expect(rendered).toContain("Scored 0.90 of 1.00, decided by judges.");
    expect(rendered).not.toContain("best of");
    expect(rendered).not.toContain("Votes:");
  });

  it("leaves a blank line around the translation, so its Markdown renders", () => {
    // Without them a fenced code block in the translation renders as one line
    // of backticks.
    const rendered = body({ posted: [posted(english, "```\ncode\n```")] });
    expect(rendered).toContain("counts.\n\n```\ncode\n```\n\n<sub>");
    expect(rendered).toContain("</summary>\n\n> ");
  });

  it("escapes a label, which arrives from a workflow file", () => {
    const hostile: Language = { code: "x", label: "<script>alert(1)</script>", scripts: ["Latin"] };
    const rendered = body({ posted: [posted(hostile, "Text.", "a<b>c")] });
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toContain("<script>");
  });

  it("escapes a model id, which arrives from the same workflow file", () => {
    const rendered = body({
      posted: [posted(english, "Text.", "a<b>c")],
      attribution: "model",
    });
    expect(rendered).toContain("a&lt;b&gt;c");
    expect(rendered).not.toContain("<b>c");
  });

  it("escapes a judge's model id in the detail line too", () => {
    const rendered = body({
      posted: [decided(english, "Text.", { votes: [{ model: "<b>j</b>", pick: "model-a" }] })],
      attribution: "detail",
    });
    expect(rendered).toContain("&lt;b&gt;j&lt;/b&gt;");
    expect(rendered).not.toContain("<b>j</b>");
  });

  it("says which language the thread was written in", () => {
    expect(body()).toContain("Translated from Tiếng Việt.");
  });

  it("claims no source language when detection reached no answer", () => {
    expect(body({ from: null })).not.toContain("Translated from");
  });

  it("says the tail was dropped, rather than letting it look complete", () => {
    expect(body({ truncated: true })).toContain("longer than this run&#39;s limit");
  });

  it("stays quiet about length when the whole body was read", () => {
    expect(body()).not.toContain("longer than");
  });

  it("names the languages nothing translated", () => {
    expect(body({ skipped: [chinese] })).toContain("Not translated this run: 中文.");
  });

  it("does not print why a language was skipped, which is a log's business", () => {
    // A public thread is the wrong place to print somebody's provider quota.
    expect(body({ skipped: [chinese] })).not.toMatch(/quota|rate limit|429|failed/i);
  });

  it("tells a reader how to get the translation redone", () => {
    // The duty owns the block, so a human's only levers are the text above it
    // and deleting it. Saying so is what stops someone editing inside it.
    expect(body()).toContain("Editing the text above republishes this");
  });

  it("renders the same run to the same bytes", () => {
    // What lets the core recognise a run that changed nothing, which is what
    // makes an edit-triggered rerun free.
    expect(body()).toBe(body());
  });

  it("round-trips through the marker, so the next run reads back what it wrote", () => {
    expect(marker.split(body({ fingerprint: "cafe1234" }))).toEqual({
      official: OFFICIAL,
      fingerprint: "cafe1234",
    });
  });
});

describe("the branding line", () => {
  it("sits between the rule and the first section, where nothing has to be unfolded", () => {
    // The whole point: Reeve already names itself in every section's boundary
    // note, and a collapsed <details> shows none of it.
    const rendered = body({ branding: true });
    const rule = rendered.indexOf("\n---\n");
    const line = rendered.indexOf("<sub>[<img");
    const first = rendered.indexOf("<details");
    expect(rule).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(rule);
    expect(line).toBeLessThan(first);
  });

  it("names Reeve and what it does, small, with the mark beside it", () => {
    const rendered = body({ branding: true });
    expect(rendered).toContain(
      `<sub>[<img src="${LOGO}" height="14" alt=""> **Reeve**]` +
        "(https://github.com/ecoma-io/reeve) — autonomous repository operations</sub>",
    );
  });

  it("pins the mark to a tag, because the block outlives the run that wrote it", () => {
    // A `main` URL would render whatever this repository holds years from now
    // into thousands of bodies nobody is going to come back and edit.
    const rendered = body({ branding: true });
    expect(rendered).toContain("raw.githubusercontent.com/ecoma-io/reeve/v0.");
    expect(rendered).not.toContain("raw.githubusercontent.com/ecoma-io/reeve/main/");
  });

  it("costs one line whatever the language count, like everything outside the sections", () => {
    const rendered = body({
      branding: true,
      posted: [posted(english), posted(chinese), posted(vietnamese)],
    });
    expect(rendered.split("<sub>[<img")).toHaveLength(2);
  });

  it("renders nothing at all when the workflow turned it off", () => {
    const rendered = body({ branding: false });
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("autonomous repository operations");
    // And the block still starts where it always did.
    expect(rendered).toContain("---\n\n<details");
  });

  it("renders nothing when no language produced a translation", () => {
    // A run that translated nothing writes nothing — not even a logo.
    expect(publication(translated({ branding: true, posted: [] })).sections).toEqual([]);
  });

  it("is left out of the fingerprint, so turning it on retranslates nothing", () => {
    // The `attribution` precedent exactly: a cosmetic choice about how the next
    // thread reads is not a mandate to re-spend a budget on every old one.
    expect(publication(translated({ branding: true })).fingerprint).toBe(
      publication(translated({ branding: false })).fingerprint,
    );
  });

  it("is not escaped, because it is this module's own markup rather than a workflow's", () => {
    // Every other string in the block arrives from somewhere and is escaped;
    // this one is written here, and escaping it would publish its source.
    const rendered = body({ branding: true });
    expect(rendered).not.toContain("&lt;img");
  });
});

describe("chrome — follows the languages actually posted", () => {
  it("renders the boundary and footer in English when only English was posted", () => {
    const rendered = body({ posted: [posted(english)] });
    expect(rendered).toContain("The text above is the original");
    expect(rendered).not.toContain("Văn bản phía trên là bản gốc");
  });

  it("renders the boundary in Vietnamese, and not English, when only Vietnamese was posted", () => {
    const rendered = body({ posted: [posted(vietnamese)] });
    expect(rendered).toContain("Văn bản phía trên là bản gốc");
    expect(rendered).not.toContain("The text above is the original");
  });

  it("renders each posted language's boundary in its own section, in posted order", () => {
    const rendered = body({ posted: [posted(vietnamese), posted(english)] });
    const vietnameseAt = rendered.indexOf("Văn bản phía trên là bản gốc");
    const englishAt = rendered.indexOf("The text above is the original");
    expect(vietnameseAt).toBeGreaterThan(-1);
    expect(englishAt).toBeGreaterThan(vietnameseAt);
  });

  it("gives a second posting in the same language its own section chrome", () => {
    // Chrome lives inside the section it describes, so it repeats with the
    // section — each copy hidden in its own <details>, never stacked visibly.
    const rendered = body({ posted: [posted(english), posted(english, "Another.", "model-b")] });
    expect(rendered.split("The text above is the original")).toHaveLength(3);
  });

  it("renders the footer's fixed notes in Vietnamese when only Vietnamese was posted", () => {
    const rendered = body({ posted: [posted(vietnamese)] });
    expect(rendered).toContain("Được dịch từ Tiếng Việt.");
    expect(rendered).toContain("Chỉnh sửa văn bản phía trên sẽ đăng lại bản dịch này");
  });

  it("falls back to English boundary/footer chrome for a posted language chrome has no row for", () => {
    // Latin has no row in chrome.ts's committed table — the whole point of the
    // deterministic English fallback rather than a runtime guess at a translation.
    const rendered = body({ posted: [posted(latin)] });
    expect(rendered).toContain("The text above is the original");
    expect(rendered.split("The text above is the original")).toHaveLength(2);
  });
});

describe("translationFingerprint", () => {
  it("is stable for the same text and the same languages", () => {
    expect(translationFingerprint(OFFICIAL, [english, chinese])).toBe(
      translationFingerprint(OFFICIAL, [english, chinese]),
    );
  });

  it("changes when the author edits the text", () => {
    // The one case that must always redo the work: the text no longer means
    // what the published translation says it means.
    expect(translationFingerprint(OFFICIAL, [english])).not.toBe(
      translationFingerprint(`${OFFICIAL} Again.`, [english]),
    );
  });

  it("changes when a language is added to the list", () => {
    expect(translationFingerprint(OFFICIAL, [english])).not.toBe(
      translationFingerprint(OFFICIAL, [english, chinese]),
    );
  });

  it("ignores the order the languages were configured in", () => {
    // Reordering `languages:` changes which section comes first, and that is not
    // worth re-spending a provider's budget on every thread in the repository.
    expect(translationFingerprint(OFFICIAL, [english, chinese])).toBe(
      translationFingerprint(OFFICIAL, [chinese, english]),
    );
  });

  it("is over the codes rather than the labels a list happens to carry", () => {
    const relabelled: Language = { ...english, label: "Anglais" };
    expect(translationFingerprint(OFFICIAL, [relabelled])).toBe(
      translationFingerprint(OFFICIAL, [english]),
    );
  });
});
