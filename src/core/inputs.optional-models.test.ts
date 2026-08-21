/**
 * The one shared input whose requirement is not the same for every duty.
 *
 * `models` is required everywhere except in a duty whose work is decidable
 * without a model at all — `dependa` reads a lockfile and a registry, and asks
 * a model only for the risk note on top. `readCore({ modelsOptional: true })`
 * is how that duty says so, and it is the only branch of the shared reader
 * that is allowed to hand back an empty roster.
 *
 * `inputs.test.ts` pins that the ordinary path refuses an empty `models`. What
 * is pinned here is that the exception is real in both directions: the flag
 * actually lets an empty roster through, and it is the flag rather than the
 * emptiness that does it.
 *
 * `@actions/core` is kept real and driven through the environment, the same as
 * next door: `INPUT_MODELS` is what `with: models:` compiles to.
 */
import type * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCore } from "./inputs.js";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setSecret: vi.fn(),
}));

vi.mock("@actions/github", () => ({ context: { issue: {} } }));

const COMPLETE = {
  "github-token": "ghs_token",
  "base-url": "https://api.openai.com/v1",
  "api-key": "",
  models: "",
  "dry-run": "false",
  endpoints: "",
  "api-keys": "",
  "request-timeout": "120s",
  temperature: "",
};

function given(inputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.toUpperCase()}`] = value;
  }
}

const environment = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...environment };
});

describe("readCore with models optional", () => {
  it("reads an empty roster rather than failing a duty that asks no model", () => {
    // The supported configuration this exists for. A duty whose findings are
    // computed from a manifest must run for a repository that configured no
    // model at all — refusing here would make a model mandatory for work no
    // model does.
    given(COMPLETE);

    const shared = readCore({ modelsOptional: true });

    expect(shared.models).toEqual([]);
    expect(shared.modelNames).toEqual(new Map());
  });

  it("reads a value that is only separators as an empty roster too", () => {
    // `models: ", ,"` clears the requirement `getInput` checks and still names
    // no model. Under the flag that is the same empty roster as a blank input,
    // not a second way to fail.
    given({ ...COMPLETE, models: " , , " });

    expect(readCore({ modelsOptional: true }).models).toEqual([]);
  });

  it("still refuses that same value for every duty that did not ask", () => {
    // The exception is the flag's, not the input's. Without it, a `models`
    // naming no model is what it has always been: a workflow with a rotation
    // that has nowhere to go.
    given({ ...COMPLETE, models: " , , " });

    expect(() => readCore()).toThrow("models: no entries. Expected at least one model id.");
    expect(() => readCore({ modelsOptional: false })).toThrow(/models: no entries/);
  });

  it("reads a roster the ordinary way when one is configured, flag or no flag", () => {
    // The flag relaxes a requirement; it must not change what a configured
    // value means.
    given({ ...COMPLETE, models: "gpt-4o-mini = Quick, gpt-4o" });

    const shared = readCore({ modelsOptional: true });

    expect(shared.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(shared.modelNames.get("gpt-4o-mini")).toBe("Quick");
  });

  it("keeps every other input required, so a missing token is still a refused run", () => {
    given({ ...COMPLETE, "github-token": "" });

    expect(() => readCore({ modelsOptional: true })).toThrow(/required/i);
  });
});
