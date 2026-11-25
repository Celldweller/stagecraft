/**
 * What "Review tags" offers for the current index: open tag suggestions and orphaned tags.
 *
 * Foundry glue only; the logic lives in lib/tag-review.mjs. The result is computed once per combination of
 * index, stored tags and dismissed list, so the stage browser can ask for the counts on every render.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { cardIndex, stageIndex } from "./media-index.mjs";
import { getTagMap } from "./tag-store.mjs";
import { findOrphans, pendingSuggestions, sanitizeDismissed } from "./lib/tag-review.mjs";

/** Hook fired after the dismissed list changed (any GM). */
export const DISMISSED_HOOK = `${MODULE_ID}.dismissedSuggestionsUpdated`;

/** @type {string[]|null} */
let dismissedCache = null;

/** @type {{stages: object, cards: object|null, tagMap: object, dismissed: string[], review: TagReview}|null} */
let memo = null;

/**
 * @typedef {object} TagReview
 * @property {import("./lib/tag-review.mjs").PendingSuggestion[]} suggestions
 * @property {import("./lib/tag-review.mjs").OrphanMove[]} moves
 * @property {import("./lib/tag-review.mjs").LostOrphan[]} lost
 * @property {"scan"|"cards"|null} incomplete  Why orphans are not offered: a scan missed folders or stopped at
 *   a limit ("scan"), or a card folder is set but its index is not loaded yet ("cards"). Files in an unread folder
 *   would otherwise look orphaned.
 */

/** @returns {string[]}  Dismissed tags, cleaned. */
export function getDismissed() {
  dismissedCache ??= sanitizeDismissed(getSetting("dismissedSuggestions"));
  return dismissedCache;
}

/**
 * Dismiss suggested tags for good. GM only (world setting).
 * @param {string[]} tags
 */
export async function dismissSuggestions(tags) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  await setSetting("dismissedSuggestions", sanitizeDismissed([...getDismissed(), ...tags]));
}

/** Forget all dismissed suggestions. GM only. */
export async function clearDismissed() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  await setSetting("dismissedSuggestions", []);
}

/** Setting onChange: drop the cache and tell the UI. */
export function onDismissedChanged() {
  dismissedCache = null;
  Hooks.callAll(DISMISSED_HOOK);
}

/**
 * Open suggestions (stages only: name parts and folders suit locations, not NPCs) and orphans (tagged paths
 * neither index contains); null without a stage index.
 * @returns {TagReview|null}
 */
export function getTagReview() {
  const stages = stageIndex.get();
  if ( !stages ) return null;
  const cards = cardIndex.get();
  const tagMap = getTagMap();
  const dismissed = getDismissed();
  if ( memo && (memo.stages === stages) && (memo.cards === cards) && (memo.tagMap === tagMap)
    && (memo.dismissed === dismissed) ) return memo.review;
  const suggestions = pendingSuggestions(stages.entries, tagMap, {root: stages.root, dismissed});
  const scanGap = index => index.truncated || (index.errors.length > 0);
  let incomplete = null;
  if ( scanGap(stages) || (cards && scanGap(cards)) ) incomplete = "scan";
  else if ( cardIndex.location().root && !cards ) incomplete = "cards";
  const entries = [...stages.entries, ...(cards?.entries ?? [])];
  const {moves, lost} = incomplete ? {moves: [], lost: []} : findOrphans(tagMap, entries);
  memo = {stages, cards, tagMap, dismissed, review: {suggestions, moves, lost, incomplete}};
  return memo.review;
}
