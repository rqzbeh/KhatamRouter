/**
 * Zero-Width Character Obfuscation & Linguistic Preservation (Wave 5)
 *
 * Request side: obfuscates sensitive agent keywords (e.g. "opencode", "cline",
 * "khatam") by inserting a U+200D ZERO WIDTH JOINER after their initial character.
 *
 * Response side: strips zero-width markers between ASCII word characters to
 * cleanly restore keywords while strictly preserving legitimate linguistic
 * and emoji code points:
 *   - U+200C (ZERO WIDTH NON-JOINER / نیم‌فاصله) in Persian and Kurdish
 *     (e.g. ارائه‌دهنده, می‌روم, کتاب‌ها)
 *   - Arabic and Indic script shaping
 *   - Emoji ZWJ sequences (👨‍👩‍👧)
 *
 * All functions are pure, non-mutating, and default-OFF unless activated by:
 *   - STEALTH_ALL=1
 *   - STEALTH_ZERO_WIDTH=1
 *   - CLI_COMPAT_ALL=1
 */

/** Default list of sensitive agent keywords subject to obfuscation. */
export const DEFAULT_AGENT_WORDS = [
  "opencode",
  "cline",
  "roo",
  "continue",
  "aider",
  "cursor",
  "khatam",
  "omniroute",
];

const ANY_ZERO_WIDTH = /[​-‍﻿]/;
const ZERO_WIDTH_SPACE_OR_BOM = /[​﻿]/g;

/**
 * Matches U+200C (ZWNJ) and U+200D (ZWJ) ONLY when bounded by ASCII word characters
 * ([A-Za-z0-9_]) or at string boundaries adjacent to ASCII word characters (e.g. across
 * streaming delta chunks).
 *
 * Crucial invariant: Non-ASCII characters (such as Persian / Arabic letters and emoji)
 * never match [A-Za-z0-9_], guaranteeing that Persian half-spaces (نیم‌فاصله) and emoji
 * sequences remain completely untouched.
 */
const JOINER_BETWEEN_ASCII_WORD_CHARS =
  /(?<=[A-Za-z0-9_])[‌‍]+(?=[A-Za-z0-9_]|$)|^[‌‍]+(?=[A-Za-z0-9_])/g;

/**
 * Check if zero-width obfuscation is enabled.
 * Default is FALSE (default-off).
 *
 * @returns {boolean}
 */
export function isZeroWidthEnabled() {
  if (typeof process === "undefined" || !process.env) return false;
  return (
    process.env.STEALTH_ALL === "1" ||
    process.env.STEALTH_ZERO_WIDTH === "1" ||
    process.env.CLI_COMPAT_ALL === "1"
  );
}

/**
 * Obfuscate sensitive agent words in text by inserting U+200D after the first character.
 *
 * @param {string} text - Input text
 * @param {string[]} [words] - List of words to obfuscate (defaults to DEFAULT_AGENT_WORDS)
 * @param {{ force?: boolean }} [options]
 * @returns {string} Obfuscated text
 */
export function obfuscateAgentWords(text, words = DEFAULT_AGENT_WORDS, options = {}) {
  if (!text || typeof text !== "string") return text;

  const enabled = options.force || isZeroWidthEnabled();
  if (!enabled) return text;

  let result = text;
  const targetWords = Array.isArray(words) && words.length > 0 ? words : DEFAULT_AGENT_WORDS;

  for (const word of targetWords) {
    if (!word || word.length < 2) continue;
    // Word boundary matching, case-insensitive
    const pattern = new RegExp(`\\b(${word[0]})(${word.slice(1)})\\b`, "gi");
    result = result.replace(pattern, "$1‍$2");
  }

  return result;
}

/**
 * Strip zero-width obfuscation markers from text while preserving Persian
 * half-spaces (ZWNJ), Arabic shaping, and emoji ZWJ sequences.
 *
 * @param {string} text - Input text
 * @param {{ force?: boolean }} [options]
 * @returns {string} Cleaned text with linguistic zero-width characters preserved
 */
export function stripObfuscationZeroWidth(text, options = {}) {
  if (!text || typeof text !== "string") return text;

  const enabled = options.force || isZeroWidthEnabled();
  if (!enabled) return text;

  if (!ANY_ZERO_WIDTH.test(text)) return text;

  return text
    .replace(ZERO_WIDTH_SPACE_OR_BOM, "")
    .replace(JOINER_BETWEEN_ASCII_WORD_CHARS, "");
}
