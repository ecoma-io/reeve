import { parseList } from "./list.js";
import { isScriptName } from "./script.js";

export interface Language {
  /**
   * The code as configured, preserved verbatim — it is echoed in the
   * `source-language` output and in the posted comment, and a consumer who
   * wrote `pt-BR` should not be handed back `pt-br`. Comparison is
   * case-insensitive; storage is not.
   */
  readonly code: string;
  /** Human-readable name, shown to readers of the published translation. */
  readonly label: string;
  /** One or more Unicode script names. */
  readonly scripts: readonly string[];
}

/**
 * Entries are separated by newlines or commas. An entry is either a bare
 * language code, or the three colon-separated fields that spell out what a bare
 * code would have been asked to imply — with `+` between scripts for a language
 * written in several:
 *
 * ```
 * vi, en, zh
 * ja:日本語:Han+Hiragana+Katakana
 * ```
 *
 * **The two forms are the same feature, not a short one and a real one.** A
 * bare code asks the runtime for the language's own name and the script it is
 * written in; the long form states them. Mixing them in one list is ordinary —
 * a project spells out the one language CLDR gets wrong for them and leaves the
 * rest bare.
 *
 * A label containing a comma has to be written on its own line — commas are
 * accepted as a separator because one-line configuration is common, and a
 * quoting syntax would be a parser nobody asked for.
 *
 * A caller holding entries that are already split — the warrant's `languages:`
 * key, where YAML made one list element one entry — passes them as an array,
 * and no separator is looked for inside them at all: a comma in a spelled-out
 * label stays part of the label there, where this one-line grammar would have
 * read it as two entries.
 *
 * @throws Error naming the offending entry. Every problem here is a typo in a
 * workflow file, and a run that continues past one silently translates into a
 * language the author did not ask for.
 */
export function parseLanguages(raw: string | readonly string[]): Language[] {
  const entries = typeof raw === "string" ? parseList(raw) : raw;

  if (entries.length === 0) {
    throw new Error("languages: no entries. Expected at least one language code.");
  }

  const languages: Language[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const language = entry.includes(":") ? spelled(entry) : derived(entry);

    const previous = seen.get(language.code.toLowerCase());
    if (previous !== undefined) {
      throw new Error(
        `languages: \`${language.code}\` is listed twice (already seen as \`${previous}\`).`,
      );
    }
    seen.set(language.code.toLowerCase(), language.code);

    languages.push(language);
  }

  return languages;
}

/**
 * A bare code, with its label and scripts read off the runtime.
 *
 * The failure names the long form as the fix, because it is one: every code
 * this refuses is still configurable, and a consumer who knows their language
 * better than CLDR does should not be blocked by CLDR's opinion.
 */
function derived(code: string): Language {
  const language = deriveLanguage(code);
  if (language === null) {
    throw new Error(
      `languages: \`${code}\` is not a language code this runtime knows a name and a script for. ` +
        "Write it as `code:Label:Script` instead, such as `" +
        code +
        ":Label:Latin`.",
    );
  }
  return { code, label: language.label, scripts: language.scripts };
}

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
 *
 * `null` covers three failures that all have the same fix — write the long form
 * — and so are not worth telling apart: a code that is not well-formed BCP 47
 * (`en_US`, `日本語`), one CLDR has never heard of (`xx`), and one it knows but
 * assigns no script to (`mul`, `zxx`, and every language that has no writing
 * system of its own).
 */
function deriveLanguage(code: string): { label: string; scripts: readonly string[] } | null {
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

/** The long form: every field stated, and nothing derived. */
function spelled(entry: string): Language {
  const fields = entry.split(":");
  if (fields.length !== 3) {
    throw new Error(
      `languages: \`${entry}\` has ${String(fields.length)} colon-separated fields, expected 3 (\`code:Label:Script\`).`,
    );
  }

  const [code, label, scriptField] = fields.map((field) => field.trim()) as [
    string,
    string,
    string,
  ];

  if (code.length === 0) throw new Error(`languages: \`${entry}\` has an empty code.`);
  if (label.length === 0) throw new Error(`languages: \`${entry}\` has an empty label.`);

  const scripts = scriptField
    .split("+")
    .map((script) => script.trim())
    .filter((script) => script.length > 0);

  if (scripts.length === 0) throw new Error(`languages: \`${entry}\` names no script.`);

  for (const script of scripts) {
    if (!isScriptName(script)) {
      throw new Error(
        `languages: \`${entry}\` names \`${script}\`, which is not a Unicode script. ` +
          "Use a Unicode script name or its four-letter alias, such as `Latin`, `Han` or `Cyrl`.",
      );
    }
  }

  return { code, label, scripts };
}

/** Finds a language by code, case-insensitively. */
export function findLanguage(languages: readonly Language[], code: string): Language | undefined {
  const wanted = code.toLowerCase();
  return languages.find((language) => language.code.toLowerCase() === wanted);
}
