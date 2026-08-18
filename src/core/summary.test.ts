import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Spend } from "./meter.js";
import { createWeather, type Failure } from "./provider.js";
import {
  authSection,
  cell,
  cost,
  count,
  fence,
  failIfProtocolExhausted,
  starvedWarning,
  table,
  warnIfStarved,
  writeRunSummary,
  writeSummary,
} from "./summary.js";

// `@actions/core` is kept real and driven through the environment, because the
// environment is what the runner actually gives an action: `GITHUB_STEP_SUMMARY`
// is a path to a file, and a mock of the summary API would prove only that the
// mock was called. What is replaced is the two reporting calls, which are
// effects on the runner rather than values.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  warning: vi.fn(),
  setFailed: vi.fn(),
  debug: vi.fn(),
}));

const environment = { ...process.env };

// One path for the whole file: `@actions/core` resolves the summary path once
// and keeps it, exactly as it does inside a job.
const file = join(await mkdtemp(join(tmpdir(), "reeve-summary-")), "summary.md");

beforeEach(async () => {
  vi.clearAllMocks();
  await writeFile(file, "");
  process.env.GITHUB_STEP_SUMMARY = file;
});

afterEach(() => {
  process.env = { ...environment };
});

describe("writeSummary", () => {
  it("writes the report to the page the runner gave it", async () => {
    await writeSummary("## Reeve\n\nSomething happened.\n");

    expect(await readFile(file, "utf8")).toBe("## Reeve\n\nSomething happened.\n");
  });

  it("adds to what an earlier step wrote rather than replacing it", async () => {
    // The summary is the job's, not this action's: a workflow running two
    // duties gets two reports, and one overwriting the other loses a run.
    await writeFile(file, "## An earlier step\n");

    await writeSummary("## Reeve\n");

    expect(await readFile(file, "utf8")).toBe("## An earlier step\n## Reeve\n");
  });

  it("says nothing when there is no summary to write to", async () => {
    // A local `node dist/index.js`, or `act`. Warning here would train a reader
    // to ignore warnings.
    delete process.env.GITHUB_STEP_SUMMARY;

    await writeSummary("## Reeve\n");

    expect(vi.mocked(core.warning)).not.toHaveBeenCalled();
    expect(vi.mocked(core.debug)).toHaveBeenCalled();
  });

  it("warns rather than fails when the page cannot be written", async () => {
    // The report is a record of work already done. Losing it is not a reason to
    // lose the run — and a summary file has a size limit a long backfill can
    // reach.
    vi.spyOn(core.summary, "write").mockRejectedValueOnce(new Error("summary is too large"));

    await expect(writeSummary("## Reeve\n")).resolves.toBeUndefined();

    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("summary is too large"),
    );
  });
});

describe("table", () => {
  it("renders a header, a rule, and the rows", () => {
    expect(table(["A", "B"], [["1", "2"]])).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("renders nothing at all for no rows", () => {
    // A header over a rule reads like a bug in the report rather than as the
    // absence it is, and only the caller knows what to say instead.
    expect(table(["A", "B"], [])).toBe("");
  });
});

describe("cell", () => {
  it("keeps a pipe inside the cell it was written in", () => {
    // `a | b` is how a judge seat with a fallback is configured, so this is the
    // ordinary case rather than a hostile one.
    expect(cell("a | b")).toBe("a \\| b");
  });

  it("keeps a trailing backslash from escaping the escape", () => {
    // `a\` before a pipe: escape the pipe alone and the `\` the caller wrote
    // consumes the one added here, leaving the pipe bare and the row short.
    expect(cell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("flattens a newline, which would otherwise end the row", () => {
    expect(cell("one\ntwo")).toBe("one two");
  });
});

describe("count", () => {
  it("groups thousands, in one locale rather than the runner's", () => {
    expect(count(1234567)).toBe("1,234,567");
  });
});

describe("fence", () => {
  it("wraps plain text in a three-backtick fence", () => {
    expect(fence("hello")).toEqual(["```", "hello", "```"]);
  });

  it("widens the fence past a triple-backtick run already inside the text", () => {
    const text = "before\n```\ncode\n```\nafter";
    const [open, body, close] = fence(text);
    expect(open).toBe("````");
    expect(close).toBe("````");
    expect(body).toBe(text);
  });

  it("widens past whatever the longest run inside actually is, not just three", () => {
    const text = "a `````` run of six";
    const [open, , close] = fence(text);
    expect(open).toBe("`".repeat(7));
    expect(close).toBe("`".repeat(7));
  });
});

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

describe("cost", () => {
  const byModel = (entry: Spend) => entry.model;

  it("renders the ordinary table, with no Endpoint column, when every request used the one endpoint", () => {
    const spent = [
      spend({ purpose: "draft", model: "gpt-5-mini", requests: 3, prompt: 100, completion: 50 }),
      spend({ purpose: "judge", model: "gpt-5", requests: 1, prompt: 20, completion: 5 }),
    ];

    expect(cost(spent, byModel)).toBe(
      [
        "### Cost",
        "",
        "| Stage | Model | Requests | Failed | Prompt | Completion | Tokens |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| Drafting | gpt-5-mini | 3 | — | 100 | 50 | 150 |",
        "| Judging | gpt-5 | 1 | — | 20 | 5 | 25 |",
        "| **Total** |  | **4** | — | **120** | **55** | **175** |",
      ].join("\n"),
    );
  });

  it("adds an Endpoint column, naming the default endpoint, once more than one endpoint carried spend", () => {
    const spent = [
      spend({ endpoint: null, requests: 2, prompt: 50, completion: 10 }),
      spend({ endpoint: "fast", requests: 1, prompt: 25, completion: 5 }),
    ];

    expect(cost(spent, byModel)).toBe(
      [
        "### Cost",
        "",
        "| Stage | Model | Endpoint | Requests | Failed | Prompt | Completion | Tokens |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| Drafting | gpt-5-mini | default | 2 | — | 50 | 10 | 60 |",
        "| Drafting | gpt-5-mini | fast | 1 | — | 25 | 5 | 30 |",
        "| **Total** |  |  | **3** | — | **75** | **15** | **90** |",
      ].join("\n"),
    );
  });

  it("says nothing was asked, rather than an empty table, when no request was made", () => {
    expect(cost([], byModel)).toBe(
      "### Cost\n\nNo model was asked anything this run — every decision was made by code.",
    );
  });

  it("marks the totals row's failure cell too, once anything failed", () => {
    const spent = [spend({ requests: 2, failed: 1, prompt: 10, completion: 2 })];

    const rendered = cost(spent, byModel);

    expect(rendered).toContain("| Drafting | gpt-5-mini | 2 | 1 | 10 | 2 | 12 |");
    expect(rendered).toContain("**Total** |  | **2** | **1** |");
    expect(rendered).toContain(
      "1 request was unusable and rotated past. That is what rotation costs, and it is in the totals because the provider counted it too.",
    );
  });

  it("flags a floor rather than a total once a provider under-reported usage", () => {
    const spent = [spend({ requests: 2, unreported: 1, prompt: 10, completion: 2 })];

    expect(cost(spent, byModel)).toContain(
      "1 of 2 requests came back without a `usage` field, so the token counts above are a floor rather than a total.",
    );
  });
});

describe("authSection", () => {
  const refused = (endpoint: string | null): Failure => ({
    ok: false,
    model: "m",
    kind: "auth",
    usage: null,
    reason: "HTTP 401: whatever the provider said",
    endpoint,
  });

  it("is empty when nothing failed auth, which is every run before this amendment", () => {
    expect(authSection([])).toBe("");
  });

  it("names every refused endpoint, with null shown as the default pair", () => {
    const section = authSection([refused(null), refused("fast")]);

    expect(section).toContain("### Endpoints that failed to authenticate");
    expect(section).toContain("`default`");
    expect(section).toContain("`fast`");
  });

  it("keeps the provider's own words out of the page", () => {
    // The refusal's reason is a provider's response body — log material, not
    // markdown this page should render.
    expect(authSection([refused("fast")])).not.toContain("whatever the provider said");
  });
});
describe("starvedWarning", () => {
  it("points a sweep at `remaining`, which is where the rest of the backlog went", () => {
    expect(starvedWarning(true)).toContain("see `remaining`");
  });

  it("says weather rather than misconfiguration, on both modes", () => {
    // D12: a run that delivered what it could is not a run that failed.
    expect(starvedWarning(false)).toContain("not a broken configuration");
    expect(starvedWarning(true)).toContain("Every model in `models` failed on capacity this run.");
  });
});

describe("warnIfStarved", () => {
  it("says nothing, and answers false, while any model is still worth asking", () => {
    const weather = createWeather();
    weather.ground("a");

    expect(warnIfStarved(["a", "b"], weather, false)).toBe(false);
    expect(vi.mocked(core.warning)).not.toHaveBeenCalled();
  });

  it("warns once and answers true when every model on the roster is grounded", () => {
    const weather = createWeather();
    weather.ground("a");
    weather.ground("b");

    expect(warnIfStarved(["a", "b"], weather, true)).toBe(true);
    expect(vi.mocked(core.warning)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.warning)).toHaveBeenCalledWith(starvedWarning(true));
  });

  it("is not starvation when there was no roster to run dry", () => {
    // An empty `models` is a duty that asks no model, not a duty that has been
    // refused by all of them.
    expect(warnIfStarved([], createWeather(), false)).toBe(false);
    expect(vi.mocked(core.warning)).not.toHaveBeenCalled();
  });
});

describe("failIfProtocolExhausted", () => {
  it("fails the run when every model on the roster failed with a protocol error", () => {
    const failures: Failure[] = [
      { ok: false, model: "a", reason: "model not found", kind: "protocol" },
      { ok: false, model: "b", reason: "invalid request", kind: "protocol" },
    ];

    expect(failIfProtocolExhausted(["a", "b"], failures)).toBe(true);
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(core.setFailed).mock.calls[0]?.[0]);
    expect(message).toContain("configuration problem");
    expect(message).toContain("a: model not found");
    expect(message).toContain("b: invalid request");
  });

  it("does not fail the run when at least one failure is not protocol", () => {
    const failures: Failure[] = [
      { ok: false, model: "a", reason: "timeout", kind: "capacity" },
      { ok: false, model: "b", reason: "model not found", kind: "protocol" },
    ];

    expect(failIfProtocolExhausted(["a", "b"], failures)).toBe(false);
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });

  it("does not fail the run for an empty roster", () => {
    expect(failIfProtocolExhausted([], [])).toBe(false);
    expect(vi.mocked(core.setFailed)).not.toHaveBeenCalled();
  });
});

describe("writeRunSummary", () => {
  it("writes the page as it was given, when no endpoint refused a key", async () => {
    await writeRunSummary("### The run", createWeather());

    const written = await readFile(file, "utf8");
    expect(written).toContain("### The run");
    expect(written).not.toContain("### Endpoints that failed to authenticate");
  });

  it("names the endpoints that refused a key underneath the page", async () => {
    // The multi-endpoint half of D12 only holds up if a run that carried on
    // without an endpoint says which one it carried on without.
    const weather = createWeather(new Set(["fast"]));
    weather.failAuth("fast", {
      ok: false,
      model: "m",
      kind: "auth",
      usage: null,
      reason: "HTTP 401",
      endpoint: "fast",
    });

    await writeRunSummary("### The run", weather);

    const written = await readFile(file, "utf8");
    expect(written).toContain("### The run");
    expect(written).toContain("### Endpoints that failed to authenticate");
    expect(written).toContain("`fast`");
  });
});

describe("cost — the plurality of what it reports", () => {
  const byModel = (entry: Spend) => entry.model;

  it("says `1 of 1 request` in the singular when the one request under-reported", () => {
    // The sentence is the whole point of the row: a reader who sees a plural
    // where there was one request stops trusting the count.
    expect(cost([spend({ requests: 1, unreported: 1 })], byModel)).toContain(
      "1 of 1 request came back without a `usage` field",
    );
  });

  it("says `requests were unusable` in the plural once more than one failed", () => {
    expect(cost([spend({ requests: 3, failed: 2 })], byModel)).toContain(
      "2 requests were unusable and rotated past.",
    );
  });

  it("says neither sentence when nothing failed and nothing was under-reported", () => {
    const rendered = cost([spend({ requests: 2 })], byModel);
    expect(rendered).not.toContain("without a `usage` field");
    expect(rendered).not.toContain("unusable and rotated past");
  });
});
