/**
 * Vitest config for the eval contract suite only.
 *
 * The root `vitest.config.ts` intentionally discovers only the src test
 * glob; the eval tree is driven by `eval/runner.ts` instead, and its one
 * vitest suite — this one — needs its own include. Kept beside the suite
 * rather than widening the root config, so the eval tree stays self-contained
 * under `eval/`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pinned so `pnpm test:contract` sees the same root from anywhere in the
  // repository — otherwise vitest roots itself at the cwd and its project-wide
  // discovery swallows every src suite into this one's run.
  root: import.meta.dirname,
  test: {
    environment: "node",
    include: ["./**/*.test.ts"],
  },
});
