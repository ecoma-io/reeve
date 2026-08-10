/**
 * The `languages` input, parsed.
 *
 * **These are the languages to translate _into_, and that is the whole of what
 * the input says.** It is not a declaration of what an author is allowed to
 * write in: a thread arrives in whatever language its author thinks in, and one
 * written in none of these is translated into all of them. What the list
 * decides is the output.
 *
 * This is also the whole of what Reeve knows about languages. There is no
 * table of "supported" languages anywhere in this repository and there must not
 * become one: a rule that cannot be derived from what a consumer wrote in their
 * workflow file — or from the runtime's own Unicode and CLDR data — is a rule
 * that serves whoever wrote it and nobody else.
 */
import { deriveLanguage } from "./derive.js";
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
 * @throws Error naming the offending entry. Every problem here is a typo in a
 * workflow file, and a run that continues past one silently translates into a
 * language the author did not ask for.
 */
export function parseLanguages(raw: string): Language[] {
  const entries = parseList(raw);

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
