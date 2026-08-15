/**
 * The run's own report, written where a run is looked at.
 *
 * GitHub gives every job a summary page beside its log, and it is the right
 * place for everything a maintainer wants to know about a run and nobody
 * reading the thread wants to see. The log has all of this too, in the order it
 * happened and interleaved with everything else; this is the same run arranged
 * for the person deciding whether the configuration is working.
 *
 * It is not the thread. Nothing here is ever published into a body — a
 * contributor came for the translation, and the token count is noise in it.
 *
 * **Writing this can never fail a job.** The report is a record of work that is
 * already done; a runner too old to set the variable, a summary file that has
 * hit its size limit, and a permissions oddity are all reasons to lose the
 * report and none of them are reasons to lose the run.
 *
 * **How a run concludes is here too.** The capacity warning every duty writes
 * before its outputs, and the auth section every duty appends to its page,
 * are both things a fifth duty has to get right by default rather than by
 * remembering — see {@link warnIfStarved} and {@link writeRunSummary}.
 */
import * as core from "@actions/core";

import { STAGE, total, type Spend } from "./meter.js";
import { starved, protocolExhausted, type Failure, type Weather } from "./provider.js";

/**
 * The endpoints whose keys were refused, named on the page — the half of the
 * multi-endpoint amendment to
 * [D12](../../docs/doctrine/north-star.md#d12-capacity-is-weather-authority-is-configuration)
 * that is a reporting duty rather than a control-flow one: a run that kept
 * going on its other endpoints has to say which ones it kept going *without*,
 * not just that it finished.
 *
 * Empty string when nothing auth-failed, which is every single-endpoint run
 * that got this far — those fail red on the first refusal and never reach a
 * summary with a deferred failure to report. Endpoint aliases are safe to
 * render bare: the input grammar refused anything but letters, digits, `-`
 * and `_` before a run began. The refusal's own text stays in the log, where
 * every failure's reason already goes — a provider's response body has no
 * business being rendered as this page's markdown.
 */
export function authSection(failures: readonly Failure[]): string {
  if (failures.length === 0) return "";
  const named = failures.map((failure) => `\`${failure.endpoint ?? "default"}\``).join(", ");
  return [
    "",
    "",
    "### Endpoints that failed to authenticate",
    "",
    `${named} — refused this run's key (an HTTP 401 or 403; the log has each ` +
      "refusal's own words). Authority is configuration, not weather: nothing " +
      "asked these endpoints again after the first refusal, and the run " +
      "carried on with the endpoints that still authenticated.",
  ].join("\n");
}

export async function writeSummary(markdown: string): Promise<void> {
  // Set by every current runner and by nothing else — `act` and a local
  // `node dist/index.js` have no summary to write to, and warning about it on
  // every local run would train a reader to ignore warnings.
  if ((process.env.GITHUB_STEP_SUMMARY ?? "").length === 0) {
    core.debug("No step summary to write to (GITHUB_STEP_SUMMARY is unset).");
    return;
  }

  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    core.warning(
      `The run summary could not be written — ${error instanceof Error ? error.message : String(error)}. ` +
        "The run itself was unaffected.",
    );
  }
}

/**
 * What a run says when every model on its roster ran dry.
 *
 * D12, in one sentence: this is weather, not a broken configuration, so the
 * run reports whatever it delivered rather than failing red. The second half
 * differs by mode because the honest thing to tell the reader differs — a
 * sweep points at `remaining`, which is where the rest of the backlog went; a
 * single-thread run has no such place to point.
 */
export function starvedWarning(sweep: boolean): string {
  return (
    "Every model in `models` failed on capacity this run. " +
    (sweep
      ? "The sweep delivered what it could before the roster ran dry, and " +
        "stopped early — see `remaining`."
      : "This run delivered what it could rather than failing red — weather, " +
        "not a broken configuration.")
  );
}

/**
 * Whether the roster ran dry this run — and, if it did, the one warning that
 * says so.
 *
 * Both halves together because a run that discovers it was starved and does
 * not say so is a run whose `starved` output is the only place the fact
 * survives, and an output nobody reads is not a report. The answer is returned
 * as well as warned about, because every duty also writes it as an output and
 * a second `starved(...)` call could disagree with the first.
 */
export function warnIfStarved(
  models: readonly string[],
  weather: Weather,
  sweep: boolean,
): boolean {
  const rosterStarved = starved(models, weather);
  if (rosterStarved) core.warning(starvedWarning(sweep));
  return rosterStarved;
}

/**
 * When every model on the roster failed with a protocol error — a model id
 * that does not exist, a body the provider rejected, a field it does not
 * accept — the roster was not starved by capacity; it was exhausted by a
 * configuration error. A run like this must not stay green: [D5](../../docs/doctrine/north-star.md#d5-failure-is-loud-it-is-never-plausible)
 * says a run that cannot do its job fails red.
 *
 * Call this after a rotation returns no usable answer, alongside
 * {@link warnIfStarved} for the capacity case. Returns `true` and sets the
 * job failed; returns `false` when the condition does not apply.
 */
export function failIfProtocolExhausted(
  models: readonly string[],
  failures: readonly Failure[],
): boolean {
  const exhausted = protocolExhausted(models, failures);
  if (exhausted) {
    const reasons = failures.map((f) => `${f.model}: ${f.reason}`).join("; ");
    core.setFailed(
      `every model on the roster failed with a protocol error — this is a configuration problem, not capacity weather. ${reasons}`,
    );
  }
  return exhausted;
}

/**
 * This run's page, with the endpoints that refused its key named underneath.
 *
 * Every duty that asks a model appends {@link authSection} to whatever it
 * rendered, and it has to be every one of them: the multi-endpoint half of D12
 * only holds up if a run that carried on without an endpoint says which one it
 * carried on without, and a duty that forgot the suffix would report a clean
 * run that was not clean.
 */
export async function writeRunSummary(page: string, weather: Weather): Promise<void> {
  await writeSummary(page + authSection(weather.authFailures));
}

/**
 * A markdown table, or nothing at all when there are no rows.
 *
 * An empty table renders as a header over a rule, which reads like a bug in the
 * report rather than as the absence it is. The caller decides what to say
 * instead, because "no requests were made" and "no languages were translated"
 * are different sentences.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";

  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/**
 * A count as a reader counts, grouped in thousands.
 *
 * `Intl` rather than a hand-rolled regex, and the invariant locale rather than
 * the runner's: a report whose thousands separator depends on which machine
 * picked up the job is a report two people cannot compare.
 */
const COUNT = new Intl.NumberFormat("en-US");

export function count(value: number): string {
  return COUNT.format(value);
}

/**
 * Cell text that cannot break the row it sits in.
 *
 * The backslash goes first and in the same pass, because it is the escape
 * character: a name ending in one would otherwise have it escape the `\` this
 * function just added, and the `|` behind it would end the cell after all.
 */
export function cell(text: string): string {
  return text.replace(/[\\|]/g, "\\$&").replace(/\r?\n/g, " ");
}

/**
 * A fenced code block wide enough to actually hold what is inside it.
 *
 * Three backticks is markdown's default fence, and this report is not the
 * only place that ever quotes model output verbatim — but a draft that
 * itself quotes a fenced code block (a maintainer asked "show me the diff",
 * say) contains a run of three or more backticks of its own, and a fixed
 * three-backtick fence around it would close early on the first one and spill
 * the rest as loose, unfenced prose. The fence returned here is always one
 * backtick longer than the longest run already inside `text`, so nothing in
 * it can ever close it before the caller does.
 */
export function fence(text: string): readonly string[] {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return [ticks, text, ticks];
}

/**
 * What the run spent, per stage and model, and what it adds up to.
 *
 * Here rather than in each duty because none of it is a duty's business: the
 * columns are the meter's, the arithmetic is the meter's, and the sentences
 * under the table are about the provider protocol rather than about labels or
 * languages. A second duty rendering its own would be a second chance to leave
 * out the line that says the totals are a floor.
 *
 * `name` is the one thing a duty knows and this does not: which of its rosters
 * a model id came from, so a judge seat called `Careful` reads as `Careful`
 * rather than as the id a maintainer masked out of the log.
 */
export function cost(spent: readonly Spend[], name: (spend: Spend) => string): string {
  const sum = total(spent);
  // Only shown once a second endpoint actually appears in the spend — a run
  // against the one endpoint every duty has always had gets the table it has
  // always gotten, with no column naming an endpoint nobody configured.
  const multiEndpoint = new Set(spent.map((spend) => spend.endpoint)).size > 1;

  const rows = spent.map((spend) => [
    STAGE[spend.purpose],
    cell(name(spend)),
    ...(multiEndpoint ? [cell(spend.endpoint ?? "default")] : []),
    count(spend.requests),
    spend.failed === 0 ? "—" : count(spend.failed),
    count(spend.prompt),
    count(spend.completion),
    count(spend.prompt + spend.completion),
  ]);

  if (rows.length === 0) {
    return [
      "### Cost",
      "",
      "No model was asked anything this run — every decision was made by code.",
    ].join("\n");
  }

  rows.push([
    "**Total**",
    "",
    ...(multiEndpoint ? [""] : []),
    `**${count(sum.requests)}**`,
    sum.failed === 0 ? "—" : `**${count(sum.failed)}**`,
    `**${count(sum.prompt)}**`,
    `**${count(sum.completion)}**`,
    `**${count(sum.prompt + sum.completion)}**`,
  ]);

  const lines = [
    "### Cost",
    "",
    table(
      [
        "Stage",
        "Model",
        ...(multiEndpoint ? ["Endpoint"] : []),
        "Requests",
        "Failed",
        "Prompt",
        "Completion",
        "Tokens",
      ],
      rows,
    ),
  ];

  // Said plainly, because the alternative is a reader treating a floor as a
  // total. Many OpenAI-compatible gateways send no `usage` at all, and a run
  // against one of those reports every request and no tokens — which is the
  // truth, and is only misleading if it goes unlabelled.
  if (sum.unreported > 0) {
    lines.push(
      "",
      `${count(sum.unreported)} of ${count(sum.requests)} request${sum.requests === 1 ? "" : "s"} ` +
        "came back without a `usage` field, so the token counts above are a floor rather than a total.",
    );
  }
  if (sum.failed > 0) {
    lines.push(
      "",
      `${count(sum.failed)} request${sum.failed === 1 ? " was" : "s were"} unusable and rotated past. ` +
        "That is what rotation costs, and it is in the totals because the provider counted it too.",
    );
  }

  return lines.join("\n");
}
