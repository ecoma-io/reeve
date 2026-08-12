import { describe, expect, it } from "vitest";

import type { LifecycleExempt, LifecycleTrack } from "../../core/warrant.js";
import { footer, renderClose, renderSay } from "./message.js";

const EXEMPT_NONE: LifecycleExempt = {
  labels: [],
  milestones: true,
  assignees: true,
  taxonomy: false,
  comments: null,
  drafts: true,
};

function track(over: Partial<LifecycleTrack> = {}): LifecycleTrack {
  return { name: "stale", when: null, resets: "any", steps: [], ...over };
}

describe("renderSay", () => {
  it("returns null for a step with no say", () => {
    expect(renderSay(null, "en")).toBeNull();
  });

  it("renders literal text as-is, regardless of language", () => {
    expect(renderSay({ kind: "text", text: "Hello there." }, "vi")).toBe("Hello there.");
  });

  it("renders the built-in bundle in the detected language", () => {
    const vi = renderSay({ kind: "built-in" }, "vi");
    const en = renderSay({ kind: "built-in" }, "en");
    expect(vi).not.toBe(en);
    expect(vi?.length).toBeGreaterThan(0);
  });

  it("falls back to the built-in English text for an unconfigured language", () => {
    expect(renderSay({ kind: "built-in" }, "xx")).toBe(renderSay({ kind: "built-in" }, "en"));
  });

  it("falls back to English text for a null language", () => {
    expect(renderSay({ kind: "built-in" }, null)).toBe(renderSay({ kind: "built-in" }, "en"));
  });

  it("resolves a map by language code", () => {
    const say = {
      kind: "map" as const,
      map: new Map([
        ["en", "English text"],
        ["vi", "Vietnamese text"],
      ]),
    };
    expect(renderSay(say, "vi")).toBe("Vietnamese text");
    expect(renderSay(say, "en")).toBe("English text");
  });

  it("falls back to the map's own en entry when the language is not in the map", () => {
    const say = { kind: "map" as const, map: new Map([["en", "English text"]]) };
    expect(renderSay(say, "fr")).toBe("English text");
  });

  it("falls back to the map's first entry when there is no en either", () => {
    const say = { kind: "map" as const, map: new Map([["ja", "Japanese text"]]) };
    expect(renderSay(say, "fr")).toBe("Japanese text");
  });

  it("returns null for an empty map", () => {
    const say = { kind: "map" as const, map: new Map<string, string>() };
    expect(renderSay(say, "en")).toBeNull();
  });
});

describe("renderClose", () => {
  it("renders built-in close text per language, falling back to English", () => {
    expect(renderClose("vi")).not.toBe(renderClose("en"));
    expect(renderClose("xx")).toBe(renderClose("en"));
    expect(renderClose(null)).toBe(renderClose("en"));
  });

  it("never returns empty text", () => {
    expect(renderClose("en").length).toBeGreaterThan(0);
  });
});

describe("footer", () => {
  it("names the author-only reset when resets is author", () => {
    const text = footer(track({ resets: "author" }), EXEMPT_NONE);
    expect(text).toContain("A reply from this thread's author restarts the clock.");
  });

  it("names any-activity reset otherwise", () => {
    const text = footer(track({ resets: "any" }), EXEMPT_NONE);
    expect(text).toContain("Any activity here restarts the clock.");
  });

  it("mentions the when label as the way to stop the track, for a when: track", () => {
    const text = footer(track({ when: "needs-info" }), EXEMPT_NONE);
    expect(text).toContain("Removing the `needs-info` label also stops this track.");
  });

  it("says nothing about a when label for an inactivity track", () => {
    const text = footer(track(), EXEMPT_NONE);
    expect(text).not.toContain("stops this track");
  });

  it("names the first exempt label as the permanent escape hatch", () => {
    const text = footer(track(), { ...EXEMPT_NONE, labels: ["pinned", "wontfix"] });
    expect(text).toContain("Adding `pinned` stops this permanently.");
    expect(text).not.toContain("wontfix");
  });

  it("omits the escape hatch line when exempt.labels is empty", () => {
    const text = footer(track(), EXEMPT_NONE);
    expect(text).not.toContain("stops this permanently");
  });

  it("always carries the attribution line", () => {
    expect(footer(track(), EXEMPT_NONE)).toContain(
      "lifecycle — a policy this repository's own warrant configured.",
    );
  });
});
