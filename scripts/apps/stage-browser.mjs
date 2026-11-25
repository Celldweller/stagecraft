/**
 * Stage browser (GM only): locations as tiles with tag labels and variant buttons; a click shows the stage.
 * Filter bar, selection, tags, rescan and thumbnails come from MediaBrowser.
 *
 * Stage-specific: the variant a variant chip asks for, the location on stage (green ring), the stage name and
 * bar colours, the light presets (save button, light bulb on tiles, warning before a switch drops unsaved lights and
 * walls),
 * the notices about the stage scene and about tags to review after a scan.
 */
import { MODULE_ID } from "../constants.mjs";
import { getStageIndex } from "../media-index.mjs";
import { mergeTagLists, sortTagsForDisplay } from "../lib/tags.mjs";
import { getTagOrder, getTags } from "../tag-store.mjs";
import { TagReview } from "./tag-review.mjs";
import { DISMISSED_HOOK, getTagReview } from "../tag-review.mjs";
import { StageSceneConfig } from "./stage-scene-config.mjs";
import {
  STAGE_NAMES_HOOK, STAGE_SCENE_HOOK, STAGE_SWITCH_HOOK, currentEntry, getCurrentStage, getStageColors,
  getStageNames, getLockViewConflicts, getStageScene, getStageSrc, getSwitchingPath, setStageColors, setStageName,
  switchStage
} from "../stage-scene.mjs";
import { PRESET_HOOK, getLightPresets, hasUnsavedPreset, presetKey } from "../light-presets.mjs";
import { confirmLights, saveStagePreset } from "./stage-prompts.mjs";
import { variantKey } from "../lib/stage.mjs";
import { CARD_POSITIONS } from "../lib/cards.mjs";
import { getCardPositions, getShownCards, setCardPosition } from "../card-layer.mjs";
import { getSetting } from "../settings.mjs";
import { EAGER_TILES, MediaBrowser, tagLabel, tileVariants } from "./media-browser.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Folders of a location's files below the stage root, for the "folders" search scope.
 * @param {import("../lib/filenames.mjs").StageLocation} location
 * @param {string} root
 */
function foldersOf(location, root) {
  const base = root.replace(/\/+$/, "");
  const folders = new Set();
  for ( const file of location.variants.flatMap(v => v.files) ) {
    let folder = String(file.folder ?? "").replace(/\/+$/, "");
    if ( base && folder.startsWith(base) ) folder = folder.slice(base.length);
    for ( const part of folder.split("/") ) if ( part ) folders.add(part);
  }
  return [...folders];
}

export class StageBrowser extends MediaBrowser {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-stage-browser`,
    classes: ["stage-browser"],
    window: {
      title: "STAGECRAFT.Browser.Title",
      icon: "fa-solid fa-masks-theater"
    },
    actions: {
      selectStage: StageBrowser.#onSelectStage,
      openTagReview: StageBrowser.#onOpenTagReview,
      setupStageScene: StageBrowser.#onSetupStageScene,
      renameStage: StageBrowser.#onRenameStage,
      renameSelection: StageBrowser.#onRenameSelection,
      activateStageScene: StageBrowser.#onActivateStageScene,
      savePreset: StageBrowser.#onSavePreset,
      closeNotice: StageBrowser.#onCloseNotice
    }
  };

  /** @override */
  static PARTS = {
    header: {template: `modules/${MODULE_ID}/templates/browser/header.hbs`},
    notice: {template: `modules/${MODULE_ID}/templates/stage-browser/notice.hbs`},
    filters: {template: `modules/${MODULE_ID}/templates/browser/filters.hbs`},
    selection: {template: `modules/${MODULE_ID}/templates/browser/selection.hbs`},
    grid: {template: `modules/${MODULE_ID}/templates/stage-browser/grid.hbs`, scrollable: [""]}
  };

  /** @override */
  static KIND = "stages";

  /** Whether to show the "review tags" notice; set by a scan, cleared when the GM closes it. */
  #notice = false;

  /** @override */
  _prepareTiles(index, {selected}) {
    const root = String(index?.root ?? "");
    const records = new Map();
    const order = getTagOrder();
    const tiles = (index?.locations ?? []).map((location, i) => {
      const {buttons: variants, records: variantRecords} = tileVariants(location);
      const tags = mergeTagLists(location.variants.flatMap(v => v.files.map(f => getTags(f.path))));
      records.set(location.key, {
        key: location.key,
        name: location.name,
        variants: variantRecords,
        tags,
        folders: foldersOf(location, root)
      });
      return {
        key: location.key,
        name: location.name,
        selected: selected.has(location.key),
        selectLabel: game.i18n.format("STAGECRAFT.Browser.SelectTile", {name: location.name}),
        tags: sortTagsForDisplay(tags, order).map(tagLabel),
        hasOverlay: (variants.length > 1) || (tags.length > 0),
        original: variants[0].path,
        src: this._tileImage(variants[0].path),
        variants,
        hasVariants: variants.length > 1,
        variantCount: game.i18n.format("STAGECRAFT.Browser.VariantCount", {count: variants.length}),
        deferred: i >= EAGER_TILES
      };
    });
    return {tiles, records};
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return Object.assign(context, {
      notice: this.#notice ? this.#noticeText() : null,
      stageNotice: this.#stageNotice()
    });
  }

  /** @override */
  _tagParts() {
    return ["notice", "grid"];
  }

  /** @override */
  _onIndexUpdated(index) {
    if ( index?.origin === "scan" ) this.#notice = true;
    super._onIndexUpdated(index);
  }

  /** @override */
  _browserHooks() {
    return [
      [DISMISSED_HOOK, () => this.render({parts: ["notice"]})],
      [STAGE_SCENE_HOOK, () => {
        this.render({parts: ["notice"]});
        this.#markCurrent();
        this.#markLights();
      }],
      [PRESET_HOOK, () => {
        this.#markLights();
        this.#markPresets();
      }],
      [STAGE_NAMES_HOOK, () => this.#applyStageNames()],
      [STAGE_SWITCH_HOOK, path => this.#showSwitching(path)]
    ];
  }

  /** @override */
  _onRenderGrid() {
    this.#showSwitching(getSwitchingPath());
    this.#markCurrent();
    this.#applyStageNames();
    this.#markPresets();
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( options.parts.includes("header") ) this.#markLights();
  }

  /** @override */
  _headerToggles() {
    return [{setting: "collapseSidebarOnStage", icon: "fa-solid fa-sidebar-flip", label: "STAGECRAFT.Sidebar.Collapse",
      hint: "STAGECRAFT.Sidebar.CollapseOnStageHint"}];
  }

  /** @override */
  _headerActions() {
    return [{action: "savePreset", icon: "fa-solid fa-lightbulb", label: "STAGECRAFT.Lights.Save",
      disabled: !currentEntry()}];
  }

  /**
   * The "Save preset" button: enabled while an indexed stage is shown, marked while its lights and walls are not
   * saved.
   * Texts name the file, because the preset belongs to that variant. DOM only, so placing a light does not
   * re-render the header.
   */
  #markLights() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const button = this.element.querySelector("[data-action=savePreset]");
    if ( !button ) return;
    const entry = currentEntry();
    const unsaved = Boolean(entry) && hasUnsavedPreset(getStageScene(), entry);
    button.disabled = !entry;
    button.classList.toggle("unsaved", unsaved);
    const file = entry?.file ?? "";
    button.dataset.tooltipText = !entry ? game.i18n.localize("STAGECRAFT.Lights.NoStage")
      : game.i18n.format(unsaved ? "STAGECRAFT.Lights.Unsaved" : "STAGECRAFT.Lights.SaveFor", {file});
    if ( unsaved ) button.setAttribute("aria-description", game.i18n.format("STAGECRAFT.Lights.Unsaved", {file}));
    else button.removeAttribute("aria-description");
  }

  /**
   * Mark the tiles and variant buttons whose variant has a light preset (light bulb). DOM only.
   */
  #markPresets() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const presets = getLightPresets();
    const locations = new Map((getStageIndex()?.locations ?? []).map(l => [l.key, l]));
    const baseLabel = game.i18n.localize("STAGECRAFT.Browser.BaseVariant");
    for ( const tile of this.element.querySelectorAll(".stage-tile[data-key]") ) {
      const location = locations.get(tile.dataset.key);
      const lit = (location?.variants ?? []).filter(v => presets[presetKey({locationKey: location.key,
        variant: v.variant})]);
      tile.classList.toggle("has-lights", lit.length > 0);
      const badge = tile.querySelector(".stage-tile-lights");
      if ( badge ) badge.dataset.tooltipText = (location?.variants.length ?? 0) > 1
        ? game.i18n.format("STAGECRAFT.Lights.PresetVariants", {variants: lit.map(v => v.variant ?? baseLabel)
          .join(", ")})
        : game.i18n.localize("STAGECRAFT.Lights.Preset");
      const litPaths = new Set(lit.map(v => v.preferred.path));
      for ( const button of tile.querySelectorAll(".stage-tile-variants button") ) {
        const has = litPaths.has(button.dataset.path);
        button.classList.toggle("has-lights", has);
        if ( has ) button.setAttribute("aria-description", game.i18n.localize("STAGECRAFT.Lights.Preset"));
        else button.removeAttribute("aria-description");
      }
    }
  }

  /**
   * Before a switch, with the setting "cardsOnStageSwitch" on "ask" and cards shown: end the dialog (hide the
   * cards) with the switch, keep the cards, or stay.
   * @param {string} path  The image to switch to.
   * @returns {Promise<boolean|null|undefined>}  Whether to end the dialog; null: do not switch; undefined: the
   *   setting decides (switchStage).
   */
  async #askEndDialog(path) {
    if ( getSetting("cardsOnStageSwitch") !== "ask" ) return undefined;
    const count = getShownCards().cards.length;
    if ( !count || (getStageSrc() === path) ) return false;
    const choice = await DialogV2.wait({
      window: {title: "STAGECRAFT.CardsOnStageSwitch.Title", icon: "fa-solid fa-comment-slash"},
      classes: [MODULE_ID, "stage-end-dialog"],
      position: {width: 460},
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("STAGECRAFT.CardsOnStageSwitch.Text", {count}))}</p>`,
      buttons: [
        {action: "end", label: "STAGECRAFT.CardsOnStageSwitch.End", icon: "fa-solid fa-comment-slash", default: true},
        {action: "keep", label: "STAGECRAFT.CardsOnStageSwitch.Keep", icon: "fa-solid fa-address-card"},
        {action: "cancel", label: "STAGECRAFT.Lights.Cancel", icon: "fa-solid fa-xmark"}
      ],
      rejectClose: false
    });
    if ( (choice === "end") || (choice === "keep") ) return choice === "end";
    return null;
  }

  /**
   * Notice about the stage scene: none chosen, Lock View settings that fight the view lock, or not active
   * (players then do not see a switch).
   * @returns {{text: string, action: string, icon: string, label: string}|null}
   */
  #stageNotice() {
    const scene = getStageScene();
    if ( !scene ) return {
      text: game.i18n.localize("STAGECRAFT.Stage.NoScene"),
      action: "setupStageScene", icon: "fa-gear", label: game.i18n.localize("STAGECRAFT.Stage.Setup")
    };
    if ( getLockViewConflicts(scene).length ) return {
      text: game.i18n.localize("STAGECRAFT.LockView.Notice"),
      action: "setupStageScene", icon: "fa-unlock", label: game.i18n.localize("STAGECRAFT.LockView.Check")
    };
    if ( !scene.active ) return {
      text: game.i18n.format("STAGECRAFT.Stage.Inactive", {name: scene.name}),
      action: "activateStageScene", icon: "fa-bullseye", label: game.i18n.localize("STAGECRAFT.Stage.Activate")
    };
    return null;
  }

  /**
   * Mark the tile and the variant the stage scene shows: class "current" on the tile, `aria-current` on its buttons.
   * DOM only, so a switch does not re-render the grid.
   */
  #markCurrent() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const current = getCurrentStage();
    for ( const tile of this.element.querySelectorAll(".stage-tile[data-key]") ) {
      const isCurrent = Boolean(current?.locationKey) && (tile.dataset.key === current.locationKey);
      tile.classList.toggle("current", isCurrent);
      for ( const button of tile.querySelectorAll("[data-action=selectStage]") ) {
        const onStage = isCurrent && (button.classList.contains("stage-tile-preview")
          || (button.dataset.path === current.variantPath));
        if ( onStage ) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      }
    }
  }

  /**
   * Show each tile's stage name (or its file name if none is set) in the overlay name button.
   * A set name is marked by colour and the players icon; the tooltip then names the file.
   */
  #applyStageNames() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const names = getStageNames();
    for ( const button of this.element.querySelectorAll(".stage-tile-name[data-action=renameStage]") ) {
      const key = button.closest(".stage-tile")?.dataset.key;
      const fileName = button.dataset.fileName ?? "";
      const stageName = key ? names[key] : undefined;
      const shown = stageName ?? fileName;
      button.classList.toggle("custom", Boolean(stageName));
      button.querySelector(".stage-tile-name-text").textContent = shown;
      button.setAttribute("aria-label", game.i18n.format("STAGECRAFT.Stage.RenameLabel", {name: shown}));
      button.dataset.tooltipText = stageName
        ? game.i18n.format("STAGECRAFT.Stage.NameTooltip", {file: fileName})
        : game.i18n.localize("STAGECRAFT.Stage.NameTooltipUnset");
    }
  }

  /**
   * Mark the tile buttons of the image being switched to as busy; clear the mark when the switch ends.
   * @param {string|null} path
   */
  #showSwitching(path) {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    for ( const button of this.element.querySelectorAll("[data-action=selectStage]") ) {
      if ( path && (button.dataset.path === path) ) button.setAttribute("aria-busy", "true");
      else button.removeAttribute("aria-busy");
    }
  }

  /**
   * Text of the notice after a scan, or null if there is nothing to review.
   * @returns {string|null}
   */
  #noticeText() {
    const review = getTagReview();
    if ( !review ) return null;
    const items = [];
    if ( review.suggestions.length ) {
      items.push(game.i18n.format("STAGECRAFT.Browser.ReviewSuggestions", {count: review.suggestions.length}));
    }
    const orphans = review.moves.length + review.lost.length;
    if ( orphans ) items.push(game.i18n.format("STAGECRAFT.Browser.ReviewOrphans", {count: orphans}));
    if ( !items.length ) return null;
    return game.i18n.format("STAGECRAFT.Browser.ReviewNotice", {items: items.join(", ")});
  }

  /** @this {StageBrowser} */
  static #onOpenTagReview() {
    TagReview.open();
  }

  /** @this {StageBrowser} */
  static #onSetupStageScene() {
    StageSceneConfig.open();
  }

  /**
   * A click on the tile name: the stage settings of this location (see #editStage).
   * @this {StageBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRenameStage(event, target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    if ( key ) await this.#editStages([key]);
  }

  /**
   * "Rename" in the selection bar: the stage name of the selected locations.
   * @this {StageBrowser}
   */
  static async #onRenameSelection() {
    await this.#editStages(this._selectedKeys());
  }

  /** @override */
  _tileContextOptions() {
    return [{
      label: "STAGECRAFT.Stage.ChangeName",
      icon: "fa-solid fa-signature",
      onClick: (event, tile) => this.#editStages(this._contextKeys(tile))
    }];
  }

  /** @override */
  _selectionActions() {
    return [{action: "renameSelection", icon: "fa-solid fa-signature", label: "STAGECRAFT.Stage.Rename"}];
  }

  /**
   * Edit the stage settings of one location (name and bar colours), or the stage name of several at once.
   * @param {string[]} keys  Location keys.
   */
  async #editStages(keys) {
    const locations = getStageIndex()?.locations.filter(l => keys.includes(l.key)) ?? [];
    if ( locations.length === 1 ) return this.#editStage(locations[0]);
    if ( locations.length ) return this.#editStageNames(locations);
  }

  /**
   * One stage name for several locations. Prefilled if they all share one; empty = default for all.
   * @param {import("../lib/filenames.mjs").StageLocation[]} locations
   */
  async #editStageNames(locations) {
    const escape = foundry.utils.escapeHTML;
    const id = "stagecraft-stage-names";
    const names = getStageNames();
    const current = new Set(locations.map(l => names[l.key] ?? ""));
    const value = (current.size === 1) ? [...current][0] : "";
    const result = await DialogV2.input({
      window: {title: game.i18n.format("STAGECRAFT.Stage.RenameManyTitle", {count: locations.length}),
        icon: "fa-solid fa-signature"},
      classes: [MODULE_ID, "stage-edit-dialog"],
      position: {width: 460},
      content: `<div class="form-group stacked">
          <label for="${id}-name">${escape(game.i18n.localize("STAGECRAFT.Stage.NameLabel"))}</label>
          <input type="text" id="${id}-name" name="stageName" value="${escape(value)}"
                 maxlength="100" autocomplete="off" autofocus aria-describedby="${id}-name-hint">
          <p class="hint" id="${id}-name-hint">${escape(game.i18n.format("STAGECRAFT.Stage.NameManyHint",
            {count: locations.length}))}</p>
        </div>`,
      ok: {label: "STAGECRAFT.Stage.NameSave", icon: "fa-solid fa-check"},
      rejectClose: false
    });
    if ( !result ) return;
    try {
      await setStageName(locations.map(l => l.key), String(result.stageName ?? ""));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * Stage settings of one location: the stage name players see (prefilled with the current one or the file name;
   * empty = default), where the cards stand on this stage (empty = the default position) and, per variant, the bar
   * colour (empty = automatic from the image edges).
   * @param {import("../lib/filenames.mjs").StageLocation} location
   */
  async #editStage(location) {
    const key = location.key;
    const fileName = location.name;
    const escape = foundry.utils.escapeHTML;
    const t = (k, data) => escape(data ? game.i18n.format(k, data) : game.i18n.localize(k));
    const id = "stagecraft-stage-edit";
    const colors = getStageColors();
    const variants = location.variants.map((v, i) => ({
      key: variantKey(location.key, v.variant),
      label: v.variant ?? game.i18n.localize("STAGECRAFT.Browser.BaseVariant"),
      field: `color${i}`
    }));
    const colorRows = variants.map(v => `<div class="form-group">
        <label for="${id}-${v.field}">${escape(v.label)}</label>
        <div class="form-fields">
          <color-picker id="${id}-${v.field}" name="${v.field}" value="${escape(colors[v.key] ?? "")}"
                        placeholder="${t("STAGECRAFT.Stage.ColorAuto")}"></color-picker>
        </div>
      </div>`).join("");
    // Card position: the stage's own, or the default (empty value).
    const ownPosition = getCardPositions()[key] ?? "";
    const defaultLabel = game.i18n.format("STAGECRAFT.Stage.CardPositionDefault", {
      position: game.i18n.localize(`STAGECRAFT.CardPosition.${getSetting("cardPosition")}`)
    });
    const positionOptions = [["", defaultLabel], ...CARD_POSITIONS.map(p => [p,
      game.i18n.localize(`STAGECRAFT.CardPosition.${p}`)])]
      .map(([value, label]) => `<option value="${value}" ${value === ownPosition ? "selected" : ""}>${escape(label)}</option>`)
      .join("");
    const result = await DialogV2.input({
      window: {title: "STAGECRAFT.Stage.RenameTitle", icon: "fa-solid fa-sliders"},
      classes: [MODULE_ID, "stage-edit-dialog"],
      position: {width: 460},
      content: `<div class="form-group stacked">
          <label for="${id}-name">${t("STAGECRAFT.Stage.NameLabel")}</label>
          <input type="text" id="${id}-name" name="stageName" value="${escape(getStageNames()[key] ?? fileName)}"
                 maxlength="100" autocomplete="off" autofocus aria-describedby="${id}-name-hint">
          <p class="hint" id="${id}-name-hint">${t("STAGECRAFT.Stage.NameHint", {file: fileName})}</p>
        </div>
        <div class="form-group stacked">
          <label for="${id}-position">${t("STAGECRAFT.Stage.CardPositionLabel")}</label>
          <select id="${id}-position" name="cardPosition" aria-describedby="${id}-position-hint">${positionOptions}</select>
          <p class="hint" id="${id}-position-hint">${t("STAGECRAFT.Stage.CardPositionHint")}</p>
        </div>
        <fieldset>
          <legend>${t("STAGECRAFT.Stage.ColorLegend")}</legend>
          <p class="hint">${t("STAGECRAFT.Stage.ColorHint")}</p>
          ${colorRows}
        </fieldset>`,
      ok: {label: "STAGECRAFT.Stage.NameSave", icon: "fa-solid fa-check"},
      rejectClose: false
    });
    if ( !result ) return;
    try {
      await setStageName(key, String(result.stageName ?? ""));
      await setStageColors(Object.fromEntries(variants.map(v => [v.key, result[v.field] || null])));
      if ( (result.cardPosition ?? "") !== ownPosition ) await setCardPosition(key, result.cardPosition || null);
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {StageBrowser} */
  static async #onActivateStageScene() {
    await getStageScene()?.activate();
  }

  /** @this {StageBrowser} */
  static async #onSavePreset() {
    try {
      await saveStagePreset();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {StageBrowser} */
  static #onCloseNotice() {
    this.#notice = false;
    this.render({parts: ["notice"]});
  }

  /**
   * Show a stage variant on the stage scene (see stage-scene.mjs), or select the tile in selection mode.
   * @this {StageBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onSelectStage(event, target) {
    // Alt/Option: tag editor for this image. Shift on a variant button: large preview while held.
    // Selection mode, Ctrl/Cmd or Shift on the image: select the tile instead.
    if ( this._tagEditorClick(event, target) || this._variantPeekClick(event, target)
      || this._selectionClick(event, target) ) return;
    const path = target.dataset.path;
    if ( !path ) return;
    try {
      if ( !(await confirmLights(path)) ) return;
      const endDialog = await this.#askEndDialog(path);
      if ( endDialog === null ) return;
      await switchStage(path, {endDialog}); // Accepts only paths from the index.
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }
}
