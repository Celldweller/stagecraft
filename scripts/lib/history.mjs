/**
 * Pure helpers for the history "Recently shown" (card-history.mjs): the last states of the shown cards that left
 * the stage, newest first.
 *
 * An entry is a shown state (`{cards, speaking, dialog?}`, lib/cards.mjs) plus `at`, the time it left (ms since the
 * epoch). No Foundry globals in here, so everything is testable with `node --test`.
 */
import { sanitizeShownCards } from "./cards.mjs";

/** Entries kept; older ones drop out. */
export const MAX_HISTORY = 5;

/**
 * @typedef {object} HistoryEntry
 * @property {{key: string, path: string, hidden?: true}[]} cards
 * @property {string|null} speaking
 * @property {string} [dialog]  The saved dialog the cards came from.
 * @property {number} at        When the cards left the stage.
 */

/**
 * Whether two states are the same cast: the same cards (images, shown or hidden) in the same order, the same
 * speaker.
 * @param {{cards: {key: string, path: string}[], speaking: string|null}} a
 * @param {{cards: {key: string, path: string}[], speaking: string|null}} b
 * @returns {boolean}
 */
export function sameShownState(a, b) {
  if ( (a.cards.length !== b.cards.length) || ((a.speaking ?? null) !== (b.speaking ?? null)) ) return false;
  return a.cards.every((card, i) => (card.key === b.cards[i].key) && (card.path === b.cards[i].path)
    && (Boolean(card.hidden) === Boolean(b.cards[i].hidden)));
}

/**
 * Clean stored entries: valid shown states with at least one card and a time, at most MAX_HISTORY. Never throws.
 * @param {unknown} data
 * @returns {HistoryEntry[]}
 */
export function sanitizeHistory(data) {
  if ( !Array.isArray(data) ) return [];
  const entries = [];
  for ( const raw of data ) {
    if ( entries.length >= MAX_HISTORY ) break;
    if ( !raw || (typeof raw !== "object") || !Number.isFinite(raw.at) ) continue;
    const {cards, speaking, dialog} = sanitizeShownCards(raw);
    if ( !cards.length ) continue;
    entries.push({cards, speaking, ...(dialog ? {dialog} : {}), at: raw.at});
  }
  return entries;
}

/**
 * Put a state that leaves the stage on top. Nothing changes for a state without cards or one equal to the newest
 * entry (two equal states in a row are one entry).
 * @param {HistoryEntry[]} entries  Newest first.
 * @param {{cards: {key: string, path: string}[], speaking: string|null, dialog?: string|null}} state
 * @param {number} at
 * @returns {HistoryEntry[]}  A new list.
 */
export function pushHistory(entries, state, at) {
  const [entry] = sanitizeHistory([{...state, at}]);
  if ( !entry || (entries[0] && sameShownState(entries[0], entry)) ) return [...entries];
  return [entry, ...entries].slice(0, MAX_HISTORY);
}
