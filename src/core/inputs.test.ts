import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readShared, threadNumber, whole } from "./inputs.js";

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
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      dryRun: false,
    });
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
