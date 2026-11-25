/**
 * Stored tags: one world setting, path → tags, for stages and cards.
 *
 * - Read through `sanitizeTagMap`, so a hand-edited or damaged setting never reaches the UI unchecked.
 * - Writes go through `updateTags`, which merges a batch of changes into one setting write.
 * - Every change (also from another GM) fires TAGS_HOOK on all clients.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { normalizeTagList, parseTagOrder, sanitizeTagMap } from "./lib/tags.mjs";

/** Hook fired after the stored tags changed: `(tagMap)`. */
export const TAGS_HOOK = `${MODULE_ID}.tagsUpdated`;

/** @type {Record<string, string[]>|null}  Sanitised copy of the setting; null until first read. */
let cache = null;

/** @returns {Record<string, string[]>}  All tags by path. Do not modify; use `updateTags`. */
export function getTagMap() {
  cache ??= sanitizeTagMap(getSetting("tags"));
  return cache;
}

/**
 * Display order of the tag prefixes (world setting "tagOrder").
 * @returns {string[]}
 */
export function getTagOrder() {
  return parseTagOrder(getSetting("tagOrder"));
}

/**
 * Tags of one file.
 * @param {string} path
 * @returns {string[]}
 */
export function getTags(path) {
  return getTagMap()[path] ?? [];
}

/**
 * All tags in use with the number of files carrying them, most frequent first.
 * @returns {{tag: string, count: number}[]}
 */
export function getKnownTags() {
  const counts = new Map();
  for ( const tags of Object.values(getTagMap()) ) {
    for ( const tag of tags ) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({tag, count}))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, "en", {sensitivity: "base"}));
}

/**
 * Replace the tags of several files in one write. An empty list removes the file's entry.
 * GM only (world setting).
 * @param {Record<string, string[]>} changes  Path → new tags.
 * @returns {Promise<void>}
 */
export async function updateTags(changes) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  // Null prototype, so a path named "__proto__" stays an ordinary key.
  const next = Object.assign(Object.create(null), getTagMap());
  for ( const [path, tags] of Object.entries(changes) ) {
    const list = normalizeTagList(Array.isArray(tags) ? tags : []);
    if ( list.length ) next[path] = list;
    else delete next[path];
  }
  await setSetting("tags", next);
}

/** Setting onChange: drop the cache and tell the UI. Runs on every client. */
export function onTagsChanged() {
  cache = null;
  Hooks.callAll(TAGS_HOOK, getTagMap());
}
