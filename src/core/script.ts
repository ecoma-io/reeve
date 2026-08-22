/**
 * Unicode script membership — the one thing about a language a duty can
 * decide without asking anything.
 *
 * The configured languages name a script per language, and every rule built on
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

function matcher(script: string, exempt: readonly string[], every = false): RegExp | null {
  const names = [script, ...exempt];
  // Rejected before the cache is consulted rather than after. A name that
  // survives this test cannot contain a space, which is what lets the joined
  // key below name exactly one request: `("Han", ["Latin"])` and
  // `("Han Latin", [])` would otherwise be the same string.
  if (!names.every((name) => SCRIPT_NAME.test(name))) return null;

  // The global variant is keyed apart from the single-match one. A space
  // cannot occur in a script name, so no prefix can collide with a name.
  const key = `${every ? "g " : ""}${names.join(" ")}`;
  const cached = matchers.get(key);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null;
  try {
    const excluded = exempt.map((name) => `\\p{Script=${name}}`).join("");
    const guard = excluded.length === 0 ? "" : `(?![${excluded}])`;
    compiled = new RegExp(`${guard}\\p{Script=${script}}`, every ? "gu" : "u");
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
 * their configured languages.
 */
export function containsScript(
  text: string,
  script: string,
  exempt: readonly string[] = [],
): boolean {
  return matcher(script, exempt)?.test(text) ?? false;
}

/**
 * How many characters of `text` belong to `script` and to none of `exempt`.
 *
 * The counting half of {@link containsScript}, and the reason it exists is the
 * difference between "this draft has a stray character" and "this draft is in
 * the wrong language". Both answer `true` to `containsScript`, and they are not
 * remotely the same defect: one is a proper noun a model left in its original
 * script, the other is a whole answer written to the wrong reader. A rule that
 * cannot tell them apart has to treat the first as the second, which is how a
 * good translation gets thrown away for two characters.
 *
 * `matchAll` clones the cached expression rather than advancing it, so the
 * global matcher held in the cache never carries `lastIndex` from one call into
 * the next.
 */
export function countScript(text: string, script: string, exempt: readonly string[] = []): number {
  const compiled = matcher(script, exempt, true);
  if (compiled === null) return 0;
  let count = 0;
  for (const _ of text.matchAll(compiled)) count += 1;
  return count;
}

/**
 * The first script a draft carries that neither the target nor the source
 * accounts for, with how much of it there is — or null when there is none.
 *
 * Shared by `translate` and `harmonise` because both ask exactly this question
 * about exactly the same configuration, and both used to answer it with a
 * private copy of the same loop. The two copies had already been noticed —
 * `harmonise/score.ts`'s said "the same logic as `translate/score.ts`'s
 * `foreignScript`" — which is the point at which a copy becomes a module.
 *
 * **This reports; it does not judge.** The caller decides what a leak is worth,
 * and that separation is the fix for the rule's own asymmetry: the scripts to
 * look for come from the configured languages, and a script the source already
 * used is exempt, so an English source makes every Latin character in a Chinese
 * draft invisible while a single Han character in a Vietnamese draft is the
 * whole finding. Reported as a proportion, that asymmetry is a difference in
 * degree a rank can hold. Reported as a boolean, it was the difference between
 * publishing and not.
 *
 * A script the source already used is not a leak: a thread quoting a Chinese
 * error message wants that message carried across intact.
 */
export function scriptLeak(
  source: string,
  draft: string,
  targetScripts: readonly string[],
  languages: readonly { readonly scripts: readonly string[] }[],
): { readonly script: string; readonly chars: number } | null {
  for (const language of languages) {
    for (const script of language.scripts) {
      // The target's own scripts are exempted per character rather than skipped
      // by name, so a workflow that spelled the same script `Latn` here and
      // `Latin` there still gets one answer. `containsScript` explains why.
      if (!containsScript(draft, script, targetScripts)) continue;
      if (containsScript(source, script, targetScripts)) continue;
      return { script, chars: countScript(draft, script, targetScripts) };
    }
  }
  return null;
}
