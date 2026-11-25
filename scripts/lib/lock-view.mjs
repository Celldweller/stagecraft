/**
 * Lock View compatibility (pure, testable): which of its per-scene settings would fight Stagecraft's own view lock.
 * Flag names checked in the Lock View repository (MaterialFoundry/LockView 2.1.1_pre1, src/locks.js and
 * src/sceneHandler.js); whether 2.0.2 on The Forge uses the same names is part of the final test there.
 */

/** Module id and flag scope of Lock View. */
export const LOCK_VIEW_ID = "LockView";

/** Settings in `flags.LockView.locks` that lock the view. */
const LOCK_KEYS = Object.freeze(["pan", "zoom", "boundingBox"]);

/** Top-level Lock View flags that change the view. */
const VIEW_KEYS = Object.freeze(["autoscale", "forceInitialView"]);

/** Every conflict key, in display order. */
export const LOCK_VIEW_CONFLICTS = Object.freeze([...LOCK_KEYS, ...VIEW_KEYS]);

/**
 * Whether a stored flag value switches its feature on. Off: false, 0, "", "0", "false", null and undefined.
 * @param {unknown} value
 * @returns {boolean}
 */
function isOn(value) {
  if ( (typeof value === "string") ) return !["", "0", "false"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

/**
 * Lock View settings of a scene that conflict with Stagecraft's view lock.
 * @param {unknown} flags  The scene's `flags` object.
 * @returns {string[]}  Keys from LOCK_VIEW_CONFLICTS.
 */
export function lockViewConflicts(flags) {
  const data = (flags && (typeof flags === "object")) ? flags[LOCK_VIEW_ID] : null;
  if ( !data || (typeof data !== "object") ) return [];
  const locks = (data.locks && (typeof data.locks === "object")) ? data.locks : {};
  return [
    ...LOCK_KEYS.filter(key => isOn(locks[key])),
    ...VIEW_KEYS.filter(key => isOn(data[key]))
  ];
}
