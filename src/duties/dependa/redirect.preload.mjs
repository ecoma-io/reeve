/**
 * Test-only preload: points the duty's hardcoded registry hosts at the stub.
 *
 * Loaded with `node --import` BEFORE the bundle, so it never ships and the
 * duty's own source is untouched. It exists because two of dependa's
 * datasources address their registries by literal origin —
 * `datasources/npm.ts` uses `https://registry.npmjs.org` and
 * `datasources/github-tags.ts` uses `https://api.github.com` — rather than
 * reading a base url from an input the way `base-url` and `GITHUB_API_URL`
 * are read. There is therefore no input a test can set to keep those two off
 * the network, and a bundle-driven case has to redirect them from outside.
 *
 * The rewrite keeps the path and query exactly and changes only the origin,
 * so what the stub receives is what the registry would have received. Nothing
 * is faked at a level the duty could tell apart from a real answer.
 */
const target = process.env.REEVE_STUB_ORIGIN;
const original = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.origin === target) return original(input, init);
  return original(new URL(url.pathname + url.search, target), init);
};
