import { describe, expect, it } from "vitest";

import type { Language } from "../../core/languages.js";
import type { Completion, Provider } from "../../core/provider.js";
import { translate } from "./draft.js";

/**
 * Translating with the real segmenter, the real sanitizer, the real scorer and
 * the real detector behind it — everything except the endpoint.
 *
 * The endpoint is the one collaborator that stays scripted, and not because it
 * is awkward: a test that reached a model would be measuring somebody's free
 * tier rather than this module, and would answer differently on every run. What
 * is worth proving here is what happens to an answer *after* it arrives, and
 * that is precisely the chain the unit tests stub flat.
 */

const vietnamese: Language = { code: "vi", label: "Tiếng Việt", scripts: ["Latin"] };
const english: Language = { code: "en", label: "English", scripts: ["Latin"] };
const CONFIGURED = [vietnamese, english];

/** An endpoint whose models answer with whatever the case scripted for them. */
function scripted(answers: Record<string, string | Completion>): Provider {
  return {
    complete(model: string): Promise<Completion> {
      const answer = answers[model];
      if (answer === undefined) {
        return Promise.resolve({ ok: false, model, reason: "no answer scripted" });
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
  "Sau khi nâng lên phiên bản mới thì trình đóng gói không còn phân giải đúng",
  "entry point nữa, và tiến trình thoát mà không in ra lỗi nào cả.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Chi tiết ở #42, cc @johnitvn.",
].join("\n");

const FAITHFUL = [
  "After the upgrade the bundler no longer resolves the entry point, and the",
  "process exits without printing any error at all.",
  "",
  "```sh",
  "pnpm build --filter @ecoma-io/reeve",
  "```",
  "",
  "Details in #42, cc @johnitvn.",
].join("\n");

describe("translating a real issue body", () => {
  it("admits a faithful draft and hands back a body that is safe to post", async () => {
    const result = await translate({
      provider: scripted({ "model-a": FAITHFUL }),
      models: ["model-a"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    const [best] = result.attempts;
    expect(best?.score.admissible).toBe(true);
    // Nothing was dropped, nothing was invented: the only imperfect measurement
    // available to a draft this faithful is length, and it is inside the band.
    expect(best?.score.value).toBe(1);
    // The code survives the round trip, and the references that would have
    // notified somebody a second time do not.
    expect(best?.text).toContain("pnpm build --filter @ecoma-io/reeve");
    expect(best?.text).toContain("#<!---->42");
    expect(best?.text).toContain("@<!---->johnitvn");
  });

  it("refuses a model that answered in the language it was asked to translate out of", async () => {
    // The most common way a free endpoint fails, and the one that no other
    // measurement here catches: the code, the links, the structure and the
    // length are all perfect, because it is the source.
    const echoed = SOURCE.replace("Chi tiết ở #42", "Xem thêm chi tiết ở #42");

    const result = await translate({
      provider: scripted({ "model-a": echoed }),
      models: ["model-a"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused[0]?.score.reason).toBe("the draft is still in Tiếng Việt");
  });

  it("refuses the source handed back unchanged", async () => {
    const result = await translate({
      provider: scripted({ "model-a": SOURCE }),
      models: ["model-a"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused[0]?.score.reason).toBe("the draft is the source, unchanged");
  });

  it("ranks the draft that carried the code across above the one that translated it", async () => {
    // Both read as English and both are admissible. Only one of them still has
    // a command a reader can run, which is the difference the weights exist to
    // express.
    const mangled = FAITHFUL.replace(
      "pnpm build --filter @ecoma-io/reeve",
      "pnpm xây_dựng --bộ_lọc @ecoma-io/reeve",
    );

    const result = await translate({
      provider: scripted({ "model-a": mangled, "model-b": FAITHFUL }),
      models: ["model-a", "model-b"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 2,
    });

    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["model-b", "model-a"]);
    expect(result.attempts[0]?.score.value).toBeGreaterThan(
      result.attempts[1]?.score.value ?? Number.NaN,
    );
  });

  it("unwraps an answer the model packaged in one markdown fence", async () => {
    // Posted as it arrived, this is a page of Markdown source rather than a
    // translation — and it would also score as a body with one code block where
    // the source had one, which is to say it would score well.
    //
    // Four backticks because the body has a fenced block of its own, and three
    // would be closed by that block's closer. That is not this module being
    // fussy: GitHub reads it the same way, so an answer wrapped in three is
    // already broken Markdown by the time it arrives and there is no wrapper
    // there to find.
    const packaged = ["````markdown", FAITHFUL, "````"].join("\n");

    const result = await translate({
      provider: scripted({ "model-a": packaged }),
      models: ["model-a"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts[0]?.text.startsWith("````")).toBe(false);
    expect(result.attempts[0]?.text).toContain("After the upgrade");
    expect(result.attempts[0]?.score.value).toBe(1);
  });

  it("unwraps a fenced answer to a body that had no code in it at all", async () => {
    // The common shape, and the one where three backticks are enough: a model
    // asked for Markdown packages ordinary prose it was never asked to package.
    const prose = "Trình đóng gói không còn phân giải đúng entry point nữa.";

    const result = await translate({
      provider: scripted({
        "model-a": "```markdown\nThe bundler no longer resolves the entry point.\n```",
      }),
      models: ["model-a"],
      source: prose,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts[0]?.text).toBe("The bundler no longer resolves the entry point.");
  });

  it("keeps a body that is nothing but one code block whole", async () => {
    // The same shape as the case above, and the opposite answer, decided by the
    // one thing that separates them: here the fence is the thread's own.
    const onlyCode = "```sh\npnpm build --filter @ecoma-io/reeve\n```";

    const result = await translate({
      provider: scripted({ "model-a": onlyCode.replace("sh", "bash") }),
      models: ["model-a"],
      source: onlyCode,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts[0]?.text).toContain("```bash");
    expect(result.attempts[0]?.text).toContain("```");
  });

  it("moves to the next model when the first one is cut off, and says which was which", async () => {
    const result = await translate({
      provider: scripted({
        "model-a": { ok: true, model: "model-a", content: "After the upg", finishReason: "length" },
        "model-b": FAITHFUL,
      }),
      models: ["model-a", "model-b"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 1,
    });

    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["model-b"]);
    expect(result.failures).toEqual([
      { ok: false, model: "model-a", reason: "the answer was cut off before it finished" },
    ]);
  });

  it("reports a language nothing could be translated into as skipped, not as a crash", async () => {
    const result = await translate({
      provider: scripted({}),
      models: ["model-a", "model-b"],
      source: SOURCE,
      from: vietnamese,
      to: english,
      languages: CONFIGURED,
      drafts: 2,
    });

    expect(result.attempts).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.failures.map((failure) => failure.model)).toEqual(["model-a", "model-b"]);
    expect(result.to).toBe(english);
  });
});
