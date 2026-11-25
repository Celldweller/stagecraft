/**
 * Format of the stage index cache: only the list of image paths, plus what it belongs to.
 *
 * The cache lives in the GM's browser (a client-scoped setting, i.e. localStorage), so players never load it.
 * localStorage is shared by all worlds on the same server address, hence the binding to world, source and root.
 * Parsing into locations and variants happens on load, so a changed variant pattern needs no rescan.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */

export const INDEX_CACHE_FORMAT = "stagecraft-index";
export const INDEX_CACHE_VERSION = 1;

/** Upper bound for cached paths; matches the scan limit. */
const MAX_FILES = 20000;
const MAX_PATH_LENGTH = 2048;

/**
 * @typedef {object} IndexCache
 * @property {string} format
 * @property {number} version
 * @property {string} worldId
 * @property {string} source
 * @property {string} root
 * @property {number} scannedAt   Timestamp (ms since epoch).
 * @property {string[]} files
 */

/**
 * Build the object to store.
 * @param {{worldId: string, source: string, root: string, scannedAt: number, files: string[]}} data
 * @returns {IndexCache}
 */
export function buildIndexCache({worldId, source, root, scannedAt, files}) {
  return {format: INDEX_CACHE_FORMAT, version: INDEX_CACHE_VERSION, worldId, source, root, scannedAt, files: [...files]};
}

/**
 * Check a stored cache against the current world and settings. Never throws.
 * @param {unknown} data   The stored value (may be anything, including data from another world or an old version).
 * @param {{worldId: string, source: string, root: string}} expected
 * @returns {{ok: true, cache: IndexCache} | {ok: false, reason: string}}
 */
export function validateIndexCache(data, {worldId, source, root}) {
  if ( data === null || data === undefined ) return {ok: false, reason: "Empty"};
  if ( typeof data !== "object" || Array.isArray(data) ) return {ok: false, reason: "NotAnObject"};
  if ( data.format !== INDEX_CACHE_FORMAT ) return {ok: false, reason: "WrongFormat"};
  if ( data.version !== INDEX_CACHE_VERSION ) return {ok: false, reason: "UnsupportedVersion"};
  if ( data.worldId !== worldId ) return {ok: false, reason: "OtherWorld"};
  if ( data.source !== source || data.root !== root ) return {ok: false, reason: "SettingsChanged"};
  if ( !Number.isFinite(data.scannedAt) ) return {ok: false, reason: "InvalidTimestamp"};
  if ( !Array.isArray(data.files) || data.files.length > MAX_FILES ) return {ok: false, reason: "InvalidFiles"};
  if ( !data.files.every(f => typeof f === "string" && f.length > 0 && f.length <= MAX_PATH_LENGTH) ) {
    return {ok: false, reason: "InvalidFiles"};
  }
  return {ok: true, cache: data};
}
