/**
 * What a step's `say:` actually renders to, and the fixed footer every
 * lifecycle comment carries underneath it.
 *
 * **No model call, anywhere in this module, on purpose.** The design allowed
 * an optional model-translation rung below the built-in bundle, the same
 * fallback `translate` uses; this duty cuts it. A repository that wrote
 * `say:` as a per-language map, or stuck to the built-in text, gets exactly
 * what it asked for with zero requests and zero keys — which is the common
 * case a staleness policy is configured for at all. A repository that wants
 * a language neither covers is better served writing its own `say:` text for
 * that language than by a model's paraphrase of a two-sentence reminder. This
 * is a deliberate simplification of the design's own text — see the PR
 * description for the fuller argument.
 */
import type { LifecycleExempt, LifecycleSay, LifecycleTrack } from "../../core/warrant.js";

const BUILTIN_REMINDER: Readonly<Record<string, string>> = {
  en: "This has been quiet for a while. If it's still relevant, any activity here restarts the clock.",
  vi: "Mục này đã im lặng một thời gian. Nếu vẫn còn liên quan, bất kỳ hoạt động nào ở đây sẽ khởi động lại đồng hồ.",
  zh: "这个话题已经沉寂了一段时间。如果它仍然相关，这里的任何活动都会重新开始计时。",
};

const BUILTIN_CLOSE: Readonly<Record<string, string>> = {
  en: "Closing as not planned for now, for the reason above. Reopening is always welcome if this is still relevant.",
  vi: "Tạm đóng vì lý do trên. Việc mở lại luôn được hoan nghênh nếu vấn đề này vẫn còn liên quan.",
  zh: "由于上述原因，暂时关闭。如果这仍然相关，欢迎随时重新打开。",
};

/** `say:` resolved to actual text for one language, or `null` for a step that posts nothing. */
export function renderSay(say: LifecycleSay | null, language: string | null): string | null {
  if (say === null) return null;
  const code = language ?? "en";
  if (say.kind === "text") return say.text;
  if (say.kind === "built-in") return BUILTIN_REMINDER[code] ?? BUILTIN_REMINDER.en ?? "";
  return say.map.get(code) ?? say.map.get("en") ?? [...say.map.values()][0] ?? null;
}

/** The close step's own explanation — always built-in text, since `close` carries no `say:` of its own. */
export function renderClose(language: string | null): string {
  const code = language ?? "en";
  return BUILTIN_CLOSE[code] ?? BUILTIN_CLOSE.en ?? "";
}

/**
 * The fixed lines every lifecycle comment carries beneath its own text —
 * what restarts the clock, what stops the track outright, and the permanent
 * escape hatch, so a reader never has to go read the warrant to find out.
 */
export function footer(track: LifecycleTrack, exempt: LifecycleExempt): string {
  const lines: string[] = [];
  lines.push(
    track.resets === "author"
      ? "A reply from this thread's author restarts the clock."
      : "Any activity here restarts the clock.",
  );
  if (track.when !== null) {
    lines.push(`Removing the \`${track.when}\` label also stops this track.`);
  }
  const escapeLabel = exempt.labels[0];
  if (escapeLabel !== undefined) {
    lines.push(`Adding \`${escapeLabel}\` stops this permanently.`);
  }
  return `${lines.join(" ")}\n\n<sub>lifecycle — a policy this repository's own warrant configured.</sub>`;
}
