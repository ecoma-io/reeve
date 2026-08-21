/**
 * Unit tests for the links module — locale-aware link rewriting.
 */
import { describe, expect, it } from "vitest";

import { localiseLinks, resolve, rewriteTarget, type LinkContext } from "./links.js";

/** A context whose repository holds exactly the given paths. */
function context(paths: readonly string[], over: Partial<LinkContext> = {}): LinkContext {
  const files = new Set(paths);
  return {
    locale: "vi",
    docPath: "README.vi.md",
    exists: (path) => files.has(path),
    ...over,
  };
}

describe("localiseLinks", () => {
  it("rewrites an internal doc link when the locale variant exists", () => {
    const text = "Read the [guide](docs/guide.md) first.";
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toBe("Read the [guide](docs/guide.vi.md) first.");
  });

  it("leaves an internal doc link alone when no locale variant exists", () => {
    const text = "Read the [guide](docs/guide.md) first.";
    const out = localiseLinks(text, context(["docs/guide.md"]));
    expect(out).toBe(text);
  });

  it("rewrites an image link when the locale variant exists", () => {
    const text = "![flow](images/flow.png)";
    const out = localiseLinks(text, context(["images/flow.png", "images/flow.vi.png"]));
    expect(out).toBe("![flow](images/flow.vi.png)");
  });

  it("leaves an image link alone when no locale variant exists", () => {
    const text = "![flow](images/flow.png)";
    const out = localiseLinks(text, context(["images/flow.png"]));
    expect(out).toBe(text);
  });

  it("carries the fragment across a rewrite unchanged", () => {
    const text = "See [setup](docs/guide.md#setup).";
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toBe("See [setup](docs/guide.vi.md#setup).");
  });

  it("never touches external URLs", () => {
    const text = "See [docs](https://example.com/guide.md) and [mail](mailto:a@b.c).";
    const out = localiseLinks(text, context(["https:/example.com/guide.vi.md"]));
    expect(out).toBe(text);
  });

  it("never touches pure fragments", () => {
    const text = "Jump to [setup](#setup).";
    expect(localiseLinks(text, context([]))).toBe(text);
  });

  it("never touches a link that already names a locale", () => {
    const text = "The [Chinese guide](docs/guide.zh.md).";
    const out = localiseLinks(text, context(["docs/guide.zh.md", "docs/guide.zh.vi.md"]));
    expect(out).toBe(text);
  });

  it("never touches links inside code fences or inline code", () => {
    const text = [
      "See [guide](docs/guide.md).",
      "```md",
      "[guide](docs/guide.md)",
      "```",
      "Run `cat [guide](docs/guide.md)` now.",
    ].join("\n");
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toContain("See [guide](docs/guide.vi.md).");
    expect(out).toContain("```md\n[guide](docs/guide.md)\n```");
    expect(out).toContain("`cat [guide](docs/guide.md)`");
  });

  it("resolves relative links against the document's own directory", () => {
    const text = "Back to the [readme](../README.md).";
    const out = localiseLinks(
      text,
      context(["README.md", "README.vi.md"], { docPath: "docs/guide.vi.md" }),
    );
    expect(out).toBe("Back to the [readme](../README.vi.md).");
  });

  it("rewrites reference-style link definitions", () => {
    const text = "See the [guide][g].\n\n[g]: docs/guide.md\n";
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toBe("See the [guide][g].\n\n[g]: docs/guide.vi.md\n");
  });

  it("keeps a link title through a rewrite", () => {
    const text = '[guide](docs/guide.md "The guide")';
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toBe('[guide](docs/guide.vi.md "The guide")');
  });

  it("rewrites angle-bracketed targets, brackets preserved", () => {
    const text = "[guide](<docs/guide.md>)";
    const out = localiseLinks(text, context(["docs/guide.md", "docs/guide.vi.md"]));
    expect(out).toBe("[guide](<docs/guide.vi.md>)");
  });

  it("leaves a link that escapes the repository root alone", () => {
    const text = "[outside](../../etc/passwd.md)";
    const out = localiseLinks(text, context(["etc/passwd.vi.md"], { docPath: "docs/guide.vi.md" }));
    expect(out).toBe(text);
  });

  it("uses the locale suffix shape discover matches, including subtags", () => {
    const text = "[guide](docs/guide.md)";
    const out = localiseLinks(
      text,
      context(["docs/guide.md", "docs/guide.zh-Hans.md"], { locale: "zh-Hans" }),
    );
    expect(out).toBe("[guide](docs/guide.zh-Hans.md)");
  });
});

describe("rewriteTarget", () => {
  it("returns null for schemes, protocol-relative URLs and empty targets", () => {
    const at = context(["docs/guide.vi.md"]);
    expect(rewriteTarget("https://x.test/guide.md", at)).toBeNull();
    expect(rewriteTarget("mailto:someone@example.com", at)).toBeNull();
    expect(rewriteTarget("//cdn.example.com/guide.md", at)).toBeNull();
    expect(rewriteTarget("", at)).toBeNull();
  });

  it("returns null for files that are neither Markdown nor images", () => {
    expect(rewriteTarget("scripts/setup.sh", context(["scripts/setup.vi.sh"]))).toBeNull();
  });
});

describe("resolve", () => {
  it("joins and normalises relative paths", () => {
    expect(resolve("docs", "guide.md")).toBe("docs/guide.md");
    expect(resolve("docs", "./guide.md")).toBe("docs/guide.md");
    expect(resolve("docs", "../README.md")).toBe("README.md");
    expect(resolve("", "README.md")).toBe("README.md");
  });

  it("treats a leading slash as repository-root-relative", () => {
    expect(resolve("docs", "/images/flow.png")).toBe("images/flow.png");
  });

  it("returns null when the path escapes the root", () => {
    expect(resolve("", "../outside.md")).toBeNull();
    expect(resolve("docs", "../../outside.md")).toBeNull();
  });
});
