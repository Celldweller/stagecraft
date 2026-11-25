/**
 * Pure helpers for the tag editor: what a selection carries, and which files a change touches.
 *
 * A target is one selected location with the files in scope (the chosen variants, all formats each).
 * Edits are differences (add / remove), never a replacement, so tags the GM did not touch stay as they are.
 * No Foundry globals, testable with `node --test`.
 */
import { normalizeTagList, tagDisplayRank } from "./tags.mjs";

/**
 * @typedef {object} EditTarget
 * @property {string} key      Location key.
 * @property {string[]} files  Paths in scope.
 */

/**
 * @typedef {object} TagSummary
 * @property {string} tag
 * @property {number} count    Targets carrying the tag on at least one file in scope.
 * @property {number} total    Targets with at least one file in scope.
 * @property {boolean} partial Whether only some targets carry it.
 */

const keyOf = tag => tag.toLocaleLowerCase("en");

/**
 * Tags of a selection with counts, in display order (then alphabetically).
 * @param {EditTarget[]} targets
 * @param {Record<string, string[]>} tagMap
 * @param {string[]} [order]  Display order of the prefixes, from `parseTagOrder`.
 * @returns {TagSummary[]}
 */
export function summarizeTags(targets, tagMap, order) {
  const active = targets.filter(t => t.files.length);
  /** @type {Map<string, {tag: string, count: number}>} */
  const byKey = new Map();
  for ( const target of active ) {
    const seen = new Set();
    for ( const file of target.files ) {
      for ( const tag of tagMap[file] ?? [] ) {
        const key = keyOf(tag);
        if ( seen.has(key) ) continue;
        seen.add(key);
        const entry = byKey.get(key) ?? {tag, count: 0};
        entry.count++;
        byKey.set(key, entry);
      }
    }
  }
  return [...byKey.values()]
    .map(({tag, count}) => ({tag, count, total: active.length, partial: count < active.length}))
    .sort((a, b) => (tagDisplayRank(a.tag, order) - tagDisplayRank(b.tag, order)) || a.tag.localeCompare(b.tag, "en", {sensitivity: "base"}));
}

/**
 * New tag lists for the files whose tags change. Removal runs first, so a tag in both lists ends up added.
 * Matching is case-insensitive; an existing spelling is kept.
 * @param {Record<string, string[]>} tagMap
 * @param {EditTarget[]} targets
 * @param {{add?: string[], remove?: string[]}} edit
 * @returns {Record<string, string[]>}  Path → new tags (empty list = remove all), only for changed files.
 */
export function applyTagEdit(tagMap, targets, {add=[], remove=[]}) {
  const adding = normalizeTagList(add);
  const removing = new Set(normalizeTagList(remove).map(keyOf));
  const changes = Object.create(null);
  const files = new Set(targets.flatMap(t => t.files));
  for ( const file of files ) {
    const current = tagMap[file] ?? [];
    const next = current.filter(tag => !removing.has(keyOf(tag)));
    const present = new Set(next.map(keyOf));
    for ( const tag of adding ) {
      if ( present.has(keyOf(tag)) ) continue;
      present.add(keyOf(tag));
      next.push(tag);
    }
    const changed = (next.length !== current.length) || next.some((tag, i) => tag !== current[i]);
    if ( changed ) changes[file] = normalizeTagList(next);
  }
  return changes;
}
