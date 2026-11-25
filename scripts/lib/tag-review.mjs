/**
 * Pure logic of the "Review tags" window: tag suggestions from names and folders, and orphaned tags.
 * No Foundry globals, testable with `node --test`.
 *
 * - A suggestion is a tag with the files it would be added to. Files that already carry it are left out,
 *   dismissed tags are never suggested. Nothing is written without the GM's confirmation.
 * - An orphan is a tagged path that the index no longer contains (file renamed, moved or deleted).
 *   If its file name occurs exactly once in the index and among the orphans, the tags can move to that file.
 */
import { parseStagePath } from "./filenames.mjs";
import { collectSuggestions, normalizeTag, normalizeTagList } from "./tags.mjs";

/** Most dismissed tags kept; older ones fall off the front. */
export const MAX_DISMISSED = 1000;

const keyOf = tag => tag.toLocaleLowerCase("en");

/**
 * Clean the stored list of dismissed tags (world setting): valid tags only, no duplicates (case-insensitive).
 * @param {unknown} value
 * @returns {string[]}
 */
export function sanitizeDismissed(value) {
  if ( !Array.isArray(value) ) return [];
  const seen = new Set();
  const list = [];
  for ( const raw of value ) {
    const tag = normalizeTag(raw);
    if ( !tag || seen.has(keyOf(tag)) ) continue;
    seen.add(keyOf(tag));
    list.push(tag);
  }
  return list.slice(-MAX_DISMISSED);
}

/**
 * @typedef {object} PendingSuggestion
 * @property {string} tag
 * @property {string[]} paths  Files the tag would be added to, in index order.
 */

/**
 * Suggestions still open for the current index: without dismissed tags and without files that already carry the tag.
 * A spelling already in use wins (see `collectSuggestions`).
 * @param {{name: string, folder: string, path: string}[]} entries  Parsed index entries.
 * @param {Record<string, string[]>} tagMap
 * @param {{root?: string, dismissed?: string[]}} [options]
 * @returns {PendingSuggestion[]}  Alphabetical.
 */
export function pendingSuggestions(entries, tagMap, {root="", dismissed=[]} = {}) {
  const knownTags = new Set(Object.values(tagMap).flat());
  const skip = new Set(dismissed.map(keyOf));
  const result = [];
  for ( const {tag, paths} of collectSuggestions(entries, {root, knownTags}) ) {
    const key = keyOf(tag);
    if ( skip.has(key) ) continue;
    const open = [...new Set(paths)].filter(path => !(tagMap[path] ?? []).some(t => keyOf(t) === key));
    if ( open.length ) result.push({tag, paths: open});
  }
  return result.sort((a, b) => a.tag.localeCompare(b.tag, "en", {sensitivity: "base"}));
}

/**
 * New tag lists for confirmed suggestions. A file keeps its tags and gains the chosen ones; existing spellings stay.
 * @param {Record<string, string[]>} tagMap
 * @param {{tag: string, paths: string[]}[]} picks
 * @returns {Record<string, string[]>}  Path → new tags, only for files that change.
 */
export function applySuggestions(tagMap, picks) {
  /** @type {Map<string, string[]>} */
  const next = new Map();
  for ( const {tag, paths} of picks ) {
    const normal = normalizeTag(tag);
    if ( !normal ) continue;
    for ( const path of paths ) {
      const list = next.get(path) ?? [...(tagMap[path] ?? [])];
      if ( !list.some(t => keyOf(t) === keyOf(normal)) ) list.push(normal);
      next.set(path, list);
    }
  }
  const changes = Object.create(null);
  for ( const [path, list] of next ) {
    // Compared after normalising: a file at the tag limit gains nothing.
    const normal = normalizeTagList(list);
    if ( normal.length !== (tagMap[path] ?? []).length ) changes[path] = normal;
  }
  return changes;
}

/**
 * @typedef {object} OrphanMove
 * @property {string} from    Stored path that is no longer indexed.
 * @property {string} to      Indexed path with the same file name.
 * @property {string[]} tags  Tags stored at `from`.
 */

/**
 * @typedef {object} LostOrphan
 * @property {string} path
 * @property {string[]} tags
 * @property {"NotFound"|"Ambiguous"} reason  No indexed file of that name, or more than one candidate.
 */

/**
 * Tagged paths missing from the index, split into those with a unique new place and the rest.
 * The file name is compared case-insensitively. It must occur once in the index and once among the orphans;
 * otherwise the assignment would be a guess.
 * @param {Record<string, string[]>} tagMap
 * @param {{path: string, file: string}[]} indexEntries
 * @returns {{moves: OrphanMove[], lost: LostOrphan[]}}  Both sorted by path.
 */
export function findOrphans(tagMap, indexEntries) {
  const indexed = new Set(indexEntries.map(e => e.path));
  /** @type {Map<string, string[]>} */
  const byFile = new Map();
  for ( const entry of indexEntries ) {
    const key = keyOf(entry.file);
    byFile.set(key, [...(byFile.get(key) ?? []), entry.path]);
  }

  const orphans = Object.keys(tagMap).filter(path => !indexed.has(path) && tagMap[path]?.length)
    .map(path => ({path, file: keyOf(parseStagePath(path).file)}));
  /** @type {Map<string, number>} */
  const orphanFiles = new Map();
  for ( const {file} of orphans ) orphanFiles.set(file, (orphanFiles.get(file) ?? 0) + 1);

  const moves = [];
  const lost = [];
  for ( const {path, file} of orphans ) {
    const candidates = byFile.get(file) ?? [];
    const tags = tagMap[path];
    if ( (candidates.length === 1) && (orphanFiles.get(file) === 1) ) moves.push({from: path, to: candidates[0], tags});
    else lost.push({path, tags, reason: candidates.length ? "Ambiguous" : "NotFound"});
  }
  const byPath = (a, b) => a.localeCompare(b, "en", {numeric: true, sensitivity: "base"});
  moves.sort((a, b) => byPath(a.from, b.from));
  lost.sort((a, b) => byPath(a.path, b.path));
  return {moves, lost};
}

/**
 * Changes that move orphaned tags to their new paths: the old entry is removed, the new file gets the union
 * (its own tags first, so their spelling wins).
 * @param {Record<string, string[]>} tagMap
 * @param {OrphanMove[]} moves
 * @returns {Record<string, string[]>}
 */
export function planOrphanMoves(tagMap, moves) {
  const changes = Object.create(null);
  for ( const {from, to, tags} of moves ) {
    changes[from] = [];
    const base = changes[to] ?? tagMap[to] ?? [];
    changes[to] = normalizeTagList([...base, ...tags]);
  }
  return changes;
}

/**
 * Changes that remove the tags of the given paths.
 * @param {string[]} paths
 * @returns {Record<string, string[]>}
 */
export function planOrphanRemoval(paths) {
  const changes = Object.create(null);
  for ( const path of paths ) changes[path] = [];
  return changes;
}
