/**
 * Stage transitions (world setting "stageTransition", chosen after a preview on 2026-11-23): how the previous stage
 * image leaves when the next one is drawn. The previous image is an HTML layer above the canvas (stage-hold.mjs);
 * each transition takes that layer away and leaves the new stage underneath visible.
 *
 * No Foundry globals in here, so everything is testable with `node --test`.
 */

/** "none" is a hard cut, as before. */
export const STAGE_TRANSITIONS = Object.freeze(["none", "fade", "dip", "hardWipe", "clock", "softWipe", "iris"]);
export const DEFAULT_STAGE_TRANSITION = "none";

/** With reduced motion every transition becomes this short fade. */
export const REDUCED_FADE_MS = 300;

/** Dip to black: fade to black (already while the new stage loads), stay black, fade the black out. */
export const DIP = Object.freeze({toBlack: 450, black: 200, fromBlack: 650});

/** Custom properties the masks are driven by (registered in styles/stagecraft.css, so they can be animated). */
const PROGRESS = "--stagecraft-hold-progress";
const ANGLE = "--stagecraft-hold-angle";

/**
 * @param {unknown} value
 * @returns {string}  A known transition, else the default.
 */
export function normalizeStageTransition(value) {
  return STAGE_TRANSITIONS.includes(value) ? /** @type {string} */ (value) : DEFAULT_STAGE_TRANSITION;
}

/**
 * @typedef {object} Reveal
 * @property {string|null} mask       CSS mask for the layer, or null.
 * @property {Keyframe[]} keyframes   For `Element#animate` on the layer.
 * @property {number} duration        Milliseconds.
 * @property {string} easing
 */

/**
 * How the layer with the previous image leaves. For "dip" this is the last part only (the black fading out); the
 * black before is the caller's (see DIP). "none" has no reveal.
 * @param {string} transition
 * @param {{reduced?: boolean}} [options]  Reduced motion: a short fade for every transition.
 * @returns {Reveal|null}
 */
export function revealFor(transition, {reduced=false} = {}) {
  const id = normalizeStageTransition(transition);
  if ( id === "none" ) return null;
  const fade = (duration, easing="ease-in-out") => ({mask: null, keyframes: [{opacity: 1}, {opacity: 0}], duration, easing});
  if ( reduced ) return fade(REDUCED_FADE_MS);
  switch ( id ) {
    case "fade": return fade(900);
    case "dip": return fade(DIP.fromBlack, "ease-out");
    // Star Wars: a sharp vertical edge from right to left.
    case "hardWipe": return {
      mask: `linear-gradient(270deg, transparent var(${PROGRESS}), #000 var(${PROGRESS}))`,
      keyframes: [{[PROGRESS]: "0%"}, {[PROGRESS]: "100%"}], duration: 800, easing: "linear"
    };
    // Star Wars: a hand turning clockwise from twelve o'clock.
    case "clock": return {
      mask: `conic-gradient(from 0deg at 50% 50%, transparent var(${ANGLE}), #000 var(${ANGLE}))`,
      keyframes: [{[ANGLE]: "0deg"}, {[ANGLE]: "360deg"}], duration: 1000, easing: "linear"
    };
    case "softWipe": return {
      mask: `linear-gradient(90deg, transparent calc(var(${PROGRESS}) - 18%), #000 var(${PROGRESS}))`,
      keyframes: [{[PROGRESS]: "0%"}, {[PROGRESS]: "118%"}], duration: 1100, easing: "ease-in-out"
    };
    case "iris": return {
      mask: `radial-gradient(circle farthest-corner at 50% 50%, transparent var(${PROGRESS}), `
        + `#000 calc(var(${PROGRESS}) + 1%))`,
      keyframes: [{[PROGRESS]: "0%"}, {[PROGRESS]: "100%"}], duration: 1100, easing: "cubic-bezier(0.45, 0, 0.3, 1)"
    };
  }
  return null;
}
