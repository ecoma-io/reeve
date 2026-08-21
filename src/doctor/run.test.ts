import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Report } from "./diagnose.js";
import { providerConfig, runDoctor } from "./run.js";

// `runDoctor` is the adapter between the decision logic (`diagnose`,
// `problems`, `summarize`) and the runner's effects (`setOutput`,
// `setFailed`, `writeSummary`) — the same shape as every duty's `main.ts`,
// which this repository tests by driving a built bundle. `runDoctor` was
// split out of `main.ts` precisely so this adapter could be tested directly
// rather than only through a spawned bundle: the decisions here are the
// normalisation of the `duty` input and the exact words of the failure.

const PROVIDER_INPUTS = [
  "base-url",
  "api-key",
  "models",
  "request-timeout",
  "endpoints",
  "api-keys",
];

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  getInput: vi.fn((name: string) => {
    if (name === "github-token") return "token";
    if (name === "warrant") return ".github/reeve.yml";
    if (name === "duty") return "";
    if (PROVIDER_INPUTS.includes(name)) return "";
    throw new Error(`unexpected input ${name}`);
  }),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "acme", repo: "widgets" } },
  getOctokit: vi.fn(() => ({})),
}));

vi.mock("./diagnose.js", () => ({
  diagnose: vi.fn(),
  problems: vi.fn(),
}));

const { diagnose } = await import("./diagnose.js");
const { problems } = await import("./diagnose.js");

const REPORT: Report = {
  warrantPath: ".github/reeve.yml",
  owner: "acme",
  repo: "widgets",
  duty: null,
  implicit: false,
  excludedLabels: [],
  authority: [],
  findings: [],
};

beforeEach(() => {
  vi.mocked(core.setOutput).mockClear();
  vi.mocked(core.setFailed).mockClear();
  vi.mocked(core.setSecret).mockClear();
  vi.mocked(core.getInput).mockClear();
  vi.mocked(diagnose).mockClear();
  vi.mocked(diagnose).mockResolvedValue(REPORT);
  vi.mocked(problems).mockReturnValue(0);
});

describe("runDoctor", () => {
  it("reads the same three inputs the action contract names, in the same places", async () => {
    await runDoctor();

    expect(core.getInput).toHaveBeenCalledWith("github-token", { required: true });
    expect(core.getInput).toHaveBeenCalledWith("warrant", { required: true });
    expect(core.getInput).toHaveBeenCalledWith("duty");
  });

  it("passes a normalised duty through, so a scoped doctor run reads the spelling the user meant", async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "duty" ? "  Triage  " : name === "warrant" ? "default" : "",
    );

    await runDoctor();

    expect(diagnose).toHaveBeenCalledWith(
      expect.objectContaining({
        duty: "triage",
        at: { owner: "acme", repo: "widgets" },
        warrantPath: "default",
      }),
    );
  });

  it("turns a whitespace-only duty into no duty at all", async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "duty" ? "   \n  " : name === "warrant" ? "default" : "",
    );

    await runDoctor();

    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ duty: null }));
  });

  it("reports the number of findings as an output, even when there are none", async () => {
    vi.mocked(problems).mockReturnValue(2);

    await runDoctor();

    expect(core.setOutput).toHaveBeenCalledWith("problems", "2");
  });

  it("fails red when any finding would refuse a duty, pluralised", async () => {
    vi.mocked(problems).mockReturnValue(2);

    await runDoctor();

    expect(core.setFailed).toHaveBeenCalledWith(
      "doctor: 2 findings would refuse a duty at runtime — see the job summary.",
    );
  });

  it("says so in the singular for exactly one finding", async () => {
    vi.mocked(problems).mockReturnValue(1);

    await runDoctor();

    expect(core.setFailed).toHaveBeenCalledWith(
      "doctor: 1 finding would refuse a duty at runtime — see the job summary.",
    );
  });

  it("does not fail the job when a report is clean", async () => {
    await runDoctor();

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("fails loud with the error's own words when something above the report throws", async () => {
    // The safety net's contract, not a happy path: `diagnose` is built to
    // turn every failure it can name into a finding, so what lands here is
    // the unexpected — and it gets the same D5 treatment as a refused run.
    vi.mocked(diagnose).mockRejectedValue(new Error("the build did not anticipate this"));

    await runDoctor();

    expect(core.setFailed).toHaveBeenCalledWith("the build did not anticipate this");
  });
});

describe("providerConfig", () => {
  it("returns undefined when a base-url is set but no model is — nothing exists to probe", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "base-url" ? "http://provider.test/v1" : "",
    );

    expect(providerConfig()).toBeUndefined();
  });

  it("registers the default endpoint's api-key as a secret before anything else runs", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "base-url"
        ? "http://provider.test/v1"
        : name === "api-key"
          ? "probe-key"
          : name === "models"
            ? "probe-model"
            : "",
    );

    providerConfig();

    expect(core.setSecret).toHaveBeenCalledWith("probe-key");
  });

  it("refuses an `api-keys` alias `endpoints` never declared — the check every duty runs", () => {
    // `readCore` refuses this configuration before a single request, so a
    // doctor report that called it clean would be reporting on a run that
    // cannot happen.
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "base-url"
        ? "http://provider.test/v1"
        : name === "models"
          ? "probe-model"
          : name === "endpoints"
            ? "spare = http://spare.test/v1"
            : name === "api-keys"
              ? "spair = k"
              : "",
    );

    expect(() => providerConfig()).toThrow("api-keys: `spair` is not declared in `endpoints`.");
  });

  it("reports that refusal through runDoctor's setFailed rather than a clean report", async () => {
    vi.mocked(core.getInput).mockImplementation((name: string) =>
      name === "github-token"
        ? "token"
        : name === "warrant"
          ? ".github/reeve.yml"
          : name === "base-url"
            ? "http://provider.test/v1"
            : name === "models"
              ? "probe-model"
              : name === "api-keys"
                ? "spare = k"
                : "",
    );

    await runDoctor();

    expect(core.setFailed).toHaveBeenCalledWith(
      "api-keys: `spare` is not declared in `endpoints`.",
    );
    expect(diagnose).not.toHaveBeenCalled();
  });
});
