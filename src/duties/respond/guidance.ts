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
 */
export async function readGuidance(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
