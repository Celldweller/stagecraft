/**
 * Cards shown to the players: an HTML layer above the canvas, shown only while the client views the stage scene.
 * On any other scene (e.g. the world map) the layer is hidden and the state stays as it is, so the cards are back on
 * the return; without a stage scene or a viewed scene (canvas disabled) the cards show everywhere.
 *
 * - State: world setting "shownCards" (see lib/cards.mjs). Only GMs write it; Foundry sends every change to all
 *   clients, and a player who connects later reads the current state on `ready`. No socket needed.
 * - The state is the cast: cards shown or hidden. Only the shown ones are drawn, in the order of the cast, so a card
 *   that is uncovered enters at the place prepared for it. Hidden cards are never in a player's page.
 * - Each client shows a card once its own copy of the image is decoded: nobody waits for a slow connection, and
 *   a slow player sees the card a little later. A new variant replaces the old image only once it is decoded.
 * - Layout: a row (top, bottom, centre) or a column (left, right), per stage location (setting "cardPositions", else
 *   "cardPosition"). Each client finds the location from the stage image with the variant pattern, so players need
 *   no index. Rows and columns keep clear of Foundry's UI, measured here (scene controls, scene navigation, sidebar,
 *   hotbar). The height is a share of the window height (setting "cardSize"), smaller for all cards alike when they
 *   would not fit (styles/stagecraft.css).
 * - Insertion marker (GM, this session only): a new card goes before the marker card, or to the end. The marker
 *   stays, so further cards follow the last one inserted; see lib/cards.mjs `moveMarker`.
 * - Entry and exit follow the setting "cardTransition" (CSS, data-transition on the layer). For "a2b1" the other
 *   cards move to their new place through measured animation (FLIP) when one is added or removed.
 * - Dialog switch (state with `turn`, e.g. a draft shown): cards that stay keep their place, a new variant turns over;
 *   the other places are paired in order (lib/cards.mjs `pairCards`) and turn over like a playing card from the old
 *   card to the new one, once the new image is decoded. Unpaired cards leave or enter as usual. With reduced motion
 *   the turn becomes a short fade.
 * - With the setting "collapseSidebarOnCards" the sidebar collapses first and the cards follow once it is gone:
 *   before the first card, and before a draft is shown (sidebar-collapse.mjs).
 * - Purely visual for players: no pointer events, hidden from assistive technology (the file names stay private).
 *   For the GM, a click on a shown card sets it as speaker or ends that (class "gm" on the layer; only the cards take
 *   pointer events, the rest of the layer lets them through to the canvas). The card browser offers the same by
 *   keyboard.
 */
import { MODULE_ID } from "./constants.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import {
  CARD_POSITIONS, CARD_TRANSITIONS, DEFAULT_CARD_TRANSITION, MAX_SHOWN_CARDS, addHiddenCards, cardPositionFor,
  hideAllInCast, moveMarker, moveCard, normalizeCardSize, pairCards, removeFromCast, sanitizeCardPositions,
  sanitizeShownCards, setCardHidden, toggleCard, toggleSpeaking, visibleCards
} from "./lib/cards.mjs";
import { locationKeyOf } from "./media-index.mjs";
import { STAGE_SCENE_HOOK, getStageSrc, viewsOtherScene } from "./stage-scene.mjs";
import { collapseBeforeCards, collapseSidebar } from "./sidebar-collapse.mjs";
import { recordShownState } from "./card-history.mjs";

/** Hook fired after the shown cards changed: `(state)`. */
export const CARDS_HOOK = `${MODULE_ID}.shownCardsUpdated`;

/** Hook fired after size, transition or position of the cards changed (settings, all clients). */
export const CARD_LAYOUT_HOOK = `${MODULE_ID}.cardLayoutUpdated`;

/** Hook fired after the insertion marker moved: `(key|null)`. */
export const MARKER_HOOK = `${MODULE_ID}.cardMarkerUpdated`;

/**
 * Foundry's UI the cards keep clear of (v14). The scene navigation element spans the whole column, so its visible
 * part is measured from its entries; the chat input stands outside the sidebar while that is collapsed.
 */
const UI_SELECTORS = Object.freeze(["#scene-controls", "#players", "#players > *", "#sidebar", "#hotbar", "#chat-message",
  "#scene-navigation-expand", "#scene-navigation .scene-navigation-menu"]);

/** @type {string|null}  The card a new one goes before; null = at the end. GM, this session only. */
let marker = null;

const LAYER_ID = `${MODULE_ID}-cards`;

/** Failsafe for the exit transition, in case it never ends. */
const EXIT_TIMEOUT_MS = 2000;

/** Duration of a whole turn (both halves), and of each half of the fade that replaces it with reduced motion. */
const TURN_MS = 560;
const TURN_REDUCED_HALF_MS = 100;

/** @type {import("./lib/cards.mjs").ShownCards|null} */
let cache = null;

/** @returns {import("./lib/cards.mjs").ShownCards}  Do not modify; use the functions below. */
export function getShownCards() {
  cache ??= sanitizeShownCards(getSetting("shownCards"));
  return cache;
}

/**
 * Store a new state. GM only. It keeps the saved dialog of the shown cards (it stays marked while the GM changes a
 * card), unless it names its own (`dialog`, also null); without cards there is no dialog. A cast that is emptied or
 * replaced (`turn`) goes into the history "Recently shown" first (card-history.mjs).
 * @param {import("./lib/cards.mjs").ShownCards & {dialog?: string|null}} state
 */
async function store(state) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const previous = getShownCards();
  if ( previous.cards.length && (!state.cards.length || state.turn) ) {
    // A failing history must not stop the cards.
    await recordShownState(previous).catch(err => console.error(`${MODULE_ID} | History not saved:`, err));
  }
  const dialog = ("dialog" in state) ? state.dialog : previous.dialog;
  await setSetting("shownCards", sanitizeShownCards({...state, dialog: state.cards.length ? dialog : null}));
}

/**
 * Show a card, change its variant, or hide it in the cast (see `toggleCard`). GM only.
 * @param {{key: string, path: string}} card
 * @returns {Promise<boolean>}  False if the card could not be shown because the cast holds MAX_SHOWN_CARDS.
 */
export async function toggleShownCard(card) {
  const state = getShownCards();
  if ( !state.cards.some(c => c.key === card.key) && (state.cards.length >= MAX_SHOWN_CARDS) ) return false;
  await store(toggleCard(state, card, {before: marker}));
  return true;
}

/**
 * Put cards into the cast hidden, before the insertion marker or the card `before` ("" = at the end). GM only.
 * @param {{key: string, path: string}[]} cards
 * @param {{before?: string|null}} [options]  Without `before`, the insertion marker.
 * @returns {Promise<number>}  How many cards found no room (MAX_SHOWN_CARDS).
 */
export async function addHiddenToCast(cards, {before} = {}) {
  const at = (before === undefined) ? marker : (before || null);
  const {state, left} = addHiddenCards(getShownCards(), cards, {before: at});
  await store(state);
  return left;
}

/**
 * Show or hide a card of the cast at its place. GM only.
 * @param {string} key
 * @param {boolean} hidden
 */
export async function setShownCardHidden(key, hidden) {
  await store(setCardHidden(getShownCards(), key, hidden));
}

/**
 * Take cards out of the cast. GM only.
 * @param {string|string[]} keys
 */
export async function removeCastCard(keys) {
  await store(removeFromCast(getShownCards(), keys));
}

/** @returns {string|null}  The card a new one goes before; null = at the end. */
export function getCardMarker() {
  return marker;
}

/**
 * Set the insertion marker: before a card of the cast, or at the end (null).
 * @param {string|null} key
 */
export function setCardMarker(key) {
  marker = (key && getShownCards().cards.some(c => c.key === key)) ? key : null;
  Hooks.callAll(MARKER_HOOK, marker);
}

/** @returns {Record<string, string>}  Card positions by location key. */
export function getCardPositions() {
  return sanitizeCardPositions(getSetting("cardPositions"));
}

/**
 * Set or clear (null = the default) the card position of one or several locations. GM only.
 * @param {string|string[]} locationKeys
 * @param {string|null} position
 */
export async function setCardPosition(locationKeys, position) {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("STAGECRAFT.Errors.GMOnly"));
  const next = Object.assign(Object.create(null), getCardPositions());
  for ( const key of [locationKeys].flat().filter(Boolean) ) {
    if ( CARD_POSITIONS.includes(position) ) next[key] = position;
    else delete next[key];
  }
  await setSetting("cardPositions", next);
}

/** @returns {string}  Where the cards stand now: the position of the location on stage, else the default. */
export function currentCardPosition() {
  return cardPositionFor(getCardPositions(), currentStageLocation(), getSetting("cardPosition"));
}

/** @returns {string|null}  Location key of the image on the stage scene, if it shows one. */
export function currentStageLocation() {
  const src = getStageSrc();
  return src ? locationKeyOf(src) : null;
}

/**
 * Mark a shown card as speaking, or end it. GM only.
 * @param {string|null} key
 */
export async function toggleSpeakingCard(key) {
  await store(toggleSpeaking(getShownCards(), key));
}

/**
 * Move a shown card to another place: before the card `before`, or to the end (null). GM only.
 * @param {string} key
 * @param {string|null} before
 */
export async function moveShownCard(key, before) {
  const state = getShownCards();
  const next = moveCard(state, key, before);
  if ( next.cards.every((c, i) => c.key === state.cards[i].key) ) return;
  await store(next);
}

/**
 * Replace the shown cards as a dialog switch: the cards turn over in place (see `renderCards`). GM only.
 * @param {import("./lib/cards.mjs").ShownCards} state  With `dialog`, the saved dialog they come from.
 */
export async function replaceShownCards(state) {
  await store({cards: state.cards, speaking: state.speaking, turn: true, dialog: state.dialog ?? null});
}

/** Hide all cards; the cast stays. GM only. */
export async function hideAllCards() {
  await store(hideAllInCast(getShownCards()));
}

/** End the dialog: the cast is emptied (it goes into the history "Recently shown"). GM only. */
export async function removeAllCards() {
  await store({cards: [], speaking: null});
}

/** Setting onChange (all clients): forget the cached state, redraw (after the sidebar, if it collapses), tell the UI. */
export function onShownCardsChanged() {
  const before = getShownCards();
  const previous = before.cards;
  cache = null;
  const moved = moveMarker(marker, previous, getShownCards().cards);
  if ( collapseBeforeCards(before, getShownCards()) ) collapseSidebar().finally(renderCards);
  else renderCards();
  Hooks.callAll(CARDS_HOOK, getShownCards());
  if ( moved !== marker ) {
    marker = moved;
    Hooks.callAll(MARKER_HOOK, marker);
  }
}

/** Setting onChange (all clients): apply the new size or transition. */
export function onCardLayoutChanged() {
  renderCards();
  Hooks.callAll(CARD_LAYOUT_HOOK);
}

/**
 * A GM's click on a shown card: set it as speaker, or end speaking if it speaks.
 * @param {PointerEvent} event
 */
async function onCardClick(event) {
  const card = event.target.closest(".card-layer-card.ready:not([data-closing])");
  if ( !card?.dataset.key ) return;
  event.preventDefault();
  try {
    await toggleSpeakingCard(card.dataset.key);
  } catch ( err ) {
    ui.notifications.error(err.message);
  }
}

/** @returns {HTMLElement}  The layer, created right after the canvas on first use. */
function layer() {
  let element = document.getElementById(LAYER_ID);
  if ( element ) return element;
  const board = document.getElementById("board");
  element = document.createElement("div");
  element.id = LAYER_ID;
  element.className = `${MODULE_ID} card-layer`;
  element.setAttribute("aria-hidden", "true");
  if ( game.user.isGM ) {
    element.classList.add("gm");
    element.addEventListener("click", onCardClick);
  }
  // After the canvas and after the stage hold layer (which is inserted right after the canvas), so cards stay on top.
  // Without a canvas (disabled in the client settings) the layer goes into the body on its own.
  const anchor = document.getElementById(`${MODULE_ID}-stage-hold`) ?? board;
  if ( anchor ) anchor.after(element);
  else document.body.append(element);
  return element;
}

/** @returns {string}  The configured transition (setting "cardTransition"), one of CARD_TRANSITIONS. */
function transition() {
  const value = String(getSetting("cardTransition") ?? "");
  return CARD_TRANSITIONS.includes(value) ? value : DEFAULT_CARD_TRANSITION;
}

/** Whether the others move to their new place through measured animation (FLIP) rather than CSS. */
function usesFlip() {
  return (transition() === "a2b1") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Positions and sizes of the cards before a change.
 * @param {HTMLElement} root
 * @returns {Map<HTMLElement, DOMRect>}
 */
function measure(root) {
  return new Map([...root.querySelectorAll(".card-layer-card:not(.detached)")]
    .map(card => [card, card.getBoundingClientRect()]));
}

/** Easing of the cards moving to their new place: off at once, a long gentle stop. */
const MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * Move every card that changed place or size from where it was to where it is now (FLIP).
 * @param {Map<HTMLElement, DOMRect>} before
 */
function flip(before) {
  const duration = parseFloat(getComputedStyle(layer()).getPropertyValue("--card-move")) || 400;
  for ( const [card, old] of before ) {
    if ( !card.isConnected ) continue;
    const now = card.getBoundingClientRect();
    if ( !now.width ) continue;
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const scale = old.width / now.width;
    if ( (Math.abs(dx) < 0.5) && (Math.abs(dy) < 0.5) && (Math.abs(scale - 1) < 0.005) ) continue;
    card.animate([
      {transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${scale})`},
      {transformOrigin: "top left", transform: "none"}
    ], {duration, easing: MOVE_EASING});
  }
}

/**
 * Take leaving cards out of the row at the place they show now (FLIP transition only): they fade out there while
 * the others move up at once, instead of one after the other. Their size is frozen, so they do not grow or shrink
 * with the new number of cards. All places are measured before the first card leaves the row: taken out one by one,
 * the next card would already have moved up into the room the previous one freed, and would glide there.
 * @param {Iterable<HTMLElement>} cards
 */
function detach(cards) {
  const places = [];
  for ( const card of cards ) {
    const root = card.parentElement;
    if ( !root || card.classList.contains("detached") ) continue;
    // A move still running would add its offset to the fixed place.
    for ( const animation of card.getAnimations() ) animation.cancel();
    places.push({card, root, rect: card.getBoundingClientRect(), origin: root.getBoundingClientRect(),
      height: card.offsetHeight});
  }
  for ( const {card, root, rect, origin, height} of places ) {
    card.style.setProperty("--card-height", `${height}px`);
    Object.assign(card.style, {position: "absolute", left: `${rect.left - origin.left - root.clientLeft}px`,
      top: `${rect.top - origin.top - root.clientTop}px`, margin: "0"});
    card.classList.add("detached");
  }
}

/**
 * The number of card places, including cards still fading out, so the size changes only once they are gone.
 * @param {HTMLElement} root
 */
function updateCount(root) {
  const count = root.querySelectorAll(".card-layer-card:not(.failed, .detached)").length;
  root.style.setProperty("--stagecraft-card-count", String(Math.max(count, 1)));
}

/**
 * Load an image into a card once it is decoded; until then the card keeps its previous image (or stays invisible).
 * @param {HTMLElement} card
 * @param {string} path
 */
function loadImage(card, path) {
  card.dataset.path = path;
  const img = document.createElement("img");
  img.alt = "";
  img.src = path;
  img.decode().then(() => {
    // A newer variant was requested meanwhile, or the card is gone.
    if ( (card.dataset.path !== path) || !card.isConnected ) return;
    if ( img.naturalWidth && img.naturalHeight ) {
      card.style.setProperty("--card-aspect", String(img.naturalWidth / img.naturalHeight));
    }
    const face = card.querySelector(".card-layer-face");
    face.querySelector("img")?.remove();
    face.append(img);
    card.classList.add("ready");
  }).catch(() => {
    if ( card.dataset.path !== path ) return;
    console.warn(`${MODULE_ID} | Card image could not be loaded: ${path}`);
    if ( !card.querySelector("img") ) {
      card.classList.add("failed");
      if ( card.isConnected ) updateCount(card.parentElement);
    }
  });
}

/**
 * Turn a card over to another image at its place, once that is decoded: the face turns edge-on, the image changes,
 * the face turns back. With reduced motion it fades out and in instead. A newer image requested meanwhile wins.
 * @param {HTMLElement} card
 * @param {string} path
 */
function turnCard(card, path) {
  card.dataset.path = path;
  const img = document.createElement("img");
  img.alt = "";
  img.src = path;
  img.decode().then(async () => {
    if ( (card.dataset.path !== path) || !card.isConnected ) return;
    const face = card.querySelector(".card-layer-face");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const half = reduced ? TURN_REDUCED_HALF_MS : TURN_MS / 2;
    const [away, back] = reduced
      ? [[{opacity: 1}, {opacity: 0}], [{opacity: 0}, {opacity: 1}]]
      : [[{rotate: "y 0deg"}, {rotate: "y 90deg"}], [{rotate: "y -90deg"}, {rotate: "y 0deg"}]];
    // Held at its end, so the old image does not flash up between the halves.
    const out = face.animate(away, {duration: half, easing: "ease-in", fill: "forwards"});
    await out.finished.catch(() => {});
    if ( (card.dataset.path !== path) || !card.isConnected ) {
      out.cancel();
      return;
    }
    if ( img.naturalWidth && img.naturalHeight ) {
      card.style.setProperty("--card-aspect", String(img.naturalWidth / img.naturalHeight));
    }
    face.querySelector("img")?.remove();
    face.append(img);
    face.animate(back, {duration: half, easing: "ease-out"});
    out.cancel();
  }).catch(() => {
    if ( card.dataset.path !== path ) return;
    // The old person must not stay under the new name.
    console.warn(`${MODULE_ID} | Card image could not be loaded: ${path}`);
    removeCard(card);
  });
}

/**
 * Let a card leave (the exit transition of the setting), then remove it and close its place.
 * @param {HTMLElement} card
 */
async function removeCard(card) {
  if ( card.dataset.closing !== undefined ) return;
  // With the FLIP transition the others move up while the card fades (renderCards detaches all leaving cards in
  // one go before its own FLIP; a card failing alone is detached here).
  if ( usesFlip() && !card.classList.contains("detached") && card.parentElement ) {
    const root = card.parentElement;
    const before = measure(root);
    detach([card]);
    updateCount(root);
    flip(before);
  }
  card.dataset.closing = "";
  // Let the browser start the exit transitions before collecting them.
  await new Promise(resolve => requestAnimationFrame(resolve));
  const animations = card.getAnimations({subtree: true});
  if ( animations.length ) {
    await Promise.race([
      Promise.allSettled(animations.map(a => a.finished)),
      new Promise(resolve => setTimeout(resolve, EXIT_TIMEOUT_MS))
    ]);
  }
  const root = card.parentElement;
  if ( !root ) return;
  const detached = card.classList.contains("detached");
  const before = (usesFlip() && !detached) ? measure(root) : null;
  card.remove();
  // A detached card took no room any more: nothing moves.
  if ( detached ) return;
  updateCount(root);
  if ( before ) flip(before);
}

/** Bring the layer in line with the stored state. Cheap when nothing changed. */
export function renderCards() {
  const root = layer();
  const state = getShownCards();
  // Measured before anything changes, so a new position or size moves the cards there too (FLIP).
  const before = usesFlip() ? measure(root) : null;
  root.dataset.transition = transition();
  root.dataset.position = currentCardPosition();
  root.style.setProperty("--card-size", String(normalizeCardSize(getSetting("cardSize"))));
  root.classList.toggle("has-speaker", Boolean(state.speaking));
  markScene(root);

  const existing = new Map();
  for ( const card of root.querySelectorAll(".card-layer-card:not([data-closing])") ) existing.set(card.dataset.key, card);

  // Only the shown cards of the cast are drawn.
  const shown = visibleCards(state);
  // A dialog switch: places of cards that go are taken over by cards that come, if the old card is on screen yet.
  const takeOver = state.turn ? pairCards([...existing.keys()], shown.map(c => c.key)) : new Map();
  for ( const [key, old] of takeOver ) if ( !existing.get(old).classList.contains("ready") ) takeOver.delete(key);

  // Cards that go stay at their place while they leave, so the others do not first move past them and back once
  // they are gone. The order below skips them, and cards still closing from an earlier change.
  const stayingKeys = new Set(shown.map(c => c.key));
  const sources = new Set(takeOver.values());
  const leaving = new Set([...existing].filter(([k]) => !stayingKeys.has(k) && !sources.has(k)).map(([, el]) => el));
  const staying = element => {
    while ( element && (leaving.has(element) || (element.dataset.closing !== undefined)) ) {
      element = element.nextElementSibling;
    }
    return element;
  };

  let previous = null;
  for ( const {key, path} of shown ) {
    let card = existing.get(key);
    existing.delete(key);
    const turn = Boolean(state.turn) && (card ? card.classList.contains("ready") : takeOver.has(key));
    if ( !card && takeOver.has(key) ) {
      card = existing.get(takeOver.get(key));
      existing.delete(takeOver.get(key));
      card.dataset.key = key;
    }
    if ( !card ) {
      card = document.createElement("div");
      card.className = "card-layer-card";
      card.dataset.key = key;
      const face = document.createElement("div");
      face.className = "card-layer-face";
      card.append(face);
    }
    if ( card.dataset.path !== path ) {
      if ( turn ) turnCard(card, path);
      else loadImage(card, path);
    }
    // Speaker and dimmed per card: a card that leaves keeps its look while it fades (it is not touched here).
    card.classList.toggle("speaking", state.speaking === key);
    card.classList.toggle("dimmed", Boolean(state.speaking) && (state.speaking !== key));
    // The GM's hint on the face, the element that takes the pointer.
    if ( game.user.isGM ) {
      card.querySelector(".card-layer-face").dataset.tooltipText = game.i18n.localize(state.speaking === key
        ? "STAGECRAFT.CardBrowser.EndSpeaker" : "STAGECRAFT.CardBrowser.SetSpeaker");
    }
    // Keep the stored order; move only what is out of place (a moved node would restart its transitions).
    const expected = staying(previous ? previous.nextElementSibling : root.firstElementChild);
    if ( card !== expected ) {
      if ( previous ) previous.after(card);
      else root.prepend(card);
    }
    previous = card;
  }
  // The leaving cards leave the row first, so one FLIP moves the others into the room they free.
  const going = [...existing.values()];
  if ( before ) detach(going);
  updateCount(root);
  if ( before ) flip(before);
  for ( const card of going ) removeCard(card);
}

/**
 * Hide the layer while this client views another scene. Hidden, not removed: the cards keep their size and place,
 * so they are back at once on the return.
 * @param {HTMLElement} [root]
 */
function markScene(root=layer()) {
  root.classList.toggle("off-stage", viewsOtherScene());
}

/**
 * Measure Foundry's UI into the layer's custom properties (0 where hidden): the right edge of the scene controls,
 * the bottom of the scene navigation's visible entries, the room the sidebar takes on the right, the hotbar at the
 * bottom, the player list at the bottom left where it reaches past the scene controls, and the chat input at the
 * bottom right while it stands outside the collapsed sidebar.
 */
function measureUi() {
  const root = layer();
  const visible = element => {
    const rect = element?.getBoundingClientRect();
    return (rect?.width && rect?.height) ? rect : null;
  };
  const box = selector => visible(document.querySelector(selector));
  const controls = box("#scene-controls");
  const sidebar = box("#sidebar");
  const hotbar = box("#hotbar");
  const chat = box("#chat-message");
  // The player list element is as narrow as the scene controls; its content reaches further.
  const playerParts = [...document.querySelectorAll("#players > *")].map(visible).filter(Boolean);
  const players = playerParts.length ? {top: Math.min(...playerParts.map(r => r.top)),
    right: Math.max(...playerParts.map(r => r.right))} : null;
  const entries = [...document.querySelectorAll("#scene-navigation-expand, #scene-navigation .scene-navigation-menu > *")]
    .map(visible).filter(Boolean);
  const navigationBottom = entries.length ? Math.max(...entries.map(r => r.bottom)) : 0;
  const sidebarLeft = sidebar?.left ?? window.innerWidth;
  const chatOutside = chat && (chat.left < sidebarLeft);
  const playersWider = players && (players.right > (controls?.right ?? 0));
  root.style.setProperty("--ui-left", `${Math.round(controls?.right ?? 0)}px`);
  root.style.setProperty("--ui-top-left", `${Math.round(navigationBottom)}px`);
  root.style.setProperty("--ui-right", `${Math.round(window.innerWidth - sidebarLeft)}px`);
  root.style.setProperty("--ui-bottom", `${Math.round(hotbar ? window.innerHeight - hotbar.top : 0)}px`);
  root.style.setProperty("--ui-bottom-left", `${Math.round(playersWider ? window.innerHeight - players.top : 0)}px`);
  root.style.setProperty("--ui-bottom-right", `${Math.round(chatOutside ? window.innerHeight - chat.top : 0)}px`);
}

/** Measure once per frame at most. */
let measuring = false;
function scheduleMeasure() {
  if ( measuring ) return;
  measuring = true;
  requestAnimationFrame(() => {
    measuring = false;
    measureUi();
  });
}

/** @type {ResizeObserver|null} */
let uiObserver = null;

/** (Re-)observe the UI elements; they exist once rendered, and a re-render may replace them. */
function observeUi() {
  uiObserver ??= new ResizeObserver(scheduleMeasure);
  uiObserver.disconnect();
  for ( const element of document.querySelectorAll(UI_SELECTORS.join(", ")) ) uiObserver.observe(element);
  scheduleMeasure();
}

/** Draw the current state and keep clear of the UI. Call once in the `ready` hook. */
export function registerCardLayer() {
  // The GM's switch with "end dialog": the cast leaves with the old stage.
  Hooks.on(`${MODULE_ID}.stageSelected`, (path, {endDialog}={}) => {
    if ( game.user.isGM && endDialog && getShownCards().cards.length ) removeAllCards().catch(err => {
      ui.notifications.error(err.message);
    });
  });
  renderCards();
  observeUi();
  window.addEventListener("resize", scheduleMeasure);
  for ( const hook of ["collapseSidebar", "renderSceneNavigation", "renderSceneControls", "renderHotbar",
    "renderChatLog", "renderPlayers"] ) {
    Hooks.on(hook, observeUi);
  }
  // A stage switch may bring another position.
  Hooks.on(STAGE_SCENE_HOOK, renderCards);
  // Another scene viewed: from canvasInit on, the new scene is the viewed one.
  Hooks.on("canvasInit", () => markScene());
}
