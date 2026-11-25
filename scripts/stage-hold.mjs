/**
 * Hold the previous stage image above the canvas while the next one is drawn, and let it leave with the stage
 * transition of the settings.
 *
 * The GM waits only briefly for the players' preload (PRELOAD_TIMEOUT_MS), so a slow connection does not hold up
 * the others. Foundry redraws the canvas on the scene update at once: it tears the scene down first and then loads
 * the textures (client/canvas/board.mjs, Canvas#draw), so a player still loading would see an empty board with a
 * loading bar. Instead, this client keeps the image it showed as an HTML layer right above the canvas (below the
 * cards and the UI) until its canvas is ready with the new one.
 *
 * - Without a transition ("none"), the layer is only needed while the new image is still loading, and goes at once.
 * - With a transition (world setting "stageTransition", lib/stage-transitions.mjs), the layer is held on every stage
 *   switch and leaves through the transition once the canvas has drawn the new stage with its lights. "Dip to black"
 *   starts fading to black right away, so loading time disappears in the black.
 * - With reduced motion every transition is a short fade.
 *
 * Only while the view lock applies (players; the GM in the player view): then the canvas shows the image fitted to
 * the window and centred, which the layer reproduces with `object-fit` and the bar colour behind it.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting } from "./settings.mjs";
import { getStageBackground, getStageScene } from "./stage-scene.mjs";
import { isViewLocked } from "./view-lock.mjs";
import { DIP, normalizeStageTransition, revealFor } from "./lib/stage-transitions.mjs";

const HOLD_ID = `${MODULE_ID}-stage-hold`;

/** Safety net: never hold longer than this, even if no canvasReady follows. */
const MAX_HOLD_MS = 60_000;

/** Safety net for a transition that never finishes. */
const REVEAL_TIMEOUT_MS = 5_000;

/** @type {{src: string|null, color: string|null}|null}  What this client's canvas drew of the stage scene. */
let drawn = null;

/** @type {number|null} */
let timer = null;

/** @returns {boolean} */
function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Remove the layer, if any. */
function release() {
  if ( timer !== null ) clearTimeout(timer);
  timer = null;
  document.getElementById(HOLD_ID)?.remove();
}

/**
 * Show an image as the layer above the canvas.
 * @param {{src: string, color: string|null}} image
 * @param {string} transition  How the layer leaves once the canvas is ready.
 */
function hold(image, transition) {
  release();
  const board = document.getElementById("board");
  if ( !board ) return;
  const layer = document.createElement("div");
  layer.id = HOLD_ID;
  layer.className = `${MODULE_ID} stage-hold`;
  layer.setAttribute("aria-hidden", "true");
  layer.dataset.transition = transition;
  if ( image.color ) layer.style.setProperty("--stage-hold-color", image.color);
  layer.style.setProperty("--stage-hold-fit", (getSetting("stageFit") === "contain") ? "contain" : "cover");
  const img = document.createElement("img");
  img.alt = "";
  img.src = image.src;
  layer.append(img);
  board.after(layer);
  // Dip to black: into the black at once, while the new stage loads.
  if ( (transition === "dip") && !reducedMotion() ) {
    const black = document.createElement("div");
    black.className = "stage-hold-black";
    layer.append(black);
    black.animate([{opacity: 0}, {opacity: 1}], {duration: DIP.toBlack, easing: "ease-in", fill: "forwards"});
  }
  timer = setTimeout(release, MAX_HOLD_MS);
}

/**
 * Wait for an animation, at most REVEAL_TIMEOUT_MS (it may be cancelled when a newer switch replaces the layer).
 * @param {Animation|undefined} animation
 */
function settle(animation) {
  if ( !animation ) return Promise.resolve();
  return Promise.race([animation.finished.catch(() => {}), new Promise(r => setTimeout(r, REVEAL_TIMEOUT_MS))]);
}

/**
 * Let the layer leave through its transition, then remove it.
 * @param {HTMLElement} layer
 */
async function reveal(layer) {
  if ( timer !== null ) clearTimeout(timer);
  timer = null;
  const transition = layer.dataset.transition;
  const reduced = reducedMotion();
  const steps = revealFor(transition, {reduced});
  if ( !steps ) return layer.remove();
  const black = layer.querySelector(".stage-hold-black");
  if ( black ) {
    // Finish the way into the black, then only the black is left on the layer.
    await settle(black.getAnimations()[0]);
    if ( !layer.isConnected ) return;
    layer.classList.add("black");
    await new Promise(r => setTimeout(r, DIP.black));
    if ( !layer.isConnected ) return;
  }
  if ( steps.mask ) {
    layer.style.setProperty("mask-image", steps.mask);
    layer.style.setProperty("-webkit-mask-image", steps.mask);
  }
  await settle(layer.animate(steps.keyframes, {duration: steps.duration, easing: steps.easing, fill: "forwards"}));
  layer.remove();
}

/**
 * Remember what the canvas drew of the stage scene, or null on another scene.
 * @param {Canvas} board
 * @returns {boolean}  Whether the canvas shows the stage scene.
 */
function remember(board) {
  const stage = getStageScene();
  const onStage = Boolean(stage && (board?.scene?.id === stage.id));
  drawn = onStage ? getStageBackground(stage) : null;
  return onStage;
}

/** Install the hooks. Call once in the `ready` hook. */
export function registerStageHold() {
  // Foundry draws the canvas before the `ready` hook, so the first canvasReady has passed already.
  if ( canvas?.ready ) remember(canvas);
  Hooks.on("canvasReady", board => {
    const layer = document.getElementById(HOLD_ID);
    const onStage = remember(board);
    if ( layer && onStage && (layer.dataset.transition !== "none") ) reveal(layer);
    else release();
  });

  // Runs in the same task as the scene update that starts the redraw, so before anything is painted.
  Hooks.on("updateScene", scene => {
    if ( !drawn?.src || (scene.id !== canvas.scene?.id) || (scene.id !== getStageScene()?.id) ) return;
    if ( !isViewLocked() ) return;
    const next = getStageBackground(scene);
    if ( !next.src || (next.src === drawn.src) ) return;
    const transition = normalizeStageTransition(getSetting("stageTransition"));
    // No transition and already loaded (preload in time): Foundry redraws within a few milliseconds, nothing to hold.
    if ( (transition === "none") && foundry.canvas.getTexture(next.src)?.valid ) return;
    hold(/** @type {{src: string, color: string|null}} */ (drawn), transition);
  });
}
