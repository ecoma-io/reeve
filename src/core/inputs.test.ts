import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bounded,
  counted,
  fraction,
  parseAttribution,
  parseApiKeys,
  parseEndpoints,
  parseSince,
  parseTemperature,
  parseTimeout,
  readCore,
  readShared,
  threadNumber,
  whole,
} from "./inputs.js";

// `@actions/core` is kept real and driven through the environment, because the
// environment is exactly what a workflow file becomes: `INPUT_MODELS` is what
// `with: models:` compiles to, and a test that reimplemented the lookup would
// stop proving the two agree. Only `setSecret` is replaced — it is an effect on
// the runner rather than a value, and its absence is the failure worth pinning.
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setSecret: vi.fn(),
}));

// The event half of the context, which arrives from a JSON file on the runner
// rather than from an input.
const { issue } = vi.hoisted((): { issue: { number?: number } } => ({ issue: {} }));
vi.mock("@actions/github", () => ({ context: { issue } }));

const COMPLETE = {
  "github-token": "ghs_token",
  "base-url": "https://api.openai.com/v1",
  "api-key": "sk-secret",
  models: "gpt-4o-mini, gpt-4o",
  "dry-run": "false",
  sweep: "false",
  since: "",
  limit: "50",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

/** The workflow file as the runner hands it over. */
function given(inputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
}

const environment = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete issue.number;
});

afterEach(() => {
  process.env = { ...environment };
});

describe("readShared", () => {
  it("reads the inputs every duty shares, so no duty parses them itself", () => {
    given(COMPLETE);
    issue.number = 42;

    expect(readShared()).toEqual({
      token: "ghs_token",
      number: 42,
      models: ["gpt-4o-mini", "gpt-4o"],
      modelNames: new Map(),
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      dryRun: false,
      sweep: false,
      since: null,
      limit: 50,
      endpoints: [],
      apiKeys: [],
      requestTimeoutMs: 120_000,
      temperature: undefined,
    });
  });

  it("reads a group duty's shared inputs with no event thread in sight", () => {
    // `harmonise` works document groups, not a thread: its `number` input is an
    // optional group base path, and a `push` run has no issue or pull request
    // to name. `needsThread: false` must not require one — a schedule-like
    // event with no `issue.number` used to throw `names no issue or pull
    // request` here.
    given(COMPLETE);
    delete issue.number;
    process.env.GITHUB_EVENT_NAME = "schedule";

    const shared = readShared({ needsThread: false });

    expect(shared.number).toBeNull();
    expect(shared.sweep).toBe(false);
  });

  it("carries the names a workflow gave its models, kept beside the ids", () => {
    // Nothing between here and publication has any business with them, which is
    // exactly why they travel separately rather than folded into the ids.
    given({ ...COMPLETE, models: "gpt-4o-mini = Quick, gpt-4o" });
    issue.number = 42;

    const shared = readShared();

    expect(shared.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(shared.modelNames.get("gpt-4o-mini")).toBe("Quick");
    expect(shared.modelNames.has("gpt-4o")).toBe(false);
  });

  it("registers the key as a secret before anything can log it", () => {
    // A provider's `reason` quotes the response body, and a gateway that echoes
    // the request would otherwise put the key in a public workflow log. The
    // masking has to happen before the first request, not before the first log.
    given(COMPLETE);
    issue.number = 42;

    readShared();

    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-secret");
  });

  it("accepts a keyless provider rather than masking an empty string", () => {
    // Free endpoints that take no key are a supported configuration, and
    // masking "" would ask the runner to redact every character it prints.
    given({ ...COMPLETE, "api-key": "" });
    issue.number = 42;

    expect(readShared().apiKey).toBe("");
    expect(vi.mocked(core.setSecret)).not.toHaveBeenCalled();
  });

  it("refuses a models input that names no model", () => {
    // `models: ", ,"` is a typo in a workflow file, and the run that continued
    // past it would fail later with a rotation that never had anywhere to go.
    given({ ...COMPLETE, models: " , , " });
    issue.number = 42;

    expect(() => readShared()).toThrow(/models: no entries/);
  });

  it("reads `dry-run` as the boolean the schema declares", () => {
    given({ ...COMPLETE, "dry-run": "true" });
    issue.number = 42;

    expect(readShared().dryRun).toBe(true);
  });

  it.each(["github-token", "models", "base-url"])(
    "refuses a run missing `%s`, before it spends anything",
    (name) => {
      given({ ...COMPLETE, [name]: "" });
      issue.number = 42;

      expect(() => readShared()).toThrow(/required/i);
    },
  );

  it("names no thread under `sweep` — a sweep works the backlog, not one issue", () => {
    given({ ...COMPLETE, sweep: "true" });

    expect(readShared().number).toBeNull();
  });

  it("refuses `sweep` combined with `number` — a workflow has to pick one", () => {
    given({ ...COMPLETE, sweep: "true", number: "42" });

    expect(() => readShared()).toThrow(/sweep: cannot be combined with `number`/);
  });

  it("reads `since` as no bound when it is empty, the default", () => {
    given({ ...COMPLETE, sweep: "true" });

    expect(readShared().since).toBeNull();
  });

  it("reads `since` as a calendar date", () => {
    given({ ...COMPLETE, sweep: "true", since: "2026-01-01" });

    expect(readShared().since).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("reads `since` as a duration", () => {
    given({ ...COMPLETE, sweep: "true", since: "90d" });

    const now = Date.now();
    const since = readShared().since;

    expect(since).not.toBeNull();
    // A duration is resolved against the moment it was read, not pinned to a
    // fixture, so this pins the arithmetic to within a second of `now` instead.
    expect(now - (since?.getTime() ?? 0)).toBeCloseTo(90 * 24 * 60 * 60 * 1000, -3);
  });

  it("reads `limit`, the most a sweep will actually process", () => {
    given({ ...COMPLETE, sweep: "true", limit: "200" });

    expect(readShared().limit).toBe(200);
  });

  it("refuses a `limit` of zero — a sweep that processes nothing is a typo", () => {
    given({ ...COMPLETE, sweep: "true", limit: "0" });

    expect(() => readShared()).toThrow(/limit: expected a whole number of 1 or more/);
  });
});

describe("parseAttribution", () => {
  it("reads the three spellings case-insensitively and trimmed", () => {
    for (const value of ["none", "model", "detail"]) {
      expect(parseAttribution(value)).toBe(value);
    }
    expect(parseAttribution("  MODEL  ")).toBe("model");
  });

  it("refuses a spelling no duty documents", () => {
    expect(() => parseAttribution("detailed")).toThrow(
      /expected `none`, `model` or `detail`, got `detailed`/,
    );
  });

  it("quotes back what the workflow wrote, not what this normalised it into", () => {
    // Every sibling parser quotes `raw`. Quoting the folded value sends a
    // maintainer looking for `detai` in a file that says `Detai`.
    expect(() => parseAttribution("  Detai ")).toThrow(
      "show-attribution: expected `none`, `model` or `detail`, got `  Detai `.",
    );
  });
});

describe("parseSince", () => {
  it("reads an empty input as no bound", () => {
    expect(parseSince("")).toBeNull();
  });

  it("reads a calendar date", () => {
    expect(parseSince("2026-01-01")).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("reads a duration in days", () => {
    const now = Date.now();

    expect(now - (parseSince("90d")?.getTime() ?? 0)).toBeCloseTo(90 * 24 * 60 * 60 * 1000, -3);
  });

  it("refuses a duration of zero days — no bound at all is what empty already means", () => {
    expect(() => parseSince("0d")).toThrow(/since: `0d` names no days at all/);
  });

  it("refuses anything that is neither a date nor a duration", () => {
    expect(() => parseSince("last week")).toThrow(
      /since: expected empty, `YYYY-MM-DD`, or a duration like `90d`/,
    );
  });
});

describe("threadNumber", () => {
  it("works on the thread a backfill named", () => {
    given({ ...COMPLETE, number: "1234" });
    issue.number = 42;

    expect(threadNumber()).toBe(1234);
  });

  it("works on the thread that triggered the workflow when no number was given", () => {
    given(COMPLETE);
    issue.number = 42;

    expect(threadNumber()).toBe(42);
  });

  it("names the event when it carries no thread and no number was given", () => {
    // A `schedule` or a `workflow_dispatch` with the field left blank. Saying
    // which event it was is the difference between a run that explains itself
    // and one that asks GitHub for issue `NaN`.
    given(COMPLETE);
    process.env.GITHUB_EVENT_NAME = "schedule";

    expect(() => threadNumber()).toThrow(/this event \(schedule\) names no issue or pull request/);
  });

  it("says the event is unknown rather than printing `undefined`", () => {
    given(COMPLETE);
    delete process.env.GITHUB_EVENT_NAME;

    expect(() => threadNumber()).toThrow(/\(unknown\)/);
  });

  it("refuses a number input that is not one", () => {
    given({ ...COMPLETE, number: "#42" });

    expect(() => threadNumber()).toThrow(/number: expected a whole number/);
  });
});

describe("whole", () => {
  it("reads a count", () => {
    expect(whole("drafts", "3")).toBe(3);
  });

  it.each([
    ["an empty input, which `Number` reads as zero", ""],
    ["a value with a unit, which `Number` reads as NaN", "6000 chars"],
    ["zero, which is a count of nothing", "0"],
    ["a negative count", "-1"],
    ["a fraction", "1.5"],
  ])("refuses %s", (_case, raw) => {
    expect(() => whole("drafts", raw)).toThrow(
      `drafts: expected a whole number of 1 or more, got \`${raw}\`.`,
    );
  });

  it("names the input it refused, so the message points at a line to fix", () => {
    expect(() => whole("max-body-chars", "lots")).toThrow(/^max-body-chars:/);
  });
});

describe("counted", () => {
  it("reads a count", () => {
    expect(counted("min-body-chars", "40")).toBe(40);
  });

  it("reads zero, which is how a threshold is turned off", () => {
    // The difference from `whole`. A minimum of nothing is a documented setting
    // for a tracker whose reports are routinely terse.
    expect(counted("min-body-chars", "0")).toBe(0);
  });

  it.each([
    ["an empty input", ""],
    ["a value with a unit", "40 chars"],
    ["a negative count", "-1"],
    ["a fraction", "1.5"],
  ])("refuses %s", (_case, raw) => {
    expect(() => counted("min-body-chars", raw)).toThrow(
      `min-body-chars: expected a whole number of 0 or more, got \`${raw}\`.`,
    );
  });
});

describe("bounded", () => {
  it("reads a count", () => {
    expect(bounded("corpus-limit", "500")).toBe(500);
  });

  it.each([
    ["none", "none"],
    ["upper case", "NONE"],
    ["surrounding space", "  none\n"],
  ])("reads %s as no bound at all", (_case, raw) => {
    expect(bounded("corpus-limit", raw)).toBeNull();
  });

  it.each([
    ["an empty input, which `Number` reads as zero", ""],
    ["zero, the wrong kind of vanishing point for a ceiling", "0"],
    ["a negative count", "-1"],
    ["a fraction", "1.5"],
    ["a value with a unit", "500 issues"],
  ])("refuses %s, naming `none` as the way to say unlimited", (_case, raw) => {
    expect(() => bounded("corpus-limit", raw)).toThrow(
      `corpus-limit: expected a whole number of 1 or more, or \`none\` for no bound, got \`${raw}\`.`,
    );
  });
});

describe("fraction", () => {
  it("reads a threshold", () => {
    expect(fraction("confidence", "0.75")).toBe(0.75);
  });

  it.each([
    ["0", 0],
    ["1", 1],
  ])("reads %s, which is a setting rather than an edge case", (raw, expected) => {
    expect(fraction("confidence", raw)).toBe(expected);
  });

  it("ignores surrounding space, which a folded YAML value leaves behind", () => {
    expect(fraction("confidence", " 0.5\n")).toBe(0.5);
  });

  it.each([
    ["a percentage, which would clamp to certainty and stop labelling anything", "75"],
    ["a negative threshold", "-0.1"],
    ["text", "high"],
    ["nothing at all", "  "],
  ])("refuses %s", (_case, raw) => {
    expect(() => fraction("confidence", raw)).toThrow(
      /confidence: expected a number between 0 and 1/,
    );
  });
});

describe("parseTimeout", () => {
  it.each([
    ["120s", 120_000],
    ["2m", 120_000],
    ["1s", 1000],
    ["  90s  ", 90_000],
  ])("reads %s as milliseconds", (raw, expected) => {
    expect(parseTimeout("request-timeout", raw)).toBe(expected);
  });

  it("refuses a bare number, naming that the unit is missing", () => {
    expect(() => parseTimeout("request-timeout", "120")).toThrow(
      "request-timeout: expected a whole number of seconds or minutes, like `120s` or `2m` — " +
        "a bare number names no unit, got `120`.",
    );
  });

  it.each([
    ["", ""],
    ["0s", "0s"],
    ["-1s", "-1s"],
    ["1h", "1h"],
    ["1.5s", "1.5s"],
  ])("refuses %s", (_case, raw) => {
    expect(() => parseTimeout("request-timeout", raw)).toThrow(/request-timeout:/);
  });

  it("refuses a duration past what a timer can hold, rather than letting it fire instantly", () => {
    // Node's timers overflow past 2^31-1 ms and fire almost immediately —
    // which would silently turn every request into instant weather.
    expect(() => parseTimeout("request-timeout", "35792m")).toThrow(
      "request-timeout: `35792m` is longer than any run could ever wait — use a shorter duration.",
    );
    expect(parseTimeout("request-timeout", "35791m")).toBe(35_791 * 60_000);
  });
});

describe("parseTemperature", () => {
  it("omits the field entirely when empty", () => {
    expect(parseTemperature("")).toBeUndefined();
    expect(parseTemperature("  ")).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["2", 2],
    ["0.7", 0.7],
  ])("reads %s", (raw, expected) => {
    expect(parseTemperature(raw)).toBe(expected);
  });

  it.each([
    ["-0.1", "-0.1"],
    ["2.1", "2.1"],
    ["hot", "hot"],
  ])(
    "refuses %s, out of the 0–2 range every OpenAI-compatible provider documents",
    (_case, raw) => {
      expect(() => parseTemperature(raw)).toThrow(
        `temperature: expected a number between 0 and 2, got \`${raw}\`.`,
      );
    },
  );
});

describe("parseEndpoints", () => {
  it("reads one alias and url", () => {
    expect(parseEndpoints("fast = https://api.example.com/v1")).toEqual([
      { alias: "fast", baseUrl: "https://api.example.com/v1", timeoutMs: null },
    ]);
  });

  it("reads a `timeout=` override after the url", () => {
    expect(parseEndpoints("fast = https://api.example.com/v1 timeout=30s")).toEqual([
      { alias: "fast", baseUrl: "https://api.example.com/v1", timeoutMs: 30_000 },
    ]);
  });

  it("reads more than one endpoint, comma or newline separated", () => {
    expect(
      parseEndpoints("fast = https://a.example.com/v1\nslow = https://b.example.com/v1"),
    ).toEqual([
      { alias: "fast", baseUrl: "https://a.example.com/v1", timeoutMs: null },
      { alias: "slow", baseUrl: "https://b.example.com/v1", timeoutMs: null },
    ]);
  });

  it("returns nothing for an empty input", () => {
    expect(parseEndpoints("")).toEqual([]);
  });

  it("refuses an entry with no `=`", () => {
    expect(() => parseEndpoints("https://api.example.com/v1")).toThrow(
      "endpoints: expected `alias = url`, got `https://api.example.com/v1`.",
    );
  });

  it("refuses an alias outside letters, digits, `-` and `_`", () => {
    expect(() => parseEndpoints("fast! = https://api.example.com/v1")).toThrow(
      "endpoints: `fast!` is not a valid alias — letters, digits, `-` and `_` only.",
    );
  });

  it("refuses `default` as an alias — it already names the built-in endpoint", () => {
    expect(() => parseEndpoints("default = https://api.example.com/v1")).toThrow(
      "endpoints: `default` is reserved — it names the built-in `base-url` endpoint. Pick another alias.",
    );
  });

  it("refuses `timeout=` written twice on one line, rather than letting the last win", () => {
    expect(() =>
      parseEndpoints("fast = https://api.example.com/v1 timeout=30s timeout=60s"),
    ).toThrow("endpoints: `fast` names `timeout=` more than once.");
  });

  it("refuses the same alias declared twice", () => {
    expect(() =>
      parseEndpoints("fast = https://a.example.com/v1\nfast = https://b.example.com/v1"),
    ).toThrow("endpoints: `fast` is declared more than once.");
  });

  it("refuses an alias with no url", () => {
    expect(() => parseEndpoints("fast = ")).toThrow("endpoints: `fast` names no url.");
  });

  it("refuses a token after the url it does not recognise", () => {
    expect(() => parseEndpoints("fast = https://api.example.com/v1 wat")).toThrow(
      "endpoints: `fast`: unrecognised `wat` — expected `timeout=<duration>`.",
    );
  });
});

describe("parseApiKeys", () => {
  it("reads one alias and key", () => {
    expect(parseApiKeys("fast = sk-secret")).toEqual([{ alias: "fast", key: "sk-secret" }]);
  });

  it("registers every value as a secret before any of them are parsed", () => {
    // The masking has to happen before a malformed later line can throw an
    // error that quotes an earlier, still-unmasked key.
    parseApiKeys("fast = sk-one\nslow = sk-two");

    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-one");
    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-two");
  });

  it("masks every value even when a later line is malformed", () => {
    expect(() => parseApiKeys("fast = sk-one\nno-equals-sign")).toThrow();

    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-one");
  });

  it("returns nothing for an empty input", () => {
    expect(parseApiKeys("")).toEqual([]);
  });

  it("refuses an entry with no `=`", () => {
    expect(() => parseApiKeys("sk-secret")).toThrow(
      "api-keys: expected `alias = key`, got an entry with no `=`.",
    );
  });

  it("refuses the same alias declared twice", () => {
    expect(() => parseApiKeys("fast = sk-one\nfast = sk-two")).toThrow(
      "api-keys: `fast` is declared more than once.",
    );
  });
});

describe("readCore", () => {
  it("reads everything a duty needs whether or not it sweeps", () => {
    given(COMPLETE);

    // The three sweep inputs are `readShared`'s, not this — a duty that
    // answers one thread never declares them.
    expect(readCore()).toEqual({
      token: "ghs_token",
      models: ["gpt-4o-mini", "gpt-4o"],
      modelNames: new Map(),
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      dryRun: false,
      endpoints: [],
      apiKeys: [],
      requestTimeoutMs: 120_000,
      temperature: undefined,
    });
  });

  it("registers `api-key` as a secret before anything can log it", () => {
    given(COMPLETE);

    readCore();

    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-secret");
  });

  it("passes when every api-keys alias is declared in endpoints", () => {
    given({
      ...COMPLETE,
      endpoints: "fast = https://api.example.com/v1",
      "api-keys": "fast = sk-secret",
    });

    expect(readCore().apiKeys).toEqual([{ alias: "fast", key: "sk-secret" }]);
  });

  it("refuses an api-keys alias endpoints never declared", () => {
    given({ ...COMPLETE, "api-keys": "fast = sk-secret" });

    expect(() => readCore()).toThrow("api-keys: `fast` is not declared in `endpoints`.");
  });
});

/**
 * The input classes a workflow file actually produces that no other block
 * here reaches — a half-typed `alias = url`, a key line with the `=` missing,
 * and a date that is a date-shaped string without being a date.
 *
 * Grouped rather than scattered because they share one property: each is a
 * mistake that is cheap to make in YAML and expensive to notice at runtime,
 * so each has to fail with a sentence naming the input it came from.
 */
describe("input classes a workflow file produces by accident", () => {
  it("names the whole entry when an endpoints line gave no alias at all", () => {
    // `= https://…` is what a half-finished edit leaves behind, and quoting
    // back an empty alias would be a message pointing at nothing.
    expect(() => parseEndpoints("= https://api.example.com/v1")).toThrow(
      "endpoints: `= https://api.example.com/v1` is not a valid alias — letters, digits, `-` and `_` only.",
    );
  });

  it("masks an api-keys line that has no `=` before refusing it", () => {
    // The masking pass runs over every entry ahead of any parsing, so a line
    // that is about to be refused has already had its value registered — the
    // refusal quotes no key, but a gateway echo later in the run cannot leak
    // one either.
    vi.mocked(core.setSecret).mockClear();

    expect(() => parseApiKeys("sk-loose-secret")).toThrow(
      "api-keys: expected `alias = key`, got an entry with no `=`.",
    );
    expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith("sk-loose-secret");
  });

  it("does not register an empty api-keys value as a secret", () => {
    // `core.setSecret("")` would mask the empty string, and masking the empty
    // string masks every log line this run writes. An alias written with no key
    // yet is a half-finished edit, not a secret.
    vi.mocked(core.setSecret).mockClear();

    expect(parseApiKeys("openrouter =")).toEqual([{ alias: "openrouter", key: "" }]);
    expect(vi.mocked(core.setSecret)).not.toHaveBeenCalled();
  });

  it("refuses an api-keys entry that named a key but no alias", () => {
    expect(() => parseApiKeys("= sk-secret")).toThrow("api-keys: an entry named no alias.");
  });

  it("refuses a date-shaped `since` the calendar has no such field for", () => {
    // Month 13 and day 0 pass the shape test and are still not dates. Reading
    // either as `Invalid Date` would leave a sweep with a lower bound of `NaN`,
    // which every thread is newer than — a backfill over the whole backlog
    // dressed up as a bounded one.
    const written = ["2026-13-01", "2026-00-01", "2026-01-32", "2026-01-00"];
    const messages = written.map((entry) => {
      try {
        parseSince(entry);
        return `${entry}: accepted`;
      } catch (error) {
        return `${entry}: ${(error as Error).message}`;
      }
    });

    expect(messages).toEqual(
      written.map((entry) => `${entry}: since: \`${entry}\` is not a real date.`),
    );
  });

  it("refuses a date-shaped `since` the calendar overflows", () => {
    // REGRESSION. `2026-02-30` is not a day that exists, and `Date` answers
    // with 2 March rather than `Invalid Date` — so the input used to be
    // accepted and silently meant a date two days later than the one written.
    // The line above already refuses `2026-01-32` and `2026-13-01` as "not a
    // real date"; 30 February is exactly as impossible, and a bound that
    // quietly moves is a bound nobody can reason about. The failure direction
    // was safe (a sweep narrowed rather than widened) — the inconsistency was
    // the bug.
    const written = ["2026-02-30", "2026-02-31", "2025-02-29", "2026-04-31", "2026-06-31"];
    const messages = written.map((entry) => {
      try {
        parseSince(entry);
        return `${entry}: accepted`;
      } catch (error) {
        return `${entry}: ${(error as Error).message}`;
      }
    });

    expect(messages).toEqual(
      written.map((entry) => `${entry}: since: \`${entry}\` is not a real date.`),
    );
  });

  it("still reads a real leap day, which is the boundary the overflow check must not eat", () => {
    expect(parseSince("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseSince("2026-12-31")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseSince("2026-01-01")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
