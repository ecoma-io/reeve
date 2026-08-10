import { describe, expect, it, vi } from "vitest";

import { detectLanguage, type LanguagePicker } from "./detect.js";
import { parseLanguages } from "./languages.js";

/**
 * Detection with nothing stubbed, on text shaped like the threads Reeve
 * reads. The interaction _is_ the behaviour here: script narrowing, the profile
 * data and the code that decides whether to trust it only mean anything
 * together, and a unit test that stubs the first two proves the ladder branches
 * correctly without proving it ever reaches the right language.
 *
 * The number that matters in every case below is the number of requests, and it
 * is asserted rather than described. A repository whose threads are mostly
 * already in its base language should reach a decision without a provider, a
 * key, or a rate limit — the free-tier path is a supported path, so the cheap
 * steps have to actually carry the common case.
 */

const DEFAULT_LANGUAGES = parseLanguages("en:English:Latin\nvi:Tiếng Việt:Latin\nzh:中文:Han");

/** A picker that fails the test if the cheap steps did not decide. */
function noRequestExpected(): LanguagePicker {
  return vi.fn<LanguagePicker>(() => {
    throw new Error("detection reached the model when the local steps should have decided");
  });
}

describe("detectLanguage, end to end", () => {
  it.each([
    ["an English title", "Build fails on Windows when the path contains a space", "en"],
    ["a Vietnamese title", "Build lỗi trên Windows khi đường dẫn có dấu cách", "vi"],
    ["a Chinese title", "路径中包含空格时在 Windows 上构建失败", "zh"],
  ])("identifies %s under the default languages with no request", async (_case, text, expected) => {
    const detection = await detectLanguage(text, DEFAULT_LANGUAGES, noRequestExpected());

    expect(detection.language?.code).toBe(expected);
    expect(detection.by).not.toBe("model");
  });

  it("identifies a Latin-script language that shares its script with another candidate", async () => {
    // Vietnamese and English are both Latin, so script narrowing cannot
    // separate them and the profile step has to. This is the case the bundled
    // data is carried for.
    const body =
      "Sau khi nâng lên phiên bản 3 thì build không còn chạy được trên Windows nữa. " +
      "Nếu thư mục checkout có dấu cách trong tên thì bộ đóng gói lại phân giải sai entry point.";

    const detection = await detectLanguage(body, DEFAULT_LANGUAGES, noRequestExpected());

    expect(detection).toMatchObject({ by: "profile" });
    expect(detection.language?.code).toBe("vi");
  });

  it("decides on script alone when the scripts already separate the candidates", async () => {
    const chineseOnly = parseLanguages("en:English:Latin\nzh:中文:Han");

    const detection = await detectLanguage(
      "重新加载页面后深色模式没有保留",
      chineseOnly,
      noRequestExpected(),
    );

    expect(detection).toMatchObject({ by: "script" });
    expect(detection.language?.code).toBe("zh");
  });

  it("survives a thread whose prose is buried in identifiers, paths and version numbers", async () => {
    // What an issue body really looks like. The identifiers are Latin whatever
    // the prose is, which is precisely how a naive check decides everything is
    // English.
    const noisy = [
      "Khi chạy `pnpm build --target=node24` trên Windows 11 (v22631.4317),",
      "tiến trình thoát với mã 1 và không in ra lỗi nào cả.",
      "Xem log tại https://github.com/ecoma-io/reeve/actions/runs/1234567890",
      "và file cấu hình `tools/build.mjs` dòng 16.",
    ].join("\n");

    const detection = await detectLanguage(noisy, DEFAULT_LANGUAGES, noRequestExpected());

    expect(detection.language?.code).toBe("vi");
  });

  it("reads a short comment through the links that outweigh it", async () => {
    // Two run links against one sentence, which is what a drive-by comment
    // looks like. Counted as prose they are longer than the prose, they are
    // Latin whatever the comment is, and the profile step answers `en` — not
    // confidently enough to be believed, so the thread costs a request it
    // should not have, and the day it does become confident the comment is
    // translated into the language it is already in. Blanking them out first is
    // what turns that into a local answer.
    const comment = [
      "Lỗi này vẫn còn.",
      "https://github.com/ecoma-io/reeve/actions/runs/1234567890",
      "https://registry.npmjs.org/@types/node/-/node-24.0.1.tgz",
    ].join("\n");

    const detection = await detectLanguage(comment, DEFAULT_LANGUAGES, noRequestExpected());

    expect(detection).toMatchObject({ by: "profile" });
    expect(detection.language?.code).toBe("vi");
  });

  it("identifies a long thread in the time a short one takes, whoever wrote it", async () => {
    // The text is whatever a stranger typed into an issue, so the cost of
    // reading it has to depend on its length and on nothing else. It did not:
    // the profile library's own noise removal matched bare domains with a
    // nested quantifier over an unescaped dot, and prose that is not a domain
    // cost it 1.65× per character — 30 characters took 22 ms and this body
    // would not have finished today. A bound rather than a benchmark: real
    // detection here is a fraction of a millisecond, so the number below is
    // three orders of magnitude of slack and still fails the shape it is for.
    const paragraph =
      "Sau khi nâng lên phiên bản mới thì trình đóng gói không còn phân giải " +
      "đúng entry point nữa, và tiến trình thoát mà không in ra lỗi nào cả. ";
    const body = paragraph.repeat(30);

    const started = performance.now();
    const detection = await detectLanguage(body, DEFAULT_LANGUAGES, noRequestExpected());
    const elapsed = performance.now() - started;

    expect(body.length).toBeGreaterThan(4000);
    expect(detection.language?.code).toBe("vi");
    expect(elapsed).toBeLessThan(500);
  });

  it("answers nothing for a thread with no prose in any configured script", async () => {
    const stackTrace = [
      "```",
      "Error: ENOENT: no such file or directory, open 'dist/index.js'",
      "    at Object.readFileSync (node:fs:441:20)",
      "    at file:///home/runner/work/_actions/main.js:12:3",
      "```",
    ].join("\n");
    const chineseOnly = parseLanguages("zh:中文:Han");

    await expect(detectLanguage(stackTrace, chineseOnly)).resolves.toEqual({
      language: null,
      by: "none",
      candidates: [],
    });
  });

  it.each([
    ["an opinion it does not stand behind", "Same here"],
    ["no opinion at all", "Bug"],
    ["too little to work with", "up"],
  ])("escalates to the model when the profile has %s", async (_case, text) => {
    // Real thread content. A drive-by comment gives the profile data almost no
    // ngrams to count, and it says so — accepting the answer anyway is how a
    // thread gets translated into the language it is already written in.
    const pick = vi.fn<LanguagePicker>().mockResolvedValue("en");

    const detection = await detectLanguage(
      text,
      parseLanguages("en:English:Latin\nvi:Tiếng Việt:Latin"),
      pick,
    );

    expect(detection).toMatchObject({ by: "model" });
    expect(pick).toHaveBeenCalledOnce();
  });

  it("hands a regional code the profile data cannot see to the model, rather than answering without it", async () => {
    // `pt-BR` is not a code the bundled data knows. Answering from the codes it
    // does know would name a language confidently because the real one was
    // never on the ballot.
    const regional = parseLanguages(
      "en:English:Latin\npt-BR:Português do Brasil:Latin\npt-PT:Português:Latin",
    );
    const pick = vi.fn<LanguagePicker>().mockResolvedValue("pt-BR");

    const detection = await detectLanguage(
      "O modo escuro não permanece depois de recarregar a página",
      regional,
      pick,
    );

    expect(detection).toMatchObject({ by: "model" });
    expect(detection.language?.code).toBe("pt-BR");
    expect(pick).toHaveBeenCalledOnce();
  });

  it("accepts a model answer whose casing differs from the configured code", async () => {
    // A model is shown `pt-BR` and is not obliged to echo it. Rejecting `pt-br`
    // would turn a correct answer into no answer, and then into a thread
    // translated into its own language.
    const regional = parseLanguages(
      "en:English:Latin\npt-BR:Português do Brasil:Latin\npt-PT:Português:Latin",
    );
    const pick = vi.fn<LanguagePicker>().mockResolvedValue("PT-br");

    const detection = await detectLanguage("qualquer texto em português", regional, pick);

    expect(detection.language?.code).toBe("pt-BR");
  });

  it("keeps consecutive detections independent of each other", async () => {
    // Two threads in one run, with different candidate sets. The second must
    // not be judged against the first one's ballot.
    const chineseOnly = parseLanguages("en:English:Latin\nzh:中文:Han");

    const first = await detectLanguage(
      "测试在 CI 上超时但在本地每次都能通过",
      chineseOnly,
      noRequestExpected(),
    );
    const second = await detectLanguage(
      "Kiểm thử bị quá thời gian trên CI nhưng chạy local vẫn được",
      DEFAULT_LANGUAGES,
      noRequestExpected(),
    );

    expect(first.language?.code).toBe("zh");
    expect(second.language?.code).toBe("vi");
  });
});
