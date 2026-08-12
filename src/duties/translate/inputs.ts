/**
 * The pure half of reading this duty's inputs — validation and shaping that
 * needs no `@actions/core` call of its own.
 *
 * `readSettings` and `readAttribution` stay in `main.ts` rather than moving
 * here, deliberately: both call `core.getInput`/`core.getBooleanInput`
 * directly, and `main.integration.test.ts`'s own "reads every input it
 * declares" check finds every one of those calls by scanning exactly two
 * files — `main.ts` and `core/inputs.ts` — for the literal text. Moving a
 * function that calls `core.getInput` itself out of `main.ts` would make
 * that check stop seeing it, which is a behavior-freeze break this wave may
 * not make. What moves here is only what was already free of that call:
 * `targets` and `readBody` never touched `core.*`, and `parseChunkChars`
 * already took its raw string as a parameter rather than reading it.
 */
import type { Language } from "../../core/languages.js";

import { marker } from "./publish.js";

/**
 * The author's own words, and whether the tail of them was left behind.
 *
 * Split before truncation, so the limit applies to what is actually translated
 * rather than being spent on a block a previous run wrote. Takes text rather
 * than fetching it, because a reply's body arrives from the listing that found
 * it and a body arrives from the thread — the same three answers either way.
 */
export function readBody(
  body: string,
  limit: number | null,
): { official: string; source: string; truncated: boolean; published: string | null } {
  const { official, fingerprint: published } = marker.split(body);
  return {
    official,
    source: limit === null ? official : official.slice(0, limit),
    truncated: limit !== null && official.length > limit,
    published,
  };
}

/**
 * The languages to translate into: every configured one except the one the
 * thread is already written in.
 *
 * A thread whose language is none of the configured ones is translated into all
 * of them. That is the honest reading of "no source language among these": a
 * German issue in a repository set up for English, Vietnamese and Chinese needs
 * all three, and there is nothing to leave out.
 */
export function targets(
  languages: readonly Language[],
  from: Language | null,
): readonly Language[] {
  if (from === null) return languages;
  const source = from.code.toLowerCase();
  return languages.filter((language) => language.code.toLowerCase() !== source);
}

/**
 * `chunk-chars`'s own floor.
 *
 * Below this, a chunk stops being a request-sizing decision and starts being
 * a way to ask a model to translate one sentence at a time — more requests
 * than the body could ever need, each one paying a fixed cost (system
 * prompt, glossary, examples) for a shrinking amount of actual text. There is
 * no ceiling: a maintainer who wants larger chunks is trading the failure
 * granularity `chunks()`'s own doc comment describes, a trade this duty is
 * not in a position to refuse on their behalf.
 */
const MIN_CHUNK_CHARS = 500;

/**
 * `chunk-chars`, refused below `MIN_CHUNK_CHARS` rather than clamped — the
 * same reasoning as every other refused-not-clamped input in this project:
 * a typo that silently produced thousands of one-paragraph requests would be
 * far more expensive to notice than a run that fails on the first thread.
 */
export function parseChunkChars(raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed.length === 0 || !Number.isInteger(value) || value < MIN_CHUNK_CHARS) {
    throw new Error(
      `chunk-chars: expected a whole number of ${String(MIN_CHUNK_CHARS)} or more, got \`${raw}\`.`,
    );
  }
  return value;
}
