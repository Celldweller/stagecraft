/**
 * Pure logic of the stage switch: socket messages and the scene update. No Foundry globals, testable with `node --test`.
 *
 * Switching runs in two steps:
 * 1. The GM sends `preload` with the new image to the players who view the stage scene; each answers `preloaded`.
 * 2. Once all answered (or after a timeout) the GM writes the image and its size to the scene in one update.
 */

/** Socket event of this module (needs `"socket": true` in module.json). */
export const SOCKET_EVENT = "module.stagecraft";

/**
 * How long the GM waits for the players to load the new image. Short on purpose: a player with a slow connection
 * must not hold up the others; they keep the previous image until theirs is loaded (stage-hold.mjs).
 */
export const PRELOAD_TIMEOUT_MS = 1000;

/** Longest accepted image path in a message. */
const MAX_SRC_LENGTH = 2048;

/** Request ids are Foundry random ids (16 alphanumeric characters); a little slack for other generators. */
const ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/**
 * @typedef {{type: "preload", id: string, src: string}} PreloadMessage
 * @typedef {{type: "preloaded", id: string, ok: boolean}} PreloadedMessage
 * @typedef {PreloadMessage|PreloadedMessage} StageMessage
 */

/**
 * Check a received socket message against the fixed schema. Unknown or malformed messages yield null.
 * Only known keys are copied, so nothing else from the payload travels on.
 * @param {unknown} data
 * @returns {StageMessage|null}
 */
export function validateStageMessage(data) {
  if ( !data || (typeof data !== "object") || Array.isArray(data) ) return null;
  const {type, id} = /** @type {Record<string, unknown>} */ (data);
  if ( (typeof id !== "string") || !ID_PATTERN.test(id) ) return null;
  if ( type === "preload" ) {
    const src = /** @type {Record<string, unknown>} */ (data).src;
    if ( (typeof src !== "string") || !src.trim() || (src.length > MAX_SRC_LENGTH) ) return null;
    if ( /^\s*(javascript|data|vbscript):/i.test(src) ) return null;
    return {type, id, src};
  }
  if ( type === "preloaded" ) {
    const ok = /** @type {Record<string, unknown>} */ (data).ok;
    return {type, id, ok: ok === true};
  }
  return null;
}

/**
 * Whole-pixel size of an image, or null if it is unusable.
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number}|null}
 */
export function imageSize(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if ( !Number.isFinite(w) || !Number.isFinite(h) || (w < 1) || (h < 1) ) return null;
  return {width: w, height: h};
}

/**
 * The scene update for a new stage image: the scene takes the image's size without padding and the stage name
 * as navigation name; the level shows the image as background, with the bar colour around it.
 * Other level data stays untouched (embedded updates are merged by `_id`).
 * @param {{levelId: string, src: string, width: number, height: number, navName: string, color: string}} stage
 * @returns {{width: number, height: number, padding: number, navName: string,
 *   levels: {_id: string, background: {src: string, color: string}}[]}}
 */
export function stageUpdateData({levelId, src, width, height, navName, color}) {
  return {width, height, padding: 0, navName, levels: [{_id: levelId, background: {src, color}}]};
}

/** Longest stage name; it becomes the scene's navigation name. */
export const MAX_STAGE_NAME_LENGTH = 100;

/** Longest location key accepted in the stored names. */
const MAX_KEY_LENGTH = 1024;

/**
 * Clean a stage name typed by the GM: whitespace collapsed, control characters removed, length limited.
 * @param {unknown} value
 * @returns {string|null}  Null for an empty name (= use the default).
 */
export function normalizeStageName(value) {
  if ( typeof value !== "string" ) return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if ( !text ) return null;
  return text.slice(0, MAX_STAGE_NAME_LENGTH).trim();
}

/**
 * Clean the stored stage names (world setting): location key → name. Never throws; anything unusable is dropped.
 * @param {unknown} data
 * @returns {Record<string, string>}  A fresh null-prototype object.
 */
export function sanitizeStageNames(data) {
  const result = Object.create(null);
  if ( !data || (typeof data !== "object") || Array.isArray(data) ) return result;
  for ( const [key, value] of Object.entries(data) ) {
    if ( !key || (key.length > MAX_KEY_LENGTH) ) continue;
    const name = normalizeStageName(value);
    if ( name ) result[key] = name;
  }
  return result;
}

/* -------------------------------------------- */
/*  Bar colour                                  */
/* -------------------------------------------- */

/** Share of black mixed into the edge colour, so bars recede behind the image. */
export const BAR_DARKEN = 0.35;

/** Colour of the bars when nothing better is known. */
export const DEFAULT_BAR_COLOR = "#000000";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Average colour of the outermost pixel ring of an RGBA image (a downscaled copy is enough).
 * @param {Uint8ClampedArray|number[]} pixels  RGBA, row by row.
 * @param {number} width
 * @param {number} height
 * @returns {{r: number, g: number, b: number}|null}
 */
export function edgeColor(pixels, width, height) {
  if ( !(width > 0) || !(height > 0) || (pixels.length < width * height * 4) ) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x, y) => {
    const i = ((y * width) + x) * 4;
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    n++;
  };
  for ( let x = 0; x < width; x++ ) {
    add(x, 0);
    if ( height > 1 ) add(x, height - 1);
  }
  for ( let y = 1; y < height - 1; y++ ) {
    add(0, y);
    if ( width > 1 ) add(width - 1, y);
  }
  return {r: r / n, g: g / n, b: b / n};
}

/**
 * The bar colour for an edge colour: darkened towards black and written as hex.
 * @param {{r: number, g: number, b: number}} rgb
 * @param {number} [amount=BAR_DARKEN]  Share of black, 0–1.
 * @returns {string}
 */
export function barColor({r, g, b}, amount=BAR_DARKEN) {
  const keep = 1 - Math.min(Math.max(amount, 0), 1);
  const channel = v => Math.round(Math.min(Math.max(v * keep, 0), 255)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * A colour as "#rrggbb" in lower case, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeHexColor(value) {
  if ( typeof value !== "string" ) return null;
  const text = value.trim();
  return HEX_COLOR.test(text) ? text.toLowerCase() : null;
}

/**
 * Key of a variant in the stored colours: location key and variant label, case-insensitive ("" for the base).
 * @param {string} locationKey
 * @param {string|null} variant
 * @returns {string}
 */
export function variantKey(locationKey, variant) {
  return `${locationKey}::${String(variant ?? "").toLocaleLowerCase("en")}`;
}

/**
 * Clean the stored bar colours (world setting): variant key → "#rrggbb". Never throws.
 * @param {unknown} data
 * @returns {Record<string, string>}  A fresh null-prototype object.
 */
export function sanitizeStageColors(data) {
  const result = Object.create(null);
  if ( !data || (typeof data !== "object") || Array.isArray(data) ) return result;
  for ( const [key, value] of Object.entries(data) ) {
    if ( !key || (key.length > MAX_KEY_LENGTH) ) continue;
    const color = normalizeHexColor(value);
    if ( color ) result[key] = color;
  }
  return result;
}
