import { describe, expect, it } from "vitest";

import type { LifecycleTrack } from "../../core/warrant.js";
import {
  renderRow,
  renderSweepPage,
  renderThreadPage,
  type DoneSummary,
  type OutcomeSummary,
} from "./summary.js";

const NOTHING_DONE: DoneSummary = {
  labeled: [],
  commented: false,
  closed: false,
  unstaled: [],
  dueNotGranted: 0,
};

function outcome(over: Partial<OutcomeSummary> = {}): OutcomeSummary {
  return {
    language: "en",
    actions: [],
    unstale: [],
    permanentlyExempt: null,
    permitted: ["label", "comment"],
    withheld: [],
    ungranted: null,
    ...over,
  };
}

function track(over: Partial<LifecycleTrack> = {}): LifecycleTrack {
  return { name: "stale", when: null, resets: "any", steps: [], ...over };
}

describe("renderRow", () => {
  it("names the ungranted reason directly", () => {
    const row = renderRow(5, outcome({ ungranted: "no policy" }), NOTHING_DONE);
    expect(row).toEqual(["#5", "no policy"]);
  });

  it("names the permanently exempt label", () => {
    const row = renderRow(5, outcome({ permanentlyExempt: "pinned" }), NOTHING_DONE);
    expect(row[1]).toContain("`pinned`");
  });

  it("says nothing due when nothing happened", () => {
    const row = renderRow(5, outcome(), NOTHING_DONE);
    expect(row[1]).toBe("Nothing due.");
  });

  it("names every action taken", () => {
    const done: DoneSummary = {
      labeled: ["stale"],
      commented: true,
      closed: true,
      unstaled: ["needs-info"],
      dueNotGranted: 1,
    };
    const row = renderRow(5, outcome(), done);
    expect(row[1]).toContain("labeled `stale`");
    expect(row[1]).toContain("commented");
    expect(row[1]).toContain("closed as not planned");
    expect(row[1]).toContain("un-staled `needs-info`");
    expect(row[1]).toContain("1 step due but withheld");
  });

  it("escapes pipes in cell text so a row cannot break the table", () => {
    const row = renderRow(5, outcome({ ungranted: "a | b" }), NOTHING_DONE);
    expect(row[1]).toBe("a \\| b");
  });
});

describe("renderSweepPage", () => {
  it("renders just the ungranted reason when the whole sweep was ungranted", () => {
    const page = renderSweepPage(".github/reeve.yml", false, [], "no lifecycle: key");
    expect(page).toContain("no lifecycle: key");
    expect(page).not.toContain("Processed");
  });

  it("says nothing was processed when results is empty and nothing is ungranted", () => {
    const page = renderSweepPage(".github/reeve.yml", false, [], null);
    expect(page).toContain("Nothing was processed this run.");
  });

  it("renders one row per thread", () => {
    const page = renderSweepPage(
      ".github/reeve.yml",
      false,
      [
        { number: 1, outcome: outcome(), done: NOTHING_DONE },
        { number: 2, outcome: outcome({ ungranted: "no policy" }), done: NOTHING_DONE },
      ],
      null,
    );
    expect(page).toContain("#1");
    expect(page).toContain("#2");
    expect(page).toContain("Processed 2 threads.");
  });

  it("mentions a dry run", () => {
    const page = renderSweepPage(".github/reeve.yml", true, [], null);
    expect(page).toContain("Dry run");
  });

  it("reports a withheld capability at most once even when several threads share it", () => {
    const page = renderSweepPage(
      ".github/reeve.yml",
      false,
      [
        { number: 1, outcome: outcome({ withheld: ["close"] }), done: NOTHING_DONE },
        { number: 2, outcome: outcome({ withheld: ["close"] }), done: NOTHING_DONE },
      ],
      null,
    );
    expect(page.match(/does not grant to lifecycle/g)).toHaveLength(1);
  });
});

describe("renderThreadPage", () => {
  it("names the thread number and a dry run", () => {
    const page = renderThreadPage(".github/reeve.yml", true, 42, outcome(), NOTHING_DONE);
    expect(page).toContain("Thread #42");
    expect(page).toContain("dry run");
  });

  it("lists each due action's track and step", () => {
    const action = { track: track({ name: "stale" }), stepIndex: 1 };
    const page = renderThreadPage(
      ".github/reeve.yml",
      false,
      42,
      outcome({ actions: [action] }),
      NOTHING_DONE,
    );
    expect(page).toContain("`stale`, step 2.");
  });

  it("shows the withheld line when a capability is missing", () => {
    const page = renderThreadPage(
      ".github/reeve.yml",
      false,
      42,
      outcome({ withheld: ["close"] }),
      NOTHING_DONE,
    );
    expect(page).toContain("does not grant to lifecycle");
  });

  it("omits language and action detail when the thread was never evaluated", () => {
    const page = renderThreadPage(
      ".github/reeve.yml",
      false,
      42,
      outcome({ ungranted: "no policy" }),
      NOTHING_DONE,
    );
    expect(page).not.toContain("Author language");
  });
});
