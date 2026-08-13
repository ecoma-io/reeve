import { beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "@actions/core";

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  info: vi.fn(),
  warning: vi.fn(),
}));

import type { ContentsApi, Location } from "../../core/forge.js";
import { formatCorrection, type Correction } from "../../core/memory.js";

import {
  attemptWrite,
  commitMessage,
  isShaConflict,
  monthShard,
  repoRelativePath,
  writeCorrection,
} from "./store.js";

const AT: Location = { owner: "acme", repo: "widgets", number: 42 };

beforeEach(() => {
  vi.clearAllMocks();
});

function correctionOf(over: Partial<Correction> = {}): Correction {
  return {
    repo: "acme/widgets",
    thread: 42,
    duty: "triage",
    at: "2026-08-01T00:00:00Z",
    title: "Dark mode setting is lost between sessions",
    excerpt: "It resets every time I close the app.",
    language: "en",
    proposed: [],
    decided: ["bug"],
    by: "maintainer",
    note: null,
    outcome: null,
    duplicateOf: null,
    pivot: null,
    ...over,
  };
}

function notFoundError(): { status: number } & Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

/** One write `createOrUpdateFileContents` recorded. */
interface Write {
  readonly path: string;
  readonly content: string;
  readonly sha: string | undefined;
  readonly branch: string | undefined;
}

/** One `getContent` read recorded. */
interface Read {
  readonly path: string;
  readonly ref: string | undefined;
}

/**
 * A writable, in-memory Contents API: `files` seeds what already exists —
 * `null` for a shard that is present but unreadable (over the 1 MB the real
 * API can inline) — and every write lands back in the same map, so a test can
 * chain a write and a follow-up read against it.
 *
 * `conflictOnce`, when set, answers the first write to that exact path with a
 * 409 and only then accepts it — `writeCorrection`'s one retry path.
 */
function contentsOf(
  files: Record<string, string | null>,
  options: { readonly conflictOnce?: string } = {},
): { readonly api: ContentsApi; readonly writes: Write[]; readonly reads: Read[] } {
  const state = new Map(Object.entries(files));
  const writes: Write[] = [];
  const reads: Read[] = [];
  let conflicted = false;

  const api: ContentsApi = {
    rest: {
      repos: {
        getContent: (params: { path: string; ref?: string }) => {
          const { path, ref } = params;
          reads.push({ path, ref });
          if (state.has(path)) {
            const content = state.get(path) ?? null;
            if (content === null) {
              return Promise.resolve({
                data: { sha: `sha-${path}`, content: "", encoding: "none" },
              });
            }
            return Promise.resolve({
              data: {
                sha: `sha-${path}`,
                content: Buffer.from(content, "utf8").toString("base64"),
                encoding: "base64",
              },
            });
          }
          const prefix = `${path.replace(/\/+$/, "")}/`;
          const children = [...state.keys()].filter((entry) => entry.startsWith(prefix));
          if (children.length > 0) {
            return Promise.resolve({
              data: children.map((entry) => ({
                name: entry.slice(prefix.length),
                path: entry,
                sha: `sha-${entry}`,
              })),
            });
          }
          return Promise.reject(notFoundError());
        },
        createOrUpdateFileContents: (params: {
          path: string;
          content: string;
          sha?: string;
          branch?: string;
        }) => {
          if (options.conflictOnce === params.path && !conflicted) {
            conflicted = true;
            return Promise.reject(Object.assign(new Error("sha conflict"), { status: 409 }));
          }
          const content = Buffer.from(params.content, "base64").toString("utf8");
          state.set(params.path, content);
          writes.push({ path: params.path, content, sha: params.sha, branch: params.branch });
          return Promise.resolve(undefined);
        },
      },
    },
  };

  return { api, writes, reads };
}

describe("repoRelativePath", () => {
  it("leaves a relative path untouched", () => {
    expect(repoRelativePath("corrections")).toBe("corrections");
  });

  it("strips GITHUB_WORKSPACE off an absolute path built from it", () => {
    const previous = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = "/home/runner/work/widgets/widgets";
    try {
      expect(repoRelativePath("/home/runner/work/widgets/widgets/corrections")).toBe("corrections");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previous;
    }
  });

  it("rejects an absolute path outside GITHUB_WORKSPACE", () => {
    const previous = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = "/home/runner/work/widgets/widgets";
    try {
      expect(() => repoRelativePath("/etc/corrections")).toThrow(
        new Error(
          "`corrections` (`/etc/corrections`) is an absolute path record cannot use — the " +
            "Contents API only understands a path relative to the repository root. Use a " +
            "repo-relative path, or one under `GITHUB_WORKSPACE` if the workflow built it from " +
            "`${{ github.workspace }}`.",
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previous;
    }
  });

  it("rejects an absolute path when GITHUB_WORKSPACE is unset", () => {
    const previous = process.env.GITHUB_WORKSPACE;
    delete process.env.GITHUB_WORKSPACE;
    try {
      expect(() => repoRelativePath("/corrections")).toThrow(/absolute path record cannot use/);
    } finally {
      if (previous !== undefined) process.env.GITHUB_WORKSPACE = previous;
    }
  });
});

describe("monthShard", () => {
  it("is this calendar month, `YYYY-MM`", () => {
    const now = new Date();
    const expected = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(monthShard()).toBe(expected);
  });
});

describe("commitMessage", () => {
  it("names the decided labels", () => {
    expect(commitMessage(correctionOf({ decided: ["bug", "docs"] }))).toBe(
      "memory: record #42 as bug, docs",
    );
  });

  it("says `no labels` when nothing was decided", () => {
    expect(commitMessage(correctionOf({ decided: [] }))).toBe("memory: record #42 as no labels");
  });
});

describe("isShaConflict", () => {
  it("is true on a 409", () => {
    expect(isShaConflict({ status: 409 })).toBe(true);
  });

  it("is true on a 422 whose message names the sha field", () => {
    const error = Object.assign(new Error('Invalid request. "sha" wasn\'t supplied.'), {
      status: 422,
    });
    expect(isShaConflict(error)).toBe(true);
  });

  it("is false on a 422 that does not mention sha", () => {
    const error = Object.assign(new Error("Invalid request."), { status: 422 });
    expect(isShaConflict(error)).toBe(false);
  });

  it("is false on any other status, or no status at all", () => {
    expect(isShaConflict({ status: 500 })).toBe(false);
    expect(isShaConflict(new Error("network error"))).toBe(false);
    expect(isShaConflict(null)).toBe(false);
  });

  it("reads a 422's message from `String(error)` when `error` is not an `Error` instance", () => {
    // The Contents API's own client throws a plain object on some paths, not
    // always an `Error` — `isShaConflict` falls back to `String(error)`
    // rather than assume `.message` exists.
    expect(isShaConflict({ status: 422, toString: () => 'Invalid request. "sha" missing.' })).toBe(
      true,
    );
    expect(isShaConflict({ status: 422, toString: () => "Invalid request." })).toBe(false);
  });
});

describe("attemptWrite", () => {
  it("appends a fresh entry to this month's shard when the store is empty", async () => {
    const { api, writes } = contentsOf({});
    await attemptWrite(api, AT, "corrections", correctionOf());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`corrections/${monthShard()}.ndjson`);
    expect(writes[0]?.sha).toBeUndefined();
    expect(writes[0]?.content.trim()).toBe(formatCorrection(correctionOf()));
  });

  it("appends to an existing shard's tail rather than overwriting it", async () => {
    const other = formatCorrection(correctionOf({ thread: 7, decided: ["docs"] }));
    const shard = `corrections/${monthShard()}.ndjson`;
    const { api, writes } = contentsOf({ [shard]: `${other}\n` });

    await attemptWrite(api, AT, "corrections", correctionOf());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(shard);
    expect(writes[0]?.sha).toBe(`sha-${shard}`);
    expect(writes[0]?.content.trim().split("\n")).toEqual([
      other,
      formatCorrection(correctionOf()),
    ]);
  });

  it("rewrites the exact matching line in place, wherever it lives", async () => {
    const existing = formatCorrection(correctionOf({ decided: ["question"] }));
    const { api, writes } = contentsOf({ "corrections/2025-01.ndjson": `${existing}\n` });

    const updated = correctionOf({ decided: ["bug"] });
    await attemptWrite(api, AT, "corrections", updated);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("corrections/2025-01.ndjson");
    expect(writes[0]?.content.trim()).toBe(formatCorrection(updated));
  });

  it("stops searching once the exact match is found — a later shard is never read", async () => {
    const existing = formatCorrection(correctionOf({ decided: ["question"] }));
    const { api, writes } = contentsOf({
      "corrections/2025-01.ndjson": `${existing}\n`,
      // A shard sorting after 2025-01 that would throw if it were ever read.
      "corrections/2025-02.ndjson": null,
    });

    await attemptWrite(api, AT, "corrections", correctionOf());

    // Only the shard holding the exact match was written to.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("corrections/2025-01.ndjson");
  });

  it("rewrites a legacy (pre-`repo`) line in place once the whole store is proven single-repo", async () => {
    const legacy = JSON.stringify({
      thread: 42,
      duty: "triage",
      decided: ["question"],
      // No `repo` field at all — the pre-`repo` shape.
    });
    const { api, writes } = contentsOf({ "corrections/2025-01.ndjson": `${legacy}\n` });

    const updated = correctionOf({ decided: ["bug"] });
    await attemptWrite(api, AT, "corrections", updated);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("corrections/2025-01.ndjson");
    expect(writes[0]?.content.trim()).toBe(formatCorrection(updated));
  });

  it("does not loosely rewrite a legacy line once another repo's own line proves the store shared", async () => {
    const legacy = JSON.stringify({ thread: 42, duty: "triage", decided: ["question"] });
    const foreign = formatCorrection(correctionOf({ repo: "acme/other", thread: 99 }));
    const shard = "corrections/2025-01.ndjson";
    const { api, writes } = contentsOf({ [shard]: `${legacy}\n${foreign}\n` });

    await attemptWrite(api, AT, "corrections", correctionOf());

    // The legacy line was left alone; a fresh entry was appended to this
    // month's shard instead.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`corrections/${monthShard()}.ndjson`);
  });

  it("a legacy line for a different `duty` is not claimed as the same correction", async () => {
    // Pre-`repo`, so `duty` also reads as its default, `"triage"` — a
    // reversal write (`duty: "duplicate"`) must not loosely match it.
    const legacy = JSON.stringify({ thread: 42, decided: ["question"] });
    const shard = "corrections/2025-01.ndjson";
    const { api, writes } = contentsOf({ [shard]: `${legacy}\n` });

    await attemptWrite(api, AT, "corrections", correctionOf({ duty: "duplicate" }));

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`corrections/${monthShard()}.ndjson`);
  });

  it("skips an unreadable shard rather than failing outright, and keeps searching", async () => {
    const existing = formatCorrection(correctionOf({ decided: ["question"] }));
    const { api, writes } = contentsOf({
      "corrections/2025-01.ndjson": null,
      "corrections/2025-02.ndjson": `${existing}\n`,
    });

    const updated = correctionOf({ decided: ["bug"] });
    await attemptWrite(api, AT, "corrections", updated);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("corrections/2025-02.ndjson");
    expect(core.warning).toHaveBeenCalledWith(
      "corrections: `corrections/2025-01.ndjson` could not be read, so it was skipped rather " +
        "than failing the whole write — the search continued through the rest of the store. " +
        "Split the corrections store into smaller shards.",
    );
  });

  it("rethrows a shard read failure that is not an unreadable-file marker, rather than swallowing it", async () => {
    // A shard `listCorrectionFiles` just listed, but whose read fails with
    // something other than the "over 1 MB, no base64 content" shape
    // `UnreadableContentsFile` names — a network error, a permissions
    // problem, anything not that one specific, recoverable case. That must
    // still fail the whole write, the same as it always did.
    const api: ContentsApi = {
      rest: {
        repos: {
          getContent: ({ path }: { path: string }) => {
            if (path === "corrections") {
              return Promise.resolve({
                data: [
                  { name: "2025-01.ndjson", path: "corrections/2025-01.ndjson", sha: "sha-1" },
                ],
              });
            }
            return Promise.reject(new Error("network error"));
          },
          createOrUpdateFileContents: () => {
            throw new Error("not reached");
          },
        },
      },
    };

    await expect(attemptWrite(api, AT, "corrections", correctionOf())).rejects.toThrow(
      "network error",
    );
  });

  it("treats a shard that vanished between listing and reading as though it were never there", async () => {
    // `listCorrectionFiles` named it, but by the time this reads it the shard
    // is gone (a 404) — `readContentsFile` answers `null`, the same "nothing
    // here" it reports for a store that never had this shard at all, and the
    // search continues rather than treating a race as a hard failure.
    const shard = "corrections/2025-01.ndjson";
    const writes: { path: string }[] = [];
    const api: ContentsApi = {
      rest: {
        repos: {
          getContent: ({ path }: { path: string }) => {
            if (path === "corrections") {
              return Promise.resolve({ data: [{ name: "2025-01.ndjson", path: shard, sha: "s" }] });
            }
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          },
          createOrUpdateFileContents: (params: { path: string }) => {
            writes.push({ path: params.path });
            return Promise.resolve(undefined);
          },
        },
      },
    };

    await attemptWrite(api, AT, "corrections", correctionOf());

    // No exact or legacy match could be read at all, so this falls through
    // to appending a fresh entry — not an error, and not a skip.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`corrections/${monthShard()}.ndjson`);
  });

  it("refuses to append when a shard could not be read and no exact match was found", async () => {
    const { api, writes } = contentsOf({ "corrections/2025-01.ndjson": null });

    await expect(attemptWrite(api, AT, "corrections", correctionOf())).rejects.toThrow(
      new Error(
        "#42 was not found in any shard this run could read, and `corrections/2025-01.ndjson` " +
          "could not be read at all. Appending a fresh entry cannot rule out duplicating one " +
          "already sitting in the shard this run could not see, so nothing was written — split " +
          "the corrections store into smaller shards.",
      ),
    );
    expect(writes).toHaveLength(0);
  });

  it("rolls over to the next numbered shard once this month's is at the soft limit", async () => {
    const base = `corrections/${monthShard()}`;
    const full = "x".repeat(900_000);
    const { api, writes } = contentsOf({ [`${base}.ndjson`]: full });

    await attemptWrite(api, AT, "corrections", correctionOf());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`${base}.2.ndjson`);
  });

  it("rolls over past an unreadable this-month shard to the next numbered one, and warns", async () => {
    // The directory listing this run sees names no shards at all (an empty
    // store, from `attemptWrite`'s own search's point of view — so its own
    // `unreadable`-then-throw path, already covered above, is never reached)
    // but this month's shard, read directly by `selectShard` once the search
    // comes up empty, answers unreadable — `selectShard`'s own catch, not
    // `attemptWrite`'s.
    const base = `corrections/${monthShard()}`;
    const writes: { path: string }[] = [];
    const api: ContentsApi = {
      rest: {
        repos: {
          getContent: ({ path }: { path: string }) => {
            if (path === `${base}.ndjson`) {
              return Promise.resolve({ data: { sha: "sha-1", content: "", encoding: "none" } });
            }
            return Promise.reject(notFoundError());
          },
          createOrUpdateFileContents: (params: { path: string }) => {
            writes.push({ path: params.path });
            return Promise.resolve(undefined);
          },
        },
      },
    };

    await attemptWrite(api, AT, "corrections", correctionOf());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`${base}.2.ndjson`);
    expect(core.warning).toHaveBeenCalledWith(
      `corrections: \`${base}.ndjson\` could not be read, so a fresh correction rolls over to ` +
        "the next shard instead. Split the corrections store into smaller shards.",
    );
  });

  it("gives up once this month's shard has grown past MAX_SHARD_ATTEMPTS numbered siblings", async () => {
    const base = `corrections/${monthShard()}`;
    const full = "x".repeat(900_000);
    const files: Record<string, string> = {};
    for (let n = 1; n <= 500; n += 1) {
      files[n === 1 ? `${base}.ndjson` : `${base}.${String(n)}.ndjson`] = full;
    }
    const { api } = contentsOf(files);

    await expect(attemptWrite(api, AT, "corrections", correctionOf())).rejects.toThrow(
      new Error(
        "corrections: this month's store has grown past 500 shards, every one of them already " +
          "at or past the 900000-byte soft limit. That is almost certainly a runaway write loop " +
          "rather than a genuinely enormous month, so this stops here rather than trying a " +
          "shard 501.",
      ),
    );
  }, 20_000);
});

describe("writeCorrection", () => {
  it("guarantees the path reaching the Contents API is repo-relative", async () => {
    const { api, writes } = contentsOf({});
    await writeCorrection(api, AT, "corrections", correctionOf());

    expect(writes[0]?.path).toBe(`corrections/${monthShard()}.ndjson`);
  });

  it("retries once after losing a race on a shard's sha, then succeeds", async () => {
    const shard = `corrections/${monthShard()}.ndjson`;
    const { api, writes } = contentsOf({}, { conflictOnce: shard });

    await writeCorrection(api, AT, "corrections", correctionOf());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(shard);
    expect(core.info).toHaveBeenCalledWith(
      "Recording #42 lost a race on the store — another commit landed first. Retrying " +
        "(attempt 2 of 3).",
    );
  });

  it("propagates a failure that is not a sha conflict on the first attempt", async () => {
    const api: ContentsApi = {
      rest: {
        repos: {
          getContent: () => Promise.reject(new Error("boom")),
          createOrUpdateFileContents: () => {
            throw new Error("not reached");
          },
        },
      },
    };

    await expect(writeCorrection(api, AT, "corrections", correctionOf())).rejects.toThrow("boom");
  });

  it("exhausts all WRITE_ATTEMPTS on a conflict that never resolves, then rethrows", async () => {
    const conflict = Object.assign(new Error("sha conflict"), { status: 409 });
    const api: ContentsApi = {
      rest: {
        repos: {
          getContent: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
          createOrUpdateFileContents: () => Promise.reject(conflict),
        },
      },
    };

    await expect(writeCorrection(api, AT, "corrections", correctionOf())).rejects.toBe(conflict);
    // Two retries logged (attempts 2 and 3) before the third attempt's
    // failure is finally left to propagate rather than tried a fourth time.
    expect(core.info).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenCalledWith(
      "Recording #42 lost a race on the store — another commit landed first. Retrying " +
        "(attempt 2 of 3).",
    );
    expect(core.info).toHaveBeenCalledWith(
      "Recording #42 lost a race on the store — another commit landed first. Retrying " +
        "(attempt 3 of 3).",
    );
  });
});

describe("attemptWrite with stateBranch", () => {
  it("passes ref to listCorrectionFiles and readContentsFile when stateBranch is set", async () => {
    const { api, writes, reads } = contentsOf({});
    const branch = "reeve/corrections";

    await attemptWrite(api, AT, "corrections", correctionOf(), branch);

    // Every read should carry ref: "reeve/corrections"
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.ref).toBe(branch);
    }
    // Every write should carry branch: "reeve/corrections"
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.branch).toBe(branch);
    }
  });

  it("omits ref and branch when stateBranch is not set", async () => {
    const { api, writes, reads } = contentsOf({});

    await attemptWrite(api, AT, "corrections", correctionOf());

    // No ref should have been passed on reads
    for (const read of reads) {
      expect(read.ref).toBeUndefined();
    }
    // No branch should have been passed on writes
    for (const write of writes) {
      expect(write.branch).toBeUndefined();
    }
  });

  it("passes branch through writeCorrection", async () => {
    const { api, writes, reads } = contentsOf({});
    const branch = "reeve/corrections";

    await writeCorrection(api, AT, "corrections", correctionOf(), branch);

    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.ref).toBe(branch);
    }
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.branch).toBe(branch);
    }
  });

  it("rewrites an exact match in place on the state branch", async () => {
    const existing = formatCorrection(correctionOf({ decided: ["question"] }));
    const { api, writes } = contentsOf({ "corrections/2025-01.ndjson": `${existing}\n` });
    const branch = "reeve/corrections";

    const updated = correctionOf({ decided: ["bug"] });
    await attemptWrite(api, AT, "corrections", updated, branch);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.branch).toBe(branch);
    expect(writes[0]?.content.trim()).toBe(formatCorrection(updated));
  });

  it("appends to a shard on the state branch", async () => {
    const other = formatCorrection(correctionOf({ thread: 7, decided: ["docs"] }));
    const shard = `corrections/${monthShard()}.ndjson`;
    const { api, writes } = contentsOf({ [shard]: `${other}\n` });
    const branch = "reeve/corrections";

    await attemptWrite(api, AT, "corrections", correctionOf(), branch);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.branch).toBe(branch);
    expect(writes[0]?.sha).toBe(`sha-${shard}`);
  });
});
