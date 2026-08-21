/**
 * The offline harness itself, pinned — the stub every eval fixture and every
 * `pnpm eval` run stands on.
 *
 * Nothing else in this suite touches `eval/harness.ts`. That matters more than
 * it looks: the harness is the whole world a duty's bundle sees during an eval
 * run, so a harness that answered a route it should not have, or that stopped
 * refusing an unmounted one, would not make a fixture red — it would make one
 * PASS for the wrong reason, quietly, across every duty at once. `pnpm eval
 * all` is a required check, and a required check whose stub can go soft is a
 * check that stops meaning anything.
 *
 * So what is pinned here is the harness's fail-loud posture and the two
 * response shapes it has already got wrong once (see `publishRoutes`'s own
 * comment about a list endpoint answered as `{ data: [] }`):
 *
 * - a request nothing mounted is a 404 that names what was asked for;
 * - the completion endpoint checks the bearer token it was given;
 * - a list endpoint answers a bare JSON array, the way Octokit reads one;
 * - a blob nobody minted is absent, never an empty file.
 *
 * No bundle is spawned and no duty is involved: these are the harness's own
 * routes, driven with `fetch` against a stub started for the case.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  askOf,
  completionRoute,
  failing,
  publishRoutes,
  repoRoutes,
  saying,
  shaOf,
  startStub,
  type ContentMap,
  type Route,
  type Scoped,
} from "../harness.ts";

let stub: Scoped | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** Starts a stub for one case, remembered so `afterEach` can close it. */
async function started(routes: readonly Route[], completion = () => saying("fallback")) {
  stub = await startStub({ routes, completion });
  return stub;
}

/** The fixture's own files, as a driver hands them to `repoRoutes`. */
function contents(entries: Readonly<Record<string, string>>): ContentMap {
  const map: ContentMap = new Map();
  for (const [path, content] of Object.entries(entries)) {
    map.set(path, { content, sha: shaOf(content) });
  }
  return map;
}

async function get(url: string): Promise<Response> {
  return fetch(url, { method: "GET" });
}

async function completion(url: string, key: string, model = "stub-model"): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("the harness refuses what it was never given", () => {
  it("answers a request nothing mounted with a 404 that names the method and the path", async () => {
    // The loud failure the harness's own doc comment promises: a fixture whose
    // duty reached an endpoint no driver mounted must not get a plausible
    // answer, because a plausible answer is how a wrong fixture goes green.
    const running = await started([]);

    const response = await get(`${running.url}/repos/ecoma-io/reeve/issues/1`);
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(404);
    expect(body.message).toBe("no stub for GET /repos/ecoma-io/reeve/issues/1");
  });

  it("refuses a completion whose bearer token is not the endpoint's key", async () => {
    // The one thing every duty's provider seam does before anything else is
    // send its key. A stub that answered without checking would let a fixture
    // pass against a run that never configured one.
    const running = await started([]);

    const response = await completion(running.url, "wrong-key");
    const body = (await response.json()) as { error?: { message?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.message).toBe("invalid api key");
    // Recorded even so: what was asked is what the driver reads back, and a
    // refused request is still a request the run spent.
    expect(running.asked).toHaveLength(1);
  });

  it("records each ask the fallback answered, split into its system and user turns", async () => {
    const running = await started([]);

    await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-stub-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "stub-model",
        messages: [
          { role: "system", content: "the rules" },
          { role: "user", content: "the thread" },
        ],
      }),
    });

    expect(running.asked).toEqual([
      { model: "stub-model", system: "the rules", user: "the thread" },
    ]);
  });

  it("leaves an ask a mounted completion route answered out of `asked` — that log is the fallback's", async () => {
    // A trap worth naming rather than discovering: `completionRoute` owns the
    // request and returns before the recording step, so a driver that mounts
    // its own completion route (harmonise does) reads an EMPTY `asked`. A
    // driver that wants the log must script through `completion:` instead.
    const running = await started([completionRoute(() => saying("routed"))]);

    const response = await completion(running.url, "sk-stub-key");
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };

    expect(body.choices?.[0]?.message?.content).toBe("routed");
    expect(running.asked).toEqual([]);
  });

  it("scripts an outage on the wire, where rotation reads it — never as content", async () => {
    // `rotateModels` classifies from the status line, so a harness that
    // delivered a failure as a 200 carrying an error string would be
    // exercising a rotation that never happened.
    const running = await started([completionRoute(() => failing(429, "out of quota"))]);

    const response = await completion(running.url, "sk-stub-key");
    const body = (await response.json()) as { error?: { message?: string } };

    expect(response.status).toBe(429);
    expect(body.error?.message).toBe("out of quota");
  });
});

describe("the repository routes answer the shapes Octokit reads", () => {
  it("lists every fixture file in a recursive tree, and nothing at all without the flag", async () => {
    const running = await started(repoRoutes(contents({ "docs/a.md": "A", "docs/a.vi.md": "B" })));

    const recursive = (await (
      await get(`${running.url}/repos/ecoma-io/reeve/git/trees/main-sha?recursive=true`)
    ).json()) as { tree: { path: string }[] };
    const shallow = (await (
      await get(`${running.url}/repos/ecoma-io/reeve/git/trees/main-sha`)
    ).json()) as { tree: unknown[] };

    expect(recursive.tree.map((entry) => entry.path)).toEqual(["docs/a.md", "docs/a.vi.md"]);
    expect(shallow.tree).toEqual([]);
  });

  it("answers a blob sha nothing minted as absent, never as an empty file", async () => {
    // An empty file is a document a duty would happily "synchronise". Absent
    // is the only honest answer for a revision the fixture never had.
    const running = await started(repoRoutes(contents({ "docs/a.md": "A" })));

    const missing = await get(`${running.url}/repos/ecoma-io/reeve/git/blobs/sha-nothing`);
    const found = await get(`${running.url}/repos/ecoma-io/reeve/git/blobs/${shaOf("A")}`);
    const body = (await found.json()) as { content: string; encoding: string };

    expect(missing.status).toBe(404);
    expect(found.status).toBe(200);
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("A");
  });

  it("answers a contents path the fixture does not have as a 404, not as an empty document", async () => {
    const running = await started(repoRoutes(contents({ "docs/a.md": "A" })));

    const response = await get(`${running.url}/repos/ecoma-io/reeve/contents/docs/missing.md`);

    expect(response.status).toBe(404);
  });

  it("answers a pull request listing with a bare array, the way a caller destructures it", async () => {
    // The regression this route already had once: answering `{ data: [] }`
    // wrapped the array a level too deep, so `data[0]` read as "no pull
    // request" and `data.find(...)` threw. Both were invisible until a caller
    // used `find`.
    const running = await started(publishRoutes(contents({})));

    const response = await get(`${running.url}/repos/ecoma-io/reeve/pulls`);
    const body: unknown = await response.json();

    expect(Array.isArray(body)).toBe(true);
  });

  it("reads a request body with no messages at all without throwing", () => {
    // Every route is handed the raw body, and a duty that sent something
    // unexpected must reach the route's own refusal rather than crash the
    // stub — a crashed stub fails every later fixture in the same run.
    expect(askOf(JSON.stringify({ model: "m" }))).toEqual({ model: "m", system: "", user: "" });
  });
});

describe("the sha the stub mints", () => {
  it("is the same for the same content and different for different content", () => {
    // The blob route looks a revision up BY sha, so two files that hashed the
    // same would serve each other's content to a duty diffing them.
    expect(shaOf("one")).toBe(shaOf("one"));
    expect(shaOf("one")).not.toBe(shaOf("two"));
    expect(shaOf("")).toMatch(/^sha-[0-9a-f]{8}$/);
  });
});
