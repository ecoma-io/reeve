import { describe, expect, it } from "vitest";

import type { Spend } from "../../core/meter.js";
import type { Language } from "../../core/languages.js";

import type { Posted } from "./publish.js";
import { summarize, summarizeSweep, type Looked, type Run, type SweepRun } from "./summary.js";

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
    endpoint: null,
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
    warrant: ".github/reeve.yml",
    implicit: false,
    ungranted: null,
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

  it("says it ran on its own defaults when there was no warrant to read", () => {
    const summary = subject({ implicit: true, warrant: ".github/reeve.yml" });

    expect(summary).toContain(
      "No `.github/reeve.yml` — this duty found no warrant file, and ran on its own " +
        "defaults (`edit-body`, and whatever `languages` was configured).",
    );
  });

  it("says nothing about an implicit warrant when one was actually read", () => {
    expect(subject({ implicit: false })).not.toContain("found no warrant file");
  });

  it("says why nothing was even attempted when a written block did not name this duty", () => {
    const summary = subject({
      ungranted:
        "`.github/reeve.yml`'s `capabilities:` block does not name `translate`; once that " +
        "block exists it is the whole answer, so add `translate: [edit-body]` to it (or " +
        "remove the block to return to defaults).",
      looked: [],
    });

    expect(summary).toContain("does not name `translate`");
    expect(summary).toContain("No model was asked anything. This is a real answer");
    // No table of translations — nothing was ever attempted for one to hold.
    expect(summary).not.toContain("### Translations");
  });
});

function sweepSubject(overrides: Partial<SweepRun> = {}): string {
  return summarizeSweep({
    dryRun: false,
    results: [{ number: 42, outcome: "published en" }],
    skipped: 2,
    remaining: 0,
    starvedRun: false,
    budgetExhausted: false,
    spent: [],
    modelNames: new Map(),
    judgeNames: new Map(),
    warrant: ".github/reeve.yml",
    ungranted: null,
    ...overrides,
  });
}

describe("the sweep summary", () => {
  it("names the mode and reports the three counts every sweep answers with", () => {
    const page = sweepSubject({ results: [], skipped: 5, remaining: 3 });

    expect(page).toContain("## Reeve · translate — sweep");
    expect(page).toContain("Processed 0, skipped 5 (already translated), 3 remaining.");
  });

  it("says a dry run rehearsed rather than published", () => {
    expect(sweepSubject({ dryRun: true })).toContain("**Dry run** — nothing was published.");
  });

  it("tables one row per thread, with its outcome", () => {
    const page = sweepSubject({
      results: [
        { number: 42, outcome: "published en, vi" },
        { number: 43, outcome: "already translated" },
      ],
    });

    expect(page).toContain("| #42 | published en, vi |");
    expect(page).toContain("| #43 | already translated |");
  });

  it("says plainly when nothing was processed, rather than an empty table", () => {
    expect(sweepSubject({ results: [] })).toContain("Nothing was processed this run.");
  });

  it("explains a starved roster as weather, not a failure", () => {
    const page = sweepSubject({ starvedRun: true, remaining: 4 });

    expect(page).toContain("ran out of capacity partway through");
    expect(page).toContain("Weather, not a failure.");
  });

  it("says nothing about the roster when it was never starved", () => {
    expect(sweepSubject({ starvedRun: false })).not.toContain("ran out of capacity");
  });

  it("explains an exhausted budget as this run's own ceiling, distinct from a starved roster", () => {
    const page = sweepSubject({ budgetExhausted: true, remaining: 4 });

    expect(page).toContain("`max-requests` was reached partway through");
    expect(page).toContain("this run's own ceiling, not the provider's");
  });

  it("says nothing about the budget when it was never exhausted", () => {
    expect(sweepSubject({ budgetExhausted: false })).not.toContain("max-requests");
  });

  it("bills drafting and judging as separate rows, as a single run does", () => {
    const page = sweepSubject({
      spent: [
        spend({ purpose: "draft", model: "writer" }),
        spend({ purpose: "judge", model: "seat-a" }),
      ],
      modelNames: new Map([["writer", "House model"]]),
      judgeNames: new Map([["seat-a", "Referee"]]),
    });

    expect(page).toContain("| Drafting | House model |");
    expect(page).toContain("| Judging | Referee |");
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(sweepSubject()).toMatch(/[^\n]\n$/);
  });

  it("reports why nothing was even attempted when a written block did not name this duty", () => {
    const page = sweepSubject({
      ungranted:
        "`.github/reeve.yml`'s `capabilities:` block does not name `translate`; once that " +
        "block exists it is the whole answer, so add `translate: [edit-body]` to it (or " +
        "remove the block to return to defaults).",
    });

    expect(page).toContain("## Reeve · translate — sweep");
    expect(page).toContain("does not name `translate`");
    // No table of results — nothing was ever attempted for one to hold.
    expect(page).not.toContain("| Thread | Outcome |");
  });
});
