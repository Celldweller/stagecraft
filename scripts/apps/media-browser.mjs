/**
 * Shared base of the stage browser and the card browser (GM only): image tiles with tag labels, filter bar with
 * suggestions and chips, selection for tagging, rescan, thumbnails.
 *
 * Rendering notes:
 * - Tiles show thumbnails from the cache folder only (see thumbnails.mjs). A tile without thumbnail shows a
 *   placeholder until its thumbnail is created in the background; originals are loaded only if that fails.
 * - Tiles beyond the first screenful get `content-visibility: auto` (see styles/stagecraft.css).
 * - Filtering only toggles `hidden` on existing tiles (the stage browser also swaps the shown variant);
 *   it never re-renders the grid. The logic lives in lib/filter.mjs.
 * - All file and folder names reach the DOM through escaped Handlebars output `{{ }}` only.
 * - DOM updates outside `_onRender` check `this.element?.isConnected`, not `this.rendered`: the latter is false
 *   while any part re-renders.
 *
 * Subclasses set `static KIND`, the parts, their own actions, and implement `_prepareTiles`.
 */
import { MODULE_ID } from "../constants.mjs";
import { indexOf } from "../media-index.mjs";
import { getSetting, setSetting } from "../settings.mjs";
import {
  chipId, collectFilterValues, exactFilter, matchesFilter, normalizeChips, normalizeScopes, parseFilterInput,
  queryTerms, shownVariant, suggestFilters
} from "../lib/filter.mjs";
import { splitTag, tagKind } from "../lib/tags.mjs";
import { TAGS_HOOK } from "../tag-store.mjs";
import { TagEditor } from "./tag-editor.mjs";
import { TileTagFitter } from "./tile-tag-fit.mjs";
import { hideImagePeek, showImagePeek } from "./image-peek.mjs";
import {
  THUMBNAILS_HOOK, getThumbnailStatus, getTileImage, loadThumbnails, requestThumbnails
} from "../thumbnails.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Tiles rendered without deferral; roughly the first screenful at default window size. */
export const EAGER_TILES = 24;

/** @param {import("../thumbnails.mjs").ThumbnailStatus} status */
function thumbState(status) {
  return `${status.loaded}|${status.unavailable}`;
}

/**
 * Display data of a tag label: the value as text, the full tag as tooltip, the prefix for the colour.
 * @param {string} tag
 */
export function tagLabel(tag) {
  return {tag, text: splitTag(tag).value, kind: tagKind(tag)};
}

/**
 * Variants of a location (stage) or person (card): buttons for the tile and entries for the filter record.
 * @param {import("../lib/filenames.mjs").StageLocation} location
 * @returns {{buttons: {label: string, path: string, isBase: boolean}[],
 *   records: {key: string, label: string, path: string}[]}}
 */
export function tileVariants(location) {
  const baseLabel = game.i18n.localize("STAGECRAFT.Browser.BaseVariant");
  const buttons = location.variants.map(v => ({
    label: v.variant ?? baseLabel,
    path: v.preferred.path,
    isBase: v.variant === null
  }));
  const records = location.variants.map((v, i) => ({
    key: v.variant === null ? "" : v.variant.toLocaleLowerCase("en"), label: buttons[i].label, path: buttons[i].path
  }));
  return {buttons, records};
}

/** Icons of the chip types, the same as the tile badges. */
const CHIP_ICONS = Object.freeze({tag: "fa-tags", variant: "fa-layer-group"});

/** Hook fired when the pinned chips changed (world setting, any GM). */
const PINNED_HOOK = `${MODULE_ID}.pinnedFiltersUpdated`;

/**
 * Remove a tile's image, so the dummy shows (the thumbnail is not there yet).
 * @param {HTMLElement} media
 */
export function clearImage(media) {
  media.querySelector("img")?.remove();
}

/**
 * Put an image into a tile's media box, or replace an earlier one. The image goes right after the dummy icon,
 * so it covers the icon once loaded and stays below the badge. Built with DOM properties, never HTML strings.
 * @param {HTMLElement} media
 * @param {string} url
 */
export function showImage(media, url) {
  let img = media.querySelector("img");
  if ( !img ) {
    img = document.createElement("img");
    Object.assign(img, {alt: "", width: 320, height: 180, loading: "lazy", decoding: "async"});
    const dummy = media.querySelector(".stage-tile-dummy");
    if ( dummy ) dummy.after(img);
    else media.prepend(img);
  }
  img.src = url;
}

export class MediaBrowser extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "media-browser"],
    tag: "section",
    window: {resizable: true},
    position: {width: 960, height: 720},
    actions: {
      rescan: MediaBrowser.#onRescan,
      toggleTile: MediaBrowser.#onToggleTile,
      pinChip: MediaBrowser.#onPinChip,
      removeChip: MediaBrowser.#onRemoveChip,
      toggleSelecting: MediaBrowser.#onToggleSelecting,
      clearSelection: MediaBrowser.#onClearSelection,
      selectAll: MediaBrowser.#onSelectAll,
      editTags: MediaBrowser.#onEditTags,
      toggleHeaderSetting: MediaBrowser.#onToggleHeaderSetting
    }
  };

  /** Which index the browser shows. @type {"stages"|"cards"} */
  static KIND = "stages";

  /** Localization section with this browser's own texts; missing keys fall back to "Browser". */
  static I18N = "Browser";

  /** Search scopes offered in the scope popover. */
  static SCOPES = ["name", "variants", "tags", "folders"];

  /** Open the single instance of this browser, or bring it to the front. */
  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if ( existing ) return existing.render({force: true});
    return new this().render({force: true});
  }

  /** Current search query; kept across re-renders. */
  #query = "";

  /** Whether a rescan is running. */
  #scanning = false;

  /** Hook ids, removed on close. */
  #hookIds = [];

  /** Thumbnail state the grid was rendered with; a change re-renders the grid once. */
  #renderedThumbState = "";

  /** Selected tile keys (for tagging); kept across re-renders, cleared on close. */
  #selected = new Set();

  /** Key of the last single selection; the start of a Shift+click range. */
  #anchor = null;

  /** Selection mode: a plain click selects instead of the browser's main action. */
  #selecting = false;

  /** @type {import("../lib/filter.mjs").Chip[]|null}  Active chips; the pinned ones on first render. */
  #chips = null;

  /** @type {Map<string, import("../lib/filter.mjs").FilterRecord>}  Filter data by tile key. */
  #records = new Map();

  /** Fits the tag labels of each tile into one line. */
  #tagFitter = new TileTagFitter();

  /** @type {ReturnType<typeof collectFilterValues>}  Tags (and variants) with counts, for suggestions. */
  #filterValues = [];

  /** Current suggestions and the highlighted one (-1 = none). */
  #suggestions = [];
  #active = -1;

  /** @returns {"stages"|"cards"} */
  get kind() {
    return this.constructor.KIND;
  }

  /** The index behind this browser. */
  get mediaIndex() {
    return indexOf(this.kind);
  }

  /** Prefix of element ids, so both browsers can be open at once. */
  get idPrefix() {
    return `${MODULE_ID}-${(this.kind === "cards") ? "card" : "stage"}`;
  }

  /**
   * Localize a browser text: this browser's own section first, then the shared "Browser" section.
   * @param {string} key
   * @param {object} [data]
   * @returns {string}
   */
  _t(key, data) {
    const own = `STAGECRAFT.${this.constructor.I18N}.${key}`;
    const id = game.i18n.has(own) ? own : `STAGECRAFT.Browser.${key}`;
    return data ? game.i18n.format(id, data) : game.i18n.localize(id);
  }

  /** Pinned chips of this browser. */
  #pinnedChips() {
    return normalizeChips(getSetting("pinnedFilters")?.[this.kind]);
  }

  /**
   * Tiles and filter records of the index. Implemented by the subclasses.
   * @abstract
   * @param {import("../media-index.mjs").MediaIndexData|null} index
   * @param {{selected: Set<string>}} state
   * @returns {{tiles: object[], records: Map<string, import("../lib/filter.mjs").FilterRecord>}}
   */
  _prepareTiles(index, state) {
    throw new Error("A subclass must implement _prepareTiles");
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const index = this.mediaIndex.get();
    const {root} = this.mediaIndex.location();
    const keys = new Set((index?.locations ?? []).map(l => l.key));
    for ( const key of this.#selected ) if ( !keys.has(key) ) this.#selected.delete(key);
    this.#chips ??= this.#pinnedChips();
    const {tiles, records} = this._prepareTiles(index, {selected: this.#selected});
    this.#records = records;
    this.#renderedThumbState = thumbState(getThumbnailStatus());
    this.#filterValues = collectFilterValues([...records.values()]);
    const scopes = normalizeScopes(getSetting("searchScopes"));
    const pinned = new Set(this.#pinnedChips().map(chipId));
    return Object.assign(context, {
      idPrefix: this.idPrefix,
      searchPlaceholder: this._t("SearchPlaceholder"),
      filterHint: this._t("FilterHint"),
      infoTooltip: this.#infoTooltip(index),
      selectModeHint: this._t("SelectModeHint"),
      scopes: this.constructor.SCOPES.map(key => ({
        key, checked: scopes[key], label: game.i18n.localize(`STAGECRAFT.Filter.Scope.${key}`)
      })),
      chips: this.#chips.map(chip => {
        const isPinned = pinned.has(chipId(chip));
        return {
          ...chip,
          kind: (chip.type === "tag") ? tagLabel(chip.value).kind : "variant",
          icon: CHIP_ICONS[chip.type],
          typeLabel: game.i18n.localize(`STAGECRAFT.Filter.Type.${chip.type}`),
          pinned: isPinned,
          pinLabel: game.i18n.format(isPinned ? "STAGECRAFT.Filter.Unpin" : "STAGECRAFT.Filter.Pin", {value: chip.value}),
          removeLabel: game.i18n.format("STAGECRAFT.Filter.Remove", {value: chip.value})
        };
      }),
      tiles,
      total: tiles.length,
      hasRoot: Boolean(root),
      hasIndex: Boolean(index),
      noRoot: this._t("NoRoot"),
      noIndex: this._t("NoIndex"),
      noImages: this._t("NoImages"),
      scanning: this.#scanning,
      selecting: this.#selecting,
      selectedCount: this.#selected.size,
      selectionActions: this._selectionActions(),
      headerActions: this._headerActions(),
      headerToggles: this._headerToggles().map(t => ({...t, checked: Boolean(getSetting(t.setting)),
        tooltip: this.#toggleTooltip(t)})),
      showSelection: this.#selecting || (this.#selected.size > 0),
      query: this.#query,
      truncated: index?.truncated ?? false,
      errorCount: index?.errors?.length ?? 0
    });
  }

  /**
   * Hooks of the subclass, registered on first render and removed on close.
   * @returns {Array<[string, Function]>}
   */
  _browserHooks() {
    return [];
  }

  /** Parts re-rendered when the stored tags change. */
  _tagParts() {
    return ["grid"];
  }

  /**
   * The index changed (scan, cache restore, settings). Re-renders by default.
   * @param {import("../media-index.mjs").MediaIndexData|null} index
   */
  _onIndexUpdated(index) {
    this.render();
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._createContextMenu(() => this.#tileContextOptions(), ".stage-tile", {fixed: true});
    // Escape with a menu of the window open (search scopes, card position) closes only that menu: Foundry would
    // otherwise close the whole window, menu and all.
    this.element.addEventListener("keydown", event => {
      if ( event.key !== "Escape" ) return;
      const open = this.element.querySelector("[popover]:popover-open");
      if ( !open ) return;
      event.preventDefault();
      event.stopPropagation();
      this._closePopover(open);
    });
    const hooks = [
      [this.mediaIndex.hook, index => this._onIndexUpdated(index)],
      [THUMBNAILS_HOOK, (status, change) => this.#onThumbnailsUpdated(status, change)],
      [TAGS_HOOK, () => this.render({parts: this._tagParts()})],
      [PINNED_HOOK, () => this.render({parts: ["filters"]})],
      [`${MODULE_ID}.collapseSidebarUpdated`, () => this.#markHeaderToggles()],
      ...this._browserHooks()
    ];
    this.#hookIds = hooks.map(([hook, fn]) => [hook, Hooks.on(hook, fn)]);
    this.#loadThumbnails();
  }

  /** List the cache folder (once) and create missing thumbnails in the background. */
  #loadThumbnails() {
    loadThumbnails().then(() => requestThumbnails()).catch(err => {
      console.error(`${MODULE_ID} | Thumbnail cache could not be read:`, err);
    });
  }

  /**
   * After the grid rendered; for DOM marks of the subclass.
   * @protected
   */
  _onRenderGrid() {}

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( options.parts.includes("header") ) this.#bindFilterInput();
    this.#applyFilter();
    this.#showThumbnailProgress(getThumbnailStatus());
    this.element.classList.toggle("selecting", this.#selecting);
    if ( options.parts.includes("grid") ) {
      const grid = this.element.querySelector(".stage-browser-grid");
      if ( grid ) {
        this.#tagFitter.attach(grid, this.element.querySelector(".stage-browser-body"), EAGER_TILES);
        this.#bindVariantPreview(grid);
      }
      else this.#tagFitter.detach();
      this._onRenderGrid();
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#tagFitter.detach();
    hideImagePeek();
    this.#selected.clear();
    this.#anchor = null;
    this.#selecting = false;
    this.#chips = null;
    for ( const [hook, id] of this.#hookIds ) Hooks.off(hook, id);
    this.#hookIds = [];
  }

  /**
   * React to thumbnail progress without re-rendering: swap in new thumbnails and update the progress bar.
   * @param {import("../thumbnails.mjs").ThumbnailStatus} status
   * @param {{path: string, url: string}|null} change
   */
  #onThumbnailsUpdated(status, change) {
    if ( !this.element?.isConnected ) return;
    // The listing was dropped (cache location or generation changed): read the new folder and fill it.
    if ( !status.loaded ) this.#loadThumbnails();
    // First listing, changed cache location or upload failure: render the grid once.
    if ( thumbState(status) !== this.#renderedThumbState ) this.render({parts: ["grid"]});
    else if ( change ) {
      for ( const media of this.element.querySelectorAll(".stage-tile-media[data-original]") ) {
        if ( media.dataset.original === change.path ) showImage(media, change.url);
      }
    }
    this.#showThumbnailProgress(status);
  }

  /** @param {import("../thumbnails.mjs").ThumbnailStatus} status */
  #showThumbnailProgress(status) {
    const box = this.element.querySelector("[data-role=thumbs]");
    if ( !box ) return;
    box.hidden = !status.running;
    const progress = box.querySelector("progress");
    progress.max = Math.max(status.total, 1);
    progress.value = status.done + status.failed;
    box.querySelector("[data-role=thumbs-count]").textContent = game.i18n.format("STAGECRAFT.Thumbs.Progress", {
      done: status.done + status.failed, total: status.total
    });
  }

  /* -------------------------------------------- */
  /*  Filter bar                                  */
  /* -------------------------------------------- */

  /** Wire the search field, its suggestion list and the scope checkboxes (after the header rendered). */
  #bindFilterInput() {
    const input = this.element.querySelector("input[type=search]");
    const list = this.element.querySelector(".stage-filter-suggestions");
    if ( !input || !list ) return;
    const apply = foundry.utils.debounce(() => this.#applyFilter(), 150);
    input.addEventListener("input", () => {
      this.#query = input.value;
      this.#updateSuggestions();
      apply();
    });
    input.addEventListener("keydown", event => this.#onFilterKeydown(event));
    input.addEventListener("blur", () => this.#closeSuggestions());
    input.addEventListener("focus", () => this.#updateSuggestions());
    // Keep the focus in the input while a suggestion is clicked.
    list.addEventListener("mousedown", event => event.preventDefault());
    list.addEventListener("click", event => {
      const option = event.target.closest("[role=option]");
      if ( option ) this.#addChip(this.#suggestions[Number(option.dataset.index)]);
    });
    for ( const box of this.element.querySelectorAll("input[name=scope]") ) {
      box.addEventListener("change", () => {
        const scopes = normalizeScopes(getSetting("searchScopes"));
        scopes[box.value] = box.checked;
        setSetting("searchScopes", scopes);
        this.#applyFilter();
      });
    }
  }

  /**
   * Arrow keys move through the suggestions, Enter takes one (or an exact `#…`/`/…` match), Esc closes the list.
   * @param {KeyboardEvent} event
   */
  #onFilterKeydown(event) {
    const open = this.#suggestions.length > 0;
    switch ( event.key ) {
      case "ArrowDown":
      case "ArrowUp": {
        if ( !open ) return;
        event.preventDefault();
        const step = (event.key === "ArrowDown") ? 1 : -1;
        const n = this.#suggestions.length;
        this.#active = (this.#active < 0) ? (step > 0 ? 0 : n - 1) : (this.#active + step + n) % n;
        this.#renderSuggestions();
        return;
      }
      case "Enter": {
        event.preventDefault();
        if ( open && (this.#active >= 0) ) return this.#addChip(this.#suggestions[this.#active]);
        const chip = exactFilter(this.#filterValues, parseFilterInput(this.#query));
        if ( chip ) this.#addChip(chip);
        else this.#updateSuggestions(); // Nothing matches exactly: the list stays open.
        return;
      }
      case "Escape":
        if ( !open ) return;
        // Close only the list, not the window.
        event.preventDefault();
        event.stopPropagation();
        this.#closeSuggestions();
    }
  }

  /** Recompute the suggestions for the current input. */
  #updateSuggestions() {
    this.#suggestions = suggestFilters(this.#filterValues, parseFilterInput(this.#query), {chips: this.#chips ?? []});
    this.#active = -1;
    this.#renderSuggestions();
  }

  #closeSuggestions() {
    this.#suggestions = [];
    this.#active = -1;
    this.#renderSuggestions();
  }

  /** Show the suggestions as listbox options. Built with DOM properties; values are text, never HTML. */
  #renderSuggestions() {
    const input = this.element.querySelector("input[type=search]");
    const list = this.element.querySelector(".stage-filter-suggestions");
    if ( !input || !list ) return;
    const options = this.#suggestions.map((suggestion, i) => {
      const li = document.createElement("li");
      li.id = `${this.idPrefix}-suggestion-${i}`;
      li.setAttribute("role", "option");
      li.dataset.index = String(i);
      li.dataset.type = suggestion.type;
      li.setAttribute("aria-selected", String(i === this.#active));
      const icon = document.createElement("i");
      icon.className = `fa-solid ${CHIP_ICONS[suggestion.type]}`;
      icon.setAttribute("aria-hidden", "true");
      const type = document.createElement("span");
      type.className = "stagecraft-visually-hidden";
      type.textContent = `${game.i18n.localize(`STAGECRAFT.Filter.Type.${suggestion.type}`)}:`;
      const text = document.createElement("span");
      text.className = "stage-filter-suggestion-text";
      text.textContent = suggestion.value;
      const count = document.createElement("span");
      count.className = "stage-filter-suggestion-count";
      count.textContent = String(suggestion.count);
      li.append(icon, type, text, count);
      return li;
    });
    list.replaceChildren(...options);
    list.hidden = !options.length;
    input.setAttribute("aria-expanded", String(options.length > 0));
    if ( this.#active >= 0 ) {
      input.setAttribute("aria-activedescendant", `${this.idPrefix}-suggestion-${this.#active}`);
      options[this.#active].scrollIntoView({block: "nearest"});
    }
    else input.removeAttribute("aria-activedescendant");
  }

  /**
   * Add a chip (from a suggestion or an exact match), clear the input and filter.
   * @param {{type: "tag"|"variant", value: string}|undefined} chip
   */
  #addChip(chip) {
    if ( !chip ) return;
    const next = {type: chip.type, value: chip.value};
    if ( !this.#chips.some(c => chipId(c) === chipId(next)) ) this.#chips.push(next);
    this.#query = "";
    const input = this.element.querySelector("input[type=search]");
    if ( input ) input.value = "";
    this.#closeSuggestions();
    this.render({parts: ["filters"]});
  }

  /**
   * Remove a chip from the current filter. A pinned chip stays pinned and is set again next time.
   * @this {MediaBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onRemoveChip(event, target) {
    this.#chips.splice(Number(target.dataset.index), 1);
    this.render({parts: ["filters"]});
  }

  /**
   * Pin a chip (set whenever the browser opens) or unpin it. Stored per browser in a world setting.
   * @this {MediaBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onPinChip(event, target) {
    const chip = this.#chips[Number(target.dataset.index)];
    if ( !chip ) return;
    const stored = getSetting("pinnedFilters") ?? {};
    const pinned = this.#pinnedChips();
    const id = chipId(chip);
    const next = pinned.some(c => chipId(c) === id) ? pinned.filter(c => chipId(c) !== id) : [...pinned, chip];
    const value = {stages: normalizeChips(stored.stages), cards: normalizeChips(stored.cards), [this.kind]: next};
    try {
      await setSetting("pinnedFilters", value);
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * Adjust a matching tile to the filter: show the variant a variant chip asks for, else the base variant.
   * @param {HTMLElement} tile
   * @param {import("../lib/filter.mjs").FilterRecord} record
   * @param {{chips: import("../lib/filter.mjs").Chip[]}} filter
   * @protected
   */
  _applyTileFilter(tile, record, filter) {
    if ( record.variants.length ) this.#showVariant(tile, shownVariant(record, filter.chips) ?? record.variants[0]);
  }

  /**
   * Hovering a variant button previews that variant in its tile; leaving it shows the tile's variant again (the one
   * the preview button selects: the base variant or the one a variant chip asks for). Only the image changes, never
   * what a click on the tile selects. Delegated on the grid, which is new on every render.
   * @param {HTMLElement} grid
   */
  #bindVariantPreview(grid) {
    const variantButton = event => event.target.closest?.(".stage-tile-variants button") ?? null;
    grid.addEventListener("pointerover", event => {
      const button = variantButton(event);
      if ( button ) this.#previewVariant(button.closest(".stage-tile"), button.dataset.path);
    });
    grid.addEventListener("pointerout", event => {
      const button = variantButton(event);
      // Moving on to the next variant button: its pointerover follows in the same task, so nothing flickers.
      if ( button && !button.contains(event.relatedTarget) ) this.#previewVariant(button.closest(".stage-tile"), null);
    });
  }

  /**
   * Show a variant's image in a tile without changing what the tile selects; null shows the tile's variant again.
   * @param {HTMLElement|null} tile
   * @param {string|null} path
   */
  #previewVariant(tile, path) {
    const media = tile?.querySelector(".stage-tile-media");
    const own = tile?.querySelector(".stage-tile-preview")?.dataset.path;
    if ( !media || !own ) return;
    const target = path ?? own;
    if ( media.dataset.original === target ) return;
    // `data-original` also lets a thumbnail generated meanwhile reach the previewed image.
    media.dataset.original = target;
    const url = this._tileImage(target);
    if ( url ) showImage(media, url);
    else clearImage(media);
  }

  /**
   * Make a tile show and select a variant (a variant chip is active), or its base variant again.
   * @param {HTMLElement} tile
   * @param {{label: string, path: string, key: string}} variant
   */
  #showVariant(tile, variant) {
    const preview = tile.querySelector(".stage-tile-preview");
    const media = tile.querySelector(".stage-tile-media");
    if ( !preview || !media || (preview.dataset.path === variant.path) ) return;
    preview.dataset.path = variant.path;
    media.dataset.original = variant.path;
    const url = this._tileImage(variant.path);
    if ( url ) showImage(media, url);
    else clearImage(media);
    for ( const button of tile.querySelectorAll(".stage-tile-variants button") ) {
      button.classList.toggle("shown", button.dataset.path === variant.path);
    }
  }

  /** Show only tiles matching chips and free text, and update the visible count. */
  #applyFilter() {
    const input = parseFilterInput(this.#query);
    const filter = {
      terms: (input.kind === "text") ? queryTerms(input.query) : [], // "#…" and "/…" only suggest
      scopes: normalizeScopes(getSetting("searchScopes")),
      chips: this.#chips ?? []
    };
    let shown = 0;
    const tiles = this.element.querySelectorAll(".stage-tile[data-key]");
    for ( const tile of tiles ) {
      const record = this.#records.get(tile.dataset.key);
      const match = Boolean(record) && matchesFilter(record, filter);
      tile.hidden = !match;
      if ( !match ) continue;
      shown++;
      this._applyTileFilter(tile, record, filter);
    }
    const status = this.element.querySelector("[data-role=count]");
    // While a rescan runs, the count says so (the button is in the window menu, where nothing shows progress).
    if ( status ) status.textContent = this.#scanning ? game.i18n.localize("STAGECRAFT.Browser.Scanning")
      : this._t("Count", {shown, total: tiles.length});
    this._onFilterApplied(filter);
  }

  /**
   * After the tiles were filtered (also after every render): filter further elements of the subclass.
   * @param {{terms: string[], scopes: object, chips: import("../lib/filter.mjs").Chip[]}} filter
   * @protected
   */
  _onFilterApplied(filter) {}

  /**
   * Context menu of a tile: edit the tags of this tile, or of the selection if the tile belongs to it; then the
   * entries of the subclass.
   */
  #tileContextOptions() {
    return [{
      label: "STAGECRAFT.Tags.Edit",
      icon: "fa-solid fa-tags",
      onClick: (event, tile) => TagEditor.open(this._contextKeys(tile), {kind: this.kind})
    }, ...this._tileContextOptions()];
  }

  /**
   * Further context menu entries of a tile; `onClick(event, tile)` gets the tile element (see `_contextKeys`).
   * @returns {object[]}
   * @protected
   */
  _tileContextOptions() {
    return [];
  }

  /**
   * The help behind "i": short sections instead of one paragraph. Every text is escaped; Foundry's tooltip cleans the
   * HTML once more.
   * @param {import("../media-index.mjs").MediaIndexData|null} index
   * @returns {string}  HTML for `data-tooltip-html`.
   */
  #infoTooltip(index) {
    const esc = foundry.utils.escapeHTML;
    const section = (title, items) => `<section><h4>${esc(title)}</h4><ul>${
      items.map(item => `<li>${esc(item)}</li>`).join("")}</ul></section>`;
    const indexItems = [
      index ? game.i18n.format("STAGECRAFT.Browser.ScannedAt", {
        date: new Date(index.scannedAt).toLocaleString(game.i18n.lang, {dateStyle: "medium", timeStyle: "short"})})
        : this._t("NotScanned"),
      game.i18n.localize("STAGECRAFT.Browser.RescanWhere")
    ];
    return section(game.i18n.localize("STAGECRAFT.Browser.InfoSearch"), this._t("InfoSearchItems").split("\n"))
      + section(game.i18n.localize("STAGECRAFT.Browser.InfoIndex"), indexItems);
  }

  /**
   * Close a menu of the window and put the focus back on the button that opened it, so it is not lost with the
   * hidden menu (no focus ring after a pointer click).
   * @param {HTMLElement} popover
   * @param {Event} [event]  The event that closes it; a click with `detail` 0 came from the keyboard.
   * @protected
   */
  _closePopover(popover, event) {
    const trigger = this.element.querySelector(`[popovertarget="${popover.id}"]`);
    if ( popover.contains(document.activeElement) || (event?.type !== "click") ) {
      trigger?.focus({focusVisible: !(event?.type === "click" && event.detail > 0)});
    }
    if ( popover.matches(":popover-open") ) popover.hidePopover();
  }

  /**
   * The window menu (⋮): "Rescan" first, then Foundry's entries. Built anew on every opening, so the label follows
   * a rescan in progress.
   * @inheritDoc
   */
  _getHeaderControls() {
    return [{action: "rescan", icon: "fa-solid fa-arrows-rotate",
      label: this.#scanning ? "STAGECRAFT.Browser.Scanning" : "STAGECRAFT.Browser.Rescan"},
    ...super._getHeaderControls()];
  }

  /**
   * Further buttons of the header, after the search.
   * @returns {{action: string, icon: string, label: string, disabled?: boolean}[]}  `label` is a localization key.
   * @protected
   */
  _headerActions() {
    return [];
  }

  /**
   * On/off switches of the header for world settings of this browser (Boolean), shown as icon buttons.
   * @returns {{setting: string, icon: string, label: string, hint: string}[]}  `setting` is a key of SETTINGS;
   *   `label` and `hint` are localization keys.
   * @protected
   */
  _headerToggles() {
    return [];
  }

  /**
   * Tooltip of a header switch: what it does and whether it is on.
   * @param {{setting: string, label: string, hint: string}} toggle
   */
  #toggleTooltip(toggle) {
    return game.i18n.format(getSetting(toggle.setting) ? "STAGECRAFT.Browser.ToggleOn" : "STAGECRAFT.Browser.ToggleOff",
      {label: game.i18n.localize(toggle.label), hint: game.i18n.localize(toggle.hint)});
  }

  /** Set the header switches to their settings (changed elsewhere, e.g. in the other browser or by another GM). */
  #markHeaderToggles() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    for ( const toggle of this._headerToggles() ) {
      const button = this.element.querySelector(`[data-action=toggleHeaderSetting][data-setting="${toggle.setting}"]`);
      if ( !button ) continue;
      button.setAttribute("aria-pressed", String(Boolean(getSetting(toggle.setting))));
      button.dataset.tooltipText = this.#toggleTooltip(toggle);
    }
  }

  /**
   * A header switch: turn its world setting on or off. Only the browser's own settings are accepted.
   * @this {MediaBrowser}
   * @param {PointerEvent} event
   * @param {HTMLButtonElement} target
   */
  static async #onToggleHeaderSetting(event, target) {
    const setting = target.dataset.setting;
    if ( !this._headerToggles().some(t => t.setting === setting) ) return;
    try {
      await setSetting(setting, !getSetting(setting));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
    this.#markHeaderToggles();
  }

  /**
   * Further buttons of the selection bar after "Edit tags", enabled while something is selected.
   * @returns {{action: string, icon: string, label: string}[]}  `label` is a localization key.
   * @protected
   */
  _selectionActions() {
    return [];
  }

  /**
   * The keys a context menu entry of a tile acts on: the selection if the tile belongs to it, else the tile alone.
   * @param {HTMLElement} tile
   * @returns {string[]}
   * @protected
   */
  _contextKeys(tile) {
    const key = tile.dataset.key;
    return this.#selected.has(key) ? [...this.#selected] : [key];
  }

  /**
   * The selected tile keys.
   * @returns {string[]}
   * @protected
   */
  _selectedKeys() {
    return [...this.#selected];
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  /**
   * Handle an Alt/Option+click on a tile: open the tag editor for just this image, whatever is selected.
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   * @returns {boolean}  Whether the click was handled (the caller then does nothing else).
   * @protected
   */
  _tagEditorClick(event, target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    if ( !key || !event.altKey ) return false;
    event.preventDefault();
    TagEditor.open([key], {kind: this.kind});
    return true;
  }

  /**
   * Handle a Shift+click on a variant button: show that variant large until Shift is released, instead of choosing
   * it (and instead of a range selection, which Shift+click on the image still does).
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   * @returns {boolean}  Whether the click was handled (the caller then does nothing else).
   * @protected
   */
  _variantPeekClick(event, target) {
    if ( !event.shiftKey || !target.closest(".stage-tile-variants") || !target.dataset.path ) return false;
    event.preventDefault();
    const name = this.#records.get(target.closest(".stage-tile")?.dataset.key)?.name ?? "";
    const label = target.textContent.trim();
    showImagePeek({
      original: target.dataset.path,
      thumb: this._tileImage(target.dataset.path),
      caption: label ? `${name} – ${label}` : name
    });
    return true;
  }

  /**
   * Handle a tile click as selection when the selection mode is on or Ctrl/Cmd/Shift is held.
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   * @returns {boolean}  Whether the click was a selection (the caller then does nothing else).
   * @protected
   */
  _selectionClick(event, target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    if ( !key || !(this.#selecting || event.ctrlKey || event.metaKey || event.shiftKey) ) return false;
    event.preventDefault();
    this.#select(key, {range: event.shiftKey});
    return true;
  }

  /**
   * Toggle a tile, or with `range` select every visible tile from the anchor to it.
   * @param {string} key
   * @param {{range?: boolean}} [options]
   */
  #select(key, {range=false} = {}) {
    if ( range && this.#anchor && (this.#anchor !== key) ) {
      const visible = [...this.element.querySelectorAll(".stage-tile[data-key]")].filter(t => !t.hidden)
        .map(t => t.dataset.key);
      const from = visible.indexOf(this.#anchor);
      const to = visible.indexOf(key);
      if ( (from !== -1) && (to !== -1) ) {
        for ( const k of visible.slice(Math.min(from, to), Math.max(from, to) + 1) ) this.#selected.add(k);
        this.#syncSelection();
        return;
      }
    }
    if ( this.#selected.has(key) ) this.#selected.delete(key);
    else this.#selected.add(key);
    this.#anchor = key;
    this.#syncSelection();
  }

  /** Show the selection on the tiles (without re-rendering the grid) and update the selection bar. */
  #syncSelection() {
    this.element.classList.toggle("selecting", this.#selecting);
    for ( const tile of this.element.querySelectorAll(".stage-tile[data-key]") ) {
      const selected = this.#selected.has(tile.dataset.key);
      tile.classList.toggle("selected", selected);
      const box = tile.querySelector(".stage-tile-check");
      if ( box ) box.checked = selected;
    }
    this.render({parts: ["selection"]});
  }

  /**
   * Checkbox on a tile.
   * @this {MediaBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleTile(event, target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    if ( key ) this.#select(key, {range: event.shiftKey});
  }

  /** @this {MediaBrowser} */
  static #onToggleSelecting() {
    this.#selecting = !this.#selecting;
    this.#syncSelection();
  }

  /** @this {MediaBrowser} */
  static #onClearSelection() {
    this.#selected.clear();
    this.#anchor = null;
    this.#syncSelection();
  }

  /**
   * Select every visible tile, so a search narrows what "select all" takes.
   * @this {MediaBrowser}
   */
  static #onSelectAll() {
    for ( const tile of this.element.querySelectorAll(".stage-tile[data-key]") ) {
      if ( !tile.hidden ) this.#selected.add(tile.dataset.key);
    }
    this.#syncSelection();
  }

  /** @this {MediaBrowser} */
  static #onEditTags() {
    if ( this.#selected.size ) TagEditor.open([...this.#selected], {kind: this.kind});
  }

  /**
   * Rescan the folder of this browser.
   * @this {MediaBrowser}
   */
  static async #onRescan() {
    if ( this.#scanning ) return;
    this.#scanning = true;
    await this.render({parts: ["header"]});
    try {
      const index = await this.mediaIndex.rescan();
      ui.notifications.info(this._t("Rescanned", {count: index.entries.length}));
    } catch ( err ) {
      ui.notifications.error(err.message);
    } finally {
      this.#scanning = false;
      this.render();
    }
  }

  /**
   * Thumbnail URL of an original for a tile (or null while it is pending).
   * @param {string} path
   * @returns {string|null}
   * @protected
   */
  _tileImage(path) {
    return getTileImage(path);
  }
}
