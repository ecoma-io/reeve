/**
 * The maintainer-authored file that tells a draft how to sound.
 *
 * Same cold-start rule as `corrections`: a repository that has never written
 * one is not a repository with a broken configuration, it is a repository
 * that has not gotten around to it, and the run proceeds exactly as it would
 * with an empty file. The path is repo-relative and read from the checkout a
 * workflow already has on disk — nothing here reaches the network for it.
 *
 * **This text is trusted-side, not fenced.** D8 says only a repository's own
 * maintainers may address the model as an instruction, and this file is that:
 * committed to the tree, reviewed like any other change, attributable in
 * `git blame` to somebody with write access. That is what lets `draft.ts` put
 * it in the system message unfenced, the same shelf the taxonomy sits on,
 * while the thread it is answering — written by a stranger — stays behind
 * `enclose()`.
 */
import { readFile } from "node:fs/promises";
import * as core from "@actions/core";

/**
 * Maximum guidance content length in characters.
 *
 * Guidance goes into the system message, which shares the model's context
 * window with the thread text. A very large guidance file would crowd out
 * the thread and waste tokens. 10 000 characters (~2 500 tokens) is enough
 * for a detailed style guide while leaving room for the conversation.
 */
export const MAX_GUIDANCE_LENGTH = 10_000;

/**
 * Reads the guidance file at `path`, or answers `null`.
 *
 * `null` covers two cases identically: the file does not exist (the cold
 * start — quiet, not a warning) and the file exists but has nothing in it
 * (a maintainer who created the file and has not written into it yet). Any
 * other read failure — a directory where a file was expected, a permissions
 * error — is also `null`, because a workflow's checkout is not something this
 * duty can repair, and refusing the whole run over a guidance file a
 * maintainer can live without would be a strange kind of strict.
 *
 * Non-ENOENT errors are logged as warnings so a maintainer can diagnose
 * misconfiguration (e.g. a directory at the guidance path) without failing
 * the run.
 *
 * Guidance exceeding {@link MAX_GUIDANCE_LENGTH} is truncated and a warning
 * is emitted, so a maintainer can trim it without the run failing.
 */
export async function readGuidance(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      core.warning(
        `respond: could not read guidance file \`${path}\` — ${(error as NodeJS.ErrnoException).message}. Proceeding without guidance.`,
      );
    }
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_GUIDANCE_LENGTH) {
    core.warning(
      `respond: guidance file \`${path}\` is ${String(trimmed.length)} characters, exceeding the ${String(MAX_GUIDANCE_LENGTH)}-character limit. Truncating.`,
    );
    return trimmed.slice(0, MAX_GUIDANCE_LENGTH);
  }
  return trimmed;
}
