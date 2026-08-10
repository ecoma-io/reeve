import { describe, expect, it } from "vitest";

import type { Spend } from "../../core/meter.js";
import type { Language } from "../../core/languages.js";

import type { Posted } from "./publish.js";
import { summarize, type Looked, type Run } from "./summary.js";

const ENGLISH: Language = { code: "en", label: "English", scripts: ["Latin"] };
const VIETNAMESE: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };

function posted(overrides: Partial<Posted> = {}): Posted {
  return { to: ENGLISH, text: "Hello", model: "House model", ...overrides };
}

function looked(overrides: Partial<Looked> = {}): Looked {
  return { what: "#42", from: VIETNAMESE, posted: [], skipped: [], note: null, ...overrides };
}

function spend(overrides: Partial<Spend> = {}): Spend {
  return {
    purpose: "draft",
    model: "a",
    requests: 1,
    failed: 0,
    unreported: 0,
    prompt: 100,
    completion: 20,
    ...overrides,
  };
}

function subject(overrides: Partial<Run> = {}): string {
  return summarize({
    thread: 42,
    dryRun: false,
    looked: [],
    spent: [],
    modelNames: new Map(),
    judgeNames: new Map(),
    ...overrides,
  });
}

describe("the run summary", () => {
  it("names the thread it ran against", () => {
    expect(subject()).toContain("Thread #42");
  });

  it("says a dry run changed nothing, where a reader will see it first", () => {
    // The page for a dry run looks exactly like the page for a real one, and
    // that is the whole reason it has to say so at the top.
    expect(subject({ dryRun: true })).toContain("**dry run**, nothing was written");
  });

  it("reports a translation with the model that wrote it", () => {
    const summary = subject({ looked: [looked({ posted: [posted()] })] });

    expect(summary).toContain("| #42 | English (en) | translated | House model |");
    expect(summary).toContain("1 translation this run.");
    expect(summary).toContain("Source language — #42: Tiếng Việt.");
  });

  it("reports the score, the drafts and the votes of a contested translation", () => {
    const summary = subject({
      looked: [
        looked({
          posted: [
            posted({
              decision: {
                score: 0.94,
                drafts: 3,
                decidedBy: "judges",
                votes: [{ model: "Referee", pick: "House model" }],
              },
            }),
          ],
        }),
      ],
    });

    expect(summary).toContain("| 0.94 | 3 | Referee→House model |");
  });

  it("reports a language no model could translate, which is the row worth reading", () => {
    const summary = subject({ looked: [looked({ skipped: [ENGLISH] })] });

    expect(summary).toContain("| #42 | English (en) | **no draft** |");
  });

  it("reports why a text was left alone", () => {
    // "Nothing happened" and "nothing was asked" look identical from outside.
    const summary = subject({ looked: [looked({ from: null, note: "already translated" })] });

    expect(summary).toContain("| #42 | — | already translated |");
  });

  it("names a reply the way the log names it", () => {
    const summary = subject({
      looked: [looked({ what: "#42 comment 991", posted: [posted()] })],
    });

    expect(summary).toContain("| #42 comment 991 | English (en) |");
  });

  it("says so plainly when nothing was translated", () => {
    expect(subject()).toContain("Nothing was translated this run.");
  });

  it("reports the spend per stage and per model, and what it adds to", () => {
    const summary = subject({
      spent: [
        spend({ purpose: "detect", model: "picker", prompt: 812, completion: 3 }),
        spend({ purpose: "draft", model: "writer", requests: 2, prompt: 4000, completion: 1200 }),
      ],
    });

    expect(summary).toContain("| Detection | picker | 1 | — | 812 | 3 | 815 |");
    expect(summary).toContain("| Drafting | writer | 2 | — | 4,000 | 1,200 | 5,200 |");
    expect(summary).toContain("| **Total** |  | **3** | — | **4,812** | **1,203** | **6,015** |");
  });

  it("shows the name a workflow gave a model, not the id it asked with", () => {
    const summary = subject({
      spent: [spend({ model: "openai/gpt-5-mini" }), spend({ purpose: "judge", model: "seat-a" })],
      modelNames: new Map([["openai/gpt-5-mini", "House model"]]),
      judgeNames: new Map([["seat-a", "Referee"]]),
    });

    expect(summary).toContain("| Drafting | House model |");
    expect(summary).toContain("| Judging | Referee |");
    expect(summary).not.toContain("openai/gpt-5-mini");
    expect(summary).not.toContain("seat-a");
  });

  it("calls the totals a floor when a provider reported no usage", () => {
    // Many OpenAI-compatible gateways send no `usage` at all, and a total that
    // did not say so would be read as the bill.
    const summary = subject({ spent: [spend({ requests: 4, unreported: 3 })] });

    expect(summary).toContain("3 of 4 requests came back without a `usage` field");
    expect(summary).toContain("a floor rather than a total");
  });

  it("says what rotation cost when a request was rotated past", () => {
    const summary = subject({ spent: [spend({ requests: 3, failed: 1 })] });

    expect(summary).toContain("1 request was unusable and rotated past");
  });

  it("says nothing about failures or floors when there were none", () => {
    const summary = subject({ spent: [spend()] });

    expect(summary).not.toContain("floor");
    expect(summary).not.toContain("rotated past");
  });

  it("says so when code decided everything, rather than printing an empty table", () => {
    // The cheapest run there is, and the one the design is arranged around.
    expect(subject()).toContain("No model was asked anything this run");
  });

  it("keeps a pipe in a name inside the cell it belongs to", () => {
    const summary = subject({ spent: [spend({ model: "a | b" })] });

    expect(summary).toContain("| Drafting | a \\| b |");
  });
});
