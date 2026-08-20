/**
 * Tests for the dependa inputs module.
 *
 * Covers input parsing, the dry-run boolean fix (getBooleanInput), ecosystem
 * validation, and path parsing.
 *
 * Note: readCore() (the shared input reader) requires at least one model.
 * Dependa's pipeline works without models (they are optional for risk
 * interpretation), but the shared core still enforces the constraint.
 * Our tests provide a mock model to satisfy this.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock @actions/core so we can control inputs
const mockInputs: Record<string, string> = {
  "github-token": "mock-token",
  warrant: ".github/reeve.yml",
  ecosystems: "",
  "risk-interpretation": "false",
  "dry-run": "false",
  "max-requests": "none",
  paths: "",
  "base-url": "https://api.openai.com/v1",
  "api-key": "",
  models: "gpt-4o",
  "request-timeout": "120s",
  temperature: "",
  endpoints: "",
  "api-keys": "",
};

vi.mock("@actions/core", () => ({
  getInput: vi.fn((name: string, _opts?: { required?: boolean }) => {
    return mockInputs[name] ?? "";
  }),
  getBooleanInput: vi.fn((name: string) => {
    return (mockInputs[name] ?? "false") === "true";
  }),
  setSecret: vi.fn(),
}));

import { readSettings } from "./inputs.js";

beforeEach(() => {
  // Reset to defaults before each test
  Object.assign(mockInputs, {
    "github-token": "mock-token",
    warrant: ".github/reeve.yml",
    ecosystems: "",
    "risk-interpretation": "false",
    "dry-run": "false",
    "max-requests": "none",
    paths: "",
    "base-url": "https://api.openai.com/v1",
    "api-key": "",
    models: "gpt-4o",
    "request-timeout": "120s",
    temperature: "",
    endpoints: "",
    "api-keys": "",
  });
});

describe("readSettings — dry-run", () => {
  it("parses dry-run as false by default", () => {
    mockInputs["dry-run"] = "false";
    const settings = readSettings();
    expect(settings.dryRun).toBe(false);
  });

  it("parses dry-run as true when set to true", () => {
    mockInputs["dry-run"] = "true";
    const settings = readSettings();
    expect(settings.dryRun).toBe(true);
  });

  it("uses getBooleanInput for dry-run (not string comparison)", async () => {
    const core = await import("@actions/core");
    const getBooleanInput = vi.mocked(core.getBooleanInput);

    // The old bug was: getInput("dry-run") !== "false" which defaults to true
    // when the input is empty. getBooleanInput handles empty as false.
    readSettings();
    expect(getBooleanInput).toHaveBeenCalledWith("dry-run");
  });

  it("defaults dry-run to false when input is empty (regression test)", () => {
    // The old bug: core.getInput("dry-run") !== "false" → "" !== "false" → true
    // The fix: core.getBooleanInput("dry-run") → false for empty
    mockInputs["dry-run"] = "";
    const settings = readSettings();
    expect(settings.dryRun).toBe(false);
  });
});

describe("readSettings — ecosystems", () => {
  it("parses ecosystems as empty when not specified", () => {
    mockInputs.ecosystems = "";
    const settings = readSettings();
    expect(settings.ecosystems).toEqual([]);
  });

  it("parses known ecosystems", () => {
    mockInputs.ecosystems = "npm,cargo";
    const settings = readSettings();
    expect(settings.ecosystems).toEqual(["npm", "cargo"]);
  });

  it("rejects unknown ecosystem names", () => {
    mockInputs.ecosystems = "npm,unknown-eco";
    expect(() => readSettings()).toThrow("unknown-eco");
  });

  it("deduplicates ecosystems", () => {
    mockInputs.ecosystems = "npm,npm,cargo";
    const settings = readSettings();
    expect(settings.ecosystems).toEqual(["npm", "cargo"]);
  });

  it("parses newline-separated ecosystems", () => {
    mockInputs.ecosystems = "npm\ncargo";
    const settings = readSettings();
    expect(settings.ecosystems).toEqual(["npm", "cargo"]);
  });

  it("parses all known ecosystems", () => {
    mockInputs.ecosystems = "npm,cargo,go,github-actions,docker";
    const settings = readSettings();
    expect(settings.ecosystems).toEqual(["npm", "cargo", "go", "github-actions", "docker"]);
  });
});

describe("readSettings — paths", () => {
  it("parses paths as empty when not specified", () => {
    mockInputs.paths = "";
    const settings = readSettings();
    expect(settings.paths).toEqual([]);
  });

  it("parses comma-separated paths", () => {
    mockInputs.paths = "src/,packages/app/";
    const settings = readSettings();
    expect(settings.paths).toEqual(["src/", "packages/app/"]);
  });

  it("parses newline-separated paths", () => {
    mockInputs.paths = "src/\npackages/app/";
    const settings = readSettings();
    expect(settings.paths).toEqual(["src/", "packages/app/"]);
  });

  it("trims whitespace from paths", () => {
    mockInputs.paths = "  src/  ,  packages/app/  ";
    const settings = readSettings();
    expect(settings.paths).toEqual(["src/", "packages/app/"]);
  });
});

describe("readSettings — risk-interpretation", () => {
  it("is off by default, so the default run makes no model call", () => {
    const settings = readSettings();
    expect(settings.riskInterpretation).toBe(false);
  });

  it("reads true as opting in", () => {
    mockInputs["risk-interpretation"] = "true";
    const settings = readSettings();
    expect(settings.riskInterpretation).toBe(true);
  });
});
