/**
 * The bundled byte-ngram profile set — which configured languages the free
 * `detectByProfile` step can identify among.
 *
 * This is a doctor-only read of the same fact `detectByProfile` answers at
 * runtime by asking the library (`eld.setLanguageSubset` returns the codes it
 * recognised), kept here as the profile's own declared codes so a doctor
 * report can name a configured language as outside the set without running
 * the detector. The two must agree: a code this list lacks is a code the
 * runtime's all-or-nothing step would decline over, exactly what the finding
 * built on this set reports.
 */
export const PROFILE_CODES: ReadonlySet<string> = new Set([
  "am",
  "ar",
  "az",
  "be",
  "bg",
  "bn",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "is",
  "it",
  "ja",
  "ka",
  "kn",
  "ko",
  "ku",
  "lo",
  "lt",
  "lv",
  "ml",
  "mr",
  "ms",
  "nl",
  "no",
  "or",
  "pa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sq",
  "sr",
  "sv",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "yo",
  "zh",
]);
