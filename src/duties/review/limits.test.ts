import { describe, expect, it } from "vitest";

import {
  GIT_SHA_LEN,
  MAX_EVIDENCE_ITEMS_PER_RUN,
  MAX_EVIDENCE_PER_FINDING,
  MAX_EVIDENCE_TEXT,
  MAX_EVIDENCE_TOTAL_CHARS,
  MAX_PROVENANCE_PATH,
} from "./limits.js";

describe("review evidence limits", () => {
  it("exports the bounded constants", () => {
    expect(MAX_EVIDENCE_PER_FINDING).toBe(8);
    expect(MAX_EVIDENCE_ITEMS_PER_RUN).toBe(128);
    expect(MAX_EVIDENCE_TEXT).toBe(512);
    expect(MAX_EVIDENCE_TOTAL_CHARS).toBe(4096);
    expect(MAX_PROVENANCE_PATH).toBe(255);
    expect(GIT_SHA_LEN).toBe(40);
  });
});
