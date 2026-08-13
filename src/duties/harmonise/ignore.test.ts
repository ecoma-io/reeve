/**
 * Unit tests for the ignore module — extract and reinsert of `<!-- reeve:ignore-* -->` markers.
 */
import { describe, expect, it } from "vitest";

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
});
