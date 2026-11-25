/**
 * Collapse Foundry's sidebar so the stage and the cards get the room (checkboxes in the stage and the card browser,
 * world settings, so every client knows them):
 * - "collapseSidebarOnStage": with every stage switch, on the clients that show the stage scene.
 * - "collapseSidebarOnCards": before the first card appears (no card shown before), and before a draft is shown
 *   (planning mode). The card layer waits for the sidebar, so the cards take their place only once; see
 *   card-layer.mjs.
 * Players always; the GM only in the player view, otherwise the GM's sidebar stays as it is. Each client collapses
 * its own sidebar; a player may open it again.
 */
import { getSetting } from "./settings.mjs";
import { STAGE_SCENE_HOOK, getStageScene, getStageSrc, viewsOtherScene } from "./stage-scene.mjs";
import { isPlayerView } from "./view-lock.mjs";

/** Failsafe for the sidebar's collapse transition, in case it never ends. */
const COLLAPSE_TIMEOUT_MS = 600;

/** @returns {boolean}  Whether the collapse applies on this client: players, and the GM in the player view. */
export function collapsesHere() {
  return !game.user.isGM || isPlayerView();
}

/** @returns {boolean}  Whether the sidebar is open on this client. */
export function isSidebarExpanded() {
  return Boolean(ui.sidebar?.rendered && ui.sidebar.expanded);
}

/**
 * Collapse the sidebar and wait until it has moved away.
 * @returns {Promise<boolean>}  Whether it was open.
 */
export async function collapseSidebar() {
  if ( !isSidebarExpanded() ) return false;
  ui.sidebar.collapse();
  // Let the browser start the transition before collecting it.
  await new Promise(resolve => requestAnimationFrame(resolve));
  const animations = document.getElementById("sidebar-content")?.getAnimations() ?? [];
  if ( animations.length ) {
    await Promise.race([
      Promise.allSettled(animations.map(a => a.finished)),
      new Promise(resolve => setTimeout(resolve, COLLAPSE_TIMEOUT_MS))
    ]);
  }
  return true;
}

/**
 * Whether the cards should wait for the sidebar to collapse before they change.
 * @param {{cards: {hidden?: true}[]}} previous  The cast before the change.
 * @param {{cards: {hidden?: true}[], turn?: true}} next  After the change.
 * @returns {boolean}
 */
export function collapseBeforeCards(previous, next) {
  // Only shown cards take room; hidden ones in the cast do not count.
  const shown = state => state.cards.some(c => !c.hidden);
  if ( !shown(next) || !getSetting("collapseSidebarOnCards") || !collapsesHere() ) return false;
  // On another scene the cards are hidden; nothing to make room for.
  if ( viewsOtherScene() ) return false;
  if ( shown(previous) && !next.turn ) return false;
  return isSidebarExpanded();
}

/** The image last seen on the stage scene; a different one is a stage switch. */
let lastSrc = null;

/** Watch for stage switches. Call once in the `ready` hook. */
export function registerSidebarCollapse() {
  lastSrc = getStageSrc();
  Hooks.on(STAGE_SCENE_HOOK, () => {
    const src = getStageSrc();
    if ( src === lastSrc ) return;
    lastSrc = src;
    if ( !src || !getSetting("collapseSidebarOnStage") || !collapsesHere() ) return;
    if ( canvas?.scene?.id !== getStageScene()?.id ) return;
    collapseSidebar();
  });
}
