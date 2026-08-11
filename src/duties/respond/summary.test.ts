import { describe, expect, it } from "vitest";

import type { Spend } from "../../core/meter.js";

import type { Decision, Responded } from "./publish.js";
import { summarize, type Run } from "./summary.js";

function decision(over: Partial<Decision> = {}): Decision {
  return {
    confidence: 0.94,
    drafts: 3,
    decidedBy: "judges",
    votes: [{ model: "Referee", pick: "House model" }],
    ...over,
  };
}

function responded(over: Partial<Responded> = {}): Responded {
  return {
    language: "English",
    text: "Thanks for the report.",
    model: "House model",
    decision: null,
    fingerprint: "abc123",
    ...over,
  };
}

function spend(over: Partial<Spend> = {}): Spend {
  return {
    purpose: "draft",
    model: "a",
    requests: 1,
    failed: 0,
    unreported: 0,
    prompt: 100,
    completion: 20,
    ...over,
  };
}

function subject(over: Partial<Run> = {}): string {
  return summarize({
    thread: 42,
    dryRun: false,
    note: null,
    language: null,
    responded: null,
    confidence: null,
    floor: 0.75,
    published: false,
    permitted: [],
    withheld: [],
    spent: [],
    modelNames: new Map(),
    judgeNames: new Map(),
    warrant: ".github/reeve.yml",
    implicit: false,
    ungranted: null,
    ...over,
  });
}

describe("the run summary", () => {
  it("names the thread it ran against", () => {
    expect(subject()).toContain("Thread #42");
  });

  it("says a dry run changed nothing, where a reader sees it first", () => {
    expect(subject({ dryRun: true })).toContain("**dry run**, nothing was written");
  });

  it("reports why the run stopped before drafting", () => {
    const summary = subject({ note: "A human already replied to this thread." });

    expect(summary).toContain("### Verdict");
    expect(summary).toContain("A human already replied to this thread.");
  });

  it("says nothing survived when no draft was admitted and no note explains why", () => {
    const summary = subject();

    expect(summary).toContain("No draft survived this run");
  });

  it("reports the language, confidence and outcome of a posted reply", () => {
    const summary = subject({
      language: "English",
      responded: responded(),
      confidence: 0.9,
      published: true,
      permitted: ["comment"],
    });

    expect(summary).toContain("| Language | English |");
    expect(summary).toContain("| Confidence | 0.90 of 1.00 (floor 0.75) |");
    expect(summary).toContain("| Outcome | posted |");
  });

  it("reports drafts, decided-by and votes for a contested reply", () => {
    const summary = subject({
      language: "English",
      responded: responded({ decision: decision() }),
      confidence: 0.94,
      published: true,
      permitted: ["comment"],
    });

    expect(summary).toContain("| Drafts | 3 |");
    expect(summary).toContain("| Decided by | judges |");
    expect(summary).toContain("| Votes | Referee→House model |");
  });

  it("says nothing about a contest that never happened", () => {
    const summary = subject({
      language: "English",
      responded: responded({ decision: null }),
      confidence: 0.9,
      published: true,
      permitted: ["comment"],
    });

    expect(summary).not.toContain("| Drafts |");
    expect(summary).not.toContain("| Decided by |");
  });

  it("says the draft was written to respond-text but withheld below the floor", () => {
    const summary = subject({
      language: "English",
      responded: responded(),
      confidence: 0.5,
      floor: 0.75,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).toContain("below the floor (0.50 < 0.75)");
    expect(summary).toContain("written to `respond-text` but nothing was posted");
  });

  it("shows the sanitised draft in a fenced block when it was withheld below the floor", () => {
    const summary = subject({
      language: "English",
      responded: responded({ text: "Could you share the version you're running?" }),
      confidence: 0.5,
      floor: 0.75,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).toContain("```\nCould you share the version you're running?\n```");
  });

  it("does not render a fenced block for a reply that was actually posted", () => {
    const summary = subject({
      language: "English",
      responded: responded(),
      confidence: 0.9,
      published: true,
      permitted: ["comment"],
    });

    expect(summary).not.toContain("```");
  });

  it("says a rendered-empty draft was refused rather than posted with nothing under the marker", () => {
    const summary = subject({
      language: "English",
      responded: responded({ text: "" }),
      confidence: 0.9,
      floor: 0.75,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).toContain("refused rather than posted with nothing under the marker");
  });

  it("does not render an empty fenced block for a rendered-empty draft", () => {
    const summary = subject({
      language: "English",
      responded: responded({ text: "" }),
      confidence: 0.9,
      floor: 0.75,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).not.toContain("```");
  });

  it("says the draft was withheld when `comment` was not granted", () => {
    const summary = subject({
      language: "English",
      responded: responded(),
      confidence: 0.9,
      published: false,
      permitted: [],
    });

    expect(summary).toContain("`comment` was not granted");
  });

  // This is the report-only dogfood shape: `apply` never names `comment`, so
  // every confident run is withheld, and the job summary is the only place
  // anyone ever reads the draft. A confidence above the floor used to be the
  // one condition that hid it here — the bug this test guards against.
  it("shows the fenced draft when a confident reply was withheld — report-only dogfooding", () => {
    const summary = subject({
      language: "English",
      responded: responded({ text: "Could you share the version you're running?" }),
      confidence: 0.94,
      floor: 0.75,
      published: false,
      permitted: [],
    });

    expect(summary).toContain("```\nCould you share the version you're running?\n```");
  });

  it("says a dry run posted nothing", () => {
    const summary = subject({
      dryRun: true,
      language: "English",
      responded: responded(),
      confidence: 0.9,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).toContain("| Outcome | dry run — nothing was written |");
  });

  it("shows the fenced draft on a dry run too, since nothing reached the thread", () => {
    const summary = subject({
      dryRun: true,
      language: "English",
      responded: responded({ text: "Could you share the version you're running?" }),
      confidence: 0.94,
      published: false,
      permitted: ["comment"],
    });

    expect(summary).toContain("```\nCould you share the version you're running?\n```");
  });

  it("says a reply that cleared every gate was posted — there is no update-in-place outcome", () => {
    const summary = subject({
      language: "English",
      responded: responded(),
      confidence: 0.9,
      published: true,
      permitted: ["comment"],
    });

    expect(summary).toContain("| Outcome | posted |");
  });

  it("names each capability `apply` asked for that the warrant did not grant", () => {
    const summary = subject({ withheld: ["comment"] });

    expect(summary).toContain(
      "`apply` asks for `comment`, which `.github/reeve.yml` does not grant to this duty.",
    );
  });

  it("says nothing about withheld capabilities when there were none", () => {
    expect(subject({ withheld: [] })).not.toContain("does not grant");
  });

  it("reports the spend per stage and per model", () => {
    const summary = subject({
      spent: [
        spend({ purpose: "detect", model: "picker", prompt: 812, completion: 3 }),
        spend({ purpose: "draft", model: "writer", requests: 2, prompt: 4000, completion: 1200 }),
      ],
    });

    expect(summary).toContain("| Detection | picker | 1 | — | 812 | 3 | 815 |");
    expect(summary).toContain("| Drafting | writer | 2 | — | 4,000 | 1,200 | 5,200 |");
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

  it("says so when code decided everything, rather than printing an empty table", () => {
    expect(subject()).toContain("No model was asked anything this run");
  });

  it("says it was granted nothing when there was no warrant to read", () => {
    const summary = subject({ implicit: true, warrant: ".github/reeve.yml" });

    expect(summary).toContain("No `.github/reeve.yml` — this duty found no warrant file.");
    expect(summary).toContain("granted nothing until a warrant explicitly names it");
  });

  it("says nothing about an implicit warrant when one was actually read", () => {
    expect(subject({ implicit: false })).not.toContain("found no warrant file");
  });

  it("says why nothing was even attempted when a written block did not name this duty", () => {
    const summary = subject({
      ungranted:
        "`.github/reeve.yml`'s `capabilities:` block does not name `respond`; once that block " +
        "exists it is the whole answer, so add `respond: [comment]` to it.",
    });

    expect(summary).toContain("does not name `respond`");
    expect(summary).toContain("No model was asked anything. This is a real answer");
    expect(summary).not.toContain("### Verdict");
  });

  it("ends with exactly one newline, whatever the last section was", () => {
    expect(subject()).toMatch(/[^\n]\n$/);
  });
});
