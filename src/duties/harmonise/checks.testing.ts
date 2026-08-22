/**
 * One named check's value off a scored draft — the assertion three of this
 * duty's suites make and none of them should spell out.
 *
 * Not a `.test.ts`: vitest collects those as suites, and a file of helpers
 * collected as a suite is a suite with no cases in it. `.testing.ts` is
 * compiled and linted like any other source and bundled into nothing, because
 * nothing outside a test imports it.
 *
 * It exists because the checks are what these suites assert on now. Demoting
 * the glossary and the script leak from refusals to weighted measurements moved
 * every one of those cases from `expect(refused).toHaveLength(1)` — which needs
 * no helper — to "this draft was admitted, and here is what it cost", which
 * needs the same three lines in every file that asks.
 */
export function scored(
  attempt:
    { readonly score: { readonly checks: readonly { name: string; value: number }[] } } | undefined,
  name: string,
): number {
  const found = attempt?.score.checks.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} check was reported`);
  return found.value;
}
