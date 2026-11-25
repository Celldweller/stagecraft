/**
 * Planning mode: the GM puts together the next cards as a draft, which the players do not see, and shows
 * it in one step.
 *
 * - The draft has the shape of the shown cards (`{cards, speaking}`, lib/cards.mjs), a cast with shown and hidden
 *   cards, and starts as a copy of it.
 * - It lives only in the GM's browser (client setting "cardDraft"), so it gives nothing away and survives a reload.
 *   Browser storage is shared by all worlds on the same server address, so the draft carries its world's id and is
 *   ignored in any other world.
 * - Planning mode is on while a draft exists. "Show" replaces the shown cards with the draft as a dialog switch (the
 *   cards turn over in place, see card-layer.mjs) and ends planning mode; "Discard" ends it without a change.
 * - The draft has its own insertion marker, like the "Shown" strip (lib/cards.mjs `moveMarker`).
 * - A saved dialog loaded into the draft (dialogs.mjs) stays linked to it as `dialog`, so it can be saved back.
 *   A draft started from the shown cards is not linked.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import {
  MAX_SHOWN_CARDS, addHiddenCards, moveCard, moveMarker, removeFromCast, sanitizeShownCards, setCardHidden, toggleCard,
  toggleSpeaking
} from "./lib/cards.mjs";
import { getShownCards, replaceShownCards } from "./card-layer.mjs";

/** Hook fired after the draft changed, started or ended: `(draft|null)`. */
export const DRAFT_HOOK = `${MODULE_ID}.cardDraftUpdated`;

/** Hook fired after the draft's insertion marker moved: `(key|null)`. */
export const DRAFT_MARKER_HOOK = `${MODULE_ID}.cardDraftMarkerUpdated`;

/** @type {string|null}  The card a new one goes before in the draft; null = at the end. */
let marker = null;

/** @type {import("./lib/cards.mjs").ShownCards|null|undefined}  undefined = not read yet. */
let cache;

/** @returns {import("./lib/cards.mjs").ShownCards|null}  The stored draft of this world, or null. */
function read() {
  const value = getSetting("cardDraft");
  if ( !value || (typeof value !== "object") || (value.world !== game.world.id) || !Array.isArray(value.cards) ) {
    return null;
  }
  const {cards, speaking, dialog} = sanitizeShownCards(value);
  return {cards, speaking, ...(dialog ? {dialog} : {})};
}

/** @returns {import("./lib/cards.mjs").ShownCards|null}  The draft, or null outside planning mode. Do not modify. */
export function getDraft() {
  if ( cache === undefined ) cache = read();
  return cache;
}

/** @returns {boolean}  Whether planning mode is on. */
export function isPlanning() {
  return getDraft() !== null;
}

function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
}

/**
 * Store the draft, or end planning mode (null). It stays linked to its saved dialog unless it names its own
 * (`dialog`, also null).
 * @param {import("./lib/cards.mjs").ShownCards|null} draft
 */
async function store(draft) {
  assertGM();
  if ( !draft ) return setSetting("cardDraft", {});
  const {cards, speaking} = sanitizeShownCards(draft);
  const dialog = ("dialog" in draft) ? draft.dialog : (getDraft()?.dialog ?? null);
  return setSetting("cardDraft", {world: game.world.id, cards, speaking, ...(dialog ? {dialog} : {})});
}

/** @returns {import("./lib/cards.mjs").ShownCards}  The draft; throws outside planning mode. */
function requireDraft() {
  const draft = getDraft();
  if ( !draft ) throw new Error(game.i18n.localize("STAGECRAFT.Draft.NotPlanning"));
  return draft;
}

/** Start planning mode with a copy of the shown cards (nothing happens if it is on already). GM only. */
export async function startDraft() {
  if ( isPlanning() ) return;
  marker = null;
  const {cards, speaking} = getShownCards();
  await store({cards: cards.map(c => ({...c})), speaking, dialog: null});
}

/**
 * Put cards into the draft, replacing what it holds, and start planning mode if it is off. GM only.
 * @param {import("./lib/cards.mjs").ShownCards} state  With `dialog`, the saved dialog they come from.
 */
export async function loadDraft(state) {
  marker = null;
  await store({cards: state.cards.map(c => ({...c})), speaking: state.speaking, dialog: state.dialog ?? null});
}

/**
 * Add a card to the draft, show it, change its variant, or hide it (see lib/cards.mjs `toggleCard`). GM only.
 * @param {{key: string, path: string}} card
 * @returns {Promise<boolean>}  False if the card could not be added because the draft holds MAX_SHOWN_CARDS.
 */
export async function toggleDraftCard(card) {
  const draft = requireDraft();
  if ( !draft.cards.some(c => c.key === card.key) && (draft.cards.length >= MAX_SHOWN_CARDS) ) return false;
  await store(toggleCard(draft, card, {before: marker}));
  return true;
}

/**
 * Put cards into the draft hidden, before its insertion marker or the card `before` ("" = at the end). GM only.
 * @param {{key: string, path: string}[]} cards
 * @param {{before?: string|null}} [options]  Without `before`, the draft's insertion marker.
 * @returns {Promise<number>}  How many cards found no room (MAX_SHOWN_CARDS).
 */
export async function addHiddenToDraft(cards, {before} = {}) {
  const at = (before === undefined) ? marker : (before || null);
  const {state, left} = addHiddenCards(requireDraft(), cards, {before: at});
  await store(state);
  return left;
}

/**
 * Show or hide a card of the draft at its place. GM only.
 * @param {string} key
 * @param {boolean} hidden
 */
export async function setDraftCardHidden(key, hidden) {
  await store(setCardHidden(requireDraft(), key, hidden));
}

/**
 * Take cards out of the draft. GM only.
 * @param {string|string[]} keys
 */
export async function removeDraftCard(keys) {
  await store(removeFromCast(requireDraft(), keys));
}

/**
 * Move a card of the draft to another place: before the card `before`, or to the end (null). GM only.
 * @param {string} key
 * @param {string|null} before
 */
export async function moveDraftCard(key, before) {
  await store(moveCard(requireDraft(), key, before));
}

/**
 * Mark a card of the draft as speaking, or end it. GM only.
 * @param {string|null} key
 */
export async function toggleDraftSpeaking(key) {
  await store(toggleSpeaking(requireDraft(), key));
}

/**
 * Link the draft to a saved dialog (e.g. after it was saved as a new one), or unlink it (null). GM only.
 * @param {string|null} id
 */
export async function setDraftDialog(id) {
  await store({...requireDraft(), dialog: id || null});
}

/** Show the draft to the players as a dialog switch and end planning mode. GM only. */
export async function showDraft() {
  const draft = requireDraft();
  await replaceShownCards(draft);
  await store(null);
}

/** End planning mode without a change for the players. GM only. */
export async function discardDraft() {
  await store(null);
}

/** @returns {string|null}  The card a new one goes before in the draft; null = at the end. */
export function getDraftMarker() {
  return marker;
}

/**
 * Set the draft's insertion marker: before a card of the draft, or at the end (null).
 * @param {string|null} key
 */
export function setDraftMarker(key) {
  marker = (key && getDraft()?.cards.some(c => c.key === key)) ? key : null;
  Hooks.callAll(DRAFT_MARKER_HOOK, marker);
}

/** Setting onChange (this client): forget the cached draft, move the marker on, tell the UI. */
export function onCardDraftChanged() {
  const previous = getDraft()?.cards ?? [];
  cache = undefined;
  const draft = getDraft();
  const moved = draft ? moveMarker(marker, previous, draft.cards) : null;
  Hooks.callAll(DRAFT_HOOK, draft);
  if ( moved !== marker ) {
    marker = moved;
    Hooks.callAll(DRAFT_MARKER_HOOK, marker);
  }
}
