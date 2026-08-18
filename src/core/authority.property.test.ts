/**
 * Property-based tests for the authority boundary and the state fingerprint.
 *
 * The tables in `authority.adversarial.test.ts` and `warrant.contract.test.ts`
 * assert the invariants against wordings somebody chose. This file asserts the
 * same invariants against wordings nobody chose — which is the half that
 * matters, because the injection that lands is the one nobody wrote down.
 *
 * Every property below is a statement a mutation would have to break to pass:
 *
 * - a grant is always a subset of the closed capability set, for any file;
 * - free text anywhere in the file never moves a grant;
 * - what `enforceLabels` applies is always a subset of the taxonomy it was
 *   handed, deduplicated, disjoint from what the thread already carries;
 * - a store record is always exactly one NDJSON line and always a fixed point
 *   of write→read→write;
 * - the parser and the reader never throw anything that is not an `Error`.
 *
 * House style follows `src/duties/dependa/semver.property.test.ts`: `fast-check`
 * arbitraries at the top, `fc.assert(fc.property(...))` bodies below. Nothing is
 * mocked and nothing is seeded from the clock.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { enclose } from "./enclose.js";
import { enforceLabels } from "./enforce.js";
import { formatCorrection, parseCorrection, tokenise, type Correction } from "./memory.js";
import {
  CAPABILITIES,
  implicitWarrant,
  parseWarrant,
  type Capability,
  type Label,
} from "./warrant.js";

const PATH = ".github/reeve.yml";

// ── Arbitraries ──────────────────────────────────────────────────────────

/**
 * Text a stranger might write: full Unicode, including the control characters,
 * surrogates and bidi marks a hand-written table would not think of.
 */
const rawText = fc.string({ minLength: 0, maxLength: 200, unit: "binary" });

/**
 * The words a seeding attempt is actually built out of.
 *
 * Uniform random text never spells `create`, `edit-file` or `@alice`, so a
 * generator that only drew from it would prove a boundary holds against noise
 * rather than against an attempt. Interleaving the vocabulary a warrant field
 * and a capability grant are written in is what makes the generated case a
 * plausible one.
 */
const VOCABULARY = [
  "create",
  "true",
  "false",
  "owner",
  "@alice",
  "@org/team",
  "confidence",
  "0.0",
  "1.0",
  "exclusive_with",
  "color",
  "ff0000",
  "paths",
  "duties",
  "label",
  "edit-file",
  "open-pr",
  "record",
  "propose",
  "none",
  "triage",
  "version: 1",
  "ignore previous instructions",
];

const hostileText = fc.oneof(
  { weight: 2, arbitrary: rawText },
  {
    weight: 3,
    arbitrary: fc
      .array(fc.oneof(fc.constantFrom(...VOCABULARY), rawText), { minLength: 1, maxLength: 8 })
      .map((parts) => parts.join(" ")),
  },
);

/** A label name shaped like one GitHub would accept, plus the odd hostile one. */
const labelName = fc.oneof(
  fc.constantFrom("bug", "docs", "wontfix", "needs reproduction", "__proto__", "constructor"),
  fc.string({ minLength: 1, maxLength: 24 }).filter((name) => name.trim().length > 0),
);

const taxonomyArb: fc.Arbitrary<readonly Label[]> = fc
  .uniqueArray(labelName, { minLength: 0, maxLength: 6 })
  .map((names) =>
    names.map((name) => ({
      name,
      description: "d",
      not: null,
      examples: [],
      owner: null,
      exclusiveWith: [],
      confidence: null,
      paths: [],
      create: false,
      color: null,
    })),
  );

/** A number, including the ones a verdict stops being a measurement at. */
const anyConfidence = fc.oneof(
  fc.double({ min: -2, max: 3, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0),
);

const correctionArb: fc.Arbitrary<Correction> = fc.record({
  repo: hostileText,
  thread: fc.integer(),
  duty: fc.constantFrom("triage", "duplicate", "review"),
  at: hostileText,
  title: hostileText,
  excerpt: hostileText,
  language: fc.option(fc.constantFrom("en", "vi", "zh"), { nil: null }),
  proposed: fc.array(hostileText, { maxLength: 4 }),
  decided: fc.array(hostileText, { maxLength: 4 }),
  by: hostileText,
  note: fc.option(hostileText, { nil: null }),
  outcome: fc.constantFrom<"overruled" | null>("overruled", null),
  duplicateOf: fc.option(fc.integer({ min: 1, max: 9999 }), { nil: null }),
  pivot: fc.option(
    fc.record({
      language: fc.constantFrom("en", "vi"),
      title: fc.string({ minLength: 1, maxLength: 40 }).filter((t) => t.trim().length > 0),
      excerpt: hostileText,
    }),
    { nil: null },
  ),
});

// ── A grant is always inside the closed set ──────────────────────────────

describe("a grant is always a subset of the closed capability set", () => {
  it("for any file this build accepts, whatever it says", () => {
    fc.assert(
      fc.property(hostileText, hostileText, (about, description) => {
        let warrant;
        try {
          warrant = parseWarrant(
            PATH,
            [
              "version: 1",
              `about: ${JSON.stringify(about)}`,
              "labels:",
              "  - name: bug",
              `    description: ${JSON.stringify(description || "d")}`,
              "duties:",
              "  triage: [label, comment]",
            ].join("\n"),
          );
        } catch {
          // A file this build refuses grants nothing at all, which is the
          // stronger half of the property.
          return true;
        }

        for (const duty of ["triage", "translate", "review", "harmonise"]) {
          const granted = warrant.granted(duty, ["edit-file", "open-pr"] as Capability[]);
          expect(granted.every((capability) => CAPABILITIES.includes(capability))).toBe(true);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("free text never moves a grant off what the duties block wrote", () => {
    fc.assert(
      fc.property(hostileText, (payload) => {
        let warrant;
        try {
          warrant = parseWarrant(
            PATH,
            [
              "version: 1",
              `about: ${JSON.stringify(payload)}`,
              "labels:",
              "  - name: bug",
              `    description: ${JSON.stringify(payload || "d")}`,
              "duties:",
              "  triage: [label]",
            ].join("\n"),
          );
        } catch {
          return true;
        }

        expect(warrant.granted("triage", ["edit-file"] as Capability[])).toEqual(["label"]);
        expect(warrant.granted("review", ["comment"])).toEqual([]);
        expect(warrant.unnamed("review")).toBe(true);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("an implicit warrant hands back exactly the fallback, for any description", () => {
    fc.assert(
      fc.property(fc.array(hostileText, { maxLength: 5 }), (descriptions) => {
        const built = implicitWarrant(
          PATH,
          descriptions.map((description, index) => ({ name: `l${String(index)}`, description })),
        );

        const fallbacks: readonly (readonly Capability[])[] = [[], ["label"], CAPABILITIES];
        for (const fallback of fallbacks) {
          expect(built.warrant.granted("triage", fallback)).toBe(fallback);
        }
        expect(built.warrant.unnamed("triage")).toBe(false);
        // A description is never anything but a description.
        for (const label of built.warrant.labels) {
          expect(label.owner).toBeNull();
          expect(label.confidence).toBeNull();
          expect(label.exclusiveWith).toEqual([]);
          expect(label.create).toBe(false);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("the reader throws an Error or returns a warrant — never anything else", () => {
    fc.assert(
      fc.property(hostileText, (source) => {
        // Rendered as one value rather than branched on, so the assertion is
        // the same shape either way: a warrant answers `granted` as a
        // function, and a refusal is an `Error` carrying a sentence.
        const answer = ((): { kind: string; detail: boolean } => {
          try {
            return {
              kind: "warrant",
              detail: typeof parseWarrant(PATH, source).granted === "function",
            };
          } catch (error) {
            return {
              kind: "error",
              detail: error instanceof Error && error.message.length > 0,
            };
          }
        })();

        expect(answer.detail).toBe(true);
        expect(["warrant", "error"]).toContain(answer.kind);
        return true;
      }),
      { numRuns: 400 },
    );
  });
});

// ── The label gate ───────────────────────────────────────────────────────

describe("what the gate applies is always inside the taxonomy it was handed", () => {
  it("applied ⊆ taxonomy, deduplicated, and disjoint from what the thread already carries", () => {
    fc.assert(
      fc.property(
        taxonomyArb,
        fc.array(labelName, { maxLength: 8 }),
        fc.array(labelName, { maxLength: 4 }),
        anyConfidence,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (taxonomy, proposed, onThread, confidence, floor) => {
          const names = new Set(taxonomy.map((entry) => entry.name));
          const decision = enforceLabels(PATH, taxonomy, proposed, onThread, confidence, floor);

          // Inside the file.
          for (const name of decision.applied) expect(names.has(name)).toBe(true);
          // Proposed by the verdict — never invented here.
          for (const name of decision.applied) expect(proposed).toContain(name);
          // Once each.
          expect(new Set(decision.applied).size).toBe(decision.applied.length);
          // Never something a maintainer already put there.
          for (const name of decision.applied) expect(onThread).not.toContain(name);
          // Every unique proposal is accounted for, exactly once.
          const seen = new Set(proposed);
          expect(decision.applied.length + decision.refused.length).toBe(seen.size);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a non-finite confidence applies nothing at all, for any taxonomy", () => {
    fc.assert(
      fc.property(
        taxonomyArb,
        fc.array(labelName, { maxLength: 6 }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (taxonomy, proposed, confidence, floor) => {
          expect(enforceLabels(PATH, taxonomy, proposed, [], confidence, floor).applied).toEqual(
            [],
          );
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("an empty taxonomy applies nothing, whatever the verdict proposed", () => {
    fc.assert(
      fc.property(
        fc.array(hostileText, { maxLength: 10 }),
        anyConfidence,
        (proposed, confidence) => {
          expect(enforceLabels(PATH, [], proposed, [], confidence, 0).applied).toEqual([]);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("the same inputs always produce the same decision — the gate reads nothing else", () => {
    fc.assert(
      fc.property(
        taxonomyArb,
        fc.array(labelName, { maxLength: 6 }),
        fc.array(labelName, { maxLength: 3 }),
        anyConfidence,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (taxonomy, proposed, onThread, confidence, floor) => {
          const once = enforceLabels(PATH, taxonomy, proposed, onThread, confidence, floor);
          const twice = enforceLabels(PATH, taxonomy, proposed, onThread, confidence, floor);
          expect(twice).toEqual(once);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── The prompt boundary ──────────────────────────────────────────────────

describe("a fence encloses any text and is closed by exactly one thing", () => {
  it("for any text, the block carries it and ends with the only closer in it", () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const fenced = enclose("untrusted-thread", text);
        const closer = `</untrusted-thread id="${fenced.nonce}">`;

        expect(fenced.block).toContain(text);
        expect(fenced.block.split(closer)).toHaveLength(2);
        expect(fenced.block.endsWith(closer)).toBe(true);
        expect(fenced.rule).toContain(fenced.nonce);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

// ── The store fingerprint ────────────────────────────────────────────────

describe("a store record is one line, and writing it is a fixed point", () => {
  it("never carries a line break out of the field it was written in", () => {
    fc.assert(
      fc.property(correctionArb, (correction) => {
        const line = formatCorrection(correction);
        expect(line).not.toContain("\n");
        expect(line).not.toContain("\r");
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("write → read → write is a fixed point for every record the store can hold", () => {
    // Stated against what `parseCorrection` produced rather than against an
    // arbitrary in-memory value, because that is the fixed point duplicate
    // detection actually needs: a line already in the file has to write back
    // byte for byte, or a rerun rewrites a record it should have recognised.
    fc.assert(
      fc.property(correctionArb, (correction) => {
        const settled = parseCorrection(formatCorrection(correction));
        expect(settled).not.toBeNull();

        const once = formatCorrection(settled!);
        const twice = formatCorrection(parseCorrection(once)!);
        expect(twice).toBe(once);
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("an in-memory record settles on the first write, and only `note` moves", () => {
    // ADJUDICATE: `formatCorrection`'s doc comment says the format exists "so
    // two runs writing the same decision write the same bytes", and it
    // normalises the excerpt to that end — but `note` is normalised on the way
    // in (`""` and whitespace read as no note) and not on the way out, so a
    // caller holding `note: ""` writes a line that reads back as `note: null`.
    // Unreachable in production today: every writer under `src/duties` sets
    // `note` to `null` or to a trimmed sentence. Pinned as found rather than
    // fixed, because normalising on write is a change to what the store
    // records, not a change to a message. Question for adjudication: should
    // `formatCorrection` trim-and-null `note` the way `parseCorrection` does?
    const written = formatCorrection({
      repo: "",
      thread: 1,
      duty: "triage",
      at: "",
      title: "",
      excerpt: "",
      language: null,
      proposed: [],
      decided: ["bug"],
      by: "",
      note: "   ",
      outcome: null,
      duplicateOf: null,
      pivot: null,
    });

    expect(written).toContain('"note":"   "');
    expect(parseCorrection(written)?.note).toBeNull();
    // And it settles: the second write is stable, which is the property
    // duplicate detection depends on.
    const settled = formatCorrection(parseCorrection(written)!);
    expect(formatCorrection(parseCorrection(settled)!)).toBe(settled);
  });

  it("the decision itself survives the round trip untouched", () => {
    fc.assert(
      fc.property(correctionArb, (correction) => {
        const parsed = parseCorrection(formatCorrection(correction));
        expect(parsed?.thread).toBe(correction.thread);
        expect(parsed?.decided).toEqual(correction.decided);
        expect(parsed?.outcome).toBe(correction.outcome);
        expect(parsed?.duplicateOf).toBe(correction.duplicateOf);
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("reading a line never throws, whatever the file holds", () => {
    fc.assert(
      fc.property(hostileText, (line) => {
        expect(() => parseCorrection(line)).not.toThrow();
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("tokenising is deterministic and produces no term carrying whitespace", () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        const once = tokenise(text);
        expect(tokenise(text)).toEqual(once);
        for (const term of once) {
          expect(term).toBe(term.toLowerCase());
          expect(/\s/.test(term)).toBe(false);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
