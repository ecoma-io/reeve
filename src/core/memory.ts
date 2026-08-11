/**
 * What a maintainer has already decided, kept where a pull request can see it.
 *
 * A general model is unreliable about labels for a reason that no amount of
 * prompt gets around: whether a slow query is `performance` or `bug` is a
 * decision **this project made**, and nothing in a model's training says where
 * this project put it. Retrieval over decisions maintainers already made is the
 * thing that fixes that, and it is the only stage in the pipeline whose
 * accuracy improves by itself.
 *
 * **Committed to the repository, as newline-delimited JSON.** Three alternatives
 * were available and each fails somewhere specific. The Actions cache is not
 * writable from a fork's pull request and GitHub may evict it after seven days
 * of no reads — a memory of what a maintainer decided that the platform is free
 * to delete. A hosted vector store makes a self-contained action into a service
 * with an account and a bill. Reading the tracker's own history through the API
 * cannot distinguish a convention from an accident, and cannot see a decision
 * that was never expressed as a label change. A committed store is in the diff,
 * in the history, and in the fork.
 *
 * **Lexical retrieval, so no embeddings provider is required.** BM25 over the
 * store is worse than a good embedding at finding a paraphrase and needs
 * nothing — no second endpoint, no second key, no second bill, and no silent
 * dependency on a model that a provider may retire. Reeve's central claim is
 * that this runs on whatever a project can already afford, and a retrieval
 * stage that needed its own paid API would be that claim with an asterisk.
 *
 * **The similarity function is a seam, and that is not decoration.** What is
 * built here ranks a Vietnamese thread against Vietnamese corrections and an
 * English thread against English ones, because shared words are what it counts.
 * Reeve's whole thesis is that those should be the same memory — a correction a
 * maintainer made on an English report should inform the verdict on the
 * Vietnamese one describing the same thing — and reaching that needs the
 * language layer that is not built yet. So the ranking is a parameter with one
 * honest implementation today, rather than an assumption baked through the
 * module.
 *
 * **An empty store is the cold start, not an error.** Every duty works with no
 * memory. It works better with one, and the store fills as a side effect of
 * correcting it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One decision, as it is written to the store.
 *
 * The excerpt rather than the body: this file is committed, read in diffs and
 * carried into every fork, and a store that copied whole issue bodies would be
 * a second copy of the tracker with none of its moderation. What retrieval
 * needs is enough text to match on.
 */
export interface Correction {
  /** The thread this was decided on. */
  readonly thread: number;
  /** When, as an ISO-8601 instant. */
  readonly at: string;
  readonly title: string;
  /** The opening of the body, cut at `EXCERPT`. */
  readonly excerpt: string;
  /** The language it was written in, or null when detection reached no answer. */
  readonly language: string | null;
  /** What was proposed at the time. Empty when nothing was. */
  readonly proposed: readonly string[];
  /** What a maintainer settled on. This is the part with the authority. */
  readonly decided: readonly string[];
  /** Who decided. A handle, without the `@`. */
  readonly by: string;
  /** Why, in their words. The highest-value field and the one most often absent. */
  readonly note: string | null;
  /**
   * This correction's title and excerpt, rendered into the run's pivot
   * language — the first language named in `languages` (or the warrant's own
   * `languages:`), which is what a store built by several projects in several
   * languages converges on as a common tongue.
   *
   * `null` when no rendering was produced: the correction's own `language`
   * already is the pivot, so there is nothing to translate into, or a
   * translation was attempted and every model rotated past it. Either reading
   * of `null` is safe — recall falls back to the correction's own text, which
   * is exactly right in the first case and merely misses a cross-language
   * match in the second, never breaking on a store written before this field
   * existed.
   */
  readonly pivot: {
    readonly language: string;
    readonly title: string;
    readonly excerpt: string;
  } | null;
}

/** How much of a body is kept. Enough to match on, far short of a copy of the tracker. */
export const EXCERPT = 500;

/**
 * How a thread is ranked against the store.
 *
 * Takes the text being triaged and one string per correction, and answers with
 * one score per correction, higher being closer. Zero and negative both mean
 * "not worth showing"; the caller drops them rather than this deciding.
 */
export type Similarity = (query: string, documents: readonly string[]) => readonly number[];

/**
 * One query in a cross-language recall — the text to rank with, and which
 * rendering of the store it should be ranked against.
 *
 * `"own"` is a correction's own title and excerpt, in whatever language it
 * was recorded in. `{ pivot: code }` picks, per correction, whichever of
 * three documents is actually written in `code` — the only ones a query in
 * `code` can honestly match:
 *
 *   1. a pivot rendering in `code` — the bridge itself, when it exists;
 *   2. failing that, the correction's own text, when the correction was
 *      *recorded* in `code` — nothing lost in translation, because there was
 *      nothing to translate: this is the case a correction recorded before a
 *      pivot-language switch still legitimately matches a query in the new
 *      pivot language, on its own words rather than a rendering it never got;
 *   3. failing both, an empty document — this correction is written in
 *      neither the language the query names nor any rendering of it, and
 *      ranking it anyway on whatever tokens happen to be shared is not a
 *      bridge, it is noise with a plausible-looking score.
 *
 * **The language travels with the query rather than being assumed from the
 * store, and that is the whole point of carrying it at all.** A project that
 * changes its configured first language part-way through a store's life
 * leaves old renderings behind in the language it used to pivot through — a
 * Vietnamese correction rendered into English before the switch to French. A
 * French-pivot query has no business matching that English text just because
 * both happen to share a few tokens with the French query — case 3 above is
 * exactly what keeps that from happening.
 */
export interface WeightedQuery {
  readonly text: string;
  readonly against: "own" | { readonly pivot: string };
}

export interface Memory {
  /** How many corrections are in the store. `0` is the cold start. */
  readonly size: number;
  /**
   * The corrections most like this text, closest first, at most `count` of
   * them. Empty when the store is empty or when nothing shares anything with
   * the query — an unrelated example in a prompt is worse than no example,
   * because a model will find a way to use it.
   */
  recall(text: string, count: number): readonly Correction[];
  /**
   * `recall`, run once per query and merged — each correction kept at the
   * best score any query found it with, deduplicated so a correction two
   * queries agree on is shown once rather than twice.
   *
   * This is the cross-language seam: one query in the thread's own language
   * reaches a correction recorded in that language directly; a second query,
   * the thread's text translated into the pivot language and matched against
   * `"pivot"`, reaches a correction recorded in a third language through the
   * pivot rendering stored alongside it. A caller with only one query in hand
   * gets exactly `recall`'s answer back — the merge of one ranking is that
   * ranking.
   */
  recallAcrossQueries(queries: readonly WeightedQuery[], count: number): readonly Correction[];
}

export function createMemory(
  corrections: readonly Correction[],
  similarity: Similarity = lexical,
): Memory {
  // Assembled once. The store is read at the start of a run and asked at most
  // once per thread, but a backfill loops, and re-tokenising the whole store
  // per thread is the kind of cost nobody notices until the store is large.
  // The pivot side cannot be precomputed the same way: which document a
  // correction contributes depends on the pivot language a query names, not
  // on the store alone, so it is built fresh per query instead — cheap,
  // because a run asks at most a couple of these.
  const ownDocuments = corrections.map(searchable);

  function ranked(text: string, against: WeightedQuery["against"]): Map<number, number> {
    if (corrections.length === 0) return new Map();
    const documents =
      against === "own"
        ? ownDocuments
        : corrections.map((correction) => searchablePivot(correction, against.pivot));
    const scores = similarity(text, documents);
    const scored = new Map<number, number>();
    scores.forEach((score, index) => {
      if (score > 0) scored.set(index, score);
    });
    return scored;
  }

  function topOf(scored: Map<number, number>, count: number): readonly Correction[] {
    return [...scored.entries()]
      .sort(
        ([leftIndex, leftScore], [rightIndex, rightScore]) =>
          rightScore - leftScore || compareAt(corrections[leftIndex], corrections[rightIndex]),
      )
      .slice(0, count)
      .map(([index]) => corrections[index])
      .filter((correction): correction is Correction => correction !== undefined);
  }

  return {
    size: corrections.length,

    recall(text, count) {
      if (corrections.length === 0 || count <= 0) return [];
      return topOf(ranked(text, "own"), count);
    },

    recallAcrossQueries(queries, count) {
      if (corrections.length === 0 || count <= 0 || queries.length === 0) return [];

      const best = new Map<number, number>();
      for (const query of queries) {
        for (const [index, score] of ranked(query.text, query.against)) {
          const current = best.get(index);
          if (current === undefined || score > current) best.set(index, score);
        }
      }
      return topOf(best, count);
    },
  };
}

// Ties broken by recency, because two equally similar decisions are best
// represented by the more recent one — a taxonomy moves, and the older
// reading of a boundary is the one that has been superseded. `left`/`right`
// here are already in "more recent first" candidate order.
function compareAt(left: Correction | undefined, right: Correction | undefined): number {
  return (right?.at ?? "").localeCompare(left?.at ?? "");
}

/**
 * What a correction is matched on.
 *
 * The title, the excerpt and the maintainer's note. Not the labels: a store
 * where `bug` is a matchable token would rank every correction that mentions
 * the word above the ones that describe the same problem, and the labels are
 * the answer rather than the question.
 */
function searchable(correction: Correction): string {
  return [correction.title, correction.excerpt, correction.note ?? ""].join("\n");
}

/**
 * The one document, of three candidates, that is actually written in
 * `target` — see `WeightedQuery`'s doc comment for the full three-way rule
 * this implements. In order: the pivot rendering, when it is in `target`;
 * failing that, the correction's own text, when the correction was recorded
 * in `target`; failing both, an empty string, so `similarity` scores it `0`
 * and this query can never surface it — not "falls back to its own text
 * regardless of language", which is exactly the false-match noise this rule
 * exists to keep out.
 */
function searchablePivot(correction: Correction, target: string): string {
  if (correction.pivot?.language === target) {
    return [correction.pivot.title, correction.pivot.excerpt, correction.note ?? ""].join("\n");
  }
  if (correction.language === target) {
    return searchable(correction);
  }
  return "";
}

/**
 * BM25, with the standard parameters.
 *
 * `k1` decides how fast a repeated term stops adding, `b` how much a long
 * document is penalised for its length. 1.2 and 0.75 are what the literature
 * settled on across corpora that look nothing like each other, which is the
 * best available reason to use them on a corpus of a few hundred issue
 * excerpts — nothing here is tuned, and tuning it against one repository's
 * store would be overfitting to that repository.
 */
const K1 = 1.2;
const B = 0.75;

export const lexical: Similarity = (query, documents) => {
  const asked = new Set(tokenise(query));
  if (asked.size === 0 || documents.length === 0) return documents.map(() => 0);

  const tokenised = documents.map(tokenise);
  const lengths = tokenised.map((tokens) => tokens.length);
  const average = lengths.reduce((sum, length) => sum + length, 0) / documents.length;

  // How many documents carry each asked-for term, which is what turns a term
  // that appears everywhere into one worth nothing.
  const carrying = new Map<string, number>();
  for (const tokens of tokenised) {
    for (const term of new Set(tokens)) {
      if (asked.has(term)) carrying.set(term, (carrying.get(term) ?? 0) + 1);
    }
  }

  return tokenised.map((tokens, index) => {
    const counts = new Map<string, number>();
    for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);

    const length = lengths[index] ?? 0;
    // `average` is 0 only when every document is empty, and then no term is
    // carried by anything and this loop never runs.
    const normalised = average === 0 ? 1 : length / average;

    let score = 0;
    for (const term of asked) {
      const frequency = counts.get(term);
      if (frequency === undefined) continue;

      const documentsWith = carrying.get(term) ?? 0;
      // The `+ 1` inside the logarithm is what keeps a term carried by every
      // document at a small positive weight rather than at zero or below. On a
      // store of a few hundred records that case is common — every correction
      // on a Node project mentions `npm` — and a negative weight would make a
      // shared word evidence of dissimilarity.
      const weight = Math.log(1 + (documents.length - documentsWith + 0.5) / (documentsWith + 0.5));
      score += weight * ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * normalised)));
    }
    return score;
  });
};

/**
 * Text as terms, in a way that does not assume the writer's language puts
 * spaces between words.
 *
 * A run of letters and digits is a term. That is the whole of it for anything
 * written in a script that separates words — English, Vietnamese, Russian — and
 * it is useless for one that does not: `导出功能有问题` is a single run, so
 * matching on runs means matching on nothing, and the thread nobody can recall
 * anything for is the one written in Chinese.
 *
 * So a run **with no cased letter in it** is also emitted as its character
 * bigrams, which is what makes the store searchable in those scripts.
 *
 * **Case rather than a list of scripts, and that is the load-bearing choice
 * here.** A "scripts that need this" constant is a thing contributors add to, a
 * thing that goes stale on the next Unicode revision, and a thing whose gaps
 * are invisible to everyone who does not write in the missing one — the exact
 * special-casing this project exists to avoid. Whether a character has an upper
 * and a lower form is a property the runtime already answers, and the scripts
 * that answer no are, near enough, the scripts that do not put spaces between
 * words. It is not a perfect proxy: Arabic and Devanagari are uncased and do
 * use spaces, so their short runs pick up bigrams they do not need. That costs
 * some precision on those two and it costs nothing anywhere else, which is the
 * right direction for a proxy to be wrong in.
 *
 * Bigramming a cased run as well was tried and is worse than it looks. Every
 * English sentence shares `es`, `in` and `re` with every other, so every
 * correction in the store matches every thread a little, and "shares nothing
 * with this" — the answer that keeps an unrelated example out of a prompt —
 * stops being reachable.
 *
 * The `40` is a ceiling on a run rather than a rule about words: a base64 blob
 * or a minified line pasted into an issue is one run of a thousand characters,
 * and bigramming it would put a thousand terms nobody will ever ask for into
 * the index.
 */
const RUN = /[\p{Letter}\p{Number}]+/gu;
const LETTER = /\p{Letter}/u;
const LONGEST_RUN = 40;

export function tokenise(text: string): string[] {
  const terms: string[] = [];

  for (const [run] of text.toLowerCase().matchAll(RUN)) {
    terms.push(run);
    if (run.length < 2 || run.length > LONGEST_RUN) continue;
    if (!LETTER.test(run) || cased(run)) continue;

    // By code point rather than by code unit: a run of characters outside the
    // basic plane would otherwise be bigrammed into halves of surrogate pairs,
    // which match nothing and are not text.
    const characters = Array.from(run);
    for (let at = 0; at + 1 < characters.length; at += 1) {
      terms.push(`${characters[at] ?? ""}${characters[at + 1] ?? ""}`);
    }
  }

  return terms;
}

/** Whether any character in the run has an upper and a lower form. */
function cased(run: string): boolean {
  return Array.from(run).some((character) => character.toLowerCase() !== character.toUpperCase());
}

/** Corrections as read, and what could not be read. */
export interface Store {
  readonly corrections: readonly Correction[];
  /**
   * Lines that were not a correction, by file. A hand-edited store is the
   * ordinary case — this is a committed file that maintainers open — so a bad
   * line is warned about and skipped rather than failing a run. Losing one
   * example is not worth losing the verdict.
   */
  readonly unreadable: readonly string[];
}

const EMPTY: Store = { corrections: [], unreadable: [] };

/**
 * Every correction under `path`.
 *
 * The path names a directory, and every `.ndjson` file in it is part of the
 * store. Sharding is what keeps this mergeable: two maintainers correcting
 * different threads in the same week append to the same file and git resolves
 * it, while a store that grew as one file would eventually make every
 * correction a conflict. Read in filename order so a run is reproducible.
 *
 * A directory that is not there is the cold start and reads as an empty store.
 * That is the same answer as a store with nothing in it, on purpose: a
 * repository that has never corrected anything and one that has just started
 * are the same repository from here.
 */
export async function readStore(path: string): Promise<Store> {
  let names: string[];
  try {
    names = (await readdir(path)).filter((name) => name.endsWith(".ndjson")).sort();
  } catch {
    return EMPTY;
  }

  const corrections: Correction[] = [];
  const unreadable: string[] = [];

  for (const name of names) {
    const file = join(path, name);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      unreadable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const [index, line] of source.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      const correction = parseCorrection(line);
      if (correction === null) {
        unreadable.push(`${file}:${String(index + 1)} is not a correction`);
        continue;
      }
      corrections.push(correction);
    }
  }

  return { corrections, unreadable };
}

/**
 * One line of the store, or null.
 *
 * Null rather than a partial record. A half-parsed correction is a maintainer's
 * decision with the decision missing, and putting one in a prompt as an example
 * teaches the model whatever the corruption happened to say.
 */
export function parseCorrection(line: string): Correction | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const thread = record.thread;
  const decided = strings(record.decided);
  // The thread and the decision are what a correction is. Everything else is
  // context that can be missing without the record ceasing to mean anything.
  if (typeof thread !== "number" || !Number.isInteger(thread) || decided === null) return null;

  return {
    thread,
    at: typeof record.at === "string" ? record.at : "",
    title: typeof record.title === "string" ? record.title : "",
    excerpt: typeof record.excerpt === "string" ? record.excerpt : "",
    language:
      typeof record.language === "string" && record.language.length > 0 ? record.language : null,
    proposed: strings(record.proposed) ?? [],
    decided,
    by: typeof record.by === "string" ? record.by : "",
    note:
      typeof record.note === "string" && record.note.trim().length > 0 ? record.note.trim() : null,
    pivot: readPivot(record.pivot),
  };
}

function strings(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every((entry) => typeof entry === "string") ? raw : null;
}

/**
 * A correction's pivot rendering, or `null` for anything that is not one —
 * including a store line written before this field existed, which has no
 * `pivot` key at all and reads exactly the same as one written with
 * `pivot: null`.
 *
 * A blank or whitespace-only title fails the whole pivot the same way
 * `pivot.ts`'s `readAnswer` refuses one at record time — it is the shape an
 * injected answer produces, not an ordinary translation. The excerpt is not
 * held to the same rule: an empty pivot body is what a genuinely empty thread
 * body translates to, and that is meaningful rather than suspicious.
 */
function readPivot(raw: unknown): Correction["pivot"] {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.language !== "string" || record.language.length === 0) return null;
  if (typeof record.title !== "string" || typeof record.excerpt !== "string") return null;
  if (record.title.trim().length === 0) return null;
  return { language: record.language, title: record.title, excerpt: record.excerpt };
}

/**
 * One correction as a line of the store.
 *
 * The key order is fixed and the excerpt is cut here rather than by the caller,
 * so two runs writing the same decision write the same bytes — which is what
 * keeps a diff of this file readable and a duplicate detectable.
 */
export function formatCorrection(correction: Correction): string {
  return JSON.stringify({
    thread: correction.thread,
    at: correction.at,
    title: correction.title,
    excerpt: correction.excerpt.slice(0, EXCERPT),
    language: correction.language,
    proposed: correction.proposed,
    decided: correction.decided,
    by: correction.by,
    note: correction.note,
    pivot:
      correction.pivot === null
        ? null
        : {
            language: correction.pivot.language,
            title: correction.pivot.title,
            excerpt: correction.pivot.excerpt.slice(0, EXCERPT),
          },
  });
}
