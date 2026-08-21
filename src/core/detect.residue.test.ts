/**
 * The prose residue, on its own.
 *
 * `residue` is the first of detection's four steps and the only one whose
 * output nothing downstream inspects — every later step reads it and reports a
 * language, so a residue that blanked the wrong thing surfaces, if at all, as a
 * detection that was merely unlucky. `detect.integration.test.ts` proves the
 * ladder reaches the right language through real noise; what is pinned here is
 * what the residue itself is allowed to contain, including the one property the
 * end-to-end cases cannot see: that a removal leaves a gap rather than joining
 * the words it stood between.
 *
 * Nothing is mocked. The segmenter is a project-internal collaborator, but it
 * is the same one the module reuses precisely so there is no second opinion
 * about where code begins — stubbing it here would be stubbing the reuse.
 */
import { describe, expect, it } from "vitest";

import { residue } from "./detect.js";

describe("residue", () => {
  it("blanks a fenced block wholesale, so a body that is mostly log is not read from the log", () => {
    // A fenced block is code because its author fenced it. The words inside
    // are not evidence about the language they were typed next to, and there
    // are usually far more of them than there are of the prose.
    const body = ["Lỗi vẫn còn.", "```", "Error: cannot find module", "```"].join("\n");

    const prose = residue(body);

    expect(prose).toContain("Lỗi vẫn còn.");
    expect(prose).not.toContain("Error");
    expect(prose).not.toContain("cannot find module");
  });

  it("blanks an inline code span, which carries an identifier rather than a sentence", () => {
    const prose = residue("Chạy `pnpm build` rồi thử lại.");

    expect(prose).not.toContain("pnpm build");
    expect(prose).toContain("rồi thử lại.");
  });

  // Each row names a fragment only that row's own pattern removes, so a row
  // cannot pass because a later pattern happened to cover the same text: the
  // domain pattern alone would take `github.com` out of the first URL and
  // leave the path behind, which is the half asserted on.
  it.each([
    ["a URL with a scheme", "https://github.com/ecoma-io/reeve/actions", "actions"],
    ["a bare `www.` address", "www.example.com/downloads", "downloads"],
    ["an e-mail address", "maintainer@example.com", "maintainer"],
    ["a domain nobody wrote a scheme for", "registry.npmjs.org", "npmjs"],
    ["a build number", "20250801", "20250801"],
    ["an identifier that is only a word because a digit stands in it", "node24", "node24"],
  ])("blanks %s, which is written the same in every language", (_case, noise, trace) => {
    const prose = residue(`Trước ${noise} sau`);

    expect(prose).not.toContain(trace);
    expect(prose).toContain("Trước");
    expect(prose).toContain("sau");
  });

  it("blanks a removal to a gap, never joining the words that stood on either side", () => {
    // The reason a removal is a space rather than a deletion. Deleting one
    // fuses `Trước` and `sau` into a token neither of them is, and the profile
    // step counts byte ngrams — a fused word is an ngram no language has,
    // charged against the language that actually wrote both halves.
    const prose = residue("Trước https://example.com/x sau");

    expect(prose).not.toMatch(/Trướcsau/);
    expect(prose).toMatch(/Trước\s+sau/);
  });

  it("leaves prose that is not noise byte for byte, diacritics included", () => {
    // Nothing downstream reads a position in this string, but everything
    // downstream reads its letters: a residue that normalised or stripped
    // diacritics would hand the profile step a language nobody wrote.
    const sentence = "Nút chuyển chế độ tối không lưu lại sau khi tải lại trang";

    expect(residue(sentence)).toBe(sentence);
  });

  it("answers with no prose at all for a body that is only a stack trace", () => {
    // What makes "none of the configured languages occurs here" a real answer
    // rather than a detector giving up: there was nothing in the thread to
    // identify in the first place.
    const trace = [
      "```",
      "Error: ENOENT: no such file or directory, open 'dist/index.js'",
      "    at Object.readFileSync (node:fs:441:20)",
      "```",
    ].join("\n");

    expect(residue(trace).trim()).toBe("");
  });
});
