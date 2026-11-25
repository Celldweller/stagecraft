/**
 * Light presets: the GM places lights, and walls to limit them, on the stage and saves them for the
 * variant on show; a switch to a variant replaces the lights and walls of the stage scene with that variant's preset
 * (in the same scene update as the image, see stage-scene.mjs), or removes them if it has none. Only the GM reads
 * the presets; players get the lights and walls as part of the scene.
 *
 * Callers pass the stage scene and the index entry of the image on show, so this module needs no import of
 * stage-scene.mjs (which imports this one).
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { variantKey } from "./lib/stage.mjs";
import {
  MAX_PRESET_LIGHTS, MAX_PRESET_WALLS, fromPresetLight, fromPresetWall, sameItems, sanitizeLightPresets,
  toPresetLight, toPresetWall
} from "./lib/lights.mjs";

/** Hook fired when the lights or walls of the stage scene or the stored presets changed. */
export const PRESET_HOOK = `${MODULE_ID}.presetsUpdated`;

/**
 * What a preset holds, per embedded collection: the document name, the fields that are not part of a preset
 * (id, the level it is placed on, and for walls the door: walls in a preset only limit the lights, a door would
 * show players a door icon), the fields always kept, and the conversion to and from the stored form.
 */
const KINDS = Object.freeze({
  lights: {documentName: "AmbientLight", drop: ["_id", "levels"], keep: ["x", "y"],
    toPreset: toPresetLight, fromPreset: fromPresetLight},
  walls: {documentName: "Wall", drop: ["_id", "levels", "door", "ds", "doorSound", "animation"], keep: ["c"],
    toPreset: toPresetWall, fromPreset: fromPresetWall}
});

/** @type {Record<string, import("./lib/lights.mjs").Preset>|null}  Sanitised presets; null until first read. */
let presetsCache = null;

/** @type {Record<string, object>}  A document of each kind with Foundry's defaults, to leave them out. */
const defaults = {};

/** @returns {Record<string, import("./lib/lights.mjs").Preset>}  Presets by variant key. Do not modify. */
export function getLightPresets() {
  presetsCache ??= sanitizeLightPresets(getSetting("lightPresets"));
  return presetsCache;
}

/**
 * Preset key of an index entry: its location and variant, so the preset stays when the file changes its format
 * or size suffix.
 * @param {{locationKey: string, variant: string|null}} entry
 */
export function presetKey(entry) {
  return variantKey(entry.locationKey, entry.variant);
}

/**
 * The image the lights and walls of a scene stand on.
 * @param {Scene} scene
 * @param {{width: number, height: number}} [size]  Another image size (the one being switched to).
 * @returns {import("./lib/lights.mjs").LightFrame}
 */
function frameOf(scene, size) {
  return {width: size?.width ?? scene.width, height: size?.height ?? scene.height,
    unit: scene.dimensions.distancePixels};
}

/**
 * A light or wall of the scene without its defaults and the fields not part of a preset.
 * @param {"lights"|"walls"} kind
 * @param {foundry.abstract.Document} doc
 */
function itemData(kind, doc) {
  const {documentName, drop, keep} = KINDS[kind];
  defaults[kind] ??= new (CONFIG[documentName].documentClass)(kind === "walls" ? {c: [0, 0, 0, 0]} : {}).toObject();
  const data = doc.toObject();
  const diff = foundry.utils.diffObject(defaults[kind], data);
  for ( const field of drop ) delete diff[field];
  for ( const field of keep ) diff[field] = data[field];
  return diff;
}

/**
 * The lights and walls of a scene, as data without defaults.
 * @param {Scene} scene
 * @returns {{lights: object[], walls: object[]}}
 */
function sceneItems(scene) {
  return {lights: scene.lights.map(l => itemData("lights", l)), walls: scene.walls.map(w => itemData("walls", w))};
}

/**
 * The preset of an entry as data for the scene, placed on its level. Items Foundry no longer accepts (e.g. after
 * a change of its data model) are left out, so the switch still works.
 * @param {{locationKey: string, variant: string|null}|null} entry
 * @param {Scene} scene
 * @param {{width: number, height: number}} size  Size of the entry's image.
 * @param {string} levelId
 * @returns {{lights: object[], walls: object[]}}
 */
export function presetFor(entry, scene, size, levelId) {
  const preset = entry ? getLightPresets()[presetKey(entry)] : null;
  const frame = frameOf(scene, size);
  const result = {};
  for ( const [kind, {documentName, fromPreset}] of Object.entries(KINDS) ) {
    const cls = CONFIG[documentName].documentClass;
    const items = (preset?.[kind] ?? []).map(item => ({...fromPreset(item, frame), levels: [levelId]}));
    result[kind] = items.filter(data => {
      try {
        new cls(data, {strict: true});
        return true;
      } catch ( err ) {
        console.warn(`${MODULE_ID} | An item of the preset ${presetKey(entry)} is invalid and left out.`, err);
        return false;
      }
    });
  }
  return result;
}

/**
 * Whether the lights and walls on the stage differ from the preset of the image on show (or the stage has some
 * but the image is not in the index, so they cannot be saved).
 * @param {Scene|null} scene
 * @param {{locationKey: string, variant: string|null}|null} entry
 * @returns {boolean}
 */
export function hasUnsavedPreset(scene, entry) {
  if ( !scene ) return false;
  const current = sceneItems(scene);
  if ( !entry ) return (current.lights.length + current.walls.length) > 0;
  const frame = frameOf(scene);
  const preset = getLightPresets()[presetKey(entry)];
  return Object.entries(KINDS).some(([kind, {fromPreset}]) => !sameItems(current[kind],
    (preset?.[kind] ?? []).map(item => fromPreset(item, frame))));
}

/**
 * Save the lights and walls on the stage as the preset of the image on show; without any, its preset is removed.
 * GM only.
 * @param {Scene|null} scene
 * @param {{locationKey: string, variant: string|null}|null} entry
 * @returns {Promise<{lights: number, walls: number}>}  What was saved.
 */
export async function savePreset(scene, entry) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  if ( !scene ) throw new Error(game.i18n.localize("STAGECRAFT.Stage.Errors.NoScene"));
  if ( !entry ) throw new Error(game.i18n.localize("STAGECRAFT.Lights.NoStage"));
  if ( (scene.lights.size > MAX_PRESET_LIGHTS) || (scene.walls.size > MAX_PRESET_WALLS) ) {
    throw new Error(game.i18n.format("STAGECRAFT.Lights.TooMany",
      {lights: MAX_PRESET_LIGHTS, walls: MAX_PRESET_WALLS}));
  }
  const frame = frameOf(scene);
  const current = sceneItems(scene);
  const preset = {
    lights: current.lights.map(l => KINDS.lights.toPreset(l, frame)),
    walls: current.walls.map(w => KINDS.walls.toPreset(w, frame))
  };
  const key = presetKey(entry);
  const next = Object.assign(Object.create(null), getLightPresets());
  if ( preset.lights.length || preset.walls.length ) next[key] = preset;
  else if ( key in next ) delete next[key];
  else return {lights: 0, walls: 0};
  await setSetting("lightPresets", next);
  presetsCache = null;
  return {lights: preset.lights.length, walls: preset.walls.length};
}

/** Setting onChange: drop the cache and tell the UI. */
export function onLightPresetsChanged() {
  presetsCache = null;
  Hooks.callAll(PRESET_HOOK);
}

/**
 * Tell the UI about changes of lights and walls on the stage scene. Call once in the `ready` hook.
 * @param {() => Scene|null} stageScene
 */
export function registerLightPresets(stageScene) {
  for ( const action of ["create", "update", "delete"] ) {
    for ( const {documentName} of Object.values(KINDS) ) {
      Hooks.on(`${action}${documentName}`, doc => {
        if ( doc.parent && (doc.parent === stageScene()) ) Hooks.callAll(PRESET_HOOK);
      });
    }
  }
}
