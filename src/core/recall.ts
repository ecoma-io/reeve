/**
 * The one place a recalled `Correction` becomes prompt text.
 *
 * Two duties (today: triage; eventually: duplicate) show a model past
 * decisions as examples. Both must show a *reversed* decision — a label a
 * human took back off, a close a human reopened — differently from an
 * ordinary one, and "differently" has to mean something a weak, free-tier
 * model cannot pattern-match past: a heading, not an adjective in front of
 * the same sentence. A model that reads "automation applied `bug`; a human
 * removed it" inside the same list as ordinary decisions has no structural
 * signal telling it this example argues the opposite of the others, and the
 * one thing worse than no memory of a mistake is a memory of it rendered so
 * it reads as an endorsement.
 *
 * So this is the only exported way to turn `Correction[]` into prompt text.
 * A duty that recalls corrections and writes its own loop over them
 * re-introduces exactly the inversion this module exists to prevent — see
 * `renderRecall`'s own doc comment and the test in `recall.test.ts` that
 * pins an `outcome: "overruled"` correction to never producing the plain
 * "DECIDED:" frame.
 *
 * **Fact-stating, not instruction-injecting.** The reversed frame says what
 * happened — automation did X, a human undid it — and never "do not do X
 * again" or "this is not a duplicate". The claim recorded is that one
 * specific action was reversed (`Correction.outcome`'s doc comment), and the
 * claim rendered has to stay that narrow: a maintainer who reopened a
 * genuine duplicate to keep a language-specific conversation alive did not
 * thereby declare the two threads unrelated, and a prompt that overstates
 * the lesson teaches something nobody decided.
 *
 * **Getting the corrections is here too.** Reading the store, warning about
 * the lines that were not corrections, bridging the query into the pivot
 * language when the store holds corrections the thread's own language cannot
 * reach, and ranking — one walk, shared by every duty that recalls, so that
 * "recall was disabled" and "recall found nothing" stay two different
 * sentences everywhere and the pivot bridge is spent on the same conditions
 * everywhere.
 */
import * as core from "@actions/core";

import type { Language } from "./languages.js";
import {
  createMemory,
  readStore,
  type Correction,
  type Store,
  type WeightedQuery,
} from "./memory.js";
import { translateToPivot } from "./pivot.js";
import { shown, type Names, type Provider, type Weather } from "./provider.js";

const DECISIONS_HEADING = "--- DECISIONS THIS PROJECT ALREADY MADE ---";
const REVERSED_HEADING = "--- REVERSED: A HUMAN UNDID ONE OF REEVE'S OWN ACTIONS ---";

/**
 * The recalled corrections, rendered as two structurally separate sections —
 * ordinary decisions first, then reversals — or `""` when there is nothing
 * to show. A caller with an empty `recalled` gets back `""` rather than a
 * heading with nothing under it, the same "say nothing about examples when
 * there are none" rule `triage/verdict.ts` already followed.
 *
 * BM25 ranks a reversal exactly like any other correction — relevance is
 * topical, polarity is not (`memory.ts`'s own doc comment on `searchable`) —
 * so `recalled` here is expected to arrive as whatever `recall` returned,
 * unfiltered, and the partition happens here rather than upstream.
 */
export function renderRecall(recalled: readonly Correction[]): string {
  const decisions = recalled.filter((correction) => correction.outcome === null);
  const reversed = recalled.filter((correction) => correction.outcome === "overruled");

  const sections: string[] = [];
  if (decisions.length > 0) {
    sections.push([DECISIONS_HEADING, ...decisions.map(renderDecision)].join("\n"));
  }
  if (reversed.length > 0) {
    sections.push([REVERSED_HEADING, ...reversed.map(renderReversed)].join("\n"));
  }
  return sections.join("\n\n");
}

/**
 * One ordinary decision. `decided`, not `proposed`, carries the authority:
 * what a maintainer settled on is the answer, and what was proposed at the
 * time is shown beside it only when the two differ, because a correction
 * where they differ is teaching something a correction where they agree is
 * not.
 */
function renderDecision(correction: Correction): string {
  const lines = [
    `#${String(correction.thread)}: ${correction.title}`,
    `  DECIDED: ${labelList(correction.decided)}`,
  ];
  if (differs(correction)) {
    lines.push(`  (proposed at the time: ${labelList(correction.proposed)})`);
  }
  if (correction.note !== null) lines.push(`  WHY: ${correction.note}`);
  return lines.join("\n");
}

/**
 * One reversal. `duplicateOf !== null` is a reversed close (S3); otherwise
 * it is a reversed label (S1). `decided` is deliberately not the headline
 * claim here — on a reversal line it is incidental standing, not the
 * correction (`Correction.decided`'s doc comment) — but it is still worth
 * showing so the example says what the thread stands as now, not only what
 * went wrong.
 */
function renderReversed(correction: Correction): string {
  const lines = [`#${String(correction.thread)}: ${correction.title}`];

  if (correction.duplicateOf !== null) {
    lines.push(
      `  Automation closed this thread as a duplicate of #${String(correction.duplicateOf)}.`,
      "  A human reopened it: that close was reversed.",
    );
  } else {
    const removed = correction.proposed.filter((label) => !correction.decided.includes(label));
    lines.push(
      removed.length === 0
        ? "  Automation labeled this thread. A human corrected the labels."
        : `  Automation applied ${labelList(removed)}. A human removed it.`,
      `  It stands as: ${labelList(correction.decided)}.`,
    );
  }
  if (correction.note !== null) lines.push(`  WHY: ${correction.note}`);
  return lines.join("\n");
}

function labelList(labels: readonly string[]): string {
  return labels.length === 0 ? "no labels" : labels.join(", ");
}

function differs(correction: Correction): boolean {
  const decided = [...correction.decided].sort();
  const proposed = [...correction.proposed].sort();
  return decided.length !== proposed.length || decided.some((name, at) => name !== proposed[at]);
}

/**
 * The store at `path`, with every line that was not a correction warned about.
 *
 * Loud, because this is a committed file that maintainers open by hand: losing
 * one example is not worth losing the verdict, and losing it silently is not
 * worth anything. A missing directory is the cold start, and `readStore`
 * already reads it as an empty store rather than a fault.
 */
export async function readStoreWarned(path: string): Promise<Store> {
  const store = await readStore(path);
  for (const line of store.unreadable) {
    core.warning(`corrections: ${line}`);
  }
  return store;
}

/**
 * The two rosters a duty configures — as much of its settings as the bridge
 * reads, so a caller passes its own `settings` and nothing has to be unpacked
 * at the call site.
 */
export interface Rosters {
  readonly models: readonly string[];
  readonly modelNames: Names;
  readonly screenModels: readonly string[];
  readonly screenNames: Names;
}

/** What one pivot bridge needs: a stage to spend, a roster to spend it on, and a thread. */
export interface Bridge {
  readonly provider: Provider;
  readonly rosters: Rosters;
  readonly title: string;
  readonly body: string;
  /** The pivot language to bridge into — see `pivotOrNone`. */
  readonly to: Language;
  readonly weather: Weather;
}

/**
 * Adds a pivot-language rendering of the thread to `queries`, when one can be
 * produced this run.
 *
 * **The cheap roster, when there is one.** A bridge is a mechanical
 * translation feeding a lexical ranker, not a deliverable anybody reads, so it
 * spends `screen-models` when those are configured and falls back to the
 * duty's own roster only when they are not. Buying the expensive roster for a
 * query nobody will ever see is the kind of cost that makes cross-language
 * recall look like a bad trade when it is not.
 *
 * **Failing is allowed.** A bridge that could not be produced — every model
 * rotated past, weather, an answer shaped wrong — leaves `queries` as it found
 * it and says so. Recall then runs on the thread's own language alone, which
 * costs a little precision and nothing else; refusing to recall at all because
 * the optional half of it failed would be trading a sure thing for a
 * nice-to-have.
 */
export async function bridgeQueries(queries: WeightedQuery[], bridge: Bridge): Promise<void> {
  const { rosters } = bridge;
  const models = rosters.screenModels.length > 0 ? rosters.screenModels : rosters.models;
  const names = rosters.screenModels.length > 0 ? rosters.screenNames : rosters.modelNames;

  const pivot = await translateToPivot({
    provider: bridge.provider,
    models,
    title: bridge.title,
    body: bridge.body,
    to: bridge.to,
    weather: bridge.weather,
  });
  for (const failure of pivot.failures) {
    core.warning(`recall: ${shown(names, failure.model)} — ${failure.reason}`);
  }

  if (pivot.draft !== null) {
    queries.push({
      text: `${pivot.draft.title}\n${pivot.draft.body}`,
      against: { pivot: bridge.to.code },
    });
  } else {
    core.info(
      "Cross-language recall could not translate this thread into the pivot language this run " +
        "— recall used the thread's own language only.",
    );
  }
}

export interface RecallRequest {
  /**
   * How many corrections may reach the prompt — `memory.recall`, already
   * defaulted to `memory.ts`'s `RECALLED`. Zero or less means the store is not touched
   * at all, not merely searched-and-returns-nothing.
   */
  readonly count: number;
  /** The corrections store's directory. */
  readonly path: string;
  readonly title: string;
  readonly body: string;
  /** The thread's own language, or `null` when detection did not settle on one. */
  readonly language: Language | null;
  /**
   * The bridge to try, or `null` when this run has none worth spending on.
   * Whether one is worth spending on is the caller's to decide, because the
   * duties do not yet agree on it — see {@link recallCorrections}.
   */
  readonly bridge: Bridge | null;
}

/** What one recall found, and what it cost the store to answer. */
export interface Recalled {
  readonly corrections: readonly Correction[];
  /** How many corrections the store holds. `0` when the store was never read. */
  readonly size: number;
  /**
   * Of `corrections`, how many were recorded in a language other than the
   * thread's — what the pivot bridge bought, stated as a number a summary can
   * show rather than a claim it has to take on trust.
   */
  readonly crossLanguage: number;
  /** Whether the store was opened at all. `false` only when `count` turned recall off. */
  readonly read: boolean;
}

/**
 * The corrections most like this thread, across the thread's own language and
 * the pivot language when a bridge is worth buying.
 *
 * **`recall: 0` is a promise as much as a setting.** The store is not touched
 * at all — not opened, not listed — which is the distinction that matters for
 * a maintainer who points `corrections` at a path they would rather this run
 * never open. The run says so out loud, because a silent no-op and an empty
 * store look identical in a log otherwise.
 *
 * **The bridge is bought only when it could change the answer.** Even with a
 * `bridge` in hand, this spends the request only if the store holds at least
 * one correction that is not already in the thread's language: a store that
 * shares one language with the thread has nothing a translated query would
 * reach that the plain one does not already reach, and that case — the common
 * one — spends no provider call here at all. What this does *not* decide is
 * whether a bridge exists to try: the duties still differ on whether a thread
 * already written in the pivot language is worth translating into itself, and
 * passing `bridge: null` is how a caller says no.
 *
 * The sentence a run logs about what it recalled stays with the caller: the
 * duties do not agree on it yet either.
 */
export async function recallCorrections(request: RecallRequest): Promise<Recalled> {
  if (request.count <= 0) {
    core.info(
      "Recall is disabled (`memory.recall` is 0 or lower) — the corrections store was not read.",
    );
    return { corrections: [], size: 0, crossLanguage: 0, read: false };
  }

  const store = await readStoreWarned(request.path);
  const memory = createMemory(store.corrections);

  const queries: WeightedQuery[] = [{ text: `${request.title}\n${request.body}`, against: "own" }];

  const own = request.language?.code ?? null;
  const bridge = request.bridge;
  if (
    bridge !== null &&
    own !== null &&
    store.corrections.some((correction) => correction.language !== own)
  ) {
    await bridgeQueries(queries, bridge);
  }

  const corrections = memory.recallAcrossQueries(queries, request.count);
  const crossLanguage =
    own === null
      ? 0
      : corrections.filter(
          (correction) => correction.language !== null && correction.language !== own,
        ).length;

  return { corrections, size: memory.size, crossLanguage, read: true };
}
