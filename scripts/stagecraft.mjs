/**
 * Stagecraft entry point, loaded by Foundry via `esmodules` in module.json.
 *
 * Console messages are developer logs and stay in English on purpose:
 * translations are not loaded yet when the `init` hook runs.
 */
import { MODULE_ID } from "./constants.mjs";
import { registerSettings } from "./settings.mjs";
import {
  cardIndex, getCardIndex, getStageIndex, invalidateStageIndex, rescanCards, rescanStages, stageIndex
} from "./media-index.mjs";
import { StageBrowser } from "./apps/stage-browser.mjs";
import { CardBrowser } from "./apps/card-browser.mjs";
import { ThumbnailCacheConfig } from "./apps/thumbnail-cache.mjs";
import { TagTransferConfig } from "./apps/tag-transfer.mjs";
import { TagReview } from "./apps/tag-review.mjs";
import { onDismissedChanged } from "./tag-review.mjs";
import { StageSceneConfig } from "./apps/stage-scene-config.mjs";
import {
  currentEntry, getStageScene, onStageColorsChanged, onStageNamesChanged, onStageSceneChanged, registerStageScene,
  switchStage
} from "./stage-scene.mjs";
import { isPlayerView, refreshView, registerViewLock, setPlayerView } from "./view-lock.mjs";
import { registerStageHold } from "./stage-hold.mjs";
import { hasUnsavedPreset, onLightPresetsChanged, registerLightPresets, savePreset } from "./light-presets.mjs";
import {
  CARDS_HOOK, addHiddenToCast, getShownCards, hideAllCards, moveShownCard, onCardLayoutChanged, onShownCardsChanged,
  registerCardLayer, removeAllCards, removeCastCard, setShownCardHidden, toggleShownCard, toggleSpeakingCard
} from "./card-layer.mjs";
import {
  addHiddenToDraft, discardDraft, getDraft, isPlanning, moveDraftCard, onCardDraftChanged, removeDraftCard,
  setDraftCardHidden, showDraft, startDraft, toggleDraftCard, toggleDraftSpeaking
} from "./card-draft.mjs";
import { registerSidebarCollapse } from "./sidebar-collapse.mjs";
import { getHistory, onCardHistoryChanged, restoreHistory } from "./card-history.mjs";
import {
  deleteDialog, editDialog, findDialog, getDialogs, onDialogsChanged, saveDialog, showDialog
} from "./dialogs.mjs";
import { getKnownTags, getTags, getTagMap, onTagsChanged, updateTags } from "./tag-store.mjs";
import {
  getThumbnailStatus, invalidateThumbnails, loadThumbnails, refreshThumbnailPlan, requestThumbnails, thumbStore
} from "./thumbnails.mjs";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
  registerSettings({
    onStageConfigChange: invalidateStageIndex,
    // The variant pattern applies to both indexes.
    onVariantPatternChange: () => {
      invalidateStageIndex();
      cardIndex.invalidate();
    },
    onThumbConfigChange: invalidateThumbnails, onTagsChange: onTagsChanged,
    onPinnedChange: () => Hooks.callAll(`${MODULE_ID}.pinnedFiltersUpdated`),
    onDismissedChange: onDismissedChanged,
    onStageSceneChange: () => {
      onStageSceneChanged();
      refreshView();
    },
    onStageNamesChange: onStageNamesChanged,
    onStageFitChange: refreshView,
    onStageColorsChange: onStageColorsChanged,
    onCardConfigChange: () => cardIndex.invalidate(),
    onShownCardsChange: onShownCardsChanged,
    onCardLayoutChange: onCardLayoutChanged,
    onLightPresetsChange: onLightPresetsChanged,
    onCardDraftChange: onCardDraftChanged,
    onCollapseSidebarChange: () => Hooks.callAll(`${MODULE_ID}.collapseSidebarUpdated`),
    onDialogsChange: onDialogsChanged,
    onCardHistoryChange: onCardHistoryChanged
  });
  registerViewLock();
  // Keys for the GM, unbound by default (Configure Controls): end the dialog (empty the cast), end the speaker.
  game.keybindings.register(MODULE_ID, "endDialog", {
    name: "STAGECRAFT.Keybindings.EndDialog.Name",
    hint: "STAGECRAFT.Keybindings.EndDialog.Hint",
    editable: [],
    restricted: true,
    onDown: () => {
      if ( !getShownCards().cards.length ) return false;
      removeAllCards().catch(err => ui.notifications.error(err.message));
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "endSpeaker", {
    name: "STAGECRAFT.Keybindings.EndSpeaker.Name",
    hint: "STAGECRAFT.Keybindings.EndSpeaker.Hint",
    editable: [],
    restricted: true,
    onDown: () => {
      if ( !getShownCards().speaking ) return false;
      toggleSpeakingCard(null).catch(err => ui.notifications.error(err.message));
      return true;
    }
  });
  // In planning mode: show the draft (unbound by default, like the keys above).
  game.keybindings.register(MODULE_ID, "showDraft", {
    name: "STAGECRAFT.Keybindings.ShowDraft.Name",
    hint: "STAGECRAFT.Keybindings.ShowDraft.Hint",
    editable: [],
    restricted: true,
    onDown: () => {
      if ( !getDraft()?.cards.length ) return false;
      showDraft().catch(err => ui.notifications.error(err.message));
      return true;
    }
  });
  game.settings.registerMenu(MODULE_ID, "stageScene", {
    name: "STAGECRAFT.StageScene.Menu.Name",
    label: "STAGECRAFT.StageScene.Menu.Label",
    hint: "STAGECRAFT.StageScene.Menu.Hint",
    icon: "fa-solid fa-panorama",
    type: StageSceneConfig,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "thumbnailCache", {
    name: "STAGECRAFT.ThumbCache.Menu.Name",
    label: "STAGECRAFT.ThumbCache.Menu.Label",
    hint: "STAGECRAFT.ThumbCache.Menu.Hint",
    icon: "fa-solid fa-images",
    type: ThumbnailCacheConfig,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "tagReview", {
    name: "STAGECRAFT.TagReview.Menu.Name",
    label: "STAGECRAFT.TagReview.Menu.Label",
    hint: "STAGECRAFT.TagReview.Menu.Hint",
    icon: "fa-solid fa-list-check",
    type: TagReview,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "tagTransfer", {
    name: "STAGECRAFT.TagTransfer.Menu.Name",
    label: "STAGECRAFT.TagTransfer.Menu.Label",
    hint: "STAGECRAFT.TagTransfer.Menu.Hint",
    icon: "fa-solid fa-file-export",
    type: TagTransferConfig,
    restricted: true
  });

  // Public API, e.g. `await game.modules.get("stagecraft").api.rescanStages()` in the console.
  game.modules.get(MODULE_ID).api = Object.freeze({
    rescanStages,
    getStageIndex,
    openStageBrowser: () => StageBrowser.open(),
    openCardBrowser: () => CardBrowser.open(),
    rescanCards,
    getCardIndex,
    stageScene: getStageScene,
    switchStage,
    // The cast: cards shown or hidden; the players see the shown ones in the order of the cast.
    cards: Object.freeze({
      shown: getShownCards,
      toggle: toggleShownCard,
      addHidden: addHiddenToCast,
      setHidden: setShownCardHidden,
      remove: removeCastCard,
      speaking: toggleSpeakingCard,
      move: moveShownCard,
      hideAll: hideAllCards,
      removeAll: removeAllCards
    }),
    // Planning mode: a draft only the GM sees, shown in one step as a dialog switch.
    draft: Object.freeze({
      start: startDraft,
      get: getDraft,
      active: isPlanning,
      toggle: toggleDraftCard,
      addHidden: addHiddenToDraft,
      setHidden: setDraftCardHidden,
      remove: removeDraftCard,
      speaking: toggleDraftSpeaking,
      move: moveDraftCard,
      show: showDraft,
      discard: discardDraft
    }),
    // History "Recently shown": the last states that left the stage, newest first; restore(0) shows the latest again.
    history: Object.freeze({
      list: getHistory,
      restore: restoreHistory
    }),
    // Saved dialogs: `ref` is a dialog's id or name, e.g. `api.dialogs.show("Pilger am Brunnen")` in a macro.
    dialogs: Object.freeze({
      list: getDialogs,
      get: findDialog,
      show: ref => showDialog(ref),
      edit: editDialog,
      save: saveDialog,
      delete: deleteDialog
    }),
    presets: Object.freeze({
      // Save the lights and walls on the stage as the preset of the variant on show (none: remove its preset).
      save: () => savePreset(getStageScene(), currentEntry()),
      unsaved: () => hasUnsavedPreset(getStageScene(), currentEntry())
    }),
    tags: Object.freeze({
      get: getTags,
      all: getTagMap,
      known: getKnownTags,
      set: (path, tags) => updateTags({[path]: tags}),
      update: updateTags
    }),
    thumbnails: Object.freeze({
      status: getThumbnailStatus,
      store: thumbStore,
      create: () => loadThumbnails().then(requestThumbnails)
    })
  });
});

// Keep thumbnails in step with the index: re-match after every change, create missing ones after a scan.
for ( const hook of [stageIndex.hook, cardIndex.hook] ) Hooks.on(hook, index => {
  refreshThumbnailPlan();
  if ( index?.origin === "scan" ) requestThumbnails();
});

/**
 * The browsers behind the toggles in the token controls: a click opens the browser, another one closes it; the
 * toggle shows whether it is open, also when it was opened or closed another way (API, window close button).
 */
const BROWSER_TOOLS = Object.freeze([
  {name: `${MODULE_ID}-stages`, cls: StageBrowser, title: "STAGECRAFT.Browser.Control",
    icon: "fa-solid fa-masks-theater"},
  {name: `${MODULE_ID}-cards`, cls: CardBrowser, title: "STAGECRAFT.CardBrowser.Control",
    icon: "fa-solid fa-address-card"}
]);

/** @param {typeof StageBrowser|typeof CardBrowser} cls */
function openBrowser(cls) {
  const app = foundry.applications.instances.get(cls.DEFAULT_OPTIONS.id);
  return app?.state === foundry.applications.api.ApplicationV2.RENDER_STATES.RENDERED ? app : null;
}

/**
 * Set a browser toggle to the browser's state; re-render the controls only on a change.
 * @param {string} name
 * @param {boolean} open
 */
function syncBrowserTool(name, open) {
  const tool = ui.controls?.controls?.tokens?.tools?.[name];
  if ( !tool || (tool.active === open) ) return;
  tool.active = open;
  ui.controls.render();
}

for ( const {name, cls} of BROWSER_TOOLS ) {
  Hooks.on(`render${cls.name}`, () => syncBrowserTool(name, true));
  Hooks.on(`close${cls.name}`, () => syncBrowserTool(name, false));
}

/** The "End Dialog" button in the token controls. */
const END_DIALOG_TOOL = `${MODULE_ID}-end-dialog`;

/**
 * Enable "End Dialog" only while the cast holds cards (shown or hidden). Scene control tools have no disabled state of their own, so the
 * rendered button is set directly, after each render of the controls and each change of the shown cards.
 */
function markEndDialog() {
  const button = document.querySelector(`#scene-controls button.tool[data-tool="${END_DIALOG_TOOL}"]`);
  if ( button ) button.disabled = !getShownCards().cards.length;
}
Hooks.on("renderSceneControls", markEndDialog);
Hooks.on(CARDS_HOOK, markEndDialog);

// Toggles in the token controls for the stage and the card browser (GM only).
Hooks.on("getSceneControlButtons", controls => {
  const tools = controls.tokens?.tools;
  if ( !tools ) return;
  for ( const {name, cls, title, icon} of BROWSER_TOOLS ) {
    tools[name] = {
      name, title, icon,
      order: Object.keys(tools).length,
      toggle: true,
      active: Boolean(openBrowser(cls)),
      visible: game.user.isGM,
      onChange: (event, active) => {
        if ( active ) cls.open();
        else openBrowser(cls)?.close();
      }
    };
  }
  // "End Dialog": empty the cast. Disabled while it is empty (see markEndDialog).
  tools[END_DIALOG_TOOL] = {
    name: END_DIALOG_TOOL,
    title: "STAGECRAFT.CardBrowser.EndDialog",
    icon: "fa-solid fa-comment-slash",
    order: Object.keys(tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => {
      if ( getShownCards().cards.length ) removeAllCards().catch(err => ui.notifications.error(err.message));
    }
  };
  // The GM sees the stage scene like the players: fitted and locked. Only on the stage scene; off by default.
  tools[`${MODULE_ID}-player-view`] = {
    name: `${MODULE_ID}-player-view`,
    title: "STAGECRAFT.ViewLock.PlayerView",
    icon: "fa-solid fa-display",
    order: Object.keys(tools).length,
    toggle: true,
    active: isPlayerView(),
    visible: game.user.isGM,
    onChange: (event, active) => setPlayerView(active)
  };
});

Hooks.once("ready", () => {
  registerStageScene();
  registerStageHold();
  registerLightPresets(getStageScene);
  registerCardLayer();
  registerSidebarCollapse();
  console.log(`${MODULE_ID} | Ready`);
});
