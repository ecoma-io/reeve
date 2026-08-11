import { describe, expect, it } from "vitest";

import { judge } from "./judge.js";
import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { translate, type Attempt } from "./draft.js";

/**
 * The panel deciding between drafts a real `translate` produced and a real
 * `score` admitted — everything behind it genuine except the endpoint.
 *
 * The seam is the point. The unit tests build an `Attempt` by hand, which
 * proves the tally and proves nothing about the two rankings meeting: the
 * drafts arrive already sorted, already sanitized, and already filtered by a
 * module that throws out everything provable. What is worth pinning here is
 * that a judge only ever chooses among what survived that, and that the score's
 * order is what it falls back to.
 *
 * The endpoint stays scripted for the same reason it does everywhere else — a
 * test that reached a model would measure somebody's free tier and answer
 * differently on every run.
 */

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };

/** An endpoint whose models answer with whatever the case scripted for them. */
function scripted(answers: Record<string, string | Completion>): Provider {
  return {
    complete(model: string): Promise<Completion> {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({
          ok: false,
          model,
          reason: "no answer scripted",
          kind: "protocol",
        });
      }
      return Promise.resolve(
        typeof answer === "string"
          ? { ok: true, model, content: answer, finishReason: "stop" }
          : answer,
      );
    },
  };
}

const SOURCE = [
  "Sau khi nâng cấp thì trình đóng gói không còn phân giải đúng entry point nữa.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Chi tiết ở #42, cc @johnitvn.",
].join("\n");

/** Faithful, and the plainer of the two readings. */
const PLAIN = [
  "After the upgrade the bundler no longer resolves the entry point correctly.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Details in #42, cc @johnitvn.",
].join("\n");

/** Equally faithful, and the one a reader would rather have. */
const FLUENT = [
  "Since the upgrade, the bundler no longer resolves the entry point properly.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "More detail in #42, cc @johnitvn.",
].join("\n");

/** Translates the code block, which the score can measure and does not admit lightly. */
const MANGLED = [
  "After the upgrade the bundler no longer resolves the entry point correctly.",
  "",
  "```sh",
  "pnpm xây-dựng --lọc @ecoma-io/reeve",
  "```",
  "",
  "Details in #42, cc @johnitvn.",
].join("\n");

/**
 * The admitted drafts of a real translation, best score first — one model per
 * scripted answer, one draft each, so the model id names the draft.
 */
async function attempts(answers: Record<string, string>): Promise<readonly Attempt[]> {
  const models = Object.keys(answers);
  const translation = await translate({
    provider: scripted(answers),
    models,
    source: SOURCE,
    from: vietnamese,
    to: english,
    languages: [vietnamese, english],
    drafts: models.length,
  });
  return translation.attempts;
}

describe("choosing between drafts a real run produced", () => {
  it("posts the draft the panel preferred over the one the score ranked first", async () => {
    const admitted = await attempts({ "model-a": PLAIN, "model-b": FLUENT });
    // Both are faithful, so the scorer cannot separate them and the panel is
    // deciding the only thing left — which is the case judges exist for.
    expect(admitted).toHaveLength(2);
    expect(admitted[0]?.score.value).toBe(admitted[1]?.score.value);

    const verdict = await judge({
      provider: scripted({ "judge-a": "2", "judge-b": "1" }),
      judges: [["judge-a"], ["judge-b"]],
      source: SOURCE,
      to: english,
      attempts: admitted,
    });

    // Seat 0 was shown the score's order and seat 1 the rotation, so both
    // ballots name the same draft.
    expect(verdict.decidedBy).toBe("judges");
    expect(verdict.winner?.text).toContain("Since the upgrade");
  });

  it("never offers a draft the score refused", async () => {
    // The second model answers in the source language, which `score` proves
    // rather than measures — so it never reaches a ballot, and no vote can
    // reinstate it.
    const admitted = await attempts({ "model-a": PLAIN, "model-b": SOURCE });
    expect(admitted).toHaveLength(1);

    const provider = scripted({ "judge-a": "1" });
    const verdict = await judge({
      provider,
      judges: [["judge-a"]],
      source: SOURCE,
      to: english,
      attempts: admitted,
    });

    expect(verdict.winner?.text).toContain("After the upgrade");
    expect(verdict.decidedBy).toBe("score");
  });

  it("shows the judge the sanitized text, markers and all", async () => {
    // What gets posted is what gets judged. Every draft carries the same
    // markers and the source carries none, so this cannot separate two drafts —
    // but a ballot quoting text the reader will never see would be judging
    // something else.
    const admitted = await attempts({ "model-a": PLAIN, "model-b": FLUENT });
    const provider = scripted({ "judge-a": "1" });

    await judge({
      provider,
      judges: [["judge-a"]],
      source: SOURCE,
      to: english,
      attempts: admitted,
    });

    expect(admitted[0]?.text).toContain("#<!---->42");
  });

  it("keeps the score's winner when every judge fails", async () => {
    const admitted = await attempts({ "model-a": MANGLED, "model-b": PLAIN });
    // The mangled code block costs it the heaviest measurement, so the scorer
    // ranks the faithful draft first without any judge being asked.
    expect(admitted[0]?.text).toContain("pnpm build");

    const verdict = await judge({
      provider: scripted({}),
      judges: [["judge-a"], ["judge-b"]],
      source: SOURCE,
      to: english,
      attempts: admitted,
    });

    expect(verdict.winner?.text).toContain("pnpm build");
    expect(verdict.decidedBy).toBe("score");
    expect(verdict.failures).toHaveLength(2);
  });

  it("reports a language nothing translated rather than posting a refused draft", async () => {
    const admitted = await attempts({ "model-a": SOURCE });
    expect(admitted).toHaveLength(0);

    const verdict = await judge({
      provider: scripted({ "judge-a": "1" }),
      judges: [["judge-a"]],
      source: SOURCE,
      to: english,
      attempts: admitted,
    });

    expect(verdict.winner).toBeNull();
  });
});
