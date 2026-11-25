/**
 * Pure helpers for the cards shown to the players: the stored state and the changes the GM makes to it.
 *
 * State (world setting "shownCards"): `{cards: [{key, path, hidden?}], speaking: key|null, turn?: true, dialog?: id}`.
 * `cards` is the cast ("Besetzung"): the cards of a scene, each shown or hidden. The players see the shown ones, in
 * the order of the cast, so a card that is uncovered appears at the place prepared for it.
 * - `key` identifies the person (the card's location key), so a variant change replaces the card in place.
 * - `path` is the image shown, as stored by the GM.
 * - `hidden: true` keeps the card in the cast without showing it (players never draw it). Only a shown card speaks.
 * - `turn` marks a switch to another dialog (a draft shown): the cards turn over in place (see `pairCards`). Any
 *   other change stores the state without it.
 * - `dialog` is the saved dialog the cards come from (lib/dialogs.mjs), so the dialog list can mark it and the
 *   history keeps it; the draft carries the dialog it was loaded from.
 * The order of `cards` is the order on screen; a newly shown card goes to the end (or before the insertion marker).
 * The draft, saved dialogs and the history use the same shape.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */

/** At most this many cards in the cast, shown or hidden; more would be too small to recognise. */
export const MAX_SHOWN_CARDS = 12;

/** Card size as a share of the window height, in percent. */
export const CARD_SIZE = Object.freeze({min: 10, max: 60, step: 5, initial: 35});

/**
 * How cards appear and leave (setting "cardTransition"; see styles/stagecraft.css, card layer):
 * a2b1 at its place, the others move along; a1b* the place opens first, then the card zooms in (b1), turns over
 * (b2), comes from above (b3) or fades (b4); simple fades, the others jump.
 */
export const CARD_TRANSITIONS = Object.freeze(["a2b1", "a1b1", "a1b2", "a1b3", "a1b4", "simple"]);
export const DEFAULT_CARD_TRANSITION = "a2b1";

/**
 * Where the cards stand (per location, setting "cardPositions"; default setting "cardPosition"):
 * a row at the top, at the bottom (above the hotbar) or in the middle of the screen, or a column on the left
 * (right of the scene controls, below the scene navigation) or on the right (left of the sidebar), top to bottom.
 */
export const CARD_POSITIONS = Object.freeze(["top", "bottom", "center", "left", "right"]);
export const DEFAULT_CARD_POSITION = "top";

/**
 * What happens to the shown cards when the GM switches the stage (setting "cardsOnStageSwitch"): they stay, the
 * dialog ends (all cards are hidden), or the stage browser asks.
 */
export const CARDS_ON_STAGE_SWITCH = Object.freeze(["keep", "end", "ask"]);
export const DEFAULT_CARDS_ON_STAGE_SWITCH = "keep";

/** Longest accepted key or path. */
const MAX_LENGTH = 1024;

/**
 * @typedef {object} ShownCard
 * @property {string} key       Person (location key of the card index).
 * @property {string} path      Image shown.
 * @property {true} [hidden]    In the cast, but not shown.
 */

/**
 * @typedef {object} ShownCards
 * @property {ShownCard[]} cards
 * @property {string|null} speaking  Key of the card that speaks; always a shown (not hidden) card.
 * @property {true} [turn]  The state replaced the previous one as a dialog switch.
 * @property {string} [dialog]  Id of the saved dialog the cards come from.
 */

/** @returns {ShownCards} */
export function emptyShownCards() {
  return {cards: [], speaking: null};
}

/** @param {unknown} value */
function validString(value) {
  return (typeof value === "string") && (value.trim().length > 0) && (value.length <= MAX_LENGTH);
}

/**
 * Clean the stored state: only string keys and paths within the length limit, each key once (first wins),
 * at most MAX_SHOWN_CARDS, `hidden` only if exactly true, `speaking` only if that card is there and not hidden,
 * `turn` only if exactly true, `dialog` only as a string within the length limit. Never throws.
 * @param {unknown} data
 * @returns {ShownCards}
 */
export function sanitizeShownCards(data) {
  const state = emptyShownCards();
  if ( !data || (typeof data !== "object") ) return state;
  const seen = new Set();
  const visible = new Set();
  for ( const entry of Array.isArray(data.cards) ? data.cards : [] ) {
    if ( state.cards.length >= MAX_SHOWN_CARDS ) break;
    if ( !entry || !validString(entry.key) || !validString(entry.path) || seen.has(entry.key) ) continue;
    seen.add(entry.key);
    const hidden = entry.hidden === true;
    if ( !hidden ) visible.add(entry.key);
    state.cards.push(hidden ? {key: entry.key, path: entry.path, hidden} : {key: entry.key, path: entry.path});
  }
  if ( validString(data.speaking) && visible.has(data.speaking) ) state.speaking = data.speaking;
  if ( data.turn === true ) state.turn = true;
  if ( validString(data.dialog) ) state.dialog = data.dialog;
  return state;
}

/**
 * The places that turn over on a dialog switch. Cards in both lists stay (a new variant turns over at its place);
 * the others are paired in their order: the first card leaving becomes the first card arriving, and so on. Leaving
 * cards without a partner go, arriving ones without a partner come.
 * @param {string[]} previous  Keys before the switch, in their order.
 * @param {string[]} next      Keys after the switch, in their order.
 * @returns {Map<string, string>}  Arriving key → the leaving key whose place it takes.
 */
export function pairCards(previous, next) {
  const before = new Set(previous);
  const after = new Set(next);
  const leaving = previous.filter(k => !after.has(k));
  const arriving = next.filter(k => !before.has(k));
  return new Map(arriving.slice(0, leaving.length).map((key, i) => [key, leaving[i]]));
}

/** @param {ShownCard[]} cards  @returns {ShownCard[]}  Copies, so the input stays unchanged. */
function copyCards(cards) {
  return cards.map(c => ({...c}));
}

/**
 * Insert a card before the card `before`, or at the end if that is null or not in the list.
 * @param {ShownCard[]} cards  Changed in place.
 * @param {ShownCard} card
 * @param {string|null} before
 */
function insertBefore(cards, card, before) {
  const at = before ? cards.findIndex(c => c.key === before) : -1;
  if ( at === -1 ) cards.push(card);
  else cards.splice(at, 0, card);
}

/** @param {ShownCards} state  @returns {ShownCard[]}  The cards the players see, in their order. */
export function visibleCards(state) {
  return state.cards.filter(c => !c.hidden);
}

/**
 * A click on a card or one of its variants in the browser:
 * - not in the cast → shown, before the card `before` (the insertion marker) or at the end if that is null or not
 *   in the cast (if the cast holds MAX_SHOWN_CARDS already, nothing changes);
 * - hidden → shown at its place, with the image clicked;
 * - shown with another image → that image, in the same place;
 * - shown with this image → hidden; it stays in the cast (and no longer speaks).
 * @param {ShownCards} state
 * @param {ShownCard} card
 * @param {{before?: string|null}} [options]
 * @returns {ShownCards}  A new state.
 */
export function toggleCard(state, {key, path}, {before=null} = {}) {
  const cards = copyCards(state.cards);
  const index = cards.findIndex(c => c.key === key);
  if ( index === -1 ) {
    if ( cards.length < MAX_SHOWN_CARDS ) insertBefore(cards, {key, path}, before);
    return {cards, speaking: state.speaking};
  }
  const card = cards[index];
  if ( card.hidden ) {
    cards[index] = {key, path};
    return {cards, speaking: state.speaking};
  }
  if ( card.path !== path ) {
    card.path = path;
    return {cards, speaking: state.speaking};
  }
  card.hidden = true;
  return {cards, speaking: state.speaking === key ? null : state.speaking};
}

/**
 * Put cards into the cast hidden, in their order before the card `before` (or at the end), e.g. dragged onto the
 * strip or "Hidden into the cast". A card already in the cast moves there with the image given and keeps whether it
 * is shown. Cards beyond MAX_SHOWN_CARDS are left out.
 * @param {ShownCards} state
 * @param {ShownCard[]} added
 * @param {{before?: string|null}} [options]
 * @returns {{state: ShownCards, left: number}}  A new state, and how many cards found no room.
 */
export function addHiddenCards(state, added, {before=null} = {}) {
  let cards = copyCards(state.cards);
  let left = 0;
  // The place stays the same while cards move: before the marker card, unless that is one of the cards moved.
  const moving = new Set(added.map(c => c.key));
  let anchor = before;
  if ( anchor && moving.has(anchor) ) {
    const start = cards.findIndex(c => c.key === anchor);
    anchor = cards.slice(start).find(c => !moving.has(c.key))?.key ?? null;
  }
  for ( const {key, path} of added ) {
    const index = cards.findIndex(c => c.key === key);
    if ( index !== -1 ) {
      const [card] = cards.splice(index, 1);
      insertBefore(cards, {...card, path}, anchor);
      continue;
    }
    if ( cards.length >= MAX_SHOWN_CARDS ) {
      left++;
      continue;
    }
    insertBefore(cards, {key, path, hidden: true}, anchor);
  }
  return {state: {cards, speaking: state.speaking}, left};
}

/**
 * Show or hide a card of the cast at its place. Hiding the speaker ends speaking. Unknown keys change nothing.
 * @param {ShownCards} state
 * @param {string} key
 * @param {boolean} hidden
 * @returns {ShownCards}  A new state.
 */
export function setCardHidden(state, key, hidden) {
  const cards = copyCards(state.cards).map(c => {
    if ( c.key !== key ) return c;
    return hidden ? {...c, hidden: true} : {key: c.key, path: c.path};
  });
  return {cards, speaking: (hidden && (state.speaking === key)) ? null : state.speaking};
}

/**
 * Hide every card of the cast; the cast stays.
 * @param {ShownCards} state
 * @returns {ShownCards}  A new state.
 */
export function hideAllInCast(state) {
  return {cards: state.cards.map(c => ({...c, hidden: true})), speaking: null};
}

/**
 * Take cards out of the cast. Unknown keys change nothing.
 * @param {ShownCards} state
 * @param {string|string[]} keys
 * @returns {ShownCards}  A new state.
 */
export function removeFromCast(state, keys) {
  const gone = new Set([keys].flat());
  const cards = copyCards(state.cards).filter(c => !gone.has(c.key));
  return {cards, speaking: gone.has(state.speaking) ? null : state.speaking};
}

/**
 * Move a card to another place: before the card `before`, or to the end (null, or a key that is not there).
 * Unknown keys change nothing; the speaker stays.
 * @param {ShownCards} state
 * @param {string} key
 * @param {string|null} before
 * @returns {ShownCards}  A new state.
 */
export function moveCard(state, key, before) {
  const cards = copyCards(state.cards);
  const from = cards.findIndex(c => c.key === key);
  if ( (from === -1) || (key === before) ) return {cards, speaking: state.speaking};
  const [card] = cards.splice(from, 1);
  const at = before ? cards.findIndex(c => c.key === before) : -1;
  if ( at === -1 ) cards.push(card);
  else cards.splice(at, 0, card);
  return {cards, speaking: state.speaking};
}

/**
 * Mark a shown card as speaking, or end it (the same key again, or null). Only one card speaks at a time; a hidden
 * card does not.
 * @param {ShownCards} state
 * @param {string|null} key
 * @returns {ShownCards}
 */
export function toggleSpeaking(state, key) {
  const cards = copyCards(state.cards);
  if ( !key || (state.speaking === key) || !cards.some(c => (c.key === key) && !c.hidden) ) return {cards, speaking: null};
  return {cards, speaking: key};
}

/**
 * The insertion marker after a change of the cast. The marker stands before a card (its key) or at the end (null)
 * and stays there, so further cards go behind the last one inserted. If the card it stood before is no longer in
 * the cast, it moves on to the card that followed it (or to the end).
 * @param {string|null} before   Marker before the change.
 * @param {ShownCard[]} previous  Cards before the change.
 * @param {ShownCard[]} current   Cards after the change.
 * @returns {string|null}
 */
export function moveMarker(before, previous, current) {
  if ( !before ) return null;
  const shown = new Set(current.map(c => c.key));
  if ( shown.has(before) ) return before;
  const start = previous.findIndex(c => c.key === before);
  if ( start === -1 ) return null;
  for ( const card of previous.slice(start + 1) ) if ( shown.has(card.key) ) return card.key;
  return null;
}

/**
 * Clean the stored card positions per location: string keys within the length limit, known positions only.
 * @param {unknown} data
 * @returns {Record<string, string>}  A fresh null-prototype object.
 */
export function sanitizeCardPositions(data) {
  const result = Object.create(null);
  if ( !data || (typeof data !== "object") || Array.isArray(data) ) return result;
  for ( const [key, value] of Object.entries(data) ) {
    if ( validString(key) && CARD_POSITIONS.includes(value) ) result[key] = value;
  }
  return result;
}

/**
 * The position for a location: its own, else the default (if that is valid), else DEFAULT_CARD_POSITION.
 * @param {Record<string, string>} positions  From `sanitizeCardPositions`.
 * @param {string|null} locationKey
 * @param {unknown} fallback  The default setting.
 * @returns {string}
 */
export function cardPositionFor(positions, locationKey, fallback) {
  if ( locationKey && positions[locationKey] ) return positions[locationKey];
  return CARD_POSITIONS.includes(fallback) ? /** @type {string} */ (fallback) : DEFAULT_CARD_POSITION;
}

/**
 * Clamp the card size setting to its range.
 * @param {unknown} value
 * @returns {number}  Percent of the window height.
 */
export function normalizeCardSize(value) {
  const number = Number(value);
  if ( !Number.isFinite(number) ) return CARD_SIZE.initial;
  return Math.min(CARD_SIZE.max, Math.max(CARD_SIZE.min, Math.round(number)));
}
