/**
 * Thumbnail cache logic: file names, sizes and the comparison of index and cache folder.
 *
 * Thumbnails live flat in one folder per generation (`{root}/{generation}/`). The file name is a hash of
 * source, original path and thumbnail spec, so no list of thumbnails needs to be stored anywhere:
 * one listing of the folder tells which thumbnails exist.
 *
 * No Foundry globals in here, so everything is testable with `node --test` and usable in the worker.
 */

/** Size and encoding of thumbnails. Changing any value produces new file names, i.e. new thumbnails. */
export const THUMB_SPEC = Object.freeze({width: 480, quality: 0.5, version: 1});

/** Preferred and fallback output formats (not every browser can encode WebP). */
export const THUMB_FORMATS = Object.freeze([
  Object.freeze({type: "image/webp", ext: "webp"}),
  Object.freeze({type: "image/jpeg", ext: "jpg"})
]);

/** Highest generation number accepted; guards against nonsense values in the settings. */
export const MAX_GENERATION = 9999;

const STEM = /^[0-9a-f]{16}-\d{1,5}$/;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * FNV-1a, 64 bit, over the UTF-8 bytes of a string. Not cryptographic; only used to derive stable,
 * short file names. Chosen over `crypto.subtle` because that needs a secure context (fails on plain http in a LAN).
 * @param {string} text
 * @returns {string}  16 lower-case hex digits.
 */
export function fnv1a64(text) {
  let hash = FNV_OFFSET;
  for ( const byte of new TextEncoder().encode(String(text)) ) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * File name of a thumbnail without extension.
 * @param {string} source   File source of the original, e.g. "data" or "forgevtt".
 * @param {string} path     Path of the original exactly as the index stores it.
 * @param {{width: number, quality: number, version: number}} [spec]
 * @returns {string}  e.g. "3f9a0c4e1b2d7a65-480"
 */
export function thumbStem(source, path, spec=THUMB_SPEC) {
  const key = [source, path, spec.width, spec.quality, spec.version].join("\n");
  return `${fnv1a64(key)}-${spec.width}`;
}

/**
 * Stem of a listed thumbnail file, or null if the file is not a Stagecraft thumbnail.
 * @param {string} path  A path or URL as returned by a folder listing.
 * @returns {string|null}
 */
export function stemOfListedFile(path) {
  const file = String(path ?? "").split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  if ( dot <= 0 ) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  if ( !THUMB_FORMATS.some(f => f.ext === ext) ) return null;
  const stem = file.slice(0, dot);
  return STEM.test(stem) ? stem : null;
}

/**
 * Folder of one cache generation.
 * @param {string} root
 * @param {number} generation
 * @returns {string}  e.g. "stagecraft/thumbs/1"
 */
export function thumbFolder(root, generation) {
  const clean = String(root ?? "").trim().replace(/^\/+|\/+$/g, "");
  const gen = normalizeGeneration(generation);
  return clean ? `${clean}/${gen}` : String(gen);
}

/**
 * Clamp a stored generation number to a positive integer.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeGeneration(value) {
  const n = Math.trunc(Number(value));
  if ( !Number.isFinite(n) || (n < 1) ) return 1;
  return Math.min(n, MAX_GENERATION);
}

/**
 * Size of a thumbnail for an original of the given size: scaled to the spec width, never enlarged.
 * @param {number} width
 * @param {number} height
 * @param {number} [maxWidth]
 * @returns {{width: number, height: number}}
 */
export function thumbnailSize(width, height, maxWidth=THUMB_SPEC.width) {
  if ( !(width > 0) || !(height > 0) ) throw new RangeError("Image has no size");
  if ( width <= maxWidth ) return {width: Math.round(width), height: Math.round(height)};
  return {width: maxWidth, height: Math.max(1, Math.round(height * maxWidth / width))};
}

/**
 * Compare the originals with the listing of the cache folder.
 * @param {object} options
 * @param {string} options.source       File source of the originals.
 * @param {string[]} options.originals  Paths of the originals that need a thumbnail.
 * @param {string[]} options.listed     Files found in the cache folder (paths or URLs).
 * @param {object} [options.spec]
 * @returns {{present: Map<string, string>, missing: string[], orphaned: string[]}}
 *   present: original path → listed thumbnail path; missing: originals without thumbnail;
 *   orphaned: listed thumbnails that belong to no original.
 */
export function planThumbnails({source, originals, listed, spec=THUMB_SPEC}) {
  const byStem = new Map();
  for ( const file of listed ) {
    const stem = stemOfListedFile(file);
    // Prefer WebP if both formats exist for the same stem.
    if ( stem && (!byStem.has(stem) || file.toLowerCase().endsWith(".webp")) ) byStem.set(stem, file);
  }
  const present = new Map();
  const missing = [];
  const used = new Set();
  for ( const path of new Set(originals) ) {
    const stem = thumbStem(source, path, spec);
    const file = byStem.get(stem);
    if ( file ) {
      present.set(path, file);
      used.add(stem);
    }
    else missing.push(path);
  }
  const orphaned = listed.filter(file => {
    const stem = stemOfListedFile(file);
    return stem && !used.has(stem);
  });
  return {present, missing, orphaned};
}
