/**
 * Pure helpers for the browser's text search. No Foundry globals, testable with `node --test`.
 */

/**
 * Normalise text for searching: lower case, accents removed, whitespace collapsed.
 * @param {string} text
 * @returns {string}
 */
export function normalizeSearchText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a query into words. Every word must occur in the text, in any order.
 * @param {string} query
 * @returns {string[]}
 */
export function queryTerms(query) {
  const normal = normalizeSearchText(query);
  return normal ? normal.split(" ") : [];
}

/**
 * Whether a (normalised) text matches all query terms. An empty query matches everything.
 * @param {string} normalizedText  Result of `normalizeSearchText`.
 * @param {string[]} terms         Result of `queryTerms`.
 * @returns {boolean}
 */
export function matchesTerms(normalizedText, terms) {
  return terms.every(term => normalizedText.includes(term));
}
