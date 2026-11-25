/**
 * Saved dialogs: cards with order, variants and speaker, optionally a stage, shown with one click. Stored in the world setting "dialogs" (lib/dialogs.mjs); like everything of the GM in Foundry,
 * players' browsers receive it but nothing shows it to them (checked on 2026-11-23).
 *
 * - Showing a dialog switches to its stage first (if it has one and another runs), then replaces the shown cards as
 *   a dialog switch: the cards turn over in place (card-layer.mjs). The shown state remembers the dialog, so the card
 *   browser can mark it.
 * - Editing a dialog means loading it into the draft of the planning mode (card-draft.mjs), changing it there and
 *   saving it back.
 * - Cards and stage are resolved against the indexes of this GM's browser; a card no longer there is left out with a
 *   warning naming it.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import {
  MAX_DIALOGS, dialogCardsOf, normalizeDialogName, resolveDialog, resolveImage, sanitizeDialogs, sortDialogs
} from "./lib/dialogs.mjs";
import { toKey } from "./lib/filenames.mjs";
import { getCardIndex, getStageIndex, parseMediaPath } from "./media-index.mjs";
import { getStageNames, getStageSrc, switchStage } from "./stage-scene.mjs";
import { replaceShownCards } from "./card-layer.mjs";
import { loadDraft } from "./card-draft.mjs";

/** Hook fired after the saved dialogs changed (any GM): `(dialogs)`. */
export const DIALOGS_HOOK = `${MODULE_ID}.dialogsUpdated`;

/** @type {import("./lib/dialogs.mjs").SavedDialog[]|null}  Sanitised, in stored order; null until first read. */
let cache = null;

function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
}

/** @returns {import("./lib/dialogs.mjs").SavedDialog[]}  In stored order. Do not modify. */
function stored() {
  cache ??= sanitizeDialogs(getSetting("dialogs"));
  return cache;
}

/** @returns {import("./lib/dialogs.mjs").SavedDialog[]}  All dialogs, by name. Do not modify. */
export function getDialogs() {
  return sortDialogs(stored());
}

/**
 * @param {string|null|undefined} id
 * @returns {import("./lib/dialogs.mjs").SavedDialog|null}
 */
export function getDialog(id) {
  return (id && stored().find(d => d.id === id)) || null;
}

/**
 * A dialog by id, or else by name (case-insensitive), e.g. for macros.
 * @param {string} ref
 * @returns {import("./lib/dialogs.mjs").SavedDialog|null}
 */
export function findDialog(ref) {
  if ( typeof ref !== "string" ) return null;
  const key = toKey(ref);
  return getDialog(ref) ?? stored().find(d => toKey(d.name) === key) ?? null;
}

/** @param {import("./media-index.mjs").MediaIndexData|null} index */
function byKey(index) {
  return new Map((index?.locations ?? []).map(l => [l.key, l]));
}

/**
 * Display name of a dialog card or stage: the person or location name (stages: the stage name), with the variant.
 * @param {import("./lib/dialogs.mjs").DialogImage} image
 * @param {"cards"|"stages"} kind
 * @returns {string}
 */
export function imageLabel(image, kind) {
  const index = (kind === "stages") ? getStageIndex() : getCardIndex();
  const location = index?.locations.find(l => l.key === image.location);
  const name = ((kind === "stages") ? getStageNames()[image.location] : null) ?? location?.name ?? image.location;
  return image.variant ? `${name} (${image.variant})` : name;
}

/**
 * The cards of a shown state or draft as the cards of a dialog.
 * @param {import("./lib/cards.mjs").ShownCards} state
 * @returns {{cards: import("./lib/dialogs.mjs").DialogImage[], speaker: string|null}}
 */
export function dialogCardsFromState(state) {
  return dialogCardsOf(state, parseMediaPath);
}

/** @returns {import("./lib/dialogs.mjs").DialogImage|null}  The stage on show as the stage of a dialog. */
export function currentStageImage() {
  const src = getStageSrc();
  if ( !src ) return null;
  const {locationKey, variant} = parseMediaPath(src);
  return {location: locationKey, variant: variant ?? null};
}

/**
 * The shown state of a dialog, resolved against this browser's card index.
 * @param {import("./lib/dialogs.mjs").SavedDialog} dialog
 * @returns {ReturnType<typeof resolveDialog>}
 */
function resolve(dialog) {
  const index = getCardIndex();
  if ( !index ) throw new Error(game.i18n.localize("STAGECRAFT.Dialogs.NoCardIndex"));
  const resolved = resolveDialog(dialog, byKey(index));
  if ( !resolved.cards.length ) {
    throw new Error(game.i18n.format("STAGECRAFT.Dialogs.NoCards", {name: dialog.name}));
  }
  if ( resolved.missing.length ) {
    ui.notifications.warn(game.i18n.format("STAGECRAFT.Dialogs.MissingCards", {
      name: dialog.name, cards: resolved.missing.map(c => imageLabel(c, "cards")).join(", ")
    }));
  }
  return resolved;
}

/**
 * Show a saved dialog: switch to its stage (if it has one and another runs), then replace the shown cards with its
 * cards and speaker as a dialog switch. GM only.
 * @param {string} ref  Id or name of the dialog.
 * @param {object} [options]
 * @param {(path: string) => Promise<boolean>} [options.beforeStageSwitch]  Asked before the stage switch (e.g. about
 *   unsaved lights); false stops here, nothing changes.
 * @returns {Promise<boolean>}  Whether the dialog was shown.
 */
export async function showDialog(ref, {beforeStageSwitch} = {}) {
  assertGM();
  const dialog = findDialog(ref);
  if ( !dialog ) throw new Error(game.i18n.format("STAGECRAFT.Dialogs.Unknown", {ref: String(ref)}));
  const {cards, speaking} = resolve(dialog);
  const stage = dialog.stage ? resolveImage(dialog.stage, byKey(getStageIndex())) : null;
  if ( dialog.stage && !stage ) {
    ui.notifications.warn(game.i18n.format("STAGECRAFT.Dialogs.MissingStage", {
      name: dialog.name, stage: imageLabel(dialog.stage, "stages")
    }));
  }
  if ( stage && (stage !== getStageSrc()) ) {
    if ( beforeStageSwitch && !(await beforeStageSwitch(stage)) ) return false;
    // The dialog replaces the cards anyway: no "end the dialog" with the switch.
    await switchStage(stage, {endDialog: false});
  }
  await replaceShownCards({cards, speaking, dialog: dialog.id});
  return true;
}

/**
 * Load a saved dialog into the draft of the planning mode (starting it if it is off), to change and save it back.
 * GM only.
 * @param {string} ref  Id or name of the dialog.
 */
export async function editDialog(ref) {
  assertGM();
  const dialog = findDialog(ref);
  if ( !dialog ) throw new Error(game.i18n.format("STAGECRAFT.Dialogs.Unknown", {ref: String(ref)}));
  const {cards, speaking} = resolve(dialog);
  await loadDraft({cards, speaking, dialog: dialog.id});
}

/**
 * @typedef {object} DialogData  What `saveDialog` takes; for an existing dialog only the fields to change.
 * @property {string} [name]
 * @property {import("./lib/dialogs.mjs").DialogImage[]} [cards]
 * @property {string|null} [speaker]
 * @property {import("./lib/dialogs.mjs").DialogImage|null} [stage]
 * @property {string[]} [tags]
 */

/**
 * Create a dialog, or change one (`id`). It needs a name and at least one card. GM only.
 * @param {DialogData} data
 * @param {string|null} [id]
 * @returns {Promise<string>}  The dialog's id.
 */
export async function saveDialog(data, id=null) {
  assertGM();
  const list = stored().map(d => ({...d}));
  let dialog;
  if ( id ) {
    const index = list.findIndex(d => d.id === id);
    if ( index === -1 ) throw new Error(game.i18n.format("STAGECRAFT.Dialogs.Unknown", {ref: id}));
    dialog = list[index] = {...list[index], ...data, id};
  }
  else {
    if ( list.length >= MAX_DIALOGS ) throw new Error(game.i18n.format("STAGECRAFT.Dialogs.TooMany", {max: MAX_DIALOGS}));
    dialog = {speaker: null, stage: null, tags: [], ...data, id: foundry.utils.randomID()};
    list.push(dialog);
  }
  if ( !normalizeDialogName(dialog.name) ) throw new Error(game.i18n.localize("STAGECRAFT.Dialogs.NameRequired"));
  if ( !dialog.cards?.length ) throw new Error(game.i18n.localize("STAGECRAFT.Dialogs.CardsRequired"));
  await setSetting("dialogs", sanitizeDialogs(list));
  return dialog.id;
}

/**
 * Delete a dialog. GM only.
 * @param {string} id
 */
export async function deleteDialog(id) {
  assertGM();
  if ( !getDialog(id) ) return;
  await setSetting("dialogs", sanitizeDialogs(stored().filter(d => d.id !== id)));
}

/** Setting onChange: drop the cache and tell the UI. */
export function onDialogsChanged() {
  cache = null;
  Hooks.callAll(DIALOGS_HOOK, getDialogs());
}
