/**
 * The stage that decides what actually happens, and the only one whose answer
 * is allowed to matter.
 *
 * Everything above this has been talking to a model. This module never does. It
 * takes a verdict as data and the warrant as a parsed file, and it works out
 * which of the effects that verdict implies are permitted — by consulting the
 * file, the workflow's own `apply` input, and what a maintainer has already
 * done to the thread. Nothing it consults can be written by the author of an
 * issue.
 *
 * **It is a separate module from the one that built the prompt, deliberately.**
 * Validation performed inside the function that assembled a request drifts
 * toward trusting the request — it has the parsed object in scope, it knows
 * what it asked for, and one refactor later it is checking the model's claim
 * about its own permissions. A module that has only ever seen the verdict and
 * the file cannot make that mistake, because it never had the other thing.
 *
 * **The narrower of the two authorities wins, always.** The warrant and the
 * workflow are both reviewable and they can disagree. A workflow may restrict
 * what the file granted; it may never widen it. That is not a preference about
 * precedence, it is the only direction in which a mistake is safe.
 *
 * **A maintainer's decision is not overruled.** A label a human applied is a
 * statement, and this module treats it as one: an exclusive conflict against a
 * label already on the thread is resolved in the human's favour, every time,
 * with no input that changes it.
 */
import * as core from "@actions/core";

import { CAPABILITIES, type Capability, type Label, type Warrant } from "./warrant.js";

/**
 * The `apply` input, refused rather than guessed at.
 *
 * This is the one input where a lenient parse is a security decision rather
 * than a convenience. `GITHUB_TOKEN` cannot express "labels but not comments" —
 * `issues: write` grants labelling, commenting, closing and assigning as one
 * indivisible scope — so this list and the warrant are the only things standing
 * between a verdict and the tracker. A misspelling that silently granted
 * nothing is a bug a maintainer discovers as an absence, which is the hardest
 * kind to notice; one that silently granted everything would be the last bug
 * this action shipped.
 */
export function parseApply(raw: string): readonly Capability[] {
  const value = raw.trim().toLowerCase();
  if (value === "none") return [];

  const requested = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (requested.length === 0) {
    throw new Error("apply: no entries. Use `none` to grant nothing, explicitly.");
  }

  const granted: Capability[] = [];
  for (const entry of requested) {
    const capability = CAPABILITIES.find((known) => known === entry);
    if (capability === undefined) {
      throw new Error(
        `apply: \`${entry}\` is not something a duty can be asked to do. ` +
          `Expected any of ${CAPABILITIES.join(", ")}, or \`none\`.`,
      );
    }
    if (!granted.includes(capability)) granted.push(capability);
  }
  return granted;
}

export interface Narrowed {
  /** What both authorities allow. This is what the run may actually do. */
  readonly permitted: readonly Capability[];
  /**
   * What the workflow asked for and the file does not grant. Not an error —
   * the file is the authority — but a silence a maintainer would misread, so
   * the caller warns with it.
   */
  readonly withheld: readonly Capability[];
}

/** The intersection, in the order the file granted them. */
export function narrow(granted: readonly Capability[], requested: readonly Capability[]): Narrowed {
  return {
    permitted: granted.filter((capability) => requested.includes(capability)),
    withheld: requested.filter((capability) => !granted.includes(capability)),
  };
}

/**
 * `narrow`, and the warning every duty writes about what it withheld.
 *
 * A withheld capability is not an error — the file is the authority, and the
 * narrower of the two wins by design — but it is a silence a maintainer
 * reading `apply` would misread, so it is said once per capability rather
 * than left to be inferred from a run that quietly did less than the workflow
 * asked for.
 *
 * `warrantPath` is a parameter rather than read off the warrant because the
 * five duties do not agree about which spelling of the path they quote:
 * translate names the raw `warrant` input, the rest name `warrant.path`. The
 * two differ only for a consumer who wrote a path that normalises to a
 * different string, and reconciling them is a behaviour change rather than
 * this extraction's business.
 */
export function narrowWarned(
  granted: readonly Capability[],
  requested: readonly Capability[],
  duty: string,
  warrantPath: string,
): Narrowed {
  const narrowed = narrow(granted, requested);
  for (const capability of narrowed.withheld) {
    core.warning(
      `\`apply\` asks for \`${capability}\`, which \`${warrantPath}\` does not grant to ${duty}. ` +
        "The narrower of the two wins.",
    );
  }
  return narrowed;
}

/** One thing that was proposed and did not happen, and why. */
export interface Refusal {
  /** What was proposed — a label name, most often. */
  readonly what: string;
  /** A sentence for the log and the report. */
  readonly why: string;
}

export interface LabelDecision {
  /** The labels to apply, in the order the verdict proposed them. */
  readonly applied: readonly string[];
  /** Everything proposed that will not be applied. */
  readonly refused: readonly Refusal[];
}

/**
 * Which of the proposed labels may be applied.
 *
 * Every check is against `taxonomy` or against the thread as it stands, and
 * never against the verdict's own account of itself. A verdict that claims a
 * label is permitted is a verdict repeating something it read in an issue
 * body.
 *
 * `taxonomy` is not necessarily the warrant's whole one — a caller narrowed
 * by its own `labels`-style input (triage's, for instance) passes only the
 * subset that input granted, so a name that exists in the file but outside
 * that subset is refused here exactly as a name the file never had at all
 * would be. Checking against the narrowed list rather than the file directly
 * is what makes the narrowing hold against an injected or hallucinated
 * proposal, not only against an honest one — a verdict is data, and a
 * subset a caller never offered the model is not something the model gets
 * to reach for anyway.
 *
 * Order is the verdict's own, which is the model's preference order, and it is
 * what breaks an exclusive conflict between two proposals: the first one named
 * wins. That is a real decision and not a tie-break dressed up — asking the
 * model to resolve its own conflict is asking the least reliable participant
 * the hardest question.
 *
 * `confidence` is the verdict's own account of how sure it is, checked against
 * `floor` — the run's own floor, the `confidence` input every label has always
 * shared — unless the label names a floor of its own in the warrant, which
 * then answers for that label alone. A label costly to get wrong can ask for
 * more certainty than the run otherwise requires, without moving the run's
 * floor for every other label to get it.
 */
export function enforceLabels(
  path: string,
  taxonomy: readonly Label[],
  proposed: readonly string[],
  onThread: readonly string[],
  confidence: number,
  floor: number,
): LabelDecision {
  const byName = new Map(taxonomy.map((label) => [label.name, label]));
  const applied: string[] = [];
  const refused: Refusal[] = [];
  const seen = new Set<string>();
  const already = new Set(onThread);

  for (const name of proposed) {
    if (seen.has(name)) continue;
    seen.add(name);

    const entry = byName.get(name);
    if (entry === undefined) {
      // The single check that makes injected text unable to invent an outcome
      // — or reach past whatever slice of the taxonomy this run was scoped
      // to. Text can persuade a model; it cannot add a name to a file it is
      // not in, or to a `labels` subset the workflow never granted it.
      refused.push({ what: name, why: `\`${path}\` does not name it` });
      continue;
    }

    const labelFloor = entry.confidence ?? floor;
    if (confidence < labelFloor) {
      refused.push({
        what: name,
        why:
          entry.confidence === null
            ? `confidence ${confidence.toFixed(2)} is under the floor of ${labelFloor.toFixed(2)}`
            : `confidence ${confidence.toFixed(2)} is under \`${name}\`'s own floor of ${labelFloor.toFixed(2)}`,
      });
      continue;
    }

    if (already.has(name)) {
      refused.push({ what: name, why: "the thread already carries it" });
      continue;
    }

    // Against what a maintainer already decided first, and then against what
    // this same verdict proposed. A human's label is a statement, and no input
    // turns overruling it on.
    const human = entry.exclusiveWith.find((other) => already.has(other));
    if (human !== undefined) {
      refused.push({
        what: name,
        why: `the thread already carries \`${human}\`, which excludes it`,
      });
      continue;
    }

    // Both directions. `needs reproduction` declaring itself exclusive with
    // `bug` has to hold when the verdict proposed `bug` first, and a warrant
    // that only wrote the rule on one of the pair means the same thing as one
    // that wrote it on both.
    const conflict = applied.find(
      (kept) =>
        entry.exclusiveWith.includes(kept) ||
        (byName.get(kept)?.exclusiveWith.includes(name) ?? false),
    );
    if (conflict !== undefined) {
      refused.push({ what: name, why: `it cannot be applied alongside \`${conflict}\`` });
      continue;
    }

    applied.push(name);
  }

  return { applied, refused };
}

/** The handles behind a set of applied labels, split by what GitHub can do with them. */
export interface Owners {
  /** Handles the assignee endpoint takes, without the `@`. */
  readonly users: readonly string[];
  /**
   * Teams the taxonomy named.
   *
   * Kept apart because **an issue cannot be assigned to a team.** GitHub's
   * assignee endpoint takes usernames, and team assignment exists only as a
   * review request on a pull request. A warrant naming `@org/team` as an owner
   * is not wrong about who owns the area — it is describing something the
   * tracker has no field for — so the run says so once rather than dropping it
   * silently or failing over it.
   */
  readonly teams: readonly string[];
}

/**
 * Who the taxonomy says owns these labels.
 *
 * Deduplicated, because two labels owned by the same person is one assignment,
 * and in the order the labels were applied so a report reads the way the
 * verdict did. Whether a username can actually be assigned is still the API's
 * answer at apply time — someone who is not a collaborator is refused there —
 * which is why nothing here treats the result as certain.
 */
export function owners(warrant: Warrant, applied: readonly string[]): Owners {
  const users: string[] = [];
  const teams: string[] = [];

  for (const name of applied) {
    const owner = warrant.labelNamed(name)?.owner;
    if (owner === null || owner === undefined) continue;

    // Stripped here rather than at parse time, so the file and every message
    // about the file read the same way a person wrote it.
    const handle = owner.replace(/^@/, "");
    const into = handle.includes("/") ? teams : users;
    if (!into.includes(handle)) into.push(handle);
  }

  return { users, teams };
}
