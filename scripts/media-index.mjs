/**
 * The image indexes: all images below the configured stage folder and below the card folder, each grouped into
 * locations (for cards: persons) and variants with the same variant pattern.
 *
 * Foundry-specific glue only; the logic lives in scripts/lib/ and is unit-tested there.
 * Each list of paths is cached in the GM's browser (client setting). Players never scan or load it.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import {
  compileVariantPattern, parseStagePath, parseVariantSetting, groupByLocation
} from "./lib/filenames.mjs";
import { scanFolder } from "./lib/scan.mjs";
import { buildIndexCache, validateIndexCache } from "./lib/index-cache.mjs";

/**
 * @typedef {object} MediaIndexData
 * @property {"stages"|"cards"} kind
 * @property {string} source
 * @property {string} root
 * @property {import("./lib/filenames.mjs").StageEntry[]} entries
 * @property {import("./lib/filenames.mjs").StageLocation[]} locations  Stages: locations; cards: one per person.
 * @property {number} scannedAt          Timestamp of the scan the paths come from (ms since epoch).
 * @property {"scan"|"cache"} origin     Whether this index was just scanned or restored from the cache.
 * @property {{dir: string, message: string}[]} errors   Scan errors (empty for a restored index).
 * @property {boolean} truncated
 */

/** @typedef {MediaIndexData} StageIndex */

/** One index: its settings, its cache and its hook. */
class MediaIndex {
  /**
   * @param {object} config
   * @param {"stages"|"cards"} config.kind
   * @param {string} config.sourceKey      Setting key of the file source.
   * @param {string} config.rootKey        Setting key of the folder.
   * @param {string} config.cacheKey       Setting key of the browser cache.
   * @param {string} config.hook           Hook fired after every change: `(index|null)`.
   * @param {string} config.noRootError    Localization key of the error without a folder.
   * @param {() => (path: string) => import("./lib/filenames.mjs").StageEntry} config.parser
   */
  constructor(config) {
    this.config = config;
  }

  /** @type {MediaIndexData|null} */
  #current = null;

  /** @type {Promise<MediaIndexData>|null} */
  #running = null;

  get hook() {
    return this.config.hook;
  }

  /**
   * The current index. Restores it from the browser cache on first use, without scanning.
   * Returns null if nothing is cached or the cache does not fit the current world and settings.
   * @returns {MediaIndexData|null}
   */
  get() {
    if ( !this.#current && game.user.isGM ) this.#current = this.#restore();
    return this.#current;
  }

  /** Drop the in-memory index, e.g. after a settings change. The next `get` re-reads the cache. */
  invalidate() {
    this.#current = null;
    Hooks.callAll(this.config.hook, null);
  }

  /**
   * Scan the folder, replace the index and update the cache. Concurrent calls share one scan. GM only.
   * @returns {Promise<MediaIndexData>}
   */
  rescan() {
    if ( !game.user.isGM ) return Promise.reject(new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly")));
    this.#running ??= this.#scanAndStore().finally(() => { this.#running = null; });
    return this.#running;
  }

  /** @returns {{source: string, root: string}} */
  location() {
    return {
      source: String(getSetting(this.config.sourceKey)),
      root: String(getSetting(this.config.rootKey) ?? "").trim()
    };
  }

  /**
   * @param {string[]} files
   * @param {Omit<MediaIndexData, "kind"|"entries"|"locations">} meta
   * @returns {MediaIndexData}
   */
  #build(files, meta) {
    const parse = this.config.parser();
    const entries = files.map(path => parse(path));
    return {kind: this.config.kind, ...meta, entries, locations: groupByLocation(entries)};
  }

  /** @returns {MediaIndexData|null} */
  #restore() {
    const {source, root} = this.location();
    if ( !root ) return null;
    const result = validateIndexCache(getSetting(this.config.cacheKey), {worldId: game.world.id, source, root});
    if ( !result.ok ) {
      if ( result.reason !== "Empty" ) {
        console.log(`${MODULE_ID} | ${this.config.kind} index cache not used: ${result.reason}`);
      }
      return null;
    }
    const {files, scannedAt} = result.cache;
    return this.#build(files, {source, root, scannedAt, origin: "cache", errors: [], truncated: false});
  }

  /** @returns {Promise<MediaIndexData>} */
  async #scanAndStore() {
    const {source, root} = this.location();
    // Without a configured folder the scan would cover the whole storage root (all systems, modules, worlds).
    if ( !root ) throw new Error(game.i18n.localize(this.config.noRootError));

    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const started = performance.now();
    const scan = await scanFolder({
      browse: (src, target, options) => FilePicker.browse(src, target, options),
      source,
      root,
      extensions: Object.keys(CONST.IMAGE_FILE_EXTENSIONS)
    });
    const scannedAt = Date.now();
    const index = this.#build(scan.files, {
      source, root, scannedAt, origin: "scan", errors: scan.errors, truncated: scan.truncated
    });
    const durationMs = Math.round(performance.now() - started);

    this.#current = index;
    await setSetting(this.config.cacheKey, buildIndexCache({worldId: game.world.id, source, root, scannedAt,
      files: scan.files}));

    console.log(`${MODULE_ID} | Indexed ${index.entries.length} ${this.config.kind} images `
      + `(${scan.dirsVisited} folders, ${durationMs} ms)`);
    if ( scan.errors.length ) console.warn(`${MODULE_ID} | Folders that could not be read:`, scan.errors);
    if ( scan.truncated ) console.warn(`${MODULE_ID} | Scan stopped early at a limit; not all images are indexed.`);
    Hooks.callAll(this.config.hook, index);
    return index;
  }
}

/** @returns {RegExp|undefined}  The configured pattern; undefined (= default) if the stored value is invalid. */
function variantPattern() {
  const compiled = compileVariantPattern(parseVariantSetting(getSetting("variantPattern")));
  return compiled.ok ? compiled.regex : undefined;
}

/** Parser with the configured variant pattern, for stages and cards alike. */
function variantParser() {
  const pattern = variantPattern();
  return path => parseStagePath(path, {pattern});
}

/**
 * Location key of an image path, with the configured variant pattern. Needs no index, so players can use it too
 * (the variant pattern is a world setting).
 * @param {string} path
 * @returns {string}
 */
export function locationKeyOf(path) {
  return variantParser()(path).locationKey;
}

/**
 * An image path parsed with the configured variant pattern (location, variant, name). Needs no index.
 * @param {string} path
 * @returns {import("./lib/filenames.mjs").StageEntry}
 */
export function parseMediaPath(path) {
  return variantParser()(path);
}

export const stageIndex = new MediaIndex({
  kind: "stages",
  sourceKey: "stageSource",
  rootKey: "stageRoot",
  cacheKey: "stageIndexCache",
  hook: `${MODULE_ID}.stageIndexUpdated`,
  noRootError: "STAGECRAFT.Errors.NoStageRoot",
  parser: variantParser
});

export const cardIndex = new MediaIndex({
  kind: "cards",
  sourceKey: "cardSource",
  rootKey: "cardRoot",
  cacheKey: "cardIndexCache",
  hook: `${MODULE_ID}.cardIndexUpdated`,
  noRootError: "STAGECRAFT.Errors.NoCardRoot",
  parser: variantParser
});

/** @param {"stages"|"cards"} kind */
export function indexOf(kind) {
  return (kind === "cards") ? cardIndex : stageIndex;
}

/** @returns {MediaIndexData|null} */
export function getStageIndex() {
  return stageIndex.get();
}

export function invalidateStageIndex() {
  stageIndex.invalidate();
}

/** @returns {Promise<MediaIndexData>} */
export function rescanStages() {
  return stageIndex.rescan();
}

/** @returns {MediaIndexData|null} */
export function getCardIndex() {
  return cardIndex.get();
}

/** @returns {Promise<MediaIndexData>} */
export function rescanCards() {
  return cardIndex.rescan();
}

/**
 * Entries of both indexes that are loaded, e.g. to match tags or thumbnails against all known files.
 * @returns {import("./lib/filenames.mjs").StageEntry[]}
 */
export function allIndexedEntries() {
  return [...(stageIndex.get()?.entries ?? []), ...(cardIndex.get()?.entries ?? [])];
}
