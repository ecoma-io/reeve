/**
 * Tests for the dependa summary module.
 *
 * The summary renders a Markdown table of group results and appends
 * warnings for starved models or exhausted budget. These tests verify
 * the rendering logic and warning messages.
 */
import { describe, expect, it } from "vitest";

import type { GroupResult } from "./model.js";

import { summarize, renderSummary } from "./summary.js";
import type { Weather } from "../../core/provider.js";

// ── helpers ──────────────────────────────────────────────────────────────

function stubWeather(starvedModels: string[] = []): Weather {
  const starvedList = [...starvedModels];
  const groundedSet = new Set(starvedModels);
  return {
    grounded: (model: string) => groundedSet.has(model),
    ground: (model: string) => {
      groundedSet.add(model);
      starvedList.push(model);
    },
    groundEndpoint: () => {
      /* no-op for tests */
    },
    get starved() {
      return starvedList;
    },
    multiEndpoint: false,
    failAuth: () => {
      /* no-op for tests */
    },
    authExhausted: false,
    authFailures: [],
  };
}

function groupResult(overrides: Partial<GroupResult> = {}): GroupResult {
  return {
    group: {
      id: "npm",
      ecosystem: "npm",
      proposals: [
        {
          dependency: {
            ecosystem: "npm",
            name: "lodash",
            constraint: "^4.0.0",
            currentVersion: "4.17.21",
            manifestPath: "package.json",
            dev: false,
            manager: "npm",
          },
          currentVersion: "4.17.21",
          targetVersion: "4.17.22",
          updateType: "patch",
          releases: [],
          securityAdvisory: null,
          risk: {
            facts: {
              updateType: "patch",
              majorDistance: 0,
              minorDistance: 0,
              patchDistance: 1,
              daysBetweenReleases: null,
              currentVersionStale: null,
              isSecurity: false,
              hasChangelog: false,
              isDev: false,
            },
            interpretation: null,
          },
          evidence: [],
          edits: [],
          groupName: null,
        },
      ],
      security: false,
      lockfilePaths: [],
    },
    pr: null,
    outcome: "draft",
    refused: [],
    ...overrides,
  };
}

// ── summarize ────────────────────────────────────────────────────────────

describe("summarize", () => {
  it("creates a summary with group data", () => {
    const results = [groupResult()];
    const summary = summarize(results, stubWeather(), ["model-a"], false);

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.groupId).toBe("npm");
    expect(summary.groups[0]?.proposalCount).toBe(1);
    expect(summary.starved).toBe(false);
    expect(summary.budgetExhausted).toBe(false);
  });

  it("detects starved models", () => {
    const weather = stubWeather(["model-a"]);
    const summary = summarize([], weather, ["model-a"], false);
    expect(summary.starved).toBe(true);
  });

  it("reports budget exhaustion", () => {
    const summary = summarize([], stubWeather(), [], true);
    expect(summary.budgetExhausted).toBe(true);
  });
});

// ── renderSummary ────────────────────────────────────────────────────────

describe("renderSummary", () => {
  it("renders a Markdown table with group results", () => {
    const summary = summarize([groupResult()], stubWeather(), [], false);
    const rendered = renderSummary(summary);

    expect(rendered).toContain("## dependa");
    expect(rendered).toContain("| Group | Ecosystem | Updates | Outcome | PR |");
    expect(rendered).toContain("npm");
    expect(rendered).toContain("1"); // proposal count
    expect(rendered).toContain("draft"); // outcome
  });

  it("includes security marker for security groups", () => {
    const securityResult = groupResult({
      group: {
        id: "security",
        ecosystem: null,
        proposals: [],
        security: true,
        lockfilePaths: [],
      },
    });

    const summary = summarize([securityResult], stubWeather(), [], false);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("🛡️");
  });

  it("renders PR link when available", () => {
    const withPr = groupResult({ pr: 42, outcome: "opened" });
    const summary = summarize([withPr], stubWeather(), [], false);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("#42");
  });

  it("renders — for groups without a PR", () => {
    const noPr = groupResult({ pr: null });
    const summary = summarize([noPr], stubWeather(), [], false);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("—");
  });

  it("shows starved warning", () => {
    const weather = stubWeather(["model-a"]);
    const summary = summarize([], weather, ["model-a"], false);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("All models failed on capacity");
  });

  it("shows budget exhaustion warning", () => {
    const summary = summarize([], stubWeather(), [], true);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("Request budget exhausted");
  });

  it("shows refused count", () => {
    const withRefusal = groupResult({
      refused: [{ what: "express", why: "policy refused major" }],
    });
    const summary = summarize([withRefusal], stubWeather(), [], false);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("1 proposal(s) refused");
  });
});
