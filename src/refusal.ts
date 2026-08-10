/**
 * What the root action says, and why it says anything at all.
 *
 * Reeve ships one action per duty, from a subdirectory: a workflow writes
 * `uses: ecoma-io/reeve/triage@v1`, never `uses: ecoma-io/reeve@v1`. The root
 * `action.yml` exists because GitHub reads a Marketplace listing from the
 * repository root and from nowhere else — so the root is a listing, and it is
 * not a duty.
 *
 * That leaves a real hazard: `uses: ecoma-io/reeve@v1` is the obvious thing to
 * write, it resolves, and it runs this. The one behaviour that is not allowed
 * is for it to quietly succeed. A run that cannot do its job fails red, and
 * this one cannot do any job — so it fails, names what the consumer asked for,
 * and says what to write instead.
 *
 * Nothing here reaches a network or a model. It is a signpost.
 */

/**
 * The duties this ref actually carries, in the order the documentation
 * introduces them. Empty until the first one lands.
 *
 * A list rather than a boolean because the message a consumer needs differs by
 * case: with nothing built the honest answer is the roadmap, and with something
 * built the answer is a corrected `uses:` line. Both are below, and both are
 * exercised by tests, so the second does not arrive untested on the day this
 * array stops being empty.
 */
export const DUTIES: readonly string[] = [];

/** Duties with a documented contract and no code at this ref. */
export const PLANNED: readonly string[] = ["triage", "translate", "duplicate", "respond"];

const ROADMAP = "https://github.com/ecoma-io/reeve/blob/main/docs/north-star.md#6-roadmap";

/**
 * Normalises what a consumer wrote in the `duty` input.
 *
 * Case and surrounding whitespace are the two ways a correct answer arrives
 * looking wrong — `Triage`, or the trailing newline a YAML block scalar leaves.
 * Neither is worth a different message than the corrected spelling would have
 * got.
 */
export function normalise(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The message this action fails with.
 *
 * Written to be read in a workflow log by someone who has just pinned Reeve for
 * the first time and has no idea why their job is red. Every branch ends in a
 * line they can paste.
 *
 * `built` is a parameter rather than a direct read of `DUTIES` so the message
 * for a ref that carries duties is testable before any ref does. A default that
 * is only ever overridden by a test would be a smell; this one is the whole
 * reason the function has two branches.
 */
export function refusal(raw: string, built: readonly string[] = DUTIES): string {
  const duty = normalise(raw);

  if (duty.length > 0 && built.includes(duty)) {
    return [
      `\`${duty}\` is a duty, but it is not this action.`,
      `Write \`uses: ecoma-io/reeve/${duty}@v1\` instead of \`uses: ecoma-io/reeve@v1\`.`,
    ].join("\n");
  }

  if (duty.length > 0 && PLANNED.includes(duty)) {
    return [
      `\`${duty}\` has a documented contract but no code at this ref.`,
      `It arrives with the stage that builds it: ${ROADMAP}`,
    ].join("\n");
  }

  const opening =
    duty.length === 0
      ? "`ecoma-io/reeve` is not a duty. Reeve ships one action per duty, and a workflow names the one it wants."
      : `Reeve has no duty called \`${duty}\`.`;

  return [opening, available(built)].join("\n");
}

/** The half of the message that lists what a consumer could write instead. */
function available(built: readonly string[]): string {
  if (built.length === 0) {
    return `No duty has been built at this ref yet. What is planned, and when: ${ROADMAP}`;
  }
  return `Available here: ${built.map((duty) => `ecoma-io/reeve/${duty}@v1`).join(", ")}`;
}
