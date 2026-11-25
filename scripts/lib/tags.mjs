/**
 * Pure helpers for tags: normalising, parsing, suggesting, and the JSON export/import format.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */
import { normalizeWhitespace, NAME_PART_SEPARATOR } from "./filenames.mjs";

/** Prefixes with a fixed spelling. Matching is case-insensitive; output uses this spelling. */
export const KNOWN_PREFIXES = Object.freeze(["Location", "Session", "Scene", "NPC", "Plot", "Faction"]);

/** Limits that keep stored settings and imports bounded. */
export const TAG_LIMITS = Object.freeze({
  maxTagLength: 64,
  maxTagsPerFile: 100,
  maxImportEntries: 20000,
  maxKeyLength: 1024
});

/** Identifier and version of the export/import file format. */
export const EXPORT_FORMAT = "stagecraft-tags";
export const EXPORT_VERSION = 1;

/** Control characters (C0, DEL, C1) never belong in a tag. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Normalise a raw tag. Returns null if nothing usable remains.
 * - whitespace collapsed and trimmed, control characters removed
 * - `prefix:value` with whitespace around the colon removed; known prefixes get their canonical spelling
 * - longer than `TAG_LIMITS.maxTagLength` → null
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeTag(raw) {
  if ( typeof raw !== "string" ) return null;
  const text = normalizeWhitespace(raw.replace(CONTROL_CHARACTERS, " "));
  if ( !text ) return null;
  const {prefix, value} = splitTag(text);
  if ( !value ) return null;
  const canonical = prefix === null ? null : (KNOWN_PREFIXES.find(p => p.toLowerCase() === prefix.toLowerCase()) ?? prefix);
  const tag = canonical === null ? value : `${canonical}:${value}`;
  return tag.length <= TAG_LIMITS.maxTagLength ? tag : null;
}

/**
 * Split a normalised tag into prefix and value. A tag without colon, or with an empty prefix, has no prefix.
 * @param {string} tag
 * @returns {{prefix: string|null, value: string}}
 */
export function splitTag(tag) {
  const colon = tag.indexOf(":");
  if ( colon <= 0 ) return {prefix: null, value: tag.trim()};
  return {prefix: tag.slice(0, colon).trim(), value: tag.slice(colon + 1).trim()};
}

/**
 * Colour group of a tag (see styles/stagecraft.css): the known prefixes in lower case, "free" without prefix,
 * "other" for any other prefix.
 * @param {string} tag
 * @returns {"session"|"scene"|"plot"|"npc"|"faction"|"location"|"free"|"other"}
 */
export function tagKind(tag) {
  const {prefix} = splitTag(tag);
  if ( prefix === null ) return "free";
  return KNOWN_PREFIXES.includes(prefix) ? /** @type {any} */ (prefix.toLowerCase()) : "other";
}

/**
 * Normalise a list of tags: invalid ones dropped, duplicates removed (case-insensitively, first spelling kept),
 * order preserved, capped at `TAG_LIMITS.maxTagsPerFile`.
 * @param {unknown[]} tags
 * @returns {string[]}
 */
export function normalizeTagList(tags) {
  const seen = new Set();
  const result = [];
  for ( const raw of tags ) {
    const tag = normalizeTag(raw);
    if ( tag === null ) continue;
    const key = tag.toLocaleLowerCase("en");
    if ( seen.has(key) ) continue;
    seen.add(key);
    result.push(tag);
    if ( result.length >= TAG_LIMITS.maxTagsPerFile ) break;
  }
  return result;
}

/**
 * Suggest tags for a parsed stage or card entry. Suggestions are only offered; the GM confirms them.
 * - the first name part before a " - " separator becomes `Location:<part>` (only if the name has such a part;
 *   `A -B` and `A- B` count as separators, a hyphen inside a word like `Kiri-Jolith` does not)
 * - each folder below `root` becomes a free tag, unless it equals the suggested location
 * Spelling differences across files (`Kalaman` vs. `kalaman`) are resolved where suggestions are collected.
 * @param {{name: string, folder: string}} entry  A parsed entry (see `parseStagePath`).
 * @param {{root?: string}} [options]  The configured source folder; folders above it are ignored.
 * @returns {string[]}
 */
export function suggestTags(entry, {root=""} = {}) {
  const suggestions = [];
  const parts = entry.name.split(NAME_PART_SEPARATOR).map(p => p.trim()).filter(Boolean);
  const location = parts.length > 1 ? parts[0] : null;
  if ( location ) suggestions.push(`Location:${location}`);
  for ( const folder of relativeFolders(entry.folder, root) ) {
    if ( location && folder.toLocaleLowerCase("en") === location.toLocaleLowerCase("en") ) continue;
    suggestions.push(folder);
  }
  return normalizeTagList(suggestions);
}

/**
 * Collect suggestions over many entries and settle spelling differences (`Kalaman` vs. `kalaman`):
 * a spelling already in use (`knownTags`) wins, otherwise the most frequent one, ties to the first seen.
 * @param {{name: string, folder: string, path: string}[]} entries
 * @param {{root?: string, knownTags?: Iterable<string>}} [options]
 * @returns {{tag: string, count: number, paths: string[]}[]}  Most frequent first, then alphabetical.
 */
export function collectSuggestions(entries, {root="", knownTags=[]} = {}) {
  const known = new Map();
  for ( const tag of knownTags ) {
    const normal = normalizeTag(tag);
    if ( normal ) known.set(normal.toLocaleLowerCase("en"), normal);
  }

  /** @type {Map<string, {spellings: Map<string, number>, paths: string[]}>} */
  const groups = new Map();
  for ( const entry of entries ) {
    for ( const tag of suggestTags(entry, {root}) ) {
      const key = tag.toLocaleLowerCase("en");
      const group = groups.get(key) ?? {spellings: new Map(), paths: []};
      group.spellings.set(tag, (group.spellings.get(tag) ?? 0) + 1);
      group.paths.push(entry.path);
      groups.set(key, group);
    }
  }

  const result = [];
  for ( const [key, group] of groups ) {
    let tag = known.get(key);
    if ( !tag ) {
      let best = 0;
      for ( const [spelling, n] of group.spellings ) {
        if ( n > best ) {
          best = n;
          tag = spelling;
        }
      }
    }
    result.push({tag, count: group.paths.length, paths: group.paths});
  }
  return result.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, "en", {sensitivity: "base"}));
}

/**
 * Folder names of `folder` below `root`.
 * @param {string} folder
 * @param {string} root
 * @returns {string[]}
 */
function relativeFolders(folder, root) {
  const clean = p => String(p).replace(/\/+$/, "");
  const base = clean(root);
  const path = clean(folder);
  if ( base && !(path === base || path.startsWith(`${base}/`)) ) return [];
  const rest = base ? path.slice(base.length) : path;
  return rest.split("/").filter(Boolean);
}

/** Default display order of the prefixes (world setting "tagOrder"). */
export const DEFAULT_TAG_ORDER = "Session, Scene, Plot, NPC, Faction, Location";

/** Longest accepted order setting; far more than a real list of prefixes needs. */
const MAX_TAG_ORDER_ENTRIES = 50;

/**
 * Clean the stored tag map (world setting): only string keys within the length limit with normalised,
 * non-empty tag lists. Never throws; anything unusable is dropped.
 * @param {unknown} data
 * @returns {Record<string, string[]>}  A fresh null-prototype object.
 */
export function sanitizeTagMap(data) {
  const result = Object.create(null);
  if ( !isPlainObject(data) ) return result;
  for ( const [path, value] of Object.entries(data) ) {
    if ( !path.trim() || (path.length > TAG_LIMITS.maxKeyLength) || !Array.isArray(value) ) continue;
    const tags = normalizeTagList(value);
    if ( tags.length ) result[path] = tags;
  }
  return result;
}

/**
 * Union of several tag lists (e.g. all variants of a location), duplicates removed case-insensitively.
 * @param {string[][]} lists
 * @returns {string[]}
 */
export function mergeTagLists(lists) {
  return normalizeTagList(lists.flat());
}

/**
 * Read the order setting: prefixes separated by commas, known prefixes in their canonical spelling, a trailing colon
 * tolerated (`NPC:`), empty entries and duplicates (case-insensitive) dropped. Never throws.
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseTagOrder(text) {
  if ( typeof text !== "string" ) return [];
  const seen = new Set();
  const order = [];
  for ( const raw of text.split(",").slice(0, MAX_TAG_ORDER_ENTRIES) ) {
    const name = normalizeWhitespace(raw.replace(CONTROL_CHARACTERS, " ")).replace(/:$/, "").trim();
    if ( !name || name.includes(":") || (name.length > TAG_LIMITS.maxTagLength) ) continue;
    const canonical = KNOWN_PREFIXES.find(p => p.toLowerCase() === name.toLowerCase()) ?? name;
    const key = canonical.toLowerCase();
    if ( seen.has(key) ) continue;
    seen.add(key);
    order.push(canonical);
  }
  return order;
}

/** The default order, parsed once. */
const DEFAULT_ORDER = Object.freeze(parseTagOrder(DEFAULT_TAG_ORDER));

/**
 * Display rank of a tag: the prefixes of `order` in that order, then any other prefix, then free tags.
 * @param {string} tag
 * @param {string[]} [order]  From `parseTagOrder`.
 * @returns {number}
 */
export function tagDisplayRank(tag, order=DEFAULT_ORDER) {
  const {prefix} = splitTag(tag);
  if ( prefix === null ) return order.length + 1;
  const lower = prefix.toLowerCase();
  const known = order.findIndex(p => p.toLowerCase() === lower);
  return known === -1 ? order.length : known;
}

/**
 * Sort a tile's tags for display by rank, stable within a rank (the stored order).
 * @param {string[]} tags
 * @param {string[]} [order]  From `parseTagOrder`.
 * @returns {string[]}
 */
export function sortTagsForDisplay(tags, order=DEFAULT_ORDER) {
  return tags.map((tag, i) => ({tag, i, r: tagDisplayRank(tag, order)}))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i)).map(t => t.tag);
}

/**
 * How many labels fit into one line, in display order, together with a "+n" chip for the rest.
 * Widths are the labels' natural widths in pixels; `chip` is the width of the "+n" chip.
 * - Everything fits: all labels, no chip.
 * - Otherwise as many labels as fit before the chip. At least one label stays (if there is one): if even the first
 *   does not fit next to the chip, it is shortened (`shrinkFirst`, shown with an ellipsis).
 * @param {number[]} widths
 * @param {{available: number, gap: number, chip: number}} space
 * @returns {{count: number, shrinkFirst: boolean}}
 */
export function fitTagCount(widths, {available, gap, chip}) {
  const total = widths.reduce((sum, w) => sum + w, 0) + (gap * Math.max(widths.length - 1, 0));
  if ( total <= available ) return {count: widths.length, shrinkFirst: false};
  let used = chip;
  let count = 0;
  for ( const width of widths ) {
    if ( used + width + gap > available ) break;
    used += width + gap;
    count++;
  }
  if ( (count === 0) && widths.length ) return {count: 1, shrinkFirst: true};
  return {count, shrinkFirst: false};
}

/**
 * Build the export object from stored tags.
 * @param {Record<string, string[]>} tagsByPath
 * @returns {{format: string, version: number, tags: Record<string, string[]>}}
 */
export function buildTagExport(tagsByPath) {
  const tags = {};
  for ( const path of Object.keys(tagsByPath).sort() ) {
    const list = normalizeTagList(tagsByPath[path] ?? []);
    if ( list.length ) tags[path] = list;
  }
  return {format: EXPORT_FORMAT, version: EXPORT_VERSION, tags};
}

/**
 * @typedef {object} ImportEntry
 * @property {string} key      File path or bare file name, as written in the import file.
 * @property {string[]} tags   Normalised tags.
 */

/**
 * @typedef {object} ImportValidation
 * @property {boolean} ok           False if the file as a whole is unusable.
 * @property {ImportEntry[]} entries
 * @property {{key: string|null, error: string}[]} errors  Problems; entry-level problems do not set ok=false.
 */

/**
 * Validate a parsed import file against the fixed schema. Never throws.
 * @param {unknown} data  Result of `JSON.parse`.
 * @returns {ImportValidation}
 */
export function validateTagImport(data) {
  const fail = error => ({ok: false, entries: [], errors: [{key: null, error}]});
  if ( !isPlainObject(data) ) return fail("NotAnObject");
  if ( data.format !== EXPORT_FORMAT ) return fail("WrongFormat");
  if ( data.version !== EXPORT_VERSION ) return fail("UnsupportedVersion");
  if ( !isPlainObject(data.tags) ) return fail("TagsNotAnObject");

  const pairs = Object.entries(data.tags);
  if ( pairs.length > TAG_LIMITS.maxImportEntries ) return fail("TooManyEntries");

  const entries = [];
  const errors = [];
  for ( const [key, value] of pairs ) {
    if ( !key.trim() || key.length > TAG_LIMITS.maxKeyLength ) {
      errors.push({key: key.slice(0, 80), error: "InvalidKey"});
      continue;
    }
    if ( !Array.isArray(value) ) {
      errors.push({key, error: "TagsNotAnArray"});
      continue;
    }
    if ( value.length > TAG_LIMITS.maxTagsPerFile ) {
      errors.push({key, error: "TooManyTags"});
      continue;
    }
    const tags = normalizeTagList(value);
    const dropped = value.length - tags.length;
    if ( dropped > 0 ) errors.push({key, error: "InvalidTagsDropped"});
    entries.push({key, tags});
  }
  return {ok: true, entries, errors};
}

/**
 * @typedef {object} ImportMatch
 * @property {{path: string, tags: string[]}[]} matched  Entries assigned to exactly one indexed file.
 * @property {{key: string, reason: "NotFound"|"Ambiguous"}[]} unmatched
 */

/**
 * Assign import entries to indexed files: first by exact path, then by bare file name (case-insensitive).
 * A file name that occurs more than once in the index is ambiguous and not assigned.
 * @param {ImportEntry[]} entries
 * @param {{path: string, file: string}[]} indexEntries  Parsed entries of the current index.
 * @returns {ImportMatch}
 */
export function matchImportEntries(entries, indexEntries) {
  const byPath = new Map(indexEntries.map(e => [e.path, e]));
  /** @type {Map<string, {path: string}[]>} */
  const byFile = new Map();
  for ( const entry of indexEntries ) {
    const key = entry.file.toLocaleLowerCase("en");
    byFile.set(key, [...(byFile.get(key) ?? []), entry]);
  }

  const matched = [];
  const unmatched = [];
  for ( const {key, tags} of entries ) {
    const exact = byPath.get(key);
    if ( exact ) {
      matched.push({path: exact.path, tags});
      continue;
    }
    const fileName = key.slice(key.lastIndexOf("/") + 1).toLocaleLowerCase("en");
    const candidates = byFile.get(fileName) ?? [];
    if ( candidates.length === 1 ) matched.push({path: candidates[0].path, tags});
    else unmatched.push({key, reason: candidates.length ? "Ambiguous" : "NotFound"});
  }
  return {matched, unmatched};
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if ( value === null || typeof value !== "object" || Array.isArray(value) ) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @typedef {object} ImportChange
 * @property {string} path
 * @property {string[]} before
 * @property {string[]} after
 * @property {string[]} added    In `after`, not in `before` (case-insensitive).
 * @property {string[]} removed  In `before`, not in `after`.
 */

/**
 * What an import would change. "replace" gives each matched file exactly the imported tags; "merge" only adds.
 * Several entries for the same file (e.g. a path and its bare file name) are combined first.
 * @param {Record<string, string[]>} tagMap     Current tags.
 * @param {{path: string, tags: string[]}[]} matched  Result of `matchImportEntries`.
 * @param {"replace"|"merge"} mode
 * @returns {{changes: Record<string, string[]>, rows: ImportChange[], unchanged: number}}
 *   `changes` for `updateTags` (empty list = no tags), `rows` sorted by path, `unchanged` matched files without change.
 */
export function planTagImport(tagMap, matched, mode) {
  /** @type {Map<string, string[]>} */
  const imported = new Map();
  for ( const {path, tags} of matched ) imported.set(path, [...(imported.get(path) ?? []), ...tags]);

  const keyOf = tag => tag.toLocaleLowerCase("en");
  const changes = Object.create(null);
  const rows = [];
  let unchanged = 0;
  for ( const [path, tags] of imported ) {
    const before = tagMap[path] ?? [];
    const after = normalizeTagList(mode === "merge" ? [...before, ...tags] : tags);
    const beforeKeys = new Set(before.map(keyOf));
    const afterKeys = new Set(after.map(keyOf));
    const added = after.filter(tag => !beforeKeys.has(keyOf(tag)));
    const removed = before.filter(tag => !afterKeys.has(keyOf(tag)));
    if ( !added.length && !removed.length ) {
      unchanged++;
      continue;
    }
    changes[path] = after;
    rows.push({path, before, after, added, removed});
  }
  rows.sort((a, b) => a.path.localeCompare(b.path, "en", {numeric: true, sensitivity: "base"}));
  return {changes, rows, unchanged};
}
