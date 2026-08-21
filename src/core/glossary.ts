/**
 * The terms a translation is not allowed to translate, read from a file the
 * repository owns.
 *
 * A glossary is the one piece of terminology policy a model cannot infer. Every
 * project has words that look like ordinary prose and are not — a product name,
 * the English term a reference page and an input are both spelled with, a term
 * of art whose translated form no reader could map back to the identifier the
 * code actually uses. Translating one of those does not produce a worse
 * sentence; it produces a sentence nobody can act on.
 *
 * **Shared between `harmonise` and `translate`, deliberately.** Both duties
 * answer the same question about the same repository, and a term that must stay
 * English in a committed `README.vi.md` must stay English in the Vietnamese
 * section of an issue body too. One file, one default path (`.reeve/glossary.yml`),
 * one grammar — a project that had to keep two lists in step would keep them out
 * of step instead.
 *
 * **The format is a YAML map of term to note.** The key is the term, matched
 * literally; the value is a sentence the model is shown next to it, explaining
 * why this word stays as it is. A value that is not a string leaves the term
 * with no note rather than refusing the file — the term is the load-bearing
 * half, and a note nobody wrote is not worth failing a run over.
 *
 * **A missing file is not an error.** It is the common case: most repositories
 * have no protected terms, and a duty that failed for want of an optional file
 * would make the file mandatory by another name. A file that exists and cannot
 * be parsed is a warning and an empty glossary, for the same reason one step
 * further along — a YAML typo in an optional file should cost this run its
 * terminology check, not the translation the run was actually for.
 *
 * **Read through the Contents API, never the filesystem.** The file belongs to
 * the repository at the ref that triggered the run, and a duty that read it from
 * the runner's working directory would be reading whatever the workflow happened
 * to check out — nothing, on a `schedule` or an `issues` event that checks out
 * no code at all.
 */
import * as core from "@actions/core";
import { parse } from "yaml";

import { readContentsFile, type ContentsApi, type Location } from "./forge.js";

/** One entry of the glossary: a term, and optionally why it is one. */
export interface GlossaryEntry {
  readonly term: string;
  readonly note?: string;
}

/**
 * Loads the glossary from the `glossary-dir` input, or an empty one.
 *
 * `duty` names the caller in the warning a malformed file produces, so a run
 * reading a log knows which duty could not make sense of the file — the two that
 * read it read it at different points in their pipelines.
 */
export async function loadGlossary(
  api: ContentsApi,
  at: Pick<Location, "owner" | "repo">,
  path: string,
  duty: string,
): Promise<readonly GlossaryEntry[]> {
  const file = await readContentsFile(api, at, path);
  if (file === null) return [];

  try {
    const parsed: unknown = parse(file.text);

    // An array, a scalar or an empty document is not a map of terms. None of
    // them is worth a warning: they are a file somebody wrote for something
    // else, and there is nothing in them this could half-read.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

    const record = parsed as Record<string, unknown>;
    const entries: GlossaryEntry[] = [];
    for (const [term, value] of Object.entries(record)) {
      if (typeof term === "string" && term.length > 0) {
        entries.push(typeof value === "string" ? { term, note: value } : { term });
      }
    }

    return entries;
  } catch {
    core.warning(
      `${duty}: glossary file \`${path}\` could not be parsed — continuing without glossary.`,
    );
    return [];
  }
}

/**
 * The first glossary term the source used and the draft did not, or null.
 *
 * The comparison is a case-sensitive literal substring on both sides, and that
 * is the whole rule. A term is a spelling, not a word — `Reeve` and `reeve` are
 * different strings, and a glossary that meant both says both. Anything cleverer
 * (case folding, word boundaries, stemming) would start guessing at a language's
 * morphology on behalf of every language configured, which is exactly the table
 * this repository refuses to keep.
 *
 * **Only terms the source actually used are considered.** A glossary is a list
 * of terms for the whole repository, and most of them appear in neither half of
 * any one comparison. Charging a draft for a term nobody wrote would refuse every
 * draft the moment the glossary grew.
 */
export function translatedTerm(
  source: string,
  draft: string,
  terms: readonly string[],
): string | null {
  for (const term of terms) {
    if (source.includes(term) && !draft.includes(term)) return term;
  }
  return null;
}

/**
 * What fraction of the terms the source used the draft carried through, from 0
 * to 1 — the measured statement of the rule {@link translatedTerm} refuses on.
 *
 * A glossary with nothing to say about this text scores 1 rather than 0: there
 * was nothing to lose, and a draft cannot be ranked below another one for text
 * neither of them had.
 */
export function termsPreserved(
  source: string,
  draft: string,
  terms: readonly string[],
): { readonly relevant: number; readonly preserved: number; readonly value: number } {
  const relevant = terms.filter((term) => source.includes(term));
  if (relevant.length === 0) return { relevant: 0, preserved: 0, value: 1 };

  const preserved = relevant.filter((term) => draft.includes(term)).length;
  return { relevant: relevant.length, preserved, value: preserved / relevant.length };
}
