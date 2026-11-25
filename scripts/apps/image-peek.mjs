/**
 * Large preview of an image while a key is held (Shift+click on a variant button in the browsers).
 *
 * - One popover element (top layer, above every window), created on first use and reused.
 * - Shows the thumbnail at once, then the original once it is decoded. The original loads as a plain image
 *   (browser cache), not as a Foundry texture, so the texture cache of the running scene stays untouched.
 * - Closes when the key is released, and also when the window loses focus (the keyup would then never arrive).
 * - Purely visual: no pointer events, no focus change.
 */
import { MODULE_ID } from "../constants.mjs";

const PEEK_ID = `${MODULE_ID}-image-peek`;

/** @type {AbortController|null}  Listeners of the open preview. */
let open = null;

/** Incremented per preview, so a late original never replaces a newer image. */
let generation = 0;

/** @returns {HTMLElement} */
function element() {
  let peek = document.getElementById(PEEK_ID);
  if ( peek ) return peek;
  peek = document.createElement("figure");
  peek.id = PEEK_ID;
  peek.className = `${MODULE_ID} image-peek`;
  peek.popover = "manual";
  peek.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.alt = "";
  const caption = document.createElement("figcaption");
  peek.append(img, caption);
  document.body.append(peek);
  return peek;
}

/** Close the preview, if open. */
export function hideImagePeek() {
  open?.abort();
  open = null;
  generation++;
  const peek = document.getElementById(PEEK_ID);
  if ( peek?.matches(":popover-open") ) peek.hidePopover();
}

/**
 * Show an image large until the key is released.
 * @param {object} image
 * @param {string} image.original     Path of the original file.
 * @param {string|null} image.thumb   Thumbnail URL shown until the original is decoded, if any.
 * @param {string} image.caption      Text below the image (name and variant).
 * @param {string} [key="Shift"]      The key whose release closes the preview.
 */
export function showImagePeek({original, thumb, caption}, key="Shift") {
  hideImagePeek();
  const current = ++generation;
  const peek = element();
  const img = peek.querySelector("img");
  peek.querySelector("figcaption").textContent = caption;
  img.src = thumb ?? original;
  peek.showPopover();

  if ( thumb && (thumb !== original) ) {
    const full = new Image();
    full.src = original;
    full.decode().then(() => {
      if ( current === generation ) img.src = original;
    }).catch(() => {});
  }

  open = new AbortController();
  const {signal} = open;
  document.addEventListener("keyup", event => {
    if ( event.key === key ) hideImagePeek();
  }, {signal});
  window.addEventListener("blur", hideImagePeek, {signal});
  document.addEventListener("visibilitychange", hideImagePeek, {signal});
}
