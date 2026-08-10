/**
 * Bundles the action into `dist/index.js`.
 *
 * A JavaScript action runs straight off the checked-out repository with no
 * install step, so whatever it imports has to already be there. Committing
 * `node_modules/` is the alternative, and it is worse in every direction:
 * thousands of files in every diff, and a supply-chain surface a reviewer
 * cannot read. One reviewable bundle it is — which is also why `dist/` is
 * tracked here while every other repository in this organisation ignores it.
 *
 * CI re-runs this and fails if the result differs from what was committed, so
 * a source change that never got rebuilt cannot ship as a stale bundle.
 */
import { build } from "esbuild";

await build({
  // TODO(stage-0): Reeve ships one action per duty from subdirectories
  // (`translate/action.yml`, `triage/action.yml`), so this becomes one entry
  // point and one bundle per duty. Kept single while the core is being folded
  // in — see docs/north-star.md, Stage 0.
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  // Matches `runs.using: node24` in action.yml. Raising one without the other
  // ships syntax the runner cannot parse, or leaves it down-levelled for a
  // runtime that never needed it.
  target: "node24",
  format: "esm",
  // ESM has no `require`, and esbuild's stand-in for it throws on first call.
  // That is not a hypothetical: `@actions/github` reaches `tunnel`, which does
  // `require("net")` at module scope, so the bundle dies on import — before any
  // of our code runs, with a message naming a module nobody here imported.
  //
  // Defining a real `require` restores it, because esbuild's shim checks for
  // one before throwing. `createRequire` is Node's supported way to get it, and
  // `platform: "node"` already means this file only ever runs where it exists.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // Deliberately not minified. This bundle is committed, so it is read in pull
  // request diffs and by anyone auditing what the action actually runs.
  minify: false,
  // And deliberately without a sourcemap, which is the same decision twice.
  // Node does not apply one unless `--enable-source-maps` is set, and nothing
  // sets it on a runner — so an inline map would have added 1.8 MB of base64 on
  // a single line to every commit and produced no better stack trace than the
  // unminified code above already gives.
  sourcemap: false,
  legalComments: "inline",
});
