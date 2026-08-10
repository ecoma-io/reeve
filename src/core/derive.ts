/**
 * What a bare language code implies, read off the runtime's own CLDR data.
 *
 * `languages: vi, en, zh` is the configuration almost everyone wants, and every
 * field the long form asks for is already known to the runtime: `Intl` holds
 * the language's name in its own language and the script it is written in. So
 * the short form derives them rather than making a consumer copy them out of a
 * table — a table that would be this repository's opinion about someone else's
 * language, and that would go stale on the next ICU update.
 *
 * **The long form stays, and it wins.** Derivation answers for the common case;
 * it cannot answer for a language CLDR does not carry, and it should not be the
 * only way to say something CLDR gets wrong for a particular project. A
 * consumer who writes `code:Label:Script` is not overriding a default, they are
 * stating a fact this module was never asked about.
 */
import { isScriptName } from "./script.js";

/** A language's name in its own language, and the scripts it is written in. */
export interface Derived {
  readonly label: string;
  readonly scripts: readonly string[];
}

/**
 * ISO 15924 codes `Intl` answers with that are not Unicode script names.
 *
 * `Intl.Locale.maximize()` speaks ISO 15924, which carries composite and
 * variant codes for writing systems that Unicode's `Script` property does not:
 * `Jpan` is "Japanese writing" — three scripts at once — and `Hans` names a
 * variant of one. Measured against this runtime, these four are the whole of
 * the disagreement; the other twenty-six codes it produced compile straight
 * into `\p{Script=…}`.
 *
 * `Hans` and `Hant` both become `Hani` rather than staying apart, because the
 * distinction they draw is not one the `Script` property makes: simplified and
 * traditional characters are all Han. Nothing is lost by flattening them here —
 * the script step only narrows the candidates, and telling `zh` from `ja` from
 * `ko` was always the job of the two steps behind it.
 */
const COMPOSITE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  Hans: ["Hani"],
  Hant: ["Hani"],
  Jpan: ["Hani", "Hiragana", "Katakana"],
  Kore: ["Hani", "Hangul"],
};

/**
 * The label and scripts for a bare code, or `null` when the runtime cannot say.
 *
 * `null` covers three failures that all have the same fix — write the long form
 * — and so are not worth telling apart: a code that is not well-formed BCP 47
 * (`en_US`, `日本語`), one CLDR has never heard of (`xx`), and one it knows but
 * assigns no script to (`mul`, `zxx`, and every language that has no writing
 * system of its own).
 */
export function deriveLanguage(code: string): Derived | null {
  let locale: Intl.Locale;
  try {
    // Both of these throw `RangeError` on a tag that is not well-formed, and a
    // language list arrives from a workflow file, so malformed is ordinary
    // input rather than an exceptional case.
    locale = new Intl.Locale(code).maximize();
  } catch {
    return null;
  }

  const scripts = scriptsOf(locale.script);
  if (scripts === null) return null;

  const label = labelOf(code);
  return label === null ? null : { label, scripts };
}

/**
 * The Unicode scripts behind an ISO 15924 code, or `null` for a code no rule
 * here can turn into one.
 *
 * Every name is checked against Unicode rather than trusted, including the ones
 * this module wrote itself. The table above is measured against one ICU
 * version, and a Node release that changes what `maximize()` answers must
 * surface as a configuration error a consumer can act on — not as a language
 * that silently matches nothing and is therefore never a detection candidate.
 */
function scriptsOf(script: string | undefined): readonly string[] | null {
  if (script === undefined) return null;

  const scripts = COMPOSITE_SCRIPTS[script] ?? [script];
  return scripts.every((name) => isScriptName(name)) ? scripts : null;
}

/**
 * The language's name in its own language: `Tiếng Việt`, not `Vietnamese`.
 *
 * It is read by the person the translation is for, and a Vietnamese reader
 * scanning for their section finds `Tiếng Việt` faster than they find a word in
 * the language they came here to avoid reading.
 *
 * `DisplayNames` answers with the code itself for a code it does not know, so
 * `xx` returns `"xx"`. That is not a label — it is the absence of one wearing
 * the input's clothes — and it is refused here rather than rendered in a
 * heading.
 *
 * The `catch` is unreachable from this module and is kept anyway: `Intl.Locale`
 * has already accepted the tag by the time this runs, so the only thing left
 * that could throw is a runtime whose ICU is built differently from the one
 * this was measured on. One line is a cheaper answer to that than a crash in
 * somebody's workflow.
 */
function labelOf(code: string): string | null {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([code], { type: "language" }).of(code);
  } catch {
    return null;
  }

  if (name === undefined || name.length === 0) return null;
  return name.toLowerCase() === code.toLowerCase() ? null : name;
}
