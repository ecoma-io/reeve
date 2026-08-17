/**
 * The evidence caps one review run may carry, so a hostile or noisy model
 * cannot flood the envelope or the summary with provenance text.
 */
export const MAX_EVIDENCE_PER_FINDING = 8;
export const MAX_EVIDENCE_ITEMS_PER_RUN = 128;
export const MAX_EVIDENCE_TEXT = 512;
export const MAX_EVIDENCE_TOTAL_CHARS = 4096;
export const MAX_PROVENANCE_PATH = 255;
export const GIT_SHA_LEN = 40;
