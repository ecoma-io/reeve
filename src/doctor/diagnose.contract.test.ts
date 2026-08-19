/**
 * What `doctor` says when the forge or the provider answers with something
 * other than the shape it hoped for.
 *
 * `diagnose.test.ts` drives the report's happy paths and its two red
 * configuration cases. This file drives the classifier — the function that
 * decides whether a failure is weather or a fault — against the answers that
 * are not `Error`-shaped at all, plus the two probe outcomes its own tests do
 * not reach.
 *
 * The reason this is worth a file rather than a footnote is D12: "capacity is
 * weather, authority is configuration". A classifier that crashed on a
 * rejection it did not expect, or that rendered `[object Object]` where a
 * reason belongs, would turn the one page a maintainer opens to find out
 * whether their configuration works into a page about the page.
 *
 * Every assertion is on the rendered finding, because the finding is the whole
 * product: doctor returns no other value a caller acts on.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackerApi } from "../core/forge.js";

import { diagnose, problems, type ProviderProbe, type Report } from "./diagnose.js";

const AT = { owner: "ecoma-io", repo: "reeve" };

const TAXONOMY = ["version: 1", "labels:", "  - name: bug", "    description: A defect."].join(
  "\n",
);

/** A `TrackerApi` whose labels listing always rejects with `reason`, whatever shape it is. */
function rejecting(reason: unknown): TrackerApi {
  return {
    rest: {
      issues: {
        // The whole point of this fake is the rejection shapes a transport
        // produces that are NOT `Error`s — a bare string, an object carrying
        // only a status. Building one through a rejected-then-thrown promise
        // keeps the lint rule's intent (never reject with a non-error by
        // accident) while still handing `diagnose` the shape under test.
        listLabelsForRepo: vi.fn(() =>
          Promise.resolve().then((): never => {
            throw reason;
          }),
        ),
      },
    },
  } as unknown as TrackerApi;
}

let scratch: string;
let warrantPath: string;
const probeFetch = vi.fn<typeof fetch>();

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "reeve-doctor-contract-"));
  warrantPath = join(scratch, "reeve.yml");
  probeFetch.mockReset();
  vi.stubGlobal("fetch", probeFetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(scratch, { recursive: true, force: true });
});

/** A report against a written warrant, so the labels check is the failing step. */
async function withWarrant(api: TrackerApi): Promise<Report> {
  await writeFile(warrantPath, TAXONOMY);
  return diagnose({ api, at: AT, warrantPath, defaultWarrantPath: warrantPath, duty: null });
}

/** A report with no warrant on disk, so building the implicit one is the failing step. */
function withoutWarrant(api: TrackerApi): Promise<Report> {
  return diagnose({
    api,
    at: AT,
    warrantPath,
    defaultWarrantPath: warrantPath,
    duty: null,
    workspaceDir: scratch,
  });
}

describe("a forge failure is classified, never crashed on", () => {
  it("renders a rejection that is not an Error rather than printing [object Object]", async () => {
    const report = await withWarrant(rejecting("the socket closed"));

    expect(problems(report)).toBe(1);
    expect(report.findings[0]?.text).toBe(
      "GET /repos/{owner}/{repo}/labels — could not be read: the socket closed.",
    );
  });

  it("reads a status off a plain rejected object, not only off an Error", async () => {
    // Some transports reject with a bare object carrying `status`. A classifier
    // that only understood `Error` would call a 401 "could not be read" and
    // bury the one failure a maintainer can actually fix.
    const report = await withWarrant(rejecting({ status: 401, toString: () => "Unauthorized" }));

    expect(problems(report)).toBe(1);
    expect(report.findings[0]?.text).toContain("refused this run's token (HTTP 401)");
  });

  it("treats a non-numeric status as no status at all", async () => {
    const report = await withWarrant(rejecting({ status: "401", toString: () => "Unauthorized" }));

    expect(problems(report)).toBe(1);
    expect(report.findings[0]?.text).toContain("could not be read");
    expect(report.findings[0]?.text).not.toContain("HTTP");
  });

  it("classifies the implicit warrant's own labels call the same way a written one's is", async () => {
    // The level-0 path reaches the forge through `resolveAuthority` rather than
    // through the taxonomy check, and it is the only network call that run
    // makes. Classifying it differently would make a rate limit fatal for a
    // repository with no warrant and weather for one with a warrant.
    const capacity = await withoutWarrant(
      rejecting(Object.assign(new Error("rate limited"), { status: 429 })),
    );

    expect(problems(capacity)).toBe(0);
    expect(capacity.findings[0]?.text).toContain("not performed, capacity");
    expect(capacity.authority).toEqual([]);
  });

  it("is red when the implicit warrant's labels call is refused this run's token", async () => {
    const refused = await withoutWarrant(
      rejecting(Object.assign(new Error("Bad credentials"), { status: 401 })),
    );

    expect(problems(refused)).toBe(1);
    expect(refused.findings[0]?.text).toContain("refused this run's token (HTTP 401)");
  });

  it("is red, naming the endpoint, when the implicit warrant's labels call fails otherwise", async () => {
    const broken = await withoutWarrant(rejecting(new Error("nope")));

    expect(problems(broken)).toBe(1);
    expect(broken.findings[0]?.text).toBe(
      "GET /repos/{owner}/{repo}/labels — could not be read: nope.",
    );
  });
});

describe("the provider probe reports a class of answer, never a provider's words", () => {
  function probe(models: readonly string[]): ProviderProbe {
    return {
      baseUrl: "http://provider.test/v1",
      apiKey: "probe-key",
      requestTimeoutMs: 5_000,
      models,
      modelNames: new Map(),
      endpoints: [],
      apiKeys: [],
    };
  }

  async function reportWithProbe(models: readonly string[]): Promise<Report> {
    await writeFile(warrantPath, TAXONOMY);
    return diagnose({
      api: {
        rest: {
          issues: {
            listLabelsForRepo: vi.fn(({ page }: { page?: number }) =>
              Promise.resolve({
                data: (page ?? 1) === 1 ? [{ name: "bug", description: "d" }] : [],
              }),
            ),
          },
        },
      } as unknown as TrackerApi,
      at: AT,
      warrantPath,
      defaultWarrantPath: warrantPath,
      duty: null,
      provider: probe(models),
    });
  }

  it("says `1 model` and not `1 models` when exactly one was rotated past", async () => {
    probeFetch.mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
      }),
    );

    const report = await reportWithProbe(["first", "second"]);
    const finding = report.findings.find((entry) => entry.text.startsWith("Provider probe"));

    expect(finding?.severity).toBe("green");
    expect(finding?.text).toContain("1 model rotated past before it");
    expect(finding?.text).not.toContain("1 models");
  });

  it("says `2 models` when more than one was rotated past", async () => {
    // The plural half of the same sentence. A report that said "2 model" would
    // be a report a maintainer stops reading.
    probeFetch
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
        }),
      );

    const report = await reportWithProbe(["first", "second", "third"]);
    const finding = report.findings.find((entry) => entry.text.startsWith("Provider probe"));

    expect(finding?.severity).toBe("green");
    expect(finding?.text).toContain("2 models rotated past before it");
  });

  it("says the endpoint answered outside the protocol when every model did", async () => {
    // A 200 whose body is not a chat completion. Weather, not a configuration
    // finding — and the class of failure is all that is reported, because a
    // provider's own body can echo the key it was sent.
    probeFetch.mockResolvedValue(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));

    const report = await reportWithProbe(["only"]);
    const finding = report.findings.find((entry) => entry.text.startsWith("Provider probe"));

    expect(finding?.severity).toBe("green");
    expect(finding?.text).toContain("answered outside the chat-completions protocol");
    expect(finding?.text).not.toContain("hello");
    expect(problems(report)).toBe(0);
  });

  it("says the endpoint answered with a rate limit when every model hit one", async () => {
    probeFetch.mockResolvedValue(new Response("slow down", { status: 429 }));

    const report = await reportWithProbe(["only"]);
    const finding = report.findings.find((entry) => entry.text.startsWith("Provider probe"));

    expect(finding?.severity).toBe("green");
    expect(finding?.text).toContain("answered with a rate limit or server error");
    expect(finding?.text).not.toContain("slow down");
  });
});
