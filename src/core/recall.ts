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
 */
import type { Correction } from "./memory.js";

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
