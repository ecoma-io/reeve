import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Language } from "./languages.js";
import { formatCorrection, type Correction, type WeightedQuery } from "./memory.js";
import { translateToPivot } from "./pivot.js";
import { createWeather, type Provider } from "./provider.js";
import {
  bridgeQueries,
  readStoreWarned,
  recallCorrections,
  renderRecall,
  type Bridge,
  type RecallRequest,
} from "./recall.js";

// `renderRecall` mocks nothing: it is pure text-shaping over data this suite
// builds by hand. What matters is the structural claim the module's own doc
// comment makes — an ordinary decision and a reversal render under different
// headings, and a reversal never falls into the plain "DECIDED:" frame an
// ordinary decision gets, because that frame reads as an endorsement.
//
// The recall half mocks two things and no more. `@actions/core`, because what
// a run *says* about a disabled recall or an unreadable shard is the behaviour
// under test. `translateToPivot`, because the bridge's contract here is when
// it is bought and what is done with what came back — the translation itself
// is pinned in `pivot.test.ts`. The filesystem stays real, for the same reason
// `memory.test.ts` keeps it: a mocked `fs` would be this test asserting its
// own stub.
vi.mock("@actions/core", () => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock("./pivot.js", () => ({ translateToPivot: vi.fn() }));

const mockedInfo = vi.mocked(core.info);
const mockedWarning = vi.mocked(core.warning);
const mockedPivot = vi.mocked(translateToPivot);

const VIETNAMESE: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const ENGLISH: Language = { code: "en", label: "English", scripts: ["Latin"] };

/** A provider nothing here ever reaches — `translateToPivot` is mocked out. */
const PROVIDER: Provider = { complete: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  mockedPivot.mockResolvedValue({ draft: null, failures: [] });
});

/** A corrections directory holding the given shards. */
async function store(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reeve-recall-"));
  const path = join(root, "corrections");
  await mkdir(path);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(path, name), contents);
  }
  return path;
}

/** One shard holding `corrections`, and the path to the store around it. */
function shard(corrections: readonly Correction[]): Promise<string> {
  return store({
    "2026-01.ndjson": `${corrections.map((entry) => formatCorrection(entry)).join("\n")}\n`,
  });
}

function bridge(over: Partial<Bridge> = {}): Bridge {
  return {
    provider: PROVIDER,
    rosters: {
      models: ["expensive"],
      modelNames: new Map([["expensive", "Expensive"]]),
      screenModels: ["cheap"],
      screenNames: new Map([["cheap", "Cheap"]]),
    },
    title: "Export produces an empty file",
    body: "The export writes zero bytes.",
    to: VIETNAMESE,
    weather: createWeather(),
    ...over,
  };
}

function decision(over: Partial<Correction> = {}): Correction {
  return {
    repo: "ecoma-io/reeve",
    thread: 1,
    duty: "triage",
    at: "2026-08-01T00:00:00Z",
    title: "Export produces an empty file",
    excerpt: "The export writes zero bytes when the table has exactly one row.",
    language: "en",
    proposed: ["bug"],
    decided: ["bug", "needs reproduction"],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

function reversedLabel(over: Partial<Correction> = {}): Correction {
  return decision({
    thread: 2,
    title: "Dark mode setting is lost between sessions",
    proposed: ["bug"],
    decided: [],
    outcome: "overruled",
    duplicateOf: null,
    ...over,
  });
}

function reversedClose(over: Partial<Correction> = {}): Correction {
  return decision({
    thread: 3,
    title: "Crash on save with a long filename",
    proposed: [],
    decided: [],
    outcome: "overruled",
    duplicateOf: 40,
    ...over,
  });
}

describe("renderRecall", () => {
  it("returns an empty string for nothing recalled", () => {
    expect(renderRecall([])).toBe("");
  });

  it("renders an ordinary decision under the decisions heading, with its labels", () => {
    const rendered = renderRecall([decision()]);

    expect(rendered).toContain("--- DECISIONS THIS PROJECT ALREADY MADE ---");
    expect(rendered).toContain("#1: Export produces an empty file");
    expect(rendered).toContain("DECIDED: bug, needs reproduction");
  });

  it("shows what was proposed only when it differs from what was decided", () => {
    const same = renderRecall([decision({ proposed: ["bug"], decided: ["bug"] })]);
    expect(same).not.toContain("proposed at the time");

    const different = renderRecall([
      decision({ proposed: ["bug"], decided: ["needs reproduction"] }),
    ]);
    expect(different).toContain("(proposed at the time: bug)");
  });

  it("never renders a reversed correction under the plain DECIDED: frame", () => {
    // The one guarantee `recall.ts`'s doc comment names by name: a model must
    // never read a reversal as an ordinary endorsed decision.
    const rendered = renderRecall([reversedLabel()]);

    expect(rendered).not.toContain("DECIDED:");
    expect(rendered).toContain("--- REVERSED: A HUMAN UNDID ONE OF REEVE'S OWN ACTIONS ---");
  });

  it("states an S1 label reversal as a fact, not an instruction", () => {
    const rendered = renderRecall([reversedLabel({ proposed: ["bug"], decided: [] })]);

    expect(rendered).toContain("Automation applied bug. A human removed it.");
    expect(rendered).toContain("It stands as: no labels.");
    expect(rendered).not.toMatch(/do not|never apply/i);
  });

  it("states an S1 reversal generically when no single removed label survives the diff", () => {
    const rendered = renderRecall([reversedLabel({ proposed: ["bug"], decided: ["bug"] })]);

    expect(rendered).toContain("Automation labeled this thread. A human corrected the labels.");
  });

  it("states an S3 close reversal as a fact, naming the target it was closed against", () => {
    const rendered = renderRecall([reversedClose()]);

    expect(rendered).toContain("Automation closed this thread as a duplicate of #40.");
    expect(rendered).toContain("A human reopened it: that close was reversed.");
  });

  it("puts decisions before reversals, as two separate sections", () => {
    const rendered = renderRecall([reversedLabel(), decision()]);
    const decidedAt = rendered.indexOf("DECISIONS THIS PROJECT ALREADY MADE");
    const reversedAt = rendered.indexOf("REVERSED: A HUMAN UNDID");

    expect(decidedAt).toBeGreaterThanOrEqual(0);
    expect(reversedAt).toBeGreaterThan(decidedAt);
  });

  it("omits a section entirely when nothing recalled belongs to it", () => {
    expect(renderRecall([decision()])).not.toContain("REVERSED");
    expect(renderRecall([reversedLabel()])).not.toContain("DECISIONS THIS PROJECT ALREADY MADE");
  });

  it("carries a note onto a reversed line the same way it does an ordinary one", () => {
    expect(renderRecall([decision({ note: "flaky on CI" })])).toContain("WHY: flaky on CI");
    expect(renderRecall([reversedClose({ note: "wrong target" })])).toContain("WHY: wrong target");
  });
});
describe("readStoreWarned", () => {
  it("reads the store it was pointed at", async () => {
    const path = await shard([decision()]);

    const store = await readStoreWarned(path);

    expect(store.corrections.map((entry) => entry.thread)).toEqual([1]);
    expect(mockedWarning).not.toHaveBeenCalled();
  });

  it("warns once per line that was not a correction, and reads the rest", async () => {
    // Loud on purpose: this is a committed file maintainers open by hand, and
    // losing one example silently is worth less than losing it noisily.
    const path = await store({
      "2026-01.ndjson": `{"broken":true}\n${formatCorrection(decision())}\n`,
    });

    const read = await readStoreWarned(path);

    expect(read.corrections).toHaveLength(1);
    expect(mockedWarning).toHaveBeenCalledTimes(1);
    expect(mockedWarning.mock.calls[0]?.[0]).toMatch(/^corrections: .*is not a correction$/);
  });

  it("says nothing about a store that is not there", async () => {
    // The cold start. A repository that has never corrected anything is not a
    // repository with a problem.
    const read = await readStoreWarned("/nowhere/at/all");

    expect(read.corrections).toEqual([]);
    expect(mockedWarning).not.toHaveBeenCalled();
  });
});

describe("bridgeQueries", () => {
  it("spends the cheap roster when one is configured", async () => {
    // A bridge is a mechanical translation feeding a lexical ranker, not text
    // anybody reads — buying the expensive roster for it is what makes
    // cross-language recall look like a bad trade when it is not.
    await bridgeQueries([], bridge());

    expect(mockedPivot.mock.calls[0]?.[0].models).toEqual(["cheap"]);
  });

  it("falls back to the duty's own roster when no cheap one was configured", async () => {
    await bridgeQueries([], bridge({ rosters: { ...bridge().rosters, screenModels: [] } }));

    expect(mockedPivot.mock.calls[0]?.[0].models).toEqual(["expensive"]);
  });

  it("adds the translated thread as a query against the pivot language", async () => {
    mockedPivot.mockResolvedValue({
      draft: { title: "Xuất ra tệp rỗng", body: "Ghi ra không byte nào." },
      failures: [],
    });
    const queries: WeightedQuery[] = [{ text: "own text", against: "own" }];

    await bridgeQueries(queries, bridge());

    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({
      text: "Xuất ra tệp rỗng\nGhi ra không byte nào.",
      against: { pivot: "vi" },
    });
  });

  it("attributes a failure to recall, under the name the roster shows", async () => {
    mockedPivot.mockResolvedValue({
      draft: null,
      failures: [{ ok: false, model: "cheap", reason: "grounded", kind: "capacity" }],
    });

    await bridgeQueries([], bridge());

    expect(mockedWarning).toHaveBeenCalledWith("recall: Cheap — grounded");
  });

  it("leaves the queries alone when no rendering came back, and says so", async () => {
    // Weather, not a fault: recall runs on the thread's own language alone,
    // which costs a little precision and nothing else.
    const queries: WeightedQuery[] = [{ text: "own text", against: "own" }];

    await bridgeQueries(queries, bridge());

    expect(queries).toHaveLength(1);
    expect(mockedInfo).toHaveBeenCalledWith(
      "Cross-language recall could not translate this thread into the pivot language this run " +
        "— recall used the thread's own language only.",
    );
  });
});

describe("recallCorrections", () => {
  /** The request every case below varies one thing about. */
  function request(path: string, over: Partial<RecallRequest> = {}): RecallRequest {
    return {
      count: 4,
      path,
      title: "Export produces an empty file",
      body: "The export writes zero bytes when the table has exactly one row.",
      language: ENGLISH,
      bridge: null,
      ...over,
    };
  }

  it("never opens the store when recall is turned off, and says that is why", async () => {
    // `recall: 0` is a promise as much as a setting: the path a maintainer
    // would rather this run never open is not opened.
    const path = await shard([decision()]);

    const recalled = await recallCorrections(request(path, { count: 0 }));

    expect(recalled).toEqual({ corrections: [], size: 0, crossLanguage: 0, read: false });
    expect(mockedInfo).toHaveBeenCalledWith(
      "Recall is disabled (`memory.recall` is 0 or lower) — the corrections store was not read.",
    );
  });

  it("treats a negative override the same way, rather than as an unbounded one", async () => {
    const path = await shard([decision()]);

    expect((await recallCorrections(request(path, { count: -1 }))).read).toBe(false);
  });

  it("ranks the thread against the store it read", async () => {
    const path = await shard([decision()]);

    const recalled = await recallCorrections(request(path));

    expect(recalled.read).toBe(true);
    expect(recalled.size).toBe(1);
    expect(recalled.corrections.map((entry) => entry.thread)).toEqual([1]);
  });

  it("caps what it returns at the count it was given", async () => {
    const path = await shard([
      decision({ thread: 1 }),
      decision({ thread: 2 }),
      decision({ thread: 3 }),
    ]);

    expect((await recallCorrections(request(path, { count: 2 }))).corrections).toHaveLength(2);
  });

  it("buys no bridge when the store shares the thread's language", async () => {
    // The common case, and the one that has to stay free: a translated query
    // would reach nothing the plain one does not already reach.
    const path = await shard([decision({ language: "en" })]);

    await recallCorrections(request(path, { bridge: bridge() }));

    expect(mockedPivot).not.toHaveBeenCalled();
  });

  it("buys the bridge when the store holds a correction the thread cannot reach", async () => {
    const path = await shard([decision({ thread: 9, language: "vi" })]);

    await recallCorrections(request(path, { bridge: bridge() }));

    expect(mockedPivot).toHaveBeenCalledTimes(1);
  });

  it("buys no bridge when the caller passed none", async () => {
    // How a duty says "a thread already written in the pivot language has
    // nothing to gain from being translated into itself".
    const path = await shard([decision({ language: "vi" })]);

    await recallCorrections(request(path, { bridge: null }));

    expect(mockedPivot).not.toHaveBeenCalled();
  });

  it("buys no bridge when the thread's own language was never identified", async () => {
    // There is no "other language" to bridge away from — the honest answer is
    // to rank on the words themselves rather than guess a direction.
    const path = await shard([decision({ language: "vi" })]);

    await recallCorrections(request(path, { language: null, bridge: bridge() }));

    expect(mockedPivot).not.toHaveBeenCalled();
  });

  it("counts what it recalled in another language, which is what the bridge bought", async () => {
    mockedPivot.mockResolvedValue({
      draft: { title: "Export produces an empty file", body: "Zero bytes." },
      failures: [],
    });
    const path = await shard([
      decision({ thread: 1, language: "en" }),
      decision({
        thread: 2,
        language: "vi",
        pivot: { language: "vi", title: "Export", excerpt: "" },
      }),
    ]);

    const recalled = await recallCorrections(request(path, { bridge: bridge() }));

    expect(recalled.crossLanguage).toBe(
      recalled.corrections.filter((entry) => entry.language === "vi").length,
    );
    expect(recalled.crossLanguage).toBeGreaterThan(0);
  });

  it("counts nothing as cross-language when the thread's language is unknown", async () => {
    const path = await shard([decision({ language: "vi" })]);

    expect((await recallCorrections(request(path, { language: null }))).crossLanguage).toBe(0);
  });
});
