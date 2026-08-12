import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "../core/forge.js";

import { diagnose, problems, type Report } from "./diagnose.js";

const AT = { owner: "ecoma-io", repo: "reeve" };

const TAXONOMY =
  "version: 1\n" +
  "labels:\n" +
  "  - name: bug\n" +
  "    description: A defect.\n" +
  "  - name: docs\n" +
  "    description: Documentation is wrong or missing.\n";

const WITH_CAPABILITIES = `${TAXONOMY}capabilities:\n  triage: [label]\n`;

const WITH_LIFECYCLE =
  TAXONOMY +
  "lifecycle:\n" +
  "  tracks:\n" +
  "    - name: stale\n" +
  "      when: needs-info\n" +
  "      steps:\n" +
  "        - label: stale\n" +
  "          after: 14d\n" +
  "  exempt:\n" +
  "    labels: [pinned]\n";

/** A fake `TrackerApi` answering `listLabelsForRepo` from a fixed list — page two always ends the walk. */
function labelsApi(names: readonly string[]): TrackerApi {
  return {
    rest: {
      issues: {
        listLabelsForRepo: vi.fn(({ page }: { page?: number }) =>
          Promise.resolve({
            data: (page ?? 1) === 1 ? names.map((name) => ({ name, description: "d" })) : [],
          }),
        ),
      },
    },
  } as unknown as TrackerApi;
}

/** A fake `TrackerApi` whose labels listing always rejects with `error`. */
function failingApi(error: Error): TrackerApi {
  return {
    rest: { issues: { listLabelsForRepo: vi.fn(() => Promise.reject(error)) } },
  } as unknown as TrackerApi;
}

let scratch: string;
let warrantPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "reeve-doctor-"));
  warrantPath = join(scratch, "reeve.yml");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function report(
  source: string,
  api: TrackerApi,
  duty: string | null = null,
): Promise<Report> {
  await writeFile(warrantPath, source);
  return diagnose({ api, at: AT, warrantPath, defaultWarrantPath: warrantPath, duty });
}

describe("diagnose", () => {
  it("is red when `duty` names something this build has never heard of", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]), "not-a-real-duty");

    expect(problems(result)).toBe(1);
    expect(result.findings[0]?.severity).toBe("red");
    expect(result.findings[0]?.text).toContain("`not-a-real-duty` is not a duty");
    expect(result.authority).toEqual([]);
  });

  it("is red when the warrant does not parse", async () => {
    const result = await report("version: 2\nlabels: []\n", labelsApi([]));

    expect(problems(result)).toBe(1);
    expect(result.findings[0]?.severity).toBe("red");
    expect(result.findings[0]?.text).toContain("declares version");
  });

  it("is red when a path a consumer named explicitly has no file at it", async () => {
    const missing = join(scratch, "nowhere.yml");
    const result = await diagnose({
      api: labelsApi([]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: warrantPath,
      duty: null,
    });

    expect(problems(result)).toBe(1);
    expect(result.findings[0]?.text).toContain("could not be read");
  });

  it("is green, and reports the narrowest authority, when the file is absent at the default path", async () => {
    const missing = join(scratch, "reeve.yml");
    const result = await diagnose({
      api: labelsApi(["bug"]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
    });

    expect(problems(result)).toBe(0);
    expect(result.implicit).toBe(true);
    expect(result.findings.some((finding) => finding.text.includes("narrowest authority"))).toBe(
      true,
    );
  });

  it("names labels left out of the implicit taxonomy for carrying no description", async () => {
    const missing = join(scratch, "reeve.yml");
    const api = {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(({ page }: { page?: number }) =>
            Promise.resolve({
              data:
                (page ?? 1) === 1
                  ? [
                      { name: "bug", description: null },
                      { name: "docs", description: "d" },
                    ]
                  : [],
            }),
          ),
        },
      },
    } as unknown as TrackerApi;

    const result = await diagnose({
      api,
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
    });

    expect(problems(result)).toBe(0);
    expect(result.excludedLabels).toEqual(["bug"]);
    expect(result.findings.some((finding) => finding.text.includes("`bug`"))).toBe(true);
  });

  it("is green when every label the warrant names exists", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]));

    expect(problems(result)).toBe(0);
    expect(
      result.findings.some((finding) => finding.text.includes("exists on this repository")),
    ).toBe(true);
  });

  it("is red when the warrant names a label this repository does not have", async () => {
    const result = await report(TAXONOMY, labelsApi(["docs"]));

    expect(problems(result)).toBe(1);
    expect(result.findings[0]?.severity).toBe("red");
    expect(result.findings[0]?.text).toContain("`bug`");
  });

  it("is green, not red, when a missing label is marked `create: true`", async () => {
    const source = `${TAXONOMY}  - name: security\n    description: A security report.\n    create: true\n`;
    const result = await report(source, labelsApi(["bug", "docs"]));

    expect(problems(result)).toBe(0);
    expect(result.findings.some((finding) => finding.text.includes("`security`"))).toBe(true);
    expect(result.findings.some((finding) => finding.text.includes("create: true"))).toBe(true);
  });

  it("checks a `lifecycle:` policy's own labels, separately from the taxonomy", async () => {
    const result = await report(WITH_LIFECYCLE, labelsApi(["bug", "docs", "needs-info"]));

    expect(problems(result)).toBe(1);
    expect(
      result.findings.some(
        (finding) => finding.severity === "red" && /stale|pinned/.test(finding.text),
      ),
    ).toBe(true);
  });

  it("says nothing about `lifecycle:` when the warrant never wrote one", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]));

    expect(result.findings.some((finding) => finding.text.includes("lifecycle"))).toBe(false);
  });

  it("is green, weather, when the labels endpoint fails on capacity — and names the endpoint", async () => {
    const error = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const result = await report(TAXONOMY, failingApi(error));

    expect(problems(result)).toBe(0);
    expect(result.findings[0]?.severity).toBe("green");
    expect(result.findings[0]?.text).toContain("GET /repos/{owner}/{repo}/labels");
    expect(result.findings[0]?.text).toContain("not performed");
  });

  it("is red when the labels endpoint refuses this run's token", async () => {
    const error = Object.assign(new Error("Bad credentials"), { status: 401 });
    const result = await report(TAXONOMY, failingApi(error));

    expect(problems(result)).toBe(1);
    expect(result.findings[0]?.severity).toBe("red");
    expect(result.findings[0]?.text).toContain("HTTP 401");
    expect(result.findings[0]?.text).toContain("GET /repos/{owner}/{repo}/labels");
  });

  it("builds an effective-authority row per duty, from each duty's own default", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]));

    const triage = result.authority.find((row) => row.duty === "triage");
    expect(triage).toEqual({ duty: "triage", granted: ["label"], denied: false, isDefault: true });

    const respond = result.authority.find((row) => row.duty === "respond");
    expect(respond).toEqual({ duty: "respond", granted: [], denied: false, isDefault: true });
  });

  it("marks a duty denied when a written `capabilities:` block does not name it", async () => {
    const result = await report(WITH_CAPABILITIES, labelsApi(["bug", "docs"]));

    const respond = result.authority.find((row) => row.duty === "respond");
    expect(respond).toEqual({ duty: "respond", granted: [], denied: true, isDefault: false });

    const triage = result.authority.find((row) => row.duty === "triage");
    expect(triage).toEqual({ duty: "triage", granted: ["label"], denied: false, isDefault: true });
  });

  it("scopes the authority table to one duty when `duty` names it", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]), "lifecycle");

    expect(result.authority).toHaveLength(1);
    expect(result.authority[0]?.duty).toBe("lifecycle");
  });
});
