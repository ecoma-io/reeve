/**
 * Reeve's own words, wherever they wrap a thread's content — the boundary
 * notes, the footers, the fixed scaffolding around a translation, a first
 * reply, a duplicate proposal, a lifecycle nudge. Never a duty's judgement,
 * never a model's output: everything below is a string this file commits and
 * a reviewer reads in the diff, the same as any other line of code.
 *
 * **Zero model calls, ever, for any of this.** A repository whose
 * `languages:` includes a code this table has no row for gets the English
 * row instead — deterministically, the same choice on every run, never a
 * request spent guessing at a translation of two sentences of scaffolding.
 * See `docs/concepts/language-layer.md`'s chrome section for why that is a
 * different question from whether a *duty* can translate a thread's content
 * into that language.
 *
 * **Chrome follows the language of the block it wraps.** A block that
 * already belongs to one language — a lifecycle comment resolved to the
 * thread's own language, a first reply, a duplicate proposal, each written in
 * one language throughout — gets its chrome in that same language, via
 * {@link chrome}. A block that introduces several language sections at
 * once — `translate`'s boundary note above every section and its footer
 * below all of them — is shared by every language a thread got translated
 * into, so it renders once per language present, English line first, via
 * {@link chromeLines}. Neither picks a single language to speak *about* the
 * others in.
 *
 * **Adding a language is one pull request, touching only this file.** A new
 * entry in {@link CHROME_LANGUAGES}, a full row of translations for it added
 * to every key in {@link CHROME}, and `chrome.test.ts`'s completeness test —
 * which checks every key against every configured language — fails loudly at
 * that same pull request if a single key was missed.
 */

/** A language this file has its own row for. Extending this is the whole of "adding a language". */
export type ChromeLanguage = "en" | "vi" | "zh";

/** Every language {@link CHROME} has a row for, English first — the order {@link chromeLines} renders in. */
export const CHROME_LANGUAGES: readonly ChromeLanguage[] = ["en", "vi", "zh"];

type Row = Readonly<Record<ChromeLanguage, string>>;

/**
 * The whole committed table, one row per chrome string, one column per
 * language. `{name}` inside a value is a placeholder {@link chrome} and
 * {@link chromeLines} substitute from their `params` argument — see either
 * one's doc comment for what happens when a placeholder is left unfilled.
 */
const CHROME = {
  // translate/publish.ts — boundary() and footer() wrap every language
  // section in the thread at once, so both render through `chromeLines`.
  translateBoundary: {
    en: "**The text above is the original, and it is the version this project answers for.** Everything below is a machine translation by [Reeve](https://github.com/ecoma-io/reeve). Where the two disagree, the text above is the one that counts.",
    vi: "**Văn bản phía trên là bản gốc, và đây là phiên bản mà dự án này chịu trách nhiệm về nội dung.** Mọi nội dung phía dưới là bản dịch máy do [Reeve](https://github.com/ecoma-io/reeve) thực hiện. Khi hai bên khác nhau, văn bản phía trên mới là bản có giá trị.",
    zh: "**上面的文本是原文，这个项目对其内容负责。** 以下所有内容均由 [Reeve](https://github.com/ecoma-io/reeve) 机器翻译。如有出入，以上面的文本为准。",
  },
  translateFooterFrom: {
    en: "Translated from {label}.",
    vi: "Được dịch từ {label}.",
    zh: "翻译自 {label}。",
  },
  translateFooterTruncated: {
    en: "The body was longer than this run's limit, so its tail was not translated.",
    vi: "Nội dung dài hơn giới hạn của lần chạy này, nên phần cuối chưa được dịch.",
    zh: "正文长度超过本次运行的限制，末尾部分未被翻译。",
  },
  translateFooterSkipped: {
    en: "Not translated this run: {list}.",
    vi: "Chưa được dịch trong lần chạy này: {list}.",
    zh: "本次运行未翻译：{list}。",
  },
  translateFooterEditable: {
    en: "Editing the text above republishes this; deleting this block regenerates it.",
    vi: "Chỉnh sửa văn bản phía trên sẽ đăng lại bản dịch này; xóa khối này sẽ tạo lại nó.",
    zh: "编辑上面的文本会重新发布此翻译；删除此区块会重新生成它。",
  },

  // lifecycle/message.ts's footer() — every line below already sits under a
  // comment `renderSay`/`renderClose` already resolved to one language, so
  // this renders through `chrome`, not `chromeLines`. The zh row keeps the
  // same register as `lifecycle/message.ts`'s own `BUILTIN_REMINDER`/
  // `BUILTIN_CLOSE` — "重新开始计时" for "restarts the clock" — so a lifecycle
  // comment reads as one voice, not two translators.
  lifecycleFooterResetsAuthor: {
    en: "A reply from this thread's author restarts the clock.",
    vi: "Một phản hồi từ tác giả của chủ đề này sẽ khởi động lại đồng hồ.",
    zh: "此话题作者的回复会重新开始计时。",
  },
  lifecycleFooterResetsAny: {
    en: "Any activity here restarts the clock.",
    vi: "Bất kỳ hoạt động nào ở đây cũng sẽ khởi động lại đồng hồ.",
    zh: "这里的任何活动都会重新开始计时。",
  },
  lifecycleFooterWhenLabel: {
    en: "Removing the `{label}` label also stops this track.",
    vi: "Gỡ nhãn `{label}` cũng sẽ dừng track này.",
    zh: "移除 `{label}` 标签也会停止此跟踪。",
  },
  lifecycleFooterEscape: {
    en: "Adding `{label}` stops this permanently.",
    vi: "Thêm nhãn `{label}` sẽ dừng việc này vĩnh viễn.",
    zh: "添加 `{label}` 会永久停止此操作。",
  },
  lifecycleFooterAttribution: {
    en: "lifecycle — a policy this repository's own warrant configured.",
    vi: "lifecycle — một chính sách do warrant của repository này cấu hình.",
    zh: "lifecycle — 该仓库自己的 warrant 所配置的策略。",
  },

  // respond/publish.ts — one reply, one language throughout, via `chrome`.
  respondBoundaryDrafted: {
    en: "This reply was drafted by [Reeve](https://github.com/ecoma-io/reeve), not by a maintainer.",
    vi: "Phản hồi này do [Reeve](https://github.com/ecoma-io/reeve) soạn, không phải do maintainer viết.",
    zh: "此回复由 [Reeve](https://github.com/ecoma-io/reeve) 撰写，而非维护者本人。",
  },
  respondBoundaryCaveat: {
    en: "A maintainer has not reviewed it. Treat it as a starting point, not an answer.",
    vi: "Chưa có maintainer nào xem xét phản hồi này. Hãy xem đây là điểm khởi đầu, không phải một câu trả lời.",
    zh: "尚无维护者审阅过此回复。请将其视为一个起点，而非最终答案。",
  },
  respondFooterUnknown: {
    en: "This project could not identify the thread's language, so the reply above is in English.",
    vi: "Dự án này không thể xác định ngôn ngữ của chủ đề, vì vậy phản hồi phía trên bằng tiếng Anh.",
    zh: "本项目无法识别该话题所使用的语言，因此上面的回复使用英文。",
  },
  respondFooterKnown: {
    en: "The thread was written in {label}.",
    vi: "Chủ đề này được viết bằng {label}.",
    zh: "该话题使用{label}撰写。",
  },
  respondFooterRecord: {
    en: "Reeve answers a thread once. This comment is the record of it.",
    vi: "Reeve chỉ trả lời mỗi chủ đề một lần. Bình luận này chính là bản ghi của lần trả lời đó.",
    zh: "Reeve 只回答一个话题一次。此评论就是这次回答的记录。",
  },

  // duplicate/publish.ts — one proposal, one language (the thread's own —
  // see `render`'s doc comment for why that signal is trustworthy here even
  // though ranking may bridge through a pivot language to find it), via
  // `chrome`.
  duplicatePossible: {
    en: "Possible duplicate of #{number}.",
    vi: "Có thể trùng lặp với #{number}.",
    zh: "可能与 #{number} 重复。",
  },
  duplicateFooterFloor: {
    en: "Proposed by a model, not decided by a maintainer — read it as a lead to check.",
    vi: "Do một model đề xuất, không phải quyết định của maintainer — hãy xem đây là một gợi ý cần kiểm chứng.",
    zh: "由模型提出，而非维护者的决定 — 请将其视为需要核实的线索。",
  },
  duplicateFooterEditable: {
    en: "Editing this thread and re-running replaces this comment; it is never posted twice.",
    vi: "Chỉnh sửa chủ đề này và chạy lại sẽ thay thế bình luận này; nó không bao giờ được đăng hai lần.",
    zh: "编辑此话题并重新运行会替换此评论；它绝不会被发布两次。",
  },
} satisfies Record<string, Row>;

/** Every key {@link CHROME} carries a row for. */
export type ChromeKey = keyof typeof CHROME;

/** Every key {@link CHROME} carries a row for, as a plain array — `chrome.test.ts`'s own key list. */
export const CHROME_KEYS: readonly ChromeKey[] = Object.keys(CHROME) as ChromeKey[];

const LANGUAGE_SET: ReadonlySet<string> = new Set(CHROME_LANGUAGES);

function resolve(code: string | null): ChromeLanguage {
  return code !== null && LANGUAGE_SET.has(code) ? (code as ChromeLanguage) : "en";
}

/**
 * Whether `code` has its own row in this table — the one fact a caller needs
 * to decide whether rendering it fell back to English, for the "noted once"
 * rule: a repository configured for a language chrome does not cover yet
 * gets told so once, in its own job summary, rather than silently reading
 * English scaffolding around content in its own language forever.
 */
export function chromeSupports(code: string | null): boolean {
  return code !== null && LANGUAGE_SET.has(code);
}

function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    if (!Object.hasOwn(params, name)) {
      // A key with a placeholder no caller filled is a bug in this file or
      // its caller, not a malformed run — same posture as an unparseable
      // model answer elsewhere in this project: fail loudly rather than
      // publish the literal `{name}` a reader would have no way to read.
      throw new Error(`chrome: "${whole}" in a template with no "${name}" in params`);
    }
    return params[name] ?? "";
  });
}

/**
 * One chrome string, in the language `code` resolves to — English
 * deterministically when `code` is `null` or not one of
 * {@link CHROME_LANGUAGES}. The single-block case: everything the caller
 * renders under this call already belongs to one language, the same one
 * `code` names.
 */
export function chrome(
  key: ChromeKey,
  code: string | null,
  params: Readonly<Record<string, string>> = {},
): string {
  return fill(CHROME[key][resolve(code)], params);
}

/**
 * `key` rendered once per distinct language `codes` resolves to, English
 * first, in {@link CHROME_LANGUAGES} order — the shared case: `codes` names
 * every language a multi-language block actually carries, not necessarily
 * every language a caller supports elsewhere.
 *
 * Two codes that both fall outside this table's languages — or one that does
 * and English itself — collapse to a single English line rather than
 * printing "the same sentence" twice; that is `resolve`'s fallback doing
 * exactly what it does for a single call, applied before the dedupe.
 */
export function chromeLines(
  key: ChromeKey,
  codes: readonly (string | null)[],
  params: Readonly<Record<string, string>> = {},
): readonly string[] {
  const present = new Set<ChromeLanguage>(codes.map((code) => resolve(code)));
  if (present.size === 0) present.add("en");
  return CHROME_LANGUAGES.filter((language) => present.has(language)).map((language) =>
    fill(CHROME[key][language], params),
  );
}

/**
 * The "noted once" half of the fallback rule: a run whose chrome fell back to
 * English because a configured language has no row in this table yet gets
 * one sentence about it in the job summary — never a silent substitution, and
 * never one line per chrome string that happened to fall back the same way.
 *
 * A caller passes every language code its own chrome calls actually used this
 * run — a `Translated`'s posted codes, a `Responded`'s `languageCode`, an
 * `outcome.language` — and gets back `null` when every one of them either has
 * a row here or was already `null` (English is not a fallback from English,
 * it is the language itself). This is deliberately a pure function of the
 * codes a caller already computed rather than a second traversal of any
 * duty's own data — the codes chrome was actually keyed by are the only
 * question this answers.
 */
export function chromeFallbackNote(codes: readonly (string | null)[]): string | null {
  const missing = new Set(
    codes.filter((code): code is string => code !== null && !chromeSupports(code)),
  );
  if (missing.size === 0) return null;

  const list = [...missing]
    .sort()
    .map((code) => `\`${code}\``)
    .join(", ");
  return (
    `${list} — Reeve's own scaffolding text has no translation for ` +
    `${missing.size === 1 ? "this language" : "these languages"} yet, so it rendered in English ` +
    `instead. Chrome covers: ${CHROME_LANGUAGES.join(", ")}.`
  );
}
