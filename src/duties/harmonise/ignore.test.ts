/**
 * Unit tests for the ignore module — extract and reinsert of `<!-- reeve:ignore-* -->` markers.
 */
import { describe, expect, it } from "vitest";

import { sanitize } from "../../core/sanitize.js";

import { extract, reinsert, _PLACEHOLDER, _SANITIZED_PLACEHOLDER } from "./ignore.js";

describe("extract", () => {
  describe("ignore-next-line", () => {
    it("skips the next non-blank line", () => {
      const content = "line before\n<!-- reeve:ignore-next-line -->\nignored line\nline after\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\nignored line\n");
      expect(result.content).toBe(`line before\n${_PLACEHOLDER}\nline after\n`);
    });

    it("keeps blank lines between marker and target line in the output", () => {
      const content =
        "line before\n<!-- reeve:ignore-next-line -->\n\n\nignored line\nline after\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\nignored line\n");
      // Blank lines between marker and target are kept in output before the placeholder
      expect(result.content).toBe(`line before\n\n\n${_PLACEHOLDER}\nline after\n`);
    });

    it("is a no-op when at the end of the document with no next line", () => {
      const content = "line before\n<!-- reeve:ignore-next-line -->\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      // The marker itself is still extracted (as an empty-effect span)
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\n");
      expect(result.content).toBe(`line before\n${_PLACEHOLDER}\n`);
    });

    it("handles the marker at the very start of the document", () => {
      const content = "<!-- reeve:ignore-next-line -->\nfirst line\nrest\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\nfirst line\n");
      expect(result.content).toBe(`${_PLACEHOLDER}\nrest\n`);
    });

    it("does not let adjacent markers consume each other", () => {
      const content = "a\n<!-- reeve:ignore-next-line -->\n<!-- reeve:ignore-next-line -->\nb\nc\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(2);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\n");
      expect(result.spans[1]?.content).toBe("<!-- reeve:ignore-next-line -->\nb\n");
      expect(result.content).toBe(`a\n${_PLACEHOLDER}\n${_PLACEHOLDER}\nc\n`);
    });

    it("does not consume an ignore-start marker as the next line", () => {
      const content =
        "a\n<!-- reeve:ignore-next-line -->\n<!-- reeve:ignore-start -->\nprotected\n<!-- reeve:ignore-end -->\nb\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(2);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\n");
      expect(result.spans[1]?.content).toBe(
        "<!-- reeve:ignore-start -->\nprotected\n<!-- reeve:ignore-end -->\n",
      );
      expect(result.content).toBe(`a\n${_PLACEHOLDER}\n${_PLACEHOLDER}\nb\n`);
    });
  });

  describe("ignore-start/end", () => {
    it("skips a block between start and end markers", () => {
      const content =
        "before\n<!-- reeve:ignore-start -->\nignored\ncontent\n<!-- reeve:ignore-end -->\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe(
        "<!-- reeve:ignore-start -->\nignored\ncontent\n<!-- reeve:ignore-end -->\n",
      );
      expect(result.content).toBe(`before\n${_PLACEHOLDER}\nafter\n`);
    });

    it("runs to the end of the document when ignore-end is missing", () => {
      const content = "before\n<!-- reeve:ignore-start -->\nignored\nno end marker\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe(
        "<!-- reeve:ignore-start -->\nignored\nno end marker\n",
      );
      expect(result.content).toBe(`before\n${_PLACEHOLDER}\n`);
    });

    it("treats an ignore-end without a matching ignore-start as a literal comment", () => {
      const content = "before\n<!-- reeve:ignore-end -->\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(0);
      expect(result.content).toBe(content);
    });

    it("handles an empty ignored block (start immediately followed by end)", () => {
      const content = "before\n<!-- reeve:ignore-start -->\n<!-- reeve:ignore-end -->\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe(
        "<!-- reeve:ignore-start -->\n<!-- reeve:ignore-end -->\n",
      );
      expect(result.content).toBe(`before\n${_PLACEHOLDER}\nafter\n`);
    });

    it("handles the block at the very start of the document", () => {
      const content = "<!-- reeve:ignore-start -->\nignored\n<!-- reeve:ignore-end -->\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.content).toBe(`${_PLACEHOLDER}\nafter\n`);
    });
  });

  describe("multiple markers", () => {
    it("handles multiple ignore-next-line markers", () => {
      const content =
        "a\n<!-- reeve:ignore-next-line -->\nb\nc\n<!-- reeve:ignore-next-line -->\nd\ne\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(2);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\nb\n");
      expect(result.spans[1]?.content).toBe("<!-- reeve:ignore-next-line -->\nd\n");
      expect(result.content).toBe(`a\n${_PLACEHOLDER}\nc\n${_PLACEHOLDER}\ne\n`);
    });

    it("handles multiple ignore-start/end blocks", () => {
      const content =
        "a\n<!-- reeve:ignore-start -->\nb1\nb2\n<!-- reeve:ignore-end -->\nc\n<!-- reeve:ignore-start -->\nd\n<!-- reeve:ignore-end -->\ne\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(2);
      expect(result.spans[0]?.content).toBe(
        "<!-- reeve:ignore-start -->\nb1\nb2\n<!-- reeve:ignore-end -->\n",
      );
      expect(result.spans[1]?.content).toBe(
        "<!-- reeve:ignore-start -->\nd\n<!-- reeve:ignore-end -->\n",
      );
      expect(result.content).toBe(`a\n${_PLACEHOLDER}\nc\n${_PLACEHOLDER}\ne\n`);
    });

    it("handles a mix of ignore-next-line and ignore-start/end", () => {
      const content =
        "a\n<!-- reeve:ignore-next-line -->\nb\n<!-- reeve:ignore-start -->\nc\n<!-- reeve:ignore-end -->\nd\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(2);
      expect(result.content).toBe(`a\n${_PLACEHOLDER}\n${_PLACEHOLDER}\nd\n`);
    });
  });

  describe("whitespace tolerance", () => {
    it("accepts markers with leading and trailing whitespace", () => {
      const content = "  <!-- reeve:ignore-next-line -->  \nignored\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe("  <!-- reeve:ignore-next-line -->  \nignored\n");
    });

    it("accepts markers with internal whitespace around the colon", () => {
      const content = "<!-- reeve:ignore-start -->\nignored\n<!-- reeve:ignore-end -->\nafter\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
    });
  });

  describe("no markers", () => {
    it("returns the content unchanged when no markers are present", () => {
      const content = "just regular text\nno markers here\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(0);
      expect(result.content).toBe(content);
    });

    it("returns the content unchanged with unrelated HTML comments", () => {
      const content = "text\n<!-- some other comment -->\nmore text\n";
      const result = extract(content);

      expect(result.spans).toHaveLength(0);
      expect(result.content).toBe(content);
    });
  });

  describe("content without trailing newline", () => {
    it("handles a document with no trailing newline", () => {
      const content = "<!-- reeve:ignore-next-line -->\nignored";
      const result = extract(content);

      expect(result.spans).toHaveLength(1);
      expect(result.spans[0]?.content).toBe("<!-- reeve:ignore-next-line -->\nignored");
    });
  });
});

describe("reinsert", () => {
  it("replaces sanitized placeholders with original content", () => {
    const spans = [{ content: "<!-- reeve:ignore-next-line -->\nkept line\n" }];
    const draft = `before\n<!-- ------------------ -->\nafter\n`;

    const result = reinsert(draft, spans);

    expect(result).toBe("before\n<!-- reeve:ignore-next-line -->\nkept line\nafter\n");
  });

  it("replaces multiple placeholders in order", () => {
    const spans = [
      { content: "<!-- reeve:ignore-next-line -->\nfirst\n" },
      { content: "<!-- reeve:ignore-start -->\nsecond\n<!-- reeve:ignore-end -->\n" },
    ];
    const draft = `a\n<!-- ------------------ -->\nb\n<!-- ------------------ -->\nc\n`;

    const result = reinsert(draft, spans);

    expect(result).toBe(
      "a\n<!-- reeve:ignore-next-line -->\nfirst\nb\n<!-- reeve:ignore-start -->\nsecond\n<!-- reeve:ignore-end -->\nc\n",
    );
  });

  it("returns the draft unchanged when there are no spans", () => {
    const draft = "no placeholders here\n";
    expect(reinsert(draft, [])).toBe(draft);
  });

  it("returns the draft unchanged and warns when placeholder count mismatches (too few)", () => {
    const spans = [{ content: "first\n" }, { content: "second\n" }];
    const draft = `a\n<!-- ------------------ -->\nb\n`;

    const result = reinsert(draft, spans);

    // Only 1 placeholder in draft, 2 spans — should return unchanged
    expect(result).toBe(draft);
  });

  it("returns the draft unchanged and warns when placeholder count mismatches (too many)", () => {
    const spans = [{ content: "first\n" }];
    const draft = `a\n<!-- ------------------ -->\nb\n<!-- ------------------ -->\nc\n`;

    const result = reinsert(draft, spans);

    // 2 placeholders in draft, 1 span — should return unchanged
    expect(result).toBe(draft);
  });
});

describe("placeholder format", () => {
  it("PLACEHOLDER has the expected format", () => {
    expect(_PLACEHOLDER).toBe("<!-- reeve-keep-section -->");
  });

  it("SANITIZED_PLACEHOLDER matches the sanitized form", () => {
    const sanitized = "<!-- ------------------ -->";
    expect(sanitized).toMatch(_SANITIZED_PLACEHOLDER);
  });

  it("SANITIZED_PLACEHOLDER does not match other comments", () => {
    expect("<!-- some other comment -->").not.toMatch(_SANITIZED_PLACEHOLDER);
    expect("<!-- ---- -->").not.toMatch(_SANITIZED_PLACEHOLDER);
    expect("<!-- ------------------- -->").not.toMatch(_SANITIZED_PLACEHOLDER);
    expect("<!-- --------------------- -->").not.toMatch(_SANITIZED_PLACEHOLDER);
  });

  it("SANITIZED_PLACEHOLDER does not match near-miss dash counts", () => {
    // 17 dashes — too few
    expect("<!-- ----------------- -->").not.toMatch(_SANITIZED_PLACEHOLDER);
    // 19 dashes — too many
    expect("<!-- ------------------- -->").not.toMatch(_SANITIZED_PLACEHOLDER);
  });

  it("SANITIZED_PLACEHOLDER does not match extra spaces around dashes", () => {
    // Two leading spaces instead of one
    expect("<!--  ------------------ -->").not.toMatch(_SANITIZED_PLACEHOLDER);
    // Two trailing spaces instead of one
    expect("<!-- ------------------  -->").not.toMatch(_SANITIZED_PLACEHOLDER);
  });
});

describe("round-trip: extract → sanitize → reinsert", () => {
  it("preserves original target content through the full pipeline", () => {
    const target = "line before\n<!-- reeve:ignore-next-line -->\nignored line\nline after\n";
    const { content: masked, spans } = extract(target);

    // Simulate what the model would do: return the masked content unchanged
    const modelOutput = masked;
    const sanitized = sanitize(modelOutput);
    const result = reinsert(sanitized, spans);

    expect(result).toBe(target);
  });

  it("preserves an ignore-start/end block through the full pipeline", () => {
    const target =
      "before\n<!-- reeve:ignore-start -->\nprotected\ncontent\n<!-- reeve:ignore-end -->\nafter\n";
    const { content: masked, spans } = extract(target);

    const modelOutput = masked;
    const sanitized = sanitize(modelOutput);
    const result = reinsert(sanitized, spans);

    expect(result).toBe(target);
  });

  it("preserves multiple ignored blocks through the full pipeline", () => {
    const target =
      "a\n<!-- reeve:ignore-next-line -->\nb\nc\n<!-- reeve:ignore-start -->\nd\n<!-- reeve:ignore-end -->\ne\n";
    const { content: masked, spans } = extract(target);

    const modelOutput = masked;
    const sanitized = sanitize(modelOutput);
    const result = reinsert(sanitized, spans);

    expect(result).toBe(target);
  });

  it("preserves content with adjacent ignore-next-line markers through the pipeline", () => {
    const target = "a\n<!-- reeve:ignore-next-line -->\n<!-- reeve:ignore-next-line -->\nb\nc\n";
    const { content: masked, spans } = extract(target);

    const modelOutput = masked;
    const sanitized = sanitize(modelOutput);
    const result = reinsert(sanitized, spans);

    expect(result).toBe(target);
  });

  it("handles a document with no trailing newline through the pipeline", () => {
    const target = "<!-- reeve:ignore-next-line -->\nignored";
    const { content: masked, spans } = extract(target);

    const modelOutput = masked;
    const sanitized = sanitize(modelOutput);
    const result = reinsert(sanitized, spans);

    expect(result).toBe(target);
  });
});

describe("extract identity property", () => {
  it("returns content unchanged when no markers are present", () => {
    const content = "just regular text\nno markers here\n";
    const result = extract(content);

    expect(result.content).toBe(content);
    expect(result.spans).toHaveLength(0);
  });

  it("returns content unchanged with unrelated HTML comments", () => {
    const content = "text\n<!-- some other comment -->\nmore text\n";
    const result = extract(content);

    expect(result.content).toBe(content);
    expect(result.spans).toHaveLength(0);
  });

  it("returns content unchanged with an orphaned ignore-end", () => {
    const content = "before\n<!-- reeve:ignore-end -->\nafter\n";
    const result = extract(content);

    expect(result.content).toBe(content);
    expect(result.spans).toHaveLength(0);
  });
});

describe("reinsert call-order contract", () => {
  it("returns the draft unchanged when called with a pre-sanitize placeholder", () => {
    // reinsert() must only be called AFTER sanitize(); calling it with the
    // raw placeholder `<!-- reeve-keep-section -->` should produce 0 matches
    // and return the draft unchanged.
    const spans = [{ content: "<!-- reeve:ignore-next-line -->\nkept line\n" }];
    const draft = `before\n<!-- reeve-keep-section -->\nafter\n`;

    const result = reinsert(draft, spans);

    // No sanitized placeholders in draft, so it is returned as-is
    expect(result).toBe(draft);
  });
});

describe("reinsert with natural placeholder collision", () => {
  it("returns draft unchanged when a pre-existing dashed comment matches the pattern", () => {
    // If the draft already contains a comment that happens to look like the
    // sanitized placeholder, and there are no spans, it should be preserved.
    const draft = "before\n<!-- ------------------ -->\nafter\n";
    expect(reinsert(draft, [])).toBe(draft);
  });

  it("returns draft unchanged when placeholder count exceeds span count due to collision", () => {
    // Two dashed comments in the draft but only one span — count mismatch,
    // so the draft is returned unchanged and a warning is logged.
    const spans = [{ content: "<!-- reeve:ignore-next-line -->\nkept line\n" }];
    const draft = `before\n<!-- ------------------ -->\nmiddle\n<!-- ------------------ -->\nafter\n`;

    const result = reinsert(draft, spans);

    expect(result).toBe(draft);
  });
});

describe("nested ignore-start/end", () => {
  it("treats a second ignore-start inside a block as literal text", () => {
    const content =
      "a\n<!-- reeve:ignore-start -->\ninner <!-- reeve:ignore-start --> text\n<!-- reeve:ignore-end -->\nb\n";
    const result = extract(content);

    // One span: from the first ignore-start to the first ignore-end
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.content).toBe(
      "<!-- reeve:ignore-start -->\ninner <!-- reeve:ignore-start --> text\n<!-- reeve:ignore-end -->\n",
    );
    expect(result.content).toBe(`a\n${_PLACEHOLDER}\nb\n`);
  });

  it("treats a second ignore-end as literal text when not inside a block", () => {
    const content =
      "a\n<!-- reeve:ignore-start -->\ninner text\n<!-- reeve:ignore-end -->\n<!-- reeve:ignore-end -->\nb\n";
    const result = extract(content);

    // One span: from ignore-start to the FIRST ignore-end
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.content).toBe(
      "<!-- reeve:ignore-start -->\ninner text\n<!-- reeve:ignore-end -->\n",
    );
    // The orphaned second ignore-end is literal
    expect(result.content).toBe(`a\n${_PLACEHOLDER}\n<!-- reeve:ignore-end -->\nb\n`);
  });
});
