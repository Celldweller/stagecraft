/**
 * View lock on the stage scene (replaces Lock View for this use): the image fits the screen, panning and zooming
 * are locked, and a window resize fits it again. Applies to players; the GM can switch it on for themselves
 * ("player view" in the token controls).
 *
 * Only public values and hooks are used (checked in 14.370, client/canvas/board.mjs), no core method is replaced:
 * - Zoom: `CONFIG.Canvas.minZoom` and `maxZoom` become accessors. While the lock applies they both return the fit
 *   zoom, otherwise whatever core or another module assigned. The canvas reads them on every draw and resize.
 * - Position: every camera move ends in `Canvas#pan`, which calls the `canvasPan` hook before the next frame.
 *   If the view left the centre, the hook pans straight back.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { getStageScene } from "./stage-scene.mjs";
import { fitScale, lockedView, viewDiffers } from "./lib/view-lock.mjs";

/** Hook fired when the GM's player view was switched: `(active)`. */
export const PLAYER_VIEW_HOOK = `${MODULE_ID}.playerViewChanged`;

/** Values assigned to the zoom limits by core or other modules; returned while the lock does not apply. */
const assigned = {minZoom: undefined, maxZoom: undefined};

/** Whether the GM looks at the stage scene like a player. Per session, off by default. */
let playerView = false;

/**
 * Whether the lock applies to the scene the canvas shows (or is drawing).
 * @returns {boolean}
 */
export function isViewLocked() {
  const scene = globalThis.canvas?.scene;
  if ( !scene ) return false;
  const stage = getStageScene();
  if ( !stage || (scene.id !== stage.id) ) return false;
  return !game.user.isGM || playerView;
}

/** @returns {boolean} */
export function isPlayerView() {
  return playerView;
}

/**
 * Switch the GM's player view on or off.
 * @param {boolean} active
 */
export function setPlayerView(active) {
  playerView = Boolean(active);
  Hooks.callAll(PLAYER_VIEW_HOOK, playerView);
  refreshView();
}

/**
 * The zoom that fits the shown scene to the window, or undefined if it cannot be computed.
 * @returns {number|undefined}
 */
function lockedScale() {
  const {sceneWidth, sceneHeight} = canvas.scene.getDimensions();
  const mode = String(getSetting("stageFit") ?? "cover");
  return fitScale({sceneWidth, sceneHeight, viewWidth: window.innerWidth, viewHeight: window.innerHeight, mode})
    ?? undefined;
}

/**
 * Re-evaluate the zoom limits and the view, through the same path a window resize takes
 * (Game#onWindowResize → Canvas#_onResize → new dimensions → pan → canvasPan hook).
 */
export function refreshView() {
  if ( canvas?.ready ) window.dispatchEvent(new Event("resize"));
}

/**
 * Keep the locked view: pan back to the centre at the fit zoom whenever it moved.
 * @param {Canvas} board
 * @param {{x: number, y: number, scale: number}} view
 */
function onCanvasPan(board, view) {
  if ( !isViewLocked() || !board.dimensions ) return;
  const target = lockedView(board.dimensions.sceneRect, board.dimensions.scale.min);
  if ( viewDiffers(view, target) ) board.pan(target);
}

/** Install the zoom accessors and the pan hook. Call once in the `init` hook. */
export function registerViewLock() {
  for ( const key of Object.keys(assigned) ) {
    assigned[key] = CONFIG.Canvas[key];
    Object.defineProperty(CONFIG.Canvas, key, {
      configurable: true,
      enumerable: true,
      get: () => (isViewLocked() ? lockedScale() : undefined) ?? assigned[key],
      set: value => { assigned[key] = value; }
    });
  }
  Hooks.on("canvasPan", onCanvasPan);
}
