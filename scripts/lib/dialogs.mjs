/**
 * Pure helpers for the saved dialogs.
 *
 * Stored (world setting "dialogs"): a list of
 * `{id, name, cards: [{location, variant, hidden?}], speaker, stage: {location, variant}|null, tags: [tag]}`.
 * - The cards are a cast like the shown cards (lib/cards.mjs): `hidden: true` puts a card into the cast without
 *   showing it.
 * - Cards and stage are kept as location key and variant label (null for the base variant), like the light presets,
 *   so a dialog stays intact when an image changes its format or size suffix. They are resolved against the index
 *   when the dialog is shown; a card that is no longer there is left out.
 * - `speaker` is the location key of a shown card of the dialog, or null.
 * - Follow-up dialogs (`next`) were dropped again before the first release; a stored `next` is ignored.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */
import { MAX_SHOWN_CARDS } from "./cards.mjs";
import { compareNatural, normalizeWhitespace, toKey } from "./filenames.mjs";
import { normalizeTagList } from "./tags.mjs";
import { matchesTerms, normalizeSearchText } from "./search.mjs";

/** At most this many dialogs; far more than a campaign is expected to need. */
export const MAX_DIALOGS = 1000;

/** Longest dialog name. */
export const MAX_DIALOG_NAME = 100;

/** Longest accepted location key or variant label (as for the other per-image settings). */
const MAX_LENGTH = 1024;

/** Dialog ids: Foundry's random ids, or anything of the same kind. */
const ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/**
 * @typedef {object} DialogImage  A card or stage of a dialog.
 * @property {string} location     Location key of the index (case-insensitive name).
 * @property {string|null} variant  Variant label; null for the base variant.
 * @property {true} [hidden]        Cards only: in the cast, but not shown.
 */

/**
 * @typedef {object} SavedDialog
 * @property {string} id
 * @property {string} name
 * @property {DialogImage[]} cards
 * @property {string|null} speaker     Location key of the card that speaks first.
 * @property {DialogImage|null} stage  The stage the dialog switches to; null keeps the running stage.
 * @property {string[]} tags
 */

/** @param {unknown} value */
function validString(value) {
  return (typeof value === "string") && (value.trim().length > 0) && (value.length <= MAX_LENGTH);
}

/**
 * A dialog name: whitespace collapsed, trimmed, within the length limit.
 * @param {unknown} value
 * @returns {string|null}  Null if empty or not a string.
 */
export function normalizeDialogName(value) {
  if ( typeof value !== "string" ) return null;
  const name = normalizeWhitespace(value).slice(0, MAX_DIALOG_NAME).trim();
  return name || null;
}

/**
 * @param {unknown} data
 * @returns {DialogImage|null}
 */
function sanitizeImage(data) {
  if ( !data || (typeof data !== "object") || !validString(data.location) ) return null;
  const variant = validString(data.variant) ? data.variant : null;
  return {location: data.location, variant};
}

/**
 * Clean the stored dialogs. Invalid dialogs and fields are dropped, each id once (first wins), each card's location
 * once per dialog, at most MAX_SHOWN_CARDS cards, `hidden` only if exactly true; the speaker only if it is a shown
 * card of the dialog. Never throws.
 * @param {unknown} data
 * @returns {SavedDialog[]}  In stored order.
 */
export function sanitizeDialogs(data) {
  if ( !Array.isArray(data) ) return [];
  /** @type {SavedDialog[]} */
  const dialogs = [];
  const ids = new Set();
  for ( const raw of data ) {
    if ( dialogs.length >= MAX_DIALOGS ) break;
    if ( !raw || (typeof raw !== "object") ) continue;
    const id = (typeof raw.id === "string") && ID_PATTERN.test(raw.id) ? raw.id : null;
    const name = normalizeDialogName(raw.name);
    if ( !id || !name || ids.has(id) ) continue;
    ids.add(id);
    const cards = [];
    const seen = new Set();
    const visible = new Set();
    for ( const card of Array.isArray(raw.cards) ? raw.cards : [] ) {
      if ( cards.length >= MAX_SHOWN_CARDS ) break;
      const image = sanitizeImage(card);
      if ( !image || seen.has(image.location) ) continue;
      seen.add(image.location);
      if ( card.hidden === true ) image.hidden = true;
      else visible.add(image.location);
      cards.push(image);
    }
    const speaker = (typeof raw.speaker === "string") && visible.has(raw.speaker) ? raw.speaker : null;
    const tags = normalizeTagList(Array.isArray(raw.tags) ? raw.tags : []);
    dialogs.push({id, name, cards, speaker, stage: sanitizeImage(raw.stage), tags});
  }
  return dialogs;
}

/**
 * Dialogs in the order of the list: by name, numbers in natural order.
 * @param {SavedDialog[]} dialogs
 * @returns {SavedDialog[]}  A new array.
 */
export function sortDialogs(dialogs) {
  return [...dialogs].sort((a, b) => compareNatural(a.name, b.name) || compareNatural(a.id, b.id));
}

/**
 * The cards of a shown state (or draft) as the cards of a dialog.
 * @param {import("./cards.mjs").ShownCards} state
 * @param {(path: string) => {variant: string|null}} parse  The index's path parser (variant pattern).
 * @returns {{cards: DialogImage[], speaker: string|null}}
 */
export function dialogCardsOf(state, parse) {
  return {
    cards: state.cards.map(card => ({location: card.key, variant: parse(card.path).variant ?? null,
      ...(card.hidden ? {hidden: true} : {})})),
    speaker: state.speaking ?? null
  };
}

/**
 * The file of a location and variant in an index, or null if the location or the variant is no longer there.
 * @param {DialogImage} image
 * @param {Map<string, import("./filenames.mjs").StageLocation>} locations  By location key.
 * @returns {string|null}
 */
export function resolveImage(image, locations) {
  const location = locations.get(image.location);
  if ( !location ) return null;
  const wanted = (image.variant === null) ? null : toKey(image.variant);
  const variant = location.variants.find(v => ((v.variant === null) ? null : toKey(v.variant)) === wanted);
  return variant?.preferred.path ?? null;
}

/**
 * The shown state of a dialog: its cards resolved against the card index. Cards that are no longer there are left
 * out and listed in `missing`; the speaker only if its card is there.
 * @param {SavedDialog} dialog
 * @param {Map<string, import("./filenames.mjs").StageLocation>} locations  Card index by location key.
 * @returns {{cards: import("./cards.mjs").ShownCard[], speaking: string|null, missing: DialogImage[]}}
 */
export function resolveDialog(dialog, locations) {
  const cards = [];
  const missing = [];
  for ( const card of dialog.cards ) {
    const path = resolveImage(card, locations);
    if ( path ) cards.push(card.hidden ? {key: card.location, path, hidden: true} : {key: card.location, path});
    else missing.push(card);
  }
  const speaking = cards.some(c => (c.key === dialog.speaker) && !c.hidden) ? dialog.speaker : null;
  return {cards, speaking, missing};
}

/**
 * Whether a dialog passes the browser's filter: every tag chip must be one of its tags (variant chips concern the
 * cards only); every word of the free text must occur in its name, its tags or the names of its cards.
 * @param {SavedDialog} dialog
 * @param {{terms?: string[], chips?: import("./filter.mjs").Chip[]}} filter
 * @param {(location: string) => string} cardName  Display name of a card's location.
 * @returns {boolean}
 */
export function dialogMatchesFilter(dialog, {terms=[], chips=[]} = {}, cardName = key => key) {
  const tags = new Set(dialog.tags.map(t => t.toLocaleLowerCase("en")));
  for ( const chip of chips ) {
    if ( (chip.type === "tag") && !tags.has(chip.value.toLocaleLowerCase("en")) ) return false;
  }
  if ( !terms.length ) return true;
  const text = normalizeSearchText([dialog.name, ...dialog.tags, ...dialog.cards.map(c => cardName(c.location))]
    .join(" "));
  return matchesTerms(text, terms);
}
