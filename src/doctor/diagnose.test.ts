import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "../core/forge.js";
import { DUTIES } from "../refusal.js";

import { diagnose, problems, type ProviderProbe, type Report } from "./diagnose.js";

const AT = { owner: "ecoma-io", repo: "reeve" };

const TAXONOMY =
  "version: 1\n" +
  "labels:\n" +
  "  - name: bug\n" +
  "    description: A defect.\n" +
  "  - name: docs\n" +
  "    description: Documentation is wrong or missing.\n";

const WITH_DUTIES = `${TAXONOMY}duties:\n  triage: [label]\n`;

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

const probeFetch = vi.fn<typeof fetch>();

/** A keyed, single-endpoint probe against a stub endpoint. */
function keyedProbe(): ProviderProbe {
  return {
    baseUrl: "http://provider.test/v1",
    apiKey: "probe-key",
    requestTimeoutMs: 5_000,
    models: ["probe-model"],
    modelNames: new Map(),
    endpoints: [],
    apiKeys: [],
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "reeve-doctor-"));
  warrantPath = join(scratch, "reeve.yml");
  probeFetch.mockReset();
  vi.stubGlobal("fetch", probeFetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(scratch, { recursive: true, force: true });
});

function probeJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

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
    // A checkout marker, standing for the repository the runner checked out —
    // the genuine level-0 absence is a file this repository never wrote, not a
    // runner that never had the repository.
    await writeFile(join(scratch, "README.md"), "some repository file");
    const result = await diagnose({
      api: labelsApi(["bug"]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
      workspaceDir: scratch,
    });

    expect(problems(result)).toBe(0);
    expect(result.implicit).toBe(true);
    expect(result.findings.some((finding) => finding.text.includes("narrowest authority"))).toBe(
      true,
    );
    expect(result.findings.some((finding) => finding.text.includes("checkout"))).toBe(false);
  });

  it("is red when the file is absent at the default path but no checkout ever reached the workspace", async () => {
    const missing = join(scratch, "reeve.yml");
    await mkdir(join(scratch, "empty-workspace"));
    const result = await diagnose({
      api: labelsApi(["bug"]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
      workspaceDir: join(scratch, "empty-workspace"),
    });

    expect(problems(result)).toBe(1);
    expect(result.implicit).toBe(true);
    expect(result.findings.some((finding) => finding.text.includes("actions/checkout"))).toBe(true);
  });

  it("is red when the file is absent at the default path and the workspace never existed at all", async () => {
    const missing = join(scratch, "reeve.yml");
    const result = await diagnose({
      api: labelsApi(["bug"]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
      workspaceDir: join(scratch, "no-such-workspace"),
    });

    expect(problems(result)).toBe(1);
    expect(result.findings.some((finding) => finding.text.includes("actions/checkout"))).toBe(true);
  });

  it("is green on a genuine level-0 absence when the workspace holds a checkout", async () => {
    const missing = join(scratch, "reeve.yml");
    await mkdir(join(scratch, ".git"));
    await writeFile(join(scratch, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = await diagnose({
      api: labelsApi(["bug"]),
      at: AT,
      warrantPath: missing,
      defaultWarrantPath: missing,
      duty: null,
      workspaceDir: scratch,
    });

    expect(problems(result)).toBe(0);
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

  it("says nothing about a `lifecycle:` labels check when the warrant never wrote one", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]));

    // Scoped to the `lifecycle:` labels-check finding specifically — the
    // aggregated default note (see the tests above) legitimately names every
    // duty running on its own default, `lifecycle` included, so a bare
    // substring match on "lifecycle" would collide with that unrelated note.
    expect(result.findings.some((finding) => finding.text.includes("lifecycle:"))).toBe(false);
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
    expect(triage).toEqual({
      duty: "triage",
      granted: ["label"],
      denied: false,
      isDefault: true,
      unused: [],
    });

    const respond = result.authority.find((row) => row.duty === "respond");
    expect(respond).toEqual({
      duty: "respond",
      granted: [],
      denied: false,
      isDefault: true,
      unused: [],
    });
  });

  it("marks a duty denied when a written `duties:` block does not name it", async () => {
    const result = await report(WITH_DUTIES, labelsApi(["bug", "docs"]));

    const respond = result.authority.find((row) => row.duty === "respond");
    expect(respond).toEqual({
      duty: "respond",
      granted: [],
      denied: true,
      isDefault: false,
      unused: [],
    });

    const triage = result.authority.find((row) => row.duty === "triage");
    expect(triage).toEqual({
      duty: "triage",
      granted: ["label"],
      denied: false,
      isDefault: true,
      unused: [],
    });
  });

  it("narrows lifecycle's granted capabilities to its own ladder, and notes what was filtered", async () => {
    const source = `${TAXONOMY}duties:\n  lifecycle: [label, comment, edit-body]\n`;
    const result = await report(source, labelsApi(["bug", "docs"]));

    const lifecycle = result.authority.find((row) => row.duty === "lifecycle");
    expect(lifecycle).toEqual({
      duty: "lifecycle",
      granted: ["label", "comment"],
      denied: false,
      isDefault: true,
      unused: ["edit-body"],
    });
  });

  it("leaves `unused` empty when the warrant grants nothing outside a duty's own ladder", async () => {
    const source = `${TAXONOMY}duties:\n  lifecycle: [label]\n`;
    const result = await report(source, labelsApi(["bug", "docs"]));

    const lifecycle = result.authority.find((row) => row.duty === "lifecycle");
    expect(lifecycle).toEqual({
      duty: "lifecycle",
      granted: ["label"],
      denied: false,
      isDefault: false,
      unused: [],
    });
  });

  it("scopes the authority table to one duty when `duty` names it", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]), "lifecycle");

    expect(result.authority).toHaveLength(1);
    expect(result.authority[0]?.duty).toBe("lifecycle");
  });

  it("names every duty running on its own default in one aggregated green note", async () => {
    const result = await report(TAXONOMY, labelsApi(["bug", "docs"]));

    const note = result.findings.find((finding) => finding.text.includes("built-in default"));
    expect(note?.severity).toBe("green");
    for (const duty of DUTIES) expect(note?.text).toContain(`\`${duty}\``);
  });

  it("leaves a duty a written block denies out of the default note — denied is not default", async () => {
    const result = await report(WITH_DUTIES, labelsApi(["bug", "docs"]));

    const note = result.findings.find((finding) => finding.text.includes("built-in default"));
    // `triage` is named with exactly its own default (`[label]`), so it is
    // still `isDefault: true` and belongs in the note. `respond` and the
    // other duties this block does not name are `denied: true` — a
    // real, designed answer, not a default, so they must not appear here.
    expect(note?.text).toContain("`triage`");
    expect(note?.text).not.toContain("`respond`");
    expect(note?.text).not.toContain("`duplicate`");
    expect(note?.text).not.toContain("`translate`");
    expect(note?.text).not.toContain("`lifecycle`");
    expect(note?.text).not.toContain("`harmonise`");
    expect(note?.text).not.toContain("`dependa`");
  });

  describe("the provider probe", () => {
    async function probed(
      provider: ProviderProbe,
      api: TrackerApi = labelsApi(["bug", "docs"]),
      duty: string | null = null,
    ): Promise<Report> {
      await mkdir(join(scratch, ".git"));
      await writeFile(join(scratch, ".git", "HEAD"), "ref: refs/heads/main\n");
      return diagnose({
        api,
        at: AT,
        warrantPath: warrantPath,
        defaultWarrantPath: warrantPath,
        duty,
        provider,
      });
    }

    it("is green when the probe sent no request at all for a keyless provider", async () => {
      probeFetch.mockRejectedValue(
        new Error("must not be called: keyless provider sends no probe"),
      );
      const result = await probed({ ...keyedProbe(), apiKey: "" });

      expect(probeFetch).not.toHaveBeenCalled();
      expect(problems(result)).toBe(0);
      expect(result.findings.some((finding) => finding.text.includes("keyless"))).toBe(true);
    });

    it("is green, not red, when every configured model answers", async () => {
      probeFetch.mockResolvedValueOnce(
        probeJson({
          choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        }),
      );

      const result = await probed(keyedProbe());

      expect(probeFetch).toHaveBeenCalledTimes(1);
      expect(problems(result)).toBe(0);
      const note = result.findings.find((finding) => finding.text.includes("Provider probe"));
      expect(note?.text).toContain("first configured model answered");
    });

    it("is green, never red, when the key is refused — weather, not authority", async () => {
      probeFetch.mockResolvedValueOnce(probeJson({ error: { message: "bad key" } }, 401));

      const result = await probed(keyedProbe());

      expect(problems(result)).toBe(0);
      const note = result.findings.find((finding) => finding.text.includes("Provider probe"));
      expect(note?.text).toContain("HTTP 401 or 403");
      expect(note?.severity).toBe("green");
    });

    it("is green, never red, when the endpoint is unreachable — weather, not authority", async () => {
      probeFetch.mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );

      const result = await probed(keyedProbe());

      expect(problems(result)).toBe(0);
      const note = result.findings.find((finding) => finding.text.includes("Provider probe"));
      expect(note?.text).toContain("could not be reached");
      expect(note?.severity).toBe("green");
    });

    it("is green, and names the models rotated past, when a model answers only after others fail", async () => {
      probeFetch
        .mockResolvedValueOnce(probeJson({ error: { message: "quota" } }, 429))
        .mockResolvedValueOnce(
          probeJson({
            choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          }),
        );

      const result = await probed({
        ...keyedProbe(),
        models: ["a", "b"],
        modelNames: new Map([["a", "A"]]),
      });

      expect(problems(result)).toBe(0);
      const note = result.findings.find((finding) => finding.text.includes("Provider probe"));
      expect(note?.text).toContain("first configured model answered");
      expect(note?.text).toContain("rotated past before it");
    });

    it("reports a provider refusal without ever printing a key", async () => {
      probeFetch.mockResolvedValueOnce(probeJson({ error: { message: "bad key" } }, 401));

      const result = await probed(keyedProbe());

      const page = result.findings.map((finding) => finding.text).join("\n");
      expect(page).not.toContain("probe-key");
    });

    it("keeps a key out of the summary even when a rate-limit body echoes it", async () => {
      probeFetch.mockResolvedValueOnce(
        probeJson({ error: { message: "quota exceeded for key probe-key" } }, 429),
      );

      const result = await probed(keyedProbe());

      expect(problems(result)).toBe(0);
      const page = result.findings.map((finding) => finding.text).join("\n");
      expect(page).not.toContain("probe-key");
    });

    it("keeps a key out of the summary even when a server-error body echoes it", async () => {
      probeFetch.mockResolvedValueOnce(probeJson({ error: { message: "boom probe-key" } }, 500));

      const result = await probed(keyedProbe());

      expect(problems(result)).toBe(0);
      const page = result.findings.map((finding) => finding.text).join("\n");
      expect(page).not.toContain("probe-key");
    });

    it("keeps a key out of the summary even when a fetch rejection mentions it", async () => {
      probeFetch.mockRejectedValueOnce(new Error("request failed — key probe-key rejected"));

      const result = await probed(keyedProbe());

      expect(problems(result)).toBe(0);
      const page = result.findings.map((finding) => finding.text).join("\n");
      expect(page).not.toContain("probe-key");
    });
  });
});
