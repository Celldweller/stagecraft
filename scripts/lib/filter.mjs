/**
 * Pure logic of the browser's filter bar: free text with search scopes, tag and variant chips, suggestions.
 * No Foundry globals, testable with `node --test`.
 *
 * - Free text searches the enabled scopes (name, variants, tags, folders); every word must occur.
 * - A tag chip matches exactly that tag (case-insensitive): `Night` never matches `Nightlund`.
 * - A variant chip keeps locations that have that variant; the tile then shows it.
 * - Chips and free text all apply together.
 */
import { normalizeSearchText, queryTerms, matchesTerms } from "./search.mjs";
import { normalizeTag, splitTag } from "./tags.mjs";

/** Search scopes of the free text, with their default. */
export const DEFAULT_SCOPES = Object.freeze({name: true, variants: true, tags: true, folders: false});

/** Chip types. */
export const CHIP_TYPES = Object.freeze(["tag", "variant"]);

/** Most suggestions shown at once. */
export const MAX_SUGGESTIONS = 8;

/**
 * @typedef {object} FilterRecord  What the filter knows about one location.
 * @property {string} key
 * @property {string} name
 * @property {{key: string, label: string, path: string}[]} variants  `key` is "" for the base variant.
 * @property {string[]} tags
 * @property {string[]} folders
 */

/**
 * @typedef {object} Chip
 * @property {"tag"|"variant"} type
 * @property {string} value  Tag as stored, or the variant label.
 */

const keyOf = text => String(text).toLocaleLowerCase("en");

/**
 * Normalise the stored scopes (client setting); unknown keys dropped, missing ones defaulted.
 * @param {unknown} value
 * @returns {{name: boolean, variants: boolean, tags: boolean, folders: boolean}}
 */
export function normalizeScopes(value) {
  const source = (value && (typeof value === "object")) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_SCOPES).map(([scope, fallback]) => {
    const v = source[scope];
    return [scope, typeof v === "boolean" ? v : fallback];
  }));
}

/**
 * Normalise a list of chips (e.g. the pinned ones from a world setting). Invalid ones dropped, duplicates removed.
 * @param {unknown} value
 * @returns {Chip[]}
 */
export function normalizeChips(value) {
  if ( !Array.isArray(value) ) return [];
  const seen = new Set();
  const chips = [];
  for ( const raw of value ) {
    if ( !raw || (typeof raw !== "object") || !CHIP_TYPES.includes(raw.type) ) continue;
    const text = (raw.type === "tag") ? normalizeTag(raw.value) : normalizeVariantLabel(raw.value);
    if ( !text ) continue;
    const id = chipId({type: raw.type, value: text});
    if ( seen.has(id) ) continue;
    seen.add(id);
    chips.push({type: raw.type, value: text});
    if ( chips.length >= 50 ) break;
  }
  return chips;
}

/** @param {unknown} value */
function normalizeVariantLabel(value) {
  if ( typeof value !== "string" ) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return (text && (text.length <= 64)) ? text : null;
}

/**
 * Identity of a chip, case-insensitive.
 * @param {Chip} chip
 * @returns {string}
 */
export function chipId(chip) {
  return `${chip.type}:${keyOf(chip.value)}`;
}

/**
 * What the input currently means: `#…` asks for a tag, `/…` for a variant, anything else is free text.
 * @param {string} text
 * @returns {{kind: "tag"|"variant"|"text", query: string}}
 */
export function parseFilterInput(text) {
  const value = String(text ?? "");
  const trimmed = value.trimStart();
  if ( trimmed.startsWith("#") ) return {kind: "tag", query: trimmed.slice(1).trim()};
  if ( trimmed.startsWith("/") ) return {kind: "variant", query: trimmed.slice(1).trim()};
  return {kind: "text", query: value.trim()};
}

/**
 * Normalised search text of a record for the enabled scopes.
 * @param {FilterRecord} record
 * @param {ReturnType<typeof normalizeScopes>} scopes
 * @returns {string}
 */
export function searchTextOf(record, scopes) {
  const parts = [];
  if ( scopes.name ) parts.push(record.name);
  if ( scopes.variants ) parts.push(...record.variants.map(v => v.label));
  if ( scopes.tags ) parts.push(...record.tags);
  if ( scopes.folders ) parts.push(...record.folders);
  return normalizeSearchText(parts.join(" "));
}

/**
 * Whether a record passes all chips and the free text.
 * @param {FilterRecord} record
 * @param {{terms?: string[], scopes?: ReturnType<typeof normalizeScopes>, chips?: Chip[]}} filter
 * @returns {boolean}
 */
export function matchesFilter(record, {terms=[], scopes=DEFAULT_SCOPES, chips=[]} = {}) {
  for ( const chip of chips ) {
    if ( chip.type === "tag" ) {
      const wanted = keyOf(chip.value);
      if ( !record.tags.some(tag => keyOf(tag) === wanted) ) return false;
    }
    else if ( !findVariant(record, chip.value) ) return false;
  }
  return !terms.length || matchesTerms(searchTextOf(record, scopes), terms);
}

/**
 * The variant a tile should show under the chips: the first variant chip's, otherwise null (= base).
 * @param {FilterRecord} record
 * @param {Chip[]} chips
 * @returns {{key: string, label: string, path: string}|null}
 */
export function shownVariant(record, chips) {
  const chip = chips.find(c => c.type === "variant");
  return chip ? findVariant(record, chip.value) : null;
}

/** @param {FilterRecord} record @param {string} label */
function findVariant(record, label) {
  const wanted = keyOf(label);
  return record.variants.find(v => v.key && (keyOf(v.label) === wanted)) ?? null;
}

/**
 * Tags and variants across all records, with the number of locations having each.
 * @param {FilterRecord[]} records
 * @returns {{type: "tag"|"variant", value: string, count: number}[]}
 */
export function collectFilterValues(records) {
  /** @type {Map<string, {type: "tag"|"variant", value: string, count: number}>} */
  const values = new Map();
  const add = (type, value) => {
    const id = `${type}:${keyOf(value)}`;
    const entry = values.get(id) ?? {type, value, count: 0};
    entry.count++;
    values.set(id, entry);
  };
  for ( const record of records ) {
    for ( const tag of new Set(record.tags.map(keyOf)) ) add("tag", record.tags.find(t => keyOf(t) === tag));
    for ( const variant of record.variants ) if ( variant.key ) add("variant", variant.label);
  }
  return [...values.values()];
}

/**
 * Suggestions for the input: tags and variants whose text contains the query.
 * Starts-with matches first (on the whole tag or its value), then by count, then alphabetically.
 * @param {ReturnType<typeof collectFilterValues>} values
 * @param {{kind: "tag"|"variant"|"text", query: string}} input
 * @param {{chips?: Chip[], limit?: number}} [options]  Values already chosen as chips are left out.
 * @returns {ReturnType<typeof collectFilterValues>}
 */
export function suggestFilters(values, {kind, query}, {chips=[], limit=MAX_SUGGESTIONS} = {}) {
  const q = normalizeSearchText(query);
  if ( !q && (kind === "text") ) return [];
  const taken = new Set(chips.map(chipId));
  const scored = [];
  for ( const value of values ) {
    if ( (kind !== "text") && (value.type !== kind) ) continue;
    if ( taken.has(chipId(value)) ) continue;
    const whole = normalizeSearchText(value.value);
    const part = (value.type === "tag") ? normalizeSearchText(splitTag(value.value).value) : whole;
    if ( q && !whole.includes(q) ) continue;
    const starts = !q || whole.startsWith(q) || part.startsWith(q);
    scored.push({value, starts});
  }
  return scored
    .sort((a, b) => (Number(b.starts) - Number(a.starts)) || (b.value.count - a.value.count)
      || a.value.value.localeCompare(b.value.value, "en", {sensitivity: "base"}))
    .slice(0, limit)
    .map(s => s.value);
}

/**
 * The chip a `#…` or `/…` input stands for when confirmed with Enter: an exact match of the whole tag,
 * or of a tag's value if only one tag has that value. Null if nothing matches exactly.
 * @param {ReturnType<typeof collectFilterValues>} values
 * @param {{kind: "tag"|"variant"|"text", query: string}} input
 * @returns {Chip|null}
 */
export function exactFilter(values, {kind, query}) {
  if ( (kind === "text") || !query ) return null;
  const q = keyOf(query.replace(/\s+/g, " ").trim());
  const ofKind = values.filter(v => v.type === kind);
  const whole = ofKind.find(v => keyOf(v.value) === q);
  if ( whole ) return {type: kind, value: whole.value};
  if ( kind !== "tag" ) return null;
  const byValue = ofKind.filter(v => keyOf(splitTag(v.value).value) === q);
  return (byValue.length === 1) ? {type: "tag", value: byValue[0].value} : null;
}

/** Re-exported for the browser, so it needs only this module for filtering. */
export { queryTerms };
