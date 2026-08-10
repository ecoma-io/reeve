/**
 * Unicode script membership — the one thing about a language a duty can
 * decide without asking anything.
 *
 * The `languages` input names a script per language, and every rule built on
 * that name is answered by the runtime's own Unicode tables rather than by a
 * list kept here. A list would be a copy of Unicode that goes stale on the next
 * Node release, and it would also be the place a contributor is tempted to add
 * "the scripts we support" — which is the special-casing Reeve exists to
 * avoid.
 */

/**
 * Unicode script long names and their four-letter aliases: `Latin`, `Latn`,
 * `Han`, `Hani`, `Old_Italic`.
 *
 * Nothing outside this shape may reach the regular expression below. The name
 * is interpolated into a pattern, and a duty’s configuration arrives from
 * a workflow file in someone else's repository — a name allowed to contain `}`
 * could close the property escape and continue with a pattern of the author's
 * choosing, which turns a language list into arbitrary matching against every
 * issue body the action reads.
 */
const SCRIPT_NAME = /^[A-Za-z][A-Za-z_]*$/;

/**
 * Compiled matchers, keyed by the script asked about together with whatever was
 * exempted from it. `null` records a name the runtime rejected, so an unknown
 * script is not re-compiled once per issue body.
 */
const matchers = new Map<string, RegExp | null>();

function matcher(script: string, exempt: readonly string[]): RegExp | null {
  const names = [script, ...exempt];
  // Rejected before the cache is consulted rather than after. A name that
  // survives this test cannot contain a space, which is what lets the joined
  // key below name exactly one request: `("Han", ["Latin"])` and
  // `("Han Latin", [])` would otherwise be the same string.
  if (!names.every((name) => SCRIPT_NAME.test(name))) return null;

  const key = names.join(" ");
  const cached = matchers.get(key);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null;
  try {
    const excluded = exempt.map((name) => `\\p{Script=${name}}`).join("");
    const guard = excluded.length === 0 ? "" : `(?![${excluded}])`;
    compiled = new RegExp(`${guard}\\p{Script=${script}}`, "u");
  } catch {
    // A name passed the shape test but Unicode has no such script. That is a
    // configuration mistake, and the caller reports it — here it is only a
    // cached "no".
    compiled = null;
  }
  matchers.set(key, compiled);
  return compiled;
}

/** Whether the runtime recognises `script` as a Unicode script name. */
export function isScriptName(script: string): boolean {
  return matcher(script, []) !== null;
}

/**
 * Whether `text` contains at least one character belonging to `script` and to
 * none of `exempt`.
 *
 * `\p{Script=…}` excludes characters Unicode assigns to `Common` — spaces,
 * digits, ASCII punctuation, emoji — so a body made entirely of a stack trace
 * matches no script at all. That is the correct answer rather than a gap: there
 * is nothing in it to translate.
 *
 * `exempt` is what keeps the answer independent of how a workflow spells a
 * script. Unicode's `Script` property puts every character in exactly one
 * script, so `\p{Script=Han}` and `\p{Script=Hani}` match the same characters
 * and nothing is in both `Han` and `Latin`. Asking whether the text holds a
 * `Han` character that is not one of `Latn`, `Latin` therefore answers "does it
 * carry a script the target does not use?" without this module ever knowing
 * that `Latn` and `Latin` name the same thing. Comparing the names would have
 * to know, and would be wrong for the consumer who spelled it both ways across
 * their `languages` input.
 */
export function containsScript(
  text: string,
  script: string,
  exempt: readonly string[] = [],
): boolean {
  return matcher(script, exempt)?.test(text) ?? false;
}
