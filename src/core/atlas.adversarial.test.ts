/**
 * The workspace atlas against manifests that are wrong, hostile or simply not
 * what the parser expected — and against a GitHub boundary that fails while it
 * is halfway through reading them.
 *
 * The atlas is evidence, never authority (see the module doc), so its posture
 * is "skip what cannot be read, keep what can, and never let a failed read
 * look like an absent package". Every case here names which of those it pins.
 *
 * `atlas.test.ts` covers the shapes that work; this file covers the ones that
 * do not, because a monorepo whose atlas silently came back empty is a triage
 * run that quietly stopped proposing area labels.
 */
import { describe, expect, it } from "vitest";

import { readAtlas, type Atlas, type AtlasApi } from "./atlas.js";

// Mirrors atlas.ts's module-private EMPTY_ATLAS so the assertion stays exact
// while the constant stays internal.
const EMPTY_ATLAS: Atlas = { packages: [], truncated: false };

const AT = { owner: "acme", repo: "widgets" };
const REF = "main";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const httpError = (status: number): Error =>
  Object.assign(new Error(`HTTP ${String(status)}`), { status });

/** A network-shaped failure with no status — D12's weather side. */
function timeout(): Error {
  const error = new Error("Request timed out");
  error.name = "TimeoutError";
  return error;
}

interface File {
  readonly path: string;
  readonly content: string;
}

/** A stub over a declared file set, optionally failing one named path. */
function apiWith(
  files: readonly File[],
  options: { failAt?: Record<string, Error>; asDirectory?: readonly string[] } = {},
): AtlasApi {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.path.split("/");
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join("/"));
  }

  return {
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { default_branch: REF } }),
        getContent: ({ path }) => {
          const failure = options.failAt?.[path];
          if (failure !== undefined) return Promise.reject(failure);
          if (options.asDirectory?.includes(path) === true) {
            return Promise.resolve({ data: [{ name: "a", path, type: "file" }] });
          }
          const content = byPath.get(path);
          if (content === undefined) return Promise.reject(httpError(404));
          return Promise.resolve({
            data: { type: "file", content: b64(content), encoding: "base64" },
          });
        },
      },
      git: {
        getTree: () =>
          Promise.resolve({
            data: {
              tree: [
                ...files.map((f) => ({ path: f.path, type: "blob" })),
                ...[...dirs].map((d) => ({ path: d, type: "tree" })),
              ],
            },
          }),
      },
    },
  };
}

const PNPM = { path: "pnpm-workspace.yaml", content: "packages:\n  - packages/*\n" };

describe("a manifest that is not the shape the parser expects contributes nothing", () => {
  it("a_pnpm_workspace_that_is_not_yaml_is_skipped_not_thrown", async () => {
    const api = apiWith([{ path: "pnpm-workspace.yaml", content: "packages: [\n" }]);
    expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
  });

  it("a_pnpm_workspace_that_is_a_scalar_or_a_list_contributes_no_globs", async () => {
    for (const content of ["just a string\n", "- one\n- two\n", "null\n"]) {
      const api = apiWith([{ path: "pnpm-workspace.yaml", content }]);
      expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
    }
  });

  it("a_pnpm_packages_key_that_is_not_a_list_contributes_no_globs", async () => {
    const api = apiWith([{ path: "pnpm-workspace.yaml", content: "packages: packages/*\n" }]);
    expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
  });

  it("a_pnpm_packages_list_drops_non_string_entries_and_keeps_the_rest", async () => {
    const api = apiWith([
      { path: "pnpm-workspace.yaml", content: "packages:\n  - 7\n  - packages/*\n" },
      { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
    ]);
    const atlas = await readAtlas(api, AT, REF);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a"]);
  });

  it("a_package_json_that_is_not_json_or_not_a_mapping_yields_no_workspaces", async () => {
    for (const content of ["{ not json", '"a string"', "null", "[1,2]"]) {
      const api = apiWith([{ path: "package.json", content }]);
      expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
    }
  });

  it("a_workspaces_key_of_the_wrong_shape_yields_nothing_rather_than_guessing", async () => {
    for (const workspaces of [
      "packages/*",
      7,
      null,
      { globs: ["packages/*"] },
      { packages: "x" },
    ]) {
      const api = apiWith([{ path: "package.json", content: JSON.stringify({ workspaces }) }]);
      expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
    }
  });

  it("a_cargo_toml_with_no_workspace_section_or_no_members_yields_nothing", async () => {
    for (const content of ["[package]\nname = 'a'\n", "[workspace]\nresolver = '2'\n"]) {
      const api = apiWith([{ path: "Cargo.toml", content }]);
      expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
    }
  });

  it("a_cargo_members_list_strips_quotes_and_drops_empty_entries", async () => {
    const api = apiWith([
      {
        path: "Cargo.toml",
        content: "[workspace]\nmembers = [\n  \"crates/a\",\n  ,\n  'crates/b',\n]\n",
      },
      { path: "crates/a/Cargo.toml", content: '[package]\nname = "a"\n' },
      { path: "crates/b/Cargo.toml", content: "[package]\nname = 'b'\n" },
    ]);
    const atlas = await readAtlas(api, AT, REF);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("a_go_work_reads_both_the_block_and_the_single_line_use_forms", async () => {
    const api = apiWith([
      { path: "go.work", content: "go 1.22\n\nuse (\n  ./svc/a\n\n  ./svc/b/\n)\nuse ./svc/c\n" },
      { path: "svc/a/go.mod", content: "module example.com/svc/a\n" },
      { path: "svc/b/go.mod", content: "module example.com/svc/b\n" },
      { path: "svc/c/go.mod", content: "module example.com/svc/c\n" },
    ]);
    const atlas = await readAtlas(api, AT, REF);
    expect(atlas.packages.map((p) => p.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("a_go_work_with_no_use_directive_at_all_yields_nothing", async () => {
    const api = apiWith([{ path: "go.work", content: "go 1.22\n" }]);
    expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
  });
});

describe("a member manifest that cannot be read is skipped, never invented", () => {
  it("a_cargo_member_with_no_name_field_is_skipped", async () => {
    const api = apiWith([
      { path: "Cargo.toml", content: '[workspace]\nmembers = ["crates/a", "crates/b"]\n' },
      { path: "crates/a/Cargo.toml", content: "[package]\nversion = '1'\n" },
      {
        path: "crates/b/Cargo.toml",
        content: '[package]\nname = "b"\ndescription = "the b crate"\n',
      },
    ]);
    const atlas = await readAtlas(api, AT, REF);
    expect(atlas.packages).toEqual([{ name: "b", path: "crates/b", description: "the b crate" }]);
  });

  it("a_cargo_member_with_no_package_section_still_reads_a_top_level_name", async () => {
    const api = apiWith([
      { path: "Cargo.toml", content: '[workspace]\nmembers = ["crates/a"]\n' },
      { path: "crates/a/Cargo.toml", content: 'name = "bare"\n' },
    ]);
    expect((await readAtlas(api, AT, REF)).packages).toEqual([
      { name: "bare", path: "crates/a", description: "" },
    ]);
  });

  it("a_go_mod_with_no_module_line_is_skipped", async () => {
    const api = apiWith([
      { path: "go.work", content: "use ./svc/a\nuse ./svc/b\n" },
      { path: "svc/a/go.mod", content: "go 1.22\n" },
      { path: "svc/b/go.mod", content: "module example.com/svc/b\n" },
    ]);
    expect((await readAtlas(api, AT, REF)).packages.map((p) => p.name)).toEqual(["b"]);
  });

  it("a_single_segment_go_module_path_is_its_own_name", async () => {
    const api = apiWith([
      { path: "go.work", content: "use ./svc/a\n" },
      { path: "svc/a/go.mod", content: "module standalone\n" },
    ]);
    expect((await readAtlas(api, AT, REF)).packages).toEqual([
      { name: "standalone", path: "svc/a", description: "" },
    ]);
  });

  it("a_manifest_path_that_answers_with_a_directory_listing_is_read_as_absent", async () => {
    // GitHub answers a directory with an array. Treating that as a file would
    // decode `undefined` and either throw or invent a package.
    const api = apiWith([PNPM, { path: "packages/a/package.json", content: "{}" }], {
      asDirectory: ["packages/a/package.json"],
    });
    expect((await readAtlas(api, AT, REF)).packages).toEqual([]);
  });

  it("a_manifest_answered_without_content_is_read_as_absent", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: REF } }),
          getContent: ({ path }) =>
            path === "pnpm-workspace.yaml"
              ? Promise.resolve({ data: { type: "file", encoding: "none" } })
              : Promise.reject(httpError(404)),
        },
        git: { getTree: () => Promise.resolve({ data: { tree: [] } }) },
      },
    };
    expect(await readAtlas(api, AT, REF)).toEqual(EMPTY_ATLAS);
  });

  it("a_manifest_answered_as_plain_text_rather_than_base64_is_still_read", async () => {
    const api: AtlasApi = {
      rest: {
        repos: {
          get: () => Promise.resolve({ data: { default_branch: REF } }),
          getContent: ({ path }) => {
            if (path === "pnpm-workspace.yaml") {
              return Promise.resolve({
                data: { type: "file", content: "packages:\n  - pkg/a\n" },
              });
            }
            if (path === "pkg/a/package.json") {
              return Promise.resolve({
                data: { type: "file", content: JSON.stringify({ name: "a" }) },
              });
            }
            return Promise.reject(httpError(404));
          },
        },
        git: {
          getTree: () =>
            Promise.resolve({
              data: {
                tree: [
                  { path: "pnpm-workspace.yaml", type: "blob" },
                  { path: "pkg/a", type: "tree" },
                ],
              },
            }),
        },
      },
    };
    expect((await readAtlas(api, AT, REF)).packages.map((p) => p.name)).toEqual(["a"]);
  });
});

describe("a GitHub failure never makes a package look absent", () => {
  it("capacity_while_reading_a_root_manifest_reports_truncated_not_an_empty_workspace", async () => {
    // The D12 arm. An empty atlas and an unread atlas are different answers:
    // the first says "this repository has no packages", the second says "this
    // run could not tell", and only the second is recoverable.
    const api = apiWith([PNPM], { failAt: { "pnpm-workspace.yaml": httpError(503) } });
    expect(await readAtlas(api, AT, REF)).toEqual({ packages: [], truncated: true });
  });

  it("a_timeout_with_no_status_on_a_root_manifest_is_also_weather", async () => {
    const api = apiWith([PNPM], { failAt: { "pnpm-workspace.yaml": timeout() } });
    expect(await readAtlas(api, AT, REF)).toEqual({ packages: [], truncated: true });
  });

  it("an_auth_failure_on_a_root_manifest_propagates_rather_than_shrinking_the_atlas", async () => {
    // 401/403 is configuration, not weather. Returning a truncated atlas would
    // hide a broken token behind a plausible-looking partial answer.
    for (const status of [401, 403]) {
      const api = apiWith([PNPM], { failAt: { "pnpm-workspace.yaml": httpError(status) } });
      await expect(readAtlas(api, AT, REF)).rejects.toMatchObject({ status });
    }
  });

  it("capacity_midway_through_the_member_walk_keeps_what_was_read_and_marks_truncated", async () => {
    // The member whose read failed must look unseen — never retired — so
    // everything already read is kept.
    const api = apiWith(
      [
        PNPM,
        { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
        { path: "packages/b/package.json", content: JSON.stringify({ name: "b" }) },
      ],
      { failAt: { "packages/b/package.json": httpError(500) } },
    );
    const atlas = await readAtlas(api, AT, REF);
    expect(atlas.truncated).toBe(true);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a"]);
  });

  it("an_auth_failure_midway_through_the_member_walk_propagates", async () => {
    const api = apiWith([PNPM, { path: "packages/a/package.json", content: "{}" }], {
      failAt: { "packages/a/package.json": httpError(403) },
    });
    await expect(readAtlas(api, AT, REF)).rejects.toMatchObject({ status: 403 });
  });

  it("a_404_on_a_member_manifest_is_an_absent_package_not_a_failure", async () => {
    const api = apiWith([
      PNPM,
      { path: "packages/a/package.json", content: JSON.stringify({ name: "a" }) },
    ]);
    // `packages/b` exists as a tree entry but carries no manifest.
    const withEmptyDir: AtlasApi = {
      rest: {
        repos: api.rest.repos,
        git: {
          getTree: () =>
            Promise.resolve({
              data: {
                tree: [
                  { path: "pnpm-workspace.yaml", type: "blob" },
                  { path: "packages", type: "tree" },
                  { path: "packages/a", type: "tree" },
                  { path: "packages/b", type: "tree" },
                ],
              },
            }),
        },
      },
    };
    const atlas = await readAtlas(withEmptyDir, AT, REF);
    expect(atlas.packages.map((p) => p.name)).toEqual(["a"]);
    expect(atlas.truncated).toBe(false);
  });
});

describe("manifest text is sanitized before it becomes evidence", () => {
  it("control_characters_are_stripped_from_a_description", async () => {
    // A description carrying real control bytes: a start-of-heading, a bell,
    // and an ANSI escape introducer. All three are stripped before the text
    // can become a label description or reach a prompt.
    const hostile = "line\u0001one\u0007two\u001b[31m";
    const api = apiWith([
      PNPM,
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "a", description: hostile }),
      },
    ]);
    const atlas = await readAtlas(api, AT, REF);
    // The escape introducer goes with them; the printable tail survives.
    expect(atlas.packages[0]?.description).toBe("lineonetwo[31m");
  });

  it("a_description_that_is_not_a_string_becomes_empty_rather_than_stringified", async () => {
    const api = apiWith([
      PNPM,
      {
        path: "packages/a/package.json",
        content: JSON.stringify({ name: "a", description: { text: "x" } }),
      },
    ]);
    expect((await readAtlas(api, AT, REF)).packages[0]?.description).toBe("");
  });

  it("a_whitespace_only_package_name_is_read_as_no_name_and_the_member_is_skipped", async () => {
    const api = apiWith([
      PNPM,
      { path: "packages/a/package.json", content: JSON.stringify({ name: "   " }) },
    ]);
    expect((await readAtlas(api, AT, REF)).packages).toEqual([]);
  });
});
