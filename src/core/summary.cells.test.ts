/**
 * The cost table against the text a consumer actually configures.
 *
 * `cell` is tested on its own next door, and `cost` is tested against model ids
 * that happen to contain nothing worth escaping — which is the shape of gap
 * that survives a round of hardening: every case passes, and the one call site
 * that has to reach for `cell` could stop doing so without a single test
 * noticing. The name in that column is a consumer's own string, taken from a
 * `models` input, so this is the ordinary case rather than a hostile one.
 */
import { describe, expect, it } from "vitest";

import type { Spend } from "./meter.js";
import { cost } from "./summary.js";

function spend(overrides: Partial<Spend> = {}): Spend {
  return {
    purpose: "draft",
    model: "gpt-5-mini",
    endpoint: null,
    requests: 1,
    failed: 0,
    unreported: 0,
    prompt: 0,
    completion: 0,
    ...overrides,
  };
}

/** Every row of the rendered table, header and rule included. */
function rows(rendered: string): string[] {
  return rendered.split("\n").filter((line) => line.startsWith("|"));
}

describe("cost, on names a workflow file can produce", () => {
  it("keeps a name carrying a pipe inside its own cell", () => {
    // `a | b` is how a judge seat with a fallback is written, so a name shaped
    // like one reaches this column by ordinary configuration. Unescaped, it
    // ends the cell early and every column after it in that row shifts left —
    // a table that silently reports one model's tokens against another's
    // stage.
    const rendered = cost([spend({ requests: 2, prompt: 10, completion: 4 })], () => "Quick | Big");

    expect(rendered).toContain("| Drafting | Quick \\| Big | 2 | — | 10 | 4 | 14 |");
  });

  it("keeps every row the same width as the header, whatever the name contains", () => {
    // The property behind the case above, stated so it holds for the backslash
    // and the newline too: a report a reader can compare is one whose rows all
    // have the columns the header promised.
    const rendered = cost(
      [
        spend({ model: "a", requests: 1 }),
        spend({ model: "b", purpose: "judge", requests: 1 }),
        spend({ model: "c", purpose: "screen", requests: 1 }),
      ],
      (entry) => ({ a: "one | two", b: "trailing\\", c: "over\ntwo lines" })[entry.model] ?? "",
    );

    const widths = new Set(rows(rendered).map((row) => row.split(/(?<!\\)\|/).length));
    expect(widths.size).toBe(1);
  });

  it("keeps a name from breaking the row it sits in when an endpoint column is present too", () => {
    const rendered = cost(
      [spend({ endpoint: null, requests: 1 }), spend({ endpoint: "fast", requests: 1 })],
      () => "Quick | Big",
    );

    const widths = new Set(rows(rendered).map((row) => row.split(/(?<!\\)\|/).length));
    expect(widths.size).toBe(1);
  });
});
