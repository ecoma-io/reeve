/**
 * Bundles every action in this repository, one bundle each.
 *
 * A JavaScript action runs straight off the checked-out repository with no
 * install step, so whatever it imports has to already be there. Committing
 * `node_modules/` is the alternative, and it is worse in every direction:
 * thousands of files in every diff, and a supply-chain surface a reviewer
 * cannot read. Reviewable bundles it is — which is also why `dist/` is tracked
 * here while every other repository in this organisation ignores it.
 *
 * One bundle per duty rather than one shared bundle behind a switch, because a
 * duty ships from its own directory next to its own `action.yml`, and
 * `runs.main` is a path rather than a path plus an argument. The core is
 * imported by every duty and so appears in every bundle; that is duplication on
 * disk and not in the source, and the alternative — a runtime lookup — would
 * put every duty's dependencies into every duty's action.
 *
 * CI re-runs this and fails if the result differs from what was committed, so a
 * source change that never got rebuilt cannot ship as a stale bundle.
 */
import { build } from "esbuild";

/**
 * Every bundle, source to destination.
 *
 * The root is the Marketplace listing's refusal and is not a duty; each duty
 * lands beside its own `action.yml`. A new duty adds one line here and one
 * directory beside it.
 */
const BUNDLES = [
  { entry: "src/main.ts", outfile: "dist/index.js" },
  { entry: "src/duties/translate/main.ts", outfile: "translate/dist/index.js" },
  { entry: "src/duties/triage/main.ts", outfile: "triage/dist/index.js" },
  { entry: "src/duties/duplicate/main.ts", outfile: "duplicate/dist/index.js" },
  { entry: "src/duties/respond/main.ts", outfile: "respond/dist/index.js" },
  { entry: "src/duties/lifecycle/main.ts", outfile: "lifecycle/dist/index.js" },
];

for (const { entry, outfile } of BUNDLES) {
  await bundle(entry, outfile);
}

function bundle(entry, outfile) {
  return build({
    entryPoints: [entry],
    outfile,
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
}
