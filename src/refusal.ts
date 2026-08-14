/**
 * What the root action says, and why it says anything at all.
 *
 * Reeve ships one action per duty, from a subdirectory: a workflow writes
 * `uses: ecoma-io/reeve/triage@v0.1`, never `uses: ecoma-io/reeve@v0.1`. The root
 * `action.yml` exists because GitHub reads a Marketplace listing from the
 * repository root and from nowhere else — so the root is a listing, and it is
 * not a duty.
 *
 * That leaves a real hazard: `uses: ecoma-io/reeve@v0.1` is the obvious thing to
 * write, it resolves, and it runs this. The one behaviour that is not allowed
 * is for it to quietly succeed. A run that cannot do its job fails red, and
 * this one cannot do any job — so it fails, names what the consumer asked for,
 * and says what to write instead.
 *
 * Nothing here reaches a network or a model. It is a signpost.
 */

/**
 * The duties this ref actually carries, in the order the documentation
 * introduces them.
 *
 * A list rather than a boolean because the message a consumer needs differs by
 * case: with nothing built the honest answer is the roadmap, and with something
 * built the answer is a corrected `uses:` line. Both are below, and both are
 * exercised by tests.
 */
export const DUTIES: readonly string[] = [
  "translate",
  "triage",
  "duplicate",
  "respond",
  "lifecycle",
  "harmonise",
  "dependa",
];

/**
 * Duties with a documented contract and no code at this ref.
 *
 * A name in both lists would be answered by the first branch below, so a duty
 * moves from here to `DUTIES` in the pull request that builds it rather than in
 * a follow-up. Empty now that every documented duty has landed; the branch
 * below stays live for whatever gets documented next, and is exercised in
 * tests by passing a `planned` list of its own rather than by this constant.
 */
export const PLANNED: readonly string[] = [];

const ROADMAP = "https://github.com/ecoma-io/reeve/blob/main/docs/doctrine/north-star.md#7-roadmap";

/**
 * The ref to write in the corrected line: the one the consumer already pinned.
 *
 * Never a version written down here. A constant would be a second place the
 * current release line is recorded, it would go stale on the next minor, and it
 * would go stale silently — telling somebody pinned to one line to write
 * another. The runner sets `GITHUB_ACTION_REF` to the ref this action was
 * resolved from, which is by construction the ref they wrote.
 *
 * Off a runner there is no such ref and no pin either, so the placeholder is
 * the honest answer rather than a guess at what they meant.
 */
function pinned(): string {
  const ref = process.env.GITHUB_ACTION_REF ?? "";
  return ref.trim().length === 0 ? "<the ref you pinned>" : ref.trim();
}

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
 * `built` and `planned` are parameters rather than direct reads of `DUTIES` and
 * `PLANNED` so the message for either kind of ref is testable independently of
 * what this ref actually carries — `built` before any ref does, and `planned`
 * after `PLANNED` has emptied out because every documented duty has landed. A
 * default that is only ever overridden by a test would be a smell; this one is
 * the whole reason the function has two branches.
 */
export function refusal(
  raw: string,
  built: readonly string[] = DUTIES,
  planned: readonly string[] = PLANNED,
): string {
  const duty = normalise(raw);

  if (duty.length > 0 && built.includes(duty)) {
    return [
      `\`${duty}\` is a duty, but it is not this action.`,
      `Write \`uses: ecoma-io/reeve/${duty}@${pinned()}\` instead of \`uses: ecoma-io/reeve@${pinned()}\`.`,
    ].join("\n");
  }

  if (duty.length > 0 && planned.includes(duty)) {
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
  return `Available here: ${built.map((duty) => `ecoma-io/reeve/${duty}@${pinned()}`).join(", ")}`;
}
