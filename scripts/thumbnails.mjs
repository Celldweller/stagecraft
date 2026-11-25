/**
 * Thumbnail cache (GM only): small previews of the stage and card images as files in one cache folder.
 *
 * - Which thumbnails exist comes from one listing of the flat cache folder; nothing is stored in settings.
 * - Missing thumbnails are created in a module worker (see workers/thumbnail-worker.mjs) and uploaded with
 *   Foundry's FilePicker. At most CONCURRENCY originals are processed at a time.
 * - Not `ImageHelper.createThumbnail`: it loads every original as a full texture into Foundry's texture cache.
 *
 * Foundry-specific glue only; names, sizes and the comparison live in lib/thumb-key.mjs and are unit-tested.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { cardIndex, stageIndex } from "./media-index.mjs";
import { THUMB_SPEC, normalizeGeneration, planThumbnails, thumbFolder, thumbStem } from "./lib/thumb-key.mjs";

/** Originals processed at the same time. */
const CONCURRENCY = 2;

/** Hook fired on every change: `(status, change)` with `change = {path, url}` for a new thumbnail. */
export const THUMBNAILS_HOOK = `${MODULE_ID}.thumbnailsUpdated`;

/**
 * @typedef {object} ThumbnailStatus
 * @property {boolean} loaded     Whether the cache folder has been listed.
 * @property {boolean} running    Whether thumbnails are being created.
 * @property {number} done        Created in the current or last run.
 * @property {number} failed      Failed in the current or last run.
 * @property {number} total       To create in the current or last run.
 * @property {boolean} unavailable Uploading to the cache folder failed; tiles fall back to the originals.
 */

/** @type {Map<string, string>|null}  Original path → thumbnail URL; null until listed. */
let present = null;

/** @type {string[]}  Files in the cache folder: the listing plus everything uploaded since. */
let listedFiles = [];

/** @type {string[]}  Listed files that belong to no original (filled by `planCache`). */
let orphaned = [];

/** @type {Promise<void>|null} */
let listing = null;

/** @type {Promise<void>|null} */
let generating = null;

/** @type {Set<string>}  Originals whose thumbnail could not be created (e.g. a broken file). */
const failed = new Set();

/** Set when another run is requested while one is going on. */
let pending = false;

/** Incremented on invalidation; a run whose token is outdated stops. */
let runToken = 0;

/** @type {ThumbnailStatus} */
const status = {loaded: false, running: false, done: 0, failed: 0, total: 0, unavailable: false};

/**
 * Where thumbnails are stored. "auto" means The Forge's Asset Library on The Forge, otherwise the user data folder.
 * @returns {{source: string, root: string, folder: string}}
 */
export function thumbStore() {
  const onForge = Boolean(globalThis.ForgeVTT?.usingTheForge);
  const setting = String(getSetting("thumbSource") ?? "auto");
  const source = (setting === "auto") ? (onForge ? "forgevtt" : "data") : setting;
  const configured = String(getSetting("thumbRoot") ?? "").trim();
  const root = configured || ((source === "forgevtt") ? "modules/stagecraft/thumbs" : "stagecraft/thumbs");
  return {source, root, folder: thumbFolder(root, normalizeGeneration(getSetting("thumbGeneration")))};
}

/** @returns {ThumbnailStatus} A copy of the current status. */
export function getThumbnailStatus() {
  return {...status};
}

/**
 * What a tile shows for an original: its thumbnail, or null while the thumbnail is pending (the tile waits
 * instead of loading the large original). The original only when its thumbnail cannot be made.
 * @param {string} path
 * @returns {string|null}
 */
export function getTileImage(path) {
  const thumb = present?.get(path);
  if ( thumb ) return thumb;
  if ( status.unavailable || failed.has(path) ) return path;
  return null;
}

/** Forget the listing, e.g. after a settings change. A running generation stops after its current images. */
export function invalidateThumbnails() {
  runToken++;
  present = null;
  listedFiles = [];
  orphaned = [];
  listing = null;
  pending = false;
  failed.clear();
  Object.assign(status, {loaded: false, running: false, done: 0, failed: 0, total: 0, unavailable: false});
  Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), null);
}

/** Match the listing against the current index again, e.g. after a rescan. Does not touch the server. */
export function refreshThumbnailPlan() {
  if ( !present ) return;
  planCache();
  Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), null);
}

/**
 * List the cache folder once. Later calls return the same promise until `invalidateThumbnails`.
 * @returns {Promise<void>}
 */
export function loadThumbnails() {
  if ( !game.user.isGM ) return Promise.resolve();
  listing ??= listCache().catch(err => {
    listing = null;
    throw err;
  });
  return listing;
}

/**
 * Create the missing thumbnails in the background. Calls during a run schedule one more run afterwards,
 * which picks up images added in the meantime.
 * @returns {Promise<void>}
 */
export function requestThumbnails() {
  if ( !game.user.isGM ) return Promise.resolve();
  if ( generating ) {
    pending = true;
    return generating;
  }
  generating = (async () => {
    do {
      pending = false;
      await generateMissing();
    } while ( pending );
  })().catch(err => {
    console.error(`${MODULE_ID} | Thumbnail creation failed:`, err);
    ui.notifications.error(game.i18n.format("STAGECRAFT.Thumbs.Failed", {message: err.message}));
  }).finally(() => {
    generating = null;
  });
  return generating;
}

/**
 * @typedef {object} ThumbnailReport
 * @property {{source: string, root: string, folder: string}} store
 * @property {number} generation  Current numbered subfolder.
 * @property {boolean} hasIndex   Whether a stage or card index exists; without one nothing can be compared.
 * @property {number} originals   Images that need a thumbnail.
 * @property {number} present     Of those, with thumbnail.
 * @property {number} missing     Of those, without thumbnail (including failed ones).
 * @property {string[]} failed    Originals whose thumbnail could not be created.
 * @property {string[]} orphaned  Files in the cache folder that belong to no image.
 * @property {ThumbnailStatus} status
 */

/**
 * Counts and lists for the cache window. Synchronous: reflects the last listing (see `loadThumbnails`).
 * @returns {ThumbnailReport}
 */
export function getThumbnailReport() {
  const groups = originalGroups();
  const originals = [...new Set(groups.flatMap(g => g.paths))];
  const withThumb = originals.filter(path => present?.has(path)).length;
  const hasIndex = groups.length > 0;
  return {
    store: thumbStore(),
    generation: normalizeGeneration(getSetting("thumbGeneration")),
    hasIndex,
    originals: originals.length,
    present: withThumb,
    missing: originals.length - withThumb,
    failed: [...failed],
    orphaned: (hasIndex && present) ? [...orphaned] : [],
    status: getThumbnailStatus()
  };
}

/**
 * Create the missing thumbnails, trying failed images again. For the explicit button; tiles use `requestThumbnails`.
 * @returns {Promise<void>}
 */
export async function createMissingThumbnails() {
  if ( !game.user.isGM ) return;
  if ( !generating ) failed.clear();
  await loadThumbnails();
  return requestThumbnails();
}

/**
 * Recreate all thumbnails in the next numbered subfolder. Files cannot be deleted through Foundry,
 * so the previous folder stays and can be removed by hand.
 * @returns {Promise<void>}
 */
export async function regenerateThumbnails() {
  if ( !game.user.isGM ) return;
  const next = normalizeGeneration(normalizeGeneration(getSetting("thumbGeneration")) + 1);
  await setSetting("thumbGeneration", next); // onChange invalidates the listing
  await loadThumbnails();
  return requestThumbnails();
}

/**
 * Numbered subfolders of the cache root other than the current one: earlier generations nobody uses any more.
 * @returns {Promise<string[]>}
 */
export async function listOldThumbnailFolders() {
  if ( !game.user.isGM ) return [];
  const {source, root} = thumbStore();
  const current = String(normalizeGeneration(getSetting("thumbGeneration")));
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  let dirs;
  try {
    dirs = (await FilePicker.browse(source, root))?.dirs ?? [];
  } catch {
    return [];
  }
  return dirs.map(dir => dir.replace(/\/+$/, "")).filter(dir => {
    const name = dir.split("/").pop();
    return /^\d+$/.test(name) && (String(Number(name)) !== current);
  });
}

/* -------------------------------------------- */

/** Originals that need a thumbnail: the preferred file of every variant. */
function originalsOf(index) {
  return index.locations.flatMap(location => location.variants.map(v => v.preferred.path));
}

/**
 * Originals of the loaded indexes, grouped by file source (the source is part of the thumbnail name).
 * @returns {{source: string, paths: string[]}[]}
 */
function originalGroups() {
  return [stageIndex.get(), cardIndex.get()].filter(Boolean)
    .map(index => ({source: index.source, paths: originalsOf(index)}));
}

async function listCache() {
  const token = runToken;
  const {source, folder} = thumbStore();
  const files = await browseFiles(source, folder);
  if ( token !== runToken ) return;
  listedFiles = files;
  planCache();
  status.loaded = true;
  Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), null);
}

/** Files of a folder; an empty list if the folder does not exist yet. */
async function browseFiles(source, folder) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  try {
    const result = await FilePicker.browse(source, folder);
    return result?.files ?? [];
  } catch {
    return [];
  }
}

/**
 * Rebuild `present` and `orphaned` from the cache folder contents and the current indexes.
 * A listed file is orphaned only if it belongs to no image of any index.
 */
function planCache() {
  const groups = originalGroups();
  present = new Map();
  const orphanSets = [];
  for ( const {source, paths} of groups ) {
    const plan = planThumbnails({source, originals: paths, listed: listedFiles});
    for ( const [path, file] of plan.present ) present.set(path, file);
    orphanSets.push(new Set(plan.orphaned));
  }
  orphaned = groups.length ? listedFiles.filter(file => orphanSets.every(set => set.has(file))) : [];
}

/** Create each missing folder segment; `createDirectory` fails for folders that exist. */
async function ensureFolder(source, folder) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const parts = folder.split("/");
  for ( let i = 1; i <= parts.length; i++ ) {
    const target = parts.slice(0, i).join("/");
    try {
      await FilePicker.browse(source, target);
    } catch {
      await FilePicker.createDirectory(source, target);
    }
  }
}

async function generateMissing() {
  if ( !originalGroups().length ) return;
  await loadThumbnails();
  const token = runToken;
  planCache();
  const missing = originalGroups().flatMap(({source, paths}) => paths
    .filter(path => !present.has(path) && !failed.has(path))
    .map(path => ({source, path})));
  if ( !missing.length ) return;

  const store = thumbStore();
  await ensureFolder(store.source, store.folder);

  Object.assign(status, {running: true, done: 0, failed: 0, total: missing.length});
  Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), null);

  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const worker = new ThumbnailWorker();
  const started = performance.now();
  let sourceBytes = 0;
  let thumbBytes = 0;
  /** @type {Error|null} */
  let uploadError = null;
  const queue = [...missing];

  const runOne = async ({source, path}) => {
    try {
      const result = await worker.create(new URL(path, document.baseURI).href);
      if ( (token !== runToken) || uploadError ) return;
      const name = `${thumbStem(source, path)}.${result.ext}`;
      const file = new File([result.blob], name, {type: result.type});
      const response = await FilePicker.upload(store.source, store.folder, file, {}, {notify: false});
      if ( !response?.path ) {
        // Upload problems (permissions, storage) affect every file, so stop instead of failing each one.
        uploadError ??= new Error(response?.error ?? game.i18n.localize("STAGECRAFT.Thumbs.UploadFailed"));
        return;
      }
      if ( token !== runToken ) return;
      listedFiles.push(response.path);
      present.set(path, response.path);
      sourceBytes += result.sourceBytes;
      thumbBytes += result.blob.size;
      status.done++;
      Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), {path, url: response.path});
    } catch ( err ) {
      if ( token !== runToken ) return;
      failed.add(path);
      status.failed++;
      console.warn(`${MODULE_ID} | Thumbnail for ${path} failed: ${err.message}`);
      Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), {path, url: path});
    }
  };

  try {
    await Promise.all(Array.from({length: CONCURRENCY}, async () => {
      while ( queue.length && !uploadError && (token === runToken) ) await runOne(queue.shift());
    }));
  } finally {
    worker.terminate();
  }
  if ( token !== runToken ) return;

  status.running = false;
  if ( uploadError ) status.unavailable = true;
  Hooks.callAll(THUMBNAILS_HOOK, getThumbnailStatus(), null);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`${MODULE_ID} | Created ${status.done} thumbnails in ${seconds} s: `
    + `${(sourceBytes / 1048576).toFixed(1)} MB originals → ${(thumbBytes / 1024).toFixed(0)} KB thumbnails`
    + (status.done ? ` (${(thumbBytes / status.done / 1024).toFixed(1)} KB each)` : ""));
  if ( uploadError ) throw uploadError;
  if ( status.failed ) ui.notifications.warn(game.i18n.format("STAGECRAFT.Thumbs.SomeFailed", {count: status.failed}));
  else if ( status.done ) ui.notifications.info(game.i18n.format("STAGECRAFT.Thumbs.Created", {count: status.done}));
}

/** Request/response wrapper around the module worker. */
class ThumbnailWorker {
  #worker = new Worker(new URL("./workers/thumbnail-worker.mjs", import.meta.url), {type: "module"});
  #nextId = 0;
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  #requests = new Map();

  constructor() {
    this.#worker.addEventListener("message", event => {
      const {id, ok, error, ...result} = event.data ?? {};
      const request = this.#requests.get(id);
      if ( !request ) return;
      this.#requests.delete(id);
      if ( ok ) request.resolve(result);
      else request.reject(new Error(error));
    });
    this.#worker.addEventListener("error", event => {
      const err = new Error(event.message || "Thumbnail worker failed to load");
      for ( const request of this.#requests.values() ) request.reject(err);
      this.#requests.clear();
    });
  }

  /**
   * @param {string} url  Absolute URL of the original.
   * @returns {Promise<{blob: Blob, type: string, ext: string, width: number, height: number, sourceBytes: number}>}
   */
  create(url) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#requests.set(id, {resolve, reject});
      this.#worker.postMessage({id, url, width: THUMB_SPEC.width, quality: THUMB_SPEC.quality});
    });
  }

  terminate() {
    this.#worker.terminate();
    for ( const request of this.#requests.values() ) request.reject(new Error("Worker terminated"));
    this.#requests.clear();
  }
}
