/**
 * The stage scene: which scene it is, what it shows, and switching it to another image.
 *
 * This is the only place that reads or writes the scene background (v14 keeps it on the scene's level,
 * see plan section 8). Everything else asks `getStageSrc` or calls `switchStage`.
 *
 * Switching: the GM sends `preload` to the players viewing the stage scene, waits until all answered `preloaded`
 * (at most PRELOAD_TIMEOUT_MS, so a player with a slow connection does not hold up the others), then writes image
 * and size in one scene update, together with the lights and walls of the new variant's preset (light-presets.mjs),
 * so they change with the image. Whoever is still loading keeps the previous image until theirs is drawn
 * (stage-hold.mjs). Messages are checked against a
 * fixed schema; `preload` is only accepted from a GM, `preloaded` only from users the GM is waiting for.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { getStageIndex } from "./media-index.mjs";
import {
  DEFAULT_BAR_COLOR, PRELOAD_TIMEOUT_MS, SOCKET_EVENT, barColor, edgeColor, imageSize, normalizeHexColor,
  normalizeStageName, sanitizeStageColors, sanitizeStageNames, stageUpdateData, validateStageMessage, variantKey
} from "./lib/stage.mjs";
import { LOCK_VIEW_ID, lockViewConflicts } from "./lib/lock-view.mjs";
import { presetFor } from "./light-presets.mjs";

/** Hook fired when the stage scene setting changed, or the stage scene was updated, activated or deleted. */
export const STAGE_SCENE_HOOK = `${MODULE_ID}.stageSceneUpdated`;

/** Hook fired while a switch runs and when it ends: `(path|null)`. */
export const STAGE_SWITCH_HOOK = `${MODULE_ID}.stageSwitching`;

/** Hook fired after the stage names changed (any GM). */
export const STAGE_NAMES_HOOK = `${MODULE_ID}.stageNamesUpdated`;

/** @type {Record<string, string>|null}  Sanitised copy of the stage names; null until first read. */
let namesCache = null;

/** @type {Record<string, string>|null}  Sanitised copy of the bar colour overrides; null until first read. */
let colorsCache = null;

/** Width of the copy the edge colour is sampled from; the outer ring of it stands for the image edges. */
const EDGE_SAMPLE_WIDTH = 32;

/** @type {Map<string, {waiting: Set<string>, resolve: () => void}>}  Open preload requests of this GM. */
const pending = new Map();

/** Counter of switch requests; only the latest one writes the scene. */
let latestSwitch = 0;

/** Path of the switch in progress, or null. */
let switching = null;

/** @returns {Scene|null}  The configured stage scene, if it still exists. */
export function getStageScene() {
  const id = String(getSetting("stageScene") ?? "");
  return (id && game.scenes.get(id)) || null;
}

/**
 * Whether this client views a scene other than the stage scene. False without a stage scene, and without a viewed
 * scene (canvas disabled in the client settings, or no scene active): then nothing is held back.
 * @returns {boolean}
 */
export function viewsOtherScene() {
  // The stored id, not the document: no need for the scene to be readable on this client.
  const stageId = String(getSetting("stageScene") ?? "");
  const viewed = game.scenes.viewed;
  return Boolean(stageId && viewed && (viewed.id !== stageId));
}

/** @returns {string|null}  Path of the switch in progress. */
export function getSwitchingPath() {
  return switching;
}

/**
 * The level that shows the stage image.
 * @param {Scene} scene
 * @returns {foundry.documents.Level|null}
 */
function stageLevel(scene) {
  return scene.initialLevel ?? null;
}

/**
 * Image the stage scene currently shows.
 * @param {Scene|null} [scene]
 * @returns {string|null}
 */
export function getStageSrc(scene=getStageScene()) {
  if ( !scene ) return null;
  return stageLevel(scene)?.background?.src || null;
}

/**
 * Image and bar colour of the stage scene's background.
 * @param {Scene|null} [scene]
 * @returns {{src: string|null, color: string|null}}
 */
export function getStageBackground(scene=getStageScene()) {
  const background = scene ? stageLevel(scene)?.background : null;
  const color = background?.color;
  return {src: background?.src || null, color: (color === null) || (color === undefined)
    ? null : foundry.utils.Color.from(color).css};
}

/**
 * What the stage scene shows, resolved against the index: the image, its location and the variant's button path.
 * @returns {{src: string, locationKey: string|null, variantPath: string|null}|null}
 */
export function getCurrentStage() {
  const src = getStageSrc();
  if ( !src ) return null;
  const index = getStageIndex();
  const entry = index?.entries.find(e => e.path === src);
  if ( !entry ) return {src, locationKey: null, variantPath: null};
  const location = index.locations.find(l => l.key === entry.locationKey);
  const variant = location?.variants.find(v => v.files.some(f => f.path === src));
  return {src, locationKey: entry.locationKey, variantPath: variant?.preferred.path ?? null};
}

/* -------------------------------------------- */
/*  Lock View                                   */
/* -------------------------------------------- */

/** @returns {boolean}  Whether the Lock View module is active in this world. */
export function isLockViewActive() {
  return Boolean(game.modules.get(LOCK_VIEW_ID)?.active);
}

/**
 * Lock View settings of the stage scene that fight Stagecraft's view lock. Empty while Lock View is inactive,
 * because its flags then have no effect.
 * @param {Scene|null} [scene]
 * @returns {string[]}
 */
export function getLockViewConflicts(scene=getStageScene()) {
  if ( !scene || !isLockViewActive() ) return [];
  return lockViewConflicts(scene.flags);
}

/**
 * Remove Lock View's view settings (locks, autoscale, forced initial view) from the stage scene,
 * so Lock View falls back to its defaults there. GM only; the caller asks for confirmation.
 */
export async function resetLockView() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const scene = getStageScene();
  if ( !scene ) return;
  await scene.update({flags: {[LOCK_VIEW_ID]: {locks: _del, autoscale: _del, forceInitialView: _del}}});
}

/* -------------------------------------------- */
/*  Stage names                                 */
/* -------------------------------------------- */

/** @returns {Record<string, string>}  Stage names by location key. Do not modify; use `setStageName`. */
export function getStageNames() {
  namesCache ??= sanitizeStageNames(getSetting("stageNames"));
  return namesCache;
}

/**
 * Navigation name of the stage scene while it shows a location: its stage name, or the neutral default.
 * File names never reach the players this way.
 * @param {string|null} locationKey
 * @returns {string}
 */
export function navNameFor(locationKey) {
  return (locationKey && getStageNames()[locationKey]) || game.i18n.localize("STAGECRAFT.Stage.DefaultNavName");
}

/**
 * Set or clear (empty name) the stage name of one or several locations, in one setting write. GM only. If the stage
 * scene shows one of them, its navigation name changes at once.
 * @param {string|string[]} locationKeys
 * @param {string} value
 */
export async function setStageName(locationKeys, value) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const keys = [locationKeys].flat().filter(k => typeof k === "string" && k);
  if ( !keys.length ) return;
  const name = normalizeStageName(value);
  const next = Object.assign(Object.create(null), getStageNames());
  for ( const key of keys ) {
    if ( name ) next[key] = name;
    else delete next[key];
  }
  await setSetting("stageNames", next);
  const scene = getStageScene();
  if ( scene && keys.includes(getCurrentStage()?.locationKey) ) {
    await scene.update({navName: name ?? game.i18n.localize("STAGECRAFT.Stage.DefaultNavName")});
  }
}

/* -------------------------------------------- */
/*  Bar colours                                 */
/* -------------------------------------------- */

/** @returns {Record<string, string>}  Bar colour overrides by variant key. Do not modify; use `setStageColors`. */
export function getStageColors() {
  colorsCache ??= sanitizeStageColors(getSetting("stageColors"));
  return colorsCache;
}

/**
 * Set or clear (null) bar colour overrides. GM only. If the stage shows one of these variants, its bars change
 * at once (a cleared override falls back to the automatic colour).
 * @param {Record<string, string|null>} changes  Variant key → "#rrggbb" or null.
 */
export async function setStageColors(changes) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const next = Object.assign(Object.create(null), getStageColors());
  let changed = false;
  for ( const [key, value] of Object.entries(changes) ) {
    const color = normalizeHexColor(value);
    if ( (next[key] ?? null) === color ) continue;
    changed = true;
    if ( color ) next[key] = color;
    else delete next[key];
  }
  if ( !changed ) return;
  await setSetting("stageColors", next);
  colorsCache = null;
  const scene = getStageScene();
  const entry = currentEntry();
  if ( !scene || !entry || !(variantKey(entry.locationKey, entry.variant) in changes) ) return;
  const level = stageLevel(scene);
  if ( !level ) return;
  const override = getStageColors()[variantKey(entry.locationKey, entry.variant)];
  const color = override ?? colorFor(entry, (await readImage(entry.path)).color);
  await scene.update({levels: [{_id: level.id, background: {color}}]});
}

/** Setting onChange: drop the cache. */
export function onStageColorsChanged() {
  colorsCache = null;
}

/**
 * Bar colour of a variant: the GM's override, else the image's darkened edge colour, else black.
 * @param {{locationKey: string, variant: string|null}} entry
 * @param {string|null} autoColor
 * @returns {string}
 */
function colorFor(entry, autoColor) {
  return getStageColors()[variantKey(entry.locationKey, entry.variant)] ?? autoColor ?? DEFAULT_BAR_COLOR;
}

/** @returns {import("./lib/filenames.mjs").StageEntry|null}  Index entry of the image on stage. */
export function currentEntry() {
  const src = getStageSrc();
  return (src && getStageIndex()?.entries.find(e => e.path === src)) || null;
}

/* -------------------------------------------- */

/** Setting onChange: drop the cache and tell the UI. */
export function onStageNamesChanged() {
  namesCache = null;
  Hooks.callAll(STAGE_NAMES_HOOK);
}

/* -------------------------------------------- */

/**
 * Create a new stage scene and make it the configured one. GM only.
 * Black, without grid, padding, token vision and fog, so only the image shows.
 * @returns {Promise<Scene>}
 */
export async function createStageScene() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const scene = await Scene.implementation.create({
    name: game.i18n.localize("STAGECRAFT.StageScene.DefaultName"),
    navName: game.i18n.localize("STAGECRAFT.Stage.DefaultNavName"),
    width: 1920,
    height: 1080,
    padding: 0,
    backgroundColor: "#000000",
    grid: {type: CONST.GRID_TYPES.GRIDLESS},
    tokenVision: false,
    fog: {mode: CONST.FOG_EXPLORATION_MODES.DISABLED}
  });
  await setSetting("stageScene", scene.id);
  return scene;
}

/**
 * Load an image in the browser (no canvas texture) and read its size and bar colour.
 * @param {string} src
 * @returns {Promise<{size: {width: number, height: number}, color: string|null}>}
 */
async function readImage(src) {
  const img = await decodeImage(src);
  const size = imageSize(img.naturalWidth, img.naturalHeight);
  if ( !size ) throw new Error(game.i18n.format("STAGECRAFT.Stage.Errors.Unreadable", {src}));
  return {size, color: await autoBarColor(img, src)};
}

/**
 * @param {string} src
 * @param {{crossOrigin?: boolean}} [options]
 * @returns {Promise<HTMLImageElement>}
 */
async function decodeImage(src, {crossOrigin=false}={}) {
  const img = new Image();
  img.decoding = "async";
  if ( crossOrigin ) img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

/**
 * Darkened average colour of the image edges. Pixels can only be read from same-origin images, or from images
 * served with CORS headers (e.g. a separate asset host); otherwise the colour stays unknown (null).
 * @param {HTMLImageElement} img
 * @param {string} src
 * @returns {Promise<string|null>}
 */
async function autoBarColor(img, src) {
  try {
    let source = img;
    if ( new URL(src, window.location.href).origin !== window.location.origin ) {
      source = await decodeImage(src, {crossOrigin: true});
    }
    const width = EDGE_SAMPLE_WIDTH;
    const height = Math.max(1, Math.round(width * source.naturalHeight / source.naturalWidth));
    const context = new OffscreenCanvas(width, height).getContext("2d", {willReadFrequently: true});
    context.drawImage(source, 0, 0, width, height);
    const rgb = edgeColor(context.getImageData(0, 0, width, height).data, width, height);
    return rgb ? barColor(rgb) : null;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | Bar colour of ${src} could not be read; using the default.`, err);
    return null;
  }
}

/**
 * Ask the players who view the stage scene to load the image, and wait for their answers (at most the timeout).
 * @param {Scene} scene
 * @param {string} src
 * @returns {Promise<void>}
 */
function preloadForPlayers(scene, src) {
  const viewers = game.users.filter(u => u.active && !u.isSelf && (u.viewedScene === scene.id)).map(u => u.id);
  if ( !viewers.length ) return Promise.resolve();
  const id = foundry.utils.randomID();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      pending.delete(id);
      resolve();
    };
    const timer = setTimeout(() => {
      const missing = pending.get(id)?.waiting.size ?? 0;
      if ( missing ) {
        console.info(`${MODULE_ID} | ${missing} player(s) still loading after ${PRELOAD_TIMEOUT_MS} ms; `
          + "they keep the previous image until the new one is drawn.");
      }
      done();
    }, PRELOAD_TIMEOUT_MS);
    pending.set(id, {waiting: new Set(viewers), resolve: done});
    game.socket.emit(SOCKET_EVENT, {type: "preload", id, src}, {recipients: viewers});
  });
}

/**
 * Show another image on the stage scene. GM only; the path must come from the stage index.
 * If the scene is not active, only its image changes; activating it stays the GM's decision.
 * @param {string} path
 * @param {object} [options]
 * @param {boolean} [options.endDialog]  Hide the shown cards with the switch (card-layer.mjs listens to the
 *   `stageSelected` hook). Default: the setting "cardsOnStageSwitch" is "end"; "ask" is the stage browser's job.
 * @returns {Promise<boolean>}  Whether this request changed the scene (a newer click supersedes it).
 */
export async function switchStage(path, {endDialog}={}) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const entry = getStageIndex()?.entries.find(e => e.path === path);
  if ( !entry ) throw new Error(game.i18n.localize("STAGECRAFT.Stage.Errors.NotIndexed"));
  const scene = getStageScene();
  if ( !scene ) throw new Error(game.i18n.localize("STAGECRAFT.Stage.Errors.NoScene"));
  const level = stageLevel(scene);
  if ( !level ) throw new Error(game.i18n.localize("STAGECRAFT.Stage.Errors.NoLevel"));
  if ( getStageSrc(scene) === path ) return false;

  const request = ++latestSwitch;
  switching = path;
  Hooks.callAll(STAGE_SWITCH_HOOK, path);
  const started = performance.now();
  const took = promise => promise.then(value => ({value, ms: Math.round(performance.now() - started)}));
  try {
    const viewing = canvas.scene?.id === scene.id;
    const [image, players, own] = await Promise.all([
      took(readImage(path)),
      took(preloadForPlayers(scene, path)),
      // The GM's own canvas, if it shows the stage: load the texture before the redraw.
      took(viewing ? foundry.canvas.loadTexture(path) : Promise.resolve(null))
    ]);
    console.log(`${MODULE_ID} | Stage switch prepared in ${Math.round(performance.now() - started)} ms `
      + `(image size and colour ${image.ms} ms, players ${players.ms} ms, `
      + `own texture ${viewing ? `${own.ms} ms` : "not needed"})`);
    if ( request !== latestSwitch ) return false;
    const navName = navNameFor(entry.locationKey);
    const color = colorFor(entry, image.value.color);
    // Lights and walls of the stage scene are replaced as a whole: the new variant's preset, or none.
    const {lights, walls} = presetFor(entry, scene, image.value.size, level.id);
    const {ForcedReplacement} = foundry.data.operators;
    await scene.update({
      ...stageUpdateData({levelId: level.id, src: path, ...image.value.size, navName, color}),
      lights: ForcedReplacement.create(lights),
      walls: ForcedReplacement.create(walls)
    });
    console.log(`${MODULE_ID} | Stage scene updated after ${Math.round(performance.now() - started)} ms`);
    endDialog ??= getSetting("cardsOnStageSwitch") === "end";
    Hooks.callAll(`${MODULE_ID}.stageSelected`, path, {endDialog});
    return true;
  } finally {
    if ( request === latestSwitch ) {
      switching = null;
      Hooks.callAll(STAGE_SWITCH_HOOK, null);
    }
  }
}

/**
 * Handle a socket message. Players load images on request; the GM collects the answers.
 * @param {unknown} data
 * @param {string} senderId  Set by the server from the sender's session; cannot be forged.
 */
async function onSocketMessage(data, senderId) {
  const message = validateStageMessage(data);
  if ( !message ) return;
  const sender = game.users.get(senderId);
  if ( message.type === "preload" ) {
    if ( !sender?.isGM ) return;
    const texture = await foundry.canvas.loadTexture(message.src);
    game.socket.emit(SOCKET_EVENT, {type: "preloaded", id: message.id, ok: Boolean(texture)}, {recipients: [senderId]});
    return;
  }
  // "preloaded": only the GM that asked is waiting for it.
  const request = pending.get(message.id);
  if ( !request || !request.waiting.delete(senderId) ) return;
  if ( !request.waiting.size ) request.resolve();
}

/** Listen to the module socket and to changes of the stage scene. Call once in the `ready` hook. */
export function registerStageScene() {
  game.socket.on(SOCKET_EVENT, onSocketMessage);
  const relevant = scene => scene?.id === String(getSetting("stageScene") ?? "");
  Hooks.on("updateScene", scene => {
    if ( relevant(scene) ) Hooks.callAll(STAGE_SCENE_HOOK);
  });
  Hooks.on("updateLevel", level => {
    if ( relevant(level.parent) ) Hooks.callAll(STAGE_SCENE_HOOK);
  });
  Hooks.on("deleteScene", scene => {
    if ( relevant(scene) ) Hooks.callAll(STAGE_SCENE_HOOK);
  });
}

/** Setting onChange: tell the UI. */
export function onStageSceneChanged() {
  Hooks.callAll(STAGE_SCENE_HOOK);
}
