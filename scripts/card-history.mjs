/**
 * History "Recently shown": the last MAX_HISTORY casts (shown and hidden cards) that left the stage, so an ended
 * dialog comes back with one click.
 *
 * - An entry is made whenever the cast is emptied or replaced: "End dialog" and "Remove all", a stage switch that
 *   ends the dialog, showing a draft, a saved dialog or an entry of this history ("Hide all" keeps the cast: no entry)
 *   (card-layer.mjs calls `recordShownState` before it stores the new state). Two equal states in a row are one entry.
 * - It lives only in the GM's browser (client setting "cardHistory"), like the draft. Browser storage is shared by
 *   all worlds on the same server address, so the history carries its world's id and is ignored in any other world.
 * - Restoring replaces the shown cards as a dialog switch (the cards turn over in place); the stage stays. In
 *   planning mode an entry is loaded into the draft instead.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { pushHistory, sanitizeHistory } from "./lib/history.mjs";
import { replaceShownCards } from "./card-layer.mjs";
import { isPlanning, loadDraft } from "./card-draft.mjs";

/** Hook fired after the history changed: `(entries)`. */
export const HISTORY_HOOK = `${MODULE_ID}.cardHistoryUpdated`;

/** @type {import("./lib/history.mjs").HistoryEntry[]|null} */
let cache = null;

/** @returns {import("./lib/history.mjs").HistoryEntry[]}  Newest first. Do not modify. */
export function getHistory() {
  if ( cache ) return cache;
  const value = getSetting("cardHistory");
  cache = (value && (typeof value === "object") && (value.world === game.world.id)) ? sanitizeHistory(value.entries) : [];
  return cache;
}

/**
 * Remember a state that is about to leave the stage. GM only; called by card-layer.mjs.
 * @param {import("./lib/cards.mjs").ShownCards} state
 */
export async function recordShownState(state) {
  if ( !game.user.isGM || !state.cards.length ) return;
  const entries = pushHistory(getHistory(), state, Date.now());
  if ( entries.length === getHistory().length && entries.every((e, i) => e === getHistory()[i]) ) return;
  await setSetting("cardHistory", {world: game.world.id, entries});
}

/**
 * Show an entry again (in planning mode: load it into the draft). GM only.
 * @param {number} index  0 = the newest.
 */
export async function restoreHistory(index) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const entry = getHistory()[index];
  if ( !entry ) throw new Error(game.i18n.localize("STAGECRAFT.History.Unknown"));
  const state = {cards: entry.cards, speaking: entry.speaking, dialog: entry.dialog ?? null};
  if ( isPlanning() ) await loadDraft(state);
  else await replaceShownCards(state);
}

/** Setting onChange (this browser): drop the cache and tell the UI. */
export function onCardHistoryChanged() {
  cache = null;
  Hooks.callAll(HISTORY_HOOK, getHistory());
}
