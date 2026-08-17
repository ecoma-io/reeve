/**
 * Vitest config for the eval contract suite only.
 *
 * The root `vitest.config.ts` intentionally discovers only the src test
 * glob; the eval tree is driven by `eval/runner.ts` instead, and its one
 * vitest suite — this one — needs its own include. Kept beside the suite
 * rather than widening the root config, so the eval tree stays self-contained
 * under `eval/`.
 *
 * `root` is pinned even though vitest would root itself at ConfigLoader.root
 * (the file's own directory) when the config is loaded by absolute path: the
 * script invokes `vitest run --config <relative path>`, and a relative path
 * roots the run at the cwd instead, silently widening discovery to the whole
 * repository. The pin keeps the two the same from inside the suite, from the
 * repo root, and from anywhere a `pnpm test:contract` is ever run from.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "node",
    include: ["./**/*.test.ts"],
    // The integration suite rebuilds a duty bundle and runs its fixtures for
    // every branch it asserts, and `eval all` now drives thirty fixtures — a
    // single case can take tens of seconds. Slow by intent, as the suite's own
    // doc comment says; the default 5s is not enough for a real run.
    testTimeout: 180_000,
  },
});
