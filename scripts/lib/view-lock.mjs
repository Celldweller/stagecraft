/**
 * Pure geometry of the view lock: the zoom that fits the stage image to the screen, and the view centred on it.
 * No Foundry globals, testable with `node --test`.
 */

/** Fit modes of the world setting: "cover" fills the screen (edges may be cut), "contain" shows the whole image. */
export const FIT_MODES = Object.freeze(["cover", "contain"]);

/** Differences below these count as "already there", so resetting the view does not loop on rounding. */
const POSITION_TOLERANCE = 0.5;
const SCALE_TOLERANCE = 1e-6;

/**
 * Zoom at which the scene fits the screen.
 * @param {{sceneWidth: number, sceneHeight: number, viewWidth: number, viewHeight: number, mode?: string}} input
 * @returns {number|null}  Null if a size is unusable.
 */
export function fitScale({sceneWidth, sceneHeight, viewWidth, viewHeight, mode="cover"}) {
  const sizes = [sceneWidth, sceneHeight, viewWidth, viewHeight];
  if ( !sizes.every(n => Number.isFinite(n) && (n > 0)) ) return null;
  const x = viewWidth / sceneWidth;
  const y = viewHeight / sceneHeight;
  return (mode === "contain") ? Math.min(x, y) : Math.max(x, y);
}

/**
 * The locked view: the centre of the scene rectangle at the given zoom.
 * @param {{x: number, y: number, width: number, height: number}} sceneRect
 * @param {number} scale
 * @returns {{x: number, y: number, scale: number}}
 */
export function lockedView(sceneRect, scale) {
  return {x: sceneRect.x + (sceneRect.width / 2), y: sceneRect.y + (sceneRect.height / 2), scale};
}

/**
 * Whether a view differs from the locked one by more than rounding.
 * @param {{x: number, y: number, scale: number}} view
 * @param {{x: number, y: number, scale: number}} target
 * @returns {boolean}
 */
export function viewDiffers(view, target) {
  return (Math.abs(view.x - target.x) > POSITION_TOLERANCE)
    || (Math.abs(view.y - target.y) > POSITION_TOLERANCE)
    || (Math.abs(view.scale - target.scale) > SCALE_TOLERANCE);
}
