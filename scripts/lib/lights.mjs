/**
 * Pure helpers for the light presets: one preset per stage variant with the lights and walls of the stage
 * scene, positions and distances relative to the image, so a torch stays on its wall whatever size the image has.
 * Walls are there to limit the lights.
 *
 * Stored (world setting "lightPresets"): `{[variantKey]: {lights: PresetLight[], walls: PresetWall[]}}`. Earlier
 * presets were a plain list of lights; they are read as presets without walls. Each light and wall holds only what
 * differs from Foundry's defaults (the caller computes that difference), plus:
 * - lights: `x` and `y` as a share of the image width and height, `config.bright`/`config.dim` as a share of the
 *   image width;
 * - walls: `c` (both end points) as shares of width and height, `threshold.light`/`.sight`/`.sound` as a share of
 *   the image width.
 * A variant without lights and walls has no entry.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */

/** At most this many lights per preset. */
export const MAX_PRESET_LIGHTS = 50;

/** At most this many walls per preset (a room outline needs a few dozen). */
export const MAX_PRESET_WALLS = 200;

/** At most this many presets; far more than stages with lights are expected. */
const MAX_PRESETS = 5000;

/** Longest accepted variant key (as for the other per-stage settings). */
const MAX_KEY_LENGTH = 1024;

/** Largest accepted light or wall in the stored JSON; a light with its defaults left out is around 150 bytes. */
const MAX_ITEM_JSON = 8192;

/** Deepest accepted nesting inside a light or wall (config.animation.* is depth 3; flags may go deeper). */
const MAX_DEPTH = 8;

/** Relative positions may lie a little outside the image (a light just beyond the edge). */
const POSITION_RANGE = Object.freeze({min: -1, max: 2});

/** Decimals of the stored shares: 5 decimals are 0.03 px on a 6000 px image. */
const SHARE_DECIMALS = 5;

/** Decimals of distances in distance units, as Foundry's forms step them (0.01). */
const DISTANCE_DECIMALS = 2;

/** Light fields taken over from a stored preset; everything else is dropped. */
const LIGHT_FIELDS = Object.freeze({
  name: "string", x: "number", y: "number", elevation: "number", rotation: "number",
  walls: "boolean", vision: "boolean", hidden: "boolean", locked: "boolean", config: "object", flags: "object"
});

/**
 * Wall fields taken over from a stored preset. No door fields: a door would show players a door icon they could
 * open; walls in a preset only limit the lights.
 */
const WALL_FIELDS = Object.freeze({
  c: "array", light: "number", move: "number", sight: "number", sound: "number", dir: "number",
  threshold: "object", flags: "object"
});

/** Distances that scale with the image: light radii in `config`, wall thresholds in `threshold`. */
const LIGHT_DISTANCES = Object.freeze(["bright", "dim"]);
const WALL_DISTANCES = Object.freeze(["light", "sight", "sound"]);

/**
 * @typedef {object} LightFrame  The image the lights and walls stand on.
 * @property {number} width   Image width in pixels (the stage scene has no padding).
 * @property {number} height  Image height in pixels.
 * @property {number} unit    Pixels per distance unit (the scene's grid size / grid distance).
 */

/**
 * @typedef {object} Preset
 * @property {object[]} lights
 * @property {object[]} walls
 */

/**
 * @param {number} value
 * @param {number} decimals
 */
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && (typeof value === "object") && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/**
 * Plain JSON data only (no functions, symbols, non-finite numbers), within the depth limit.
 * @param {unknown} value
 * @param {number} depth
 */
function isJsonData(value, depth=0) {
  if ( depth > MAX_DEPTH ) return false;
  if ( value === null ) return true;
  switch ( typeof value ) {
    case "string": case "boolean": return true;
    case "number": return Number.isFinite(value);
    case "object":
      if ( Array.isArray(value) ) return value.every(v => isJsonData(v, depth + 1));
      return isPlainObject(value) && Object.values(value).every(v => isJsonData(v, depth + 1));
    default: return false;
  }
}

/** @param {LightFrame} frame */
function checkFrame(frame) {
  if ( ![frame?.width, frame?.height, frame?.unit].every(v => Number.isFinite(v) && (v > 0)) ) {
    throw new Error("Invalid light frame");
  }
}

/**
 * Scale the distances of an object in place (those that are numbers; null means "none" and stays).
 * @param {object|undefined} target
 * @param {readonly string[]} keys
 * @param {(value: number) => number} scale
 */
function scaleDistances(target, keys, scale) {
  if ( !target ) return;
  for ( const key of keys ) if ( Number.isFinite(target[key]) ) target[key] = scale(target[key]);
}

/**
 * A light of the stage scene as a preset light.
 * @param {object} light  The light's data without its defaults, but always with `x` and `y` (pixels).
 * @param {LightFrame} frame  The image it stands on.
 * @returns {object}  A new object; position and radii as shares of the image.
 */
export function toPresetLight(light, frame) {
  checkFrame(frame);
  const result = structuredClone(light);
  result.x = round(light.x / frame.width, SHARE_DECIMALS);
  result.y = round(light.y / frame.height, SHARE_DECIMALS);
  scaleDistances(result.config, LIGHT_DISTANCES, v => round(v * frame.unit / frame.width, SHARE_DECIMALS));
  return result;
}

/**
 * A preset light as light data for an image: pixels and distance units, rounded as Foundry stores them.
 * @param {object} light  A preset light (see `toPresetLight`).
 * @param {LightFrame} frame  The image it is placed on.
 * @returns {object}  A new object.
 */
export function fromPresetLight(light, frame) {
  checkFrame(frame);
  const result = structuredClone(light);
  result.x = Math.round(light.x * frame.width);
  result.y = Math.round(light.y * frame.height);
  scaleDistances(result.config, LIGHT_DISTANCES, v => round(v * frame.width / frame.unit, DISTANCE_DECIMALS));
  return result;
}

/**
 * A wall of the stage scene as a preset wall.
 * @param {object} wall  The wall's data without its defaults and door fields, but always with `c` (pixels).
 * @param {LightFrame} frame  The image it stands on.
 * @returns {object}  A new object; end points and thresholds as shares of the image.
 */
export function toPresetWall(wall, frame) {
  checkFrame(frame);
  const result = structuredClone(wall);
  result.c = wall.c.map((v, i) => round(v / (i % 2 ? frame.height : frame.width), SHARE_DECIMALS));
  scaleDistances(result.threshold, WALL_DISTANCES, v => round(v * frame.unit / frame.width, SHARE_DECIMALS));
  return result;
}

/**
 * A preset wall as wall data for an image: whole pixels and distance units.
 * @param {object} wall  A preset wall (see `toPresetWall`).
 * @param {LightFrame} frame  The image it is placed on.
 * @returns {object}  A new object.
 */
export function fromPresetWall(wall, frame) {
  checkFrame(frame);
  const result = structuredClone(wall);
  result.c = wall.c.map((v, i) => Math.round(v * (i % 2 ? frame.height : frame.width)));
  scaleDistances(result.threshold, WALL_DISTANCES, v => round(v * frame.width / frame.unit, DISTANCE_DECIMALS));
  return result;
}

/** @param {unknown} value */
function inRange(value) {
  return Number.isFinite(value) && (value >= POSITION_RANGE.min) && (value <= POSITION_RANGE.max);
}

/**
 * Clean one stored light or wall: known fields of the right type, plain JSON, size limited.
 * @param {unknown} item
 * @param {Record<string, string>} fields
 * @returns {object|null}
 */
function sanitizeItem(item, fields) {
  if ( !isPlainObject(item) ) return null;
  const result = {};
  for ( const [field, type] of Object.entries(fields) ) {
    if ( !(field in item) ) continue;
    const value = item[field];
    let ok;
    switch ( type ) {
      case "object": ok = isPlainObject(value) && isJsonData(value); break;
      case "array": ok = Array.isArray(value) && isJsonData(value); break;
      case "number": ok = Number.isFinite(value); break;
      default: ok = typeof value === type;
    }
    if ( ok ) result[field] = structuredClone(value);
  }
  if ( JSON.stringify(result).length > MAX_ITEM_JSON ) return null;
  return result;
}

/** @param {unknown} light */
function sanitizeLight(light) {
  const result = sanitizeItem(light, LIGHT_FIELDS);
  return (result && inRange(result.x) && inRange(result.y)) ? result : null;
}

/** @param {unknown} wall */
function sanitizeWall(wall) {
  const result = sanitizeItem(wall, WALL_FIELDS);
  return (result?.c?.length === 4) && result.c.every(inRange) ? result : null;
}

/**
 * Clean the stored presets: variant key → `{lights, walls}` (each limited, unusable items dropped); an earlier
 * preset (a plain list of lights) becomes one without walls; keys without lights and walls are dropped.
 * Never throws.
 * @param {unknown} data
 * @returns {Record<string, Preset>}  A fresh null-prototype object.
 */
export function sanitizeLightPresets(data) {
  const result = Object.create(null);
  if ( !isPlainObject(data) ) return result;
  let count = 0;
  for ( const [key, value] of Object.entries(data) ) {
    if ( count >= MAX_PRESETS ) break;
    if ( !key.trim() || (key.length > MAX_KEY_LENGTH) ) continue;
    const preset = Array.isArray(value) ? {lights: value, walls: []} : value;
    if ( !isPlainObject(preset) ) continue;
    const list = (items, max, clean) => (Array.isArray(items) ? items.slice(0, max).map(clean).filter(Boolean) : []);
    const lights = list(preset.lights, MAX_PRESET_LIGHTS, sanitizeLight);
    const walls = list(preset.walls, MAX_PRESET_WALLS, sanitizeWall);
    if ( !lights.length && !walls.length ) continue;
    result[key] = {lights, walls};
    count++;
  }
  return result;
}

/**
 * A stable text for an item's data: keys sorted, numbers rounded, so equal items give equal texts.
 * @param {unknown} value
 * @returns {string}
 */
function signature(value) {
  if ( Array.isArray(value) ) return `[${value.map(signature).join(",")}]`;
  if ( value && (typeof value === "object") ) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${signature(value[k])}`).join(",")}}`;
  }
  if ( typeof value === "number" ) return String(round(value, 4));
  return JSON.stringify(value ?? null);
}

/**
 * Whether two sets of lights or walls (data in pixels, defaults left out, see `fromPresetLight`) are the same,
 * regardless of their order.
 * @param {object[]} a
 * @param {object[]} b
 * @returns {boolean}
 */
export function sameItems(a, b) {
  if ( a.length !== b.length ) return false;
  const left = a.map(signature).sort();
  const right = b.map(signature).sort();
  return left.every((s, i) => s === right[i]);
}
