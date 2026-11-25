/**
 * Card browser (GM only): one tile per person with tag labels and variant buttons (e.g. "Lyssa Coldrin" and
 * "Lyssa Coldrin (Courtesan)", same variant pattern as the stages). Filter bar, selection, tags, rescan, thumbnails
 * and variant display come from MediaBrowser.
 *
 * The strip "Cast" holds the cards of a scene, shown or hidden (lib/cards.mjs); the players see the shown ones in
 * its order. A click on a tile shows the card (at the insertion marker, or at its place if it is hidden in the cast)
 * or hides it again, it stays in the cast; a click on a variant shows exactly that one (in place of the shown
 * variant). A tile dragged onto the strip, "Add hidden to the cast" in its context menu and in the selection bar put
 * cards into the cast hidden. In the strip a click on a card shows or hides it; its context menu sets the speaker
 * or removes it. Shown cards have the green ring, hidden ones of the cast a faint one and an eye; on a shown card
 * a button marks it as speaking. "Hide all" hides every card of the cast, "Remove all" empties it. The cards
 * themselves are drawn by card-layer.mjs on every client.
 *
 * Planning mode ("Plan" in the header, card-draft.mjs): clicks, the speaking button and the context menu change the
 * draft instead, whose cards have a dashed blue ring; the green ring still shows what the players see. The "Shown"
 * strip becomes the "Draft" strip with "Show" and "Discard".
 *
 * The cards in the strip can be dragged to another place (between two cards, or onto a card: before it on its
 * first half, after it on the second); in planning mode in the draft. Everything the strip does works on the draft
 * in planning mode.
 *
 * Saved dialogs (dialogs.mjs): a list above the strip, collapsed on every opening and only built while open,
 * filtered by the tag chips and the free text like the tiles. A click shows a dialog (with its stage, after the warning about unsaved lights); in planning mode it loads the
 * dialog into the draft, like "Edit" in its context menu (with "Properties" and "Delete"; no buttons on the dialog,
 * so a click during the session can only show it). The strip saves the shown cards or the draft as a new dialog and
 * saves a draft loaded from a dialog back.
 */
import { MODULE_ID } from "../constants.mjs";
import { mergeTagLists, sortTagsForDisplay } from "../lib/tags.mjs";
import { getTagOrder, getTags } from "../tag-store.mjs";
import { EAGER_TILES, MediaBrowser, tagLabel, tileVariants } from "./media-browser.mjs";
import {
  CARDS_HOOK, CARD_LAYOUT_HOOK, MARKER_HOOK, addHiddenToCast, currentCardPosition, currentStageLocation,
  getCardMarker, getShownCards, hideAllCards, moveShownCard, removeAllCards, removeCastCard, setCardMarker,
  setCardPosition, setShownCardHidden, toggleShownCard, toggleSpeakingCard
} from "../card-layer.mjs";
import { getCardIndex, getStageIndex } from "../media-index.mjs";
import { STAGE_SCENE_HOOK, getStageNames } from "../stage-scene.mjs";
import { CARD_POSITIONS } from "../lib/cards.mjs";
import { getSetting } from "../settings.mjs";
import {
  DRAFT_HOOK, DRAFT_MARKER_HOOK, addHiddenToDraft, discardDraft, getDraft, getDraftMarker, isPlanning, moveDraftCard,
  removeDraftCard, setDraftCardHidden, setDraftMarker, showDraft, startDraft, toggleDraftCard, toggleDraftSpeaking
} from "../card-draft.mjs";

/** Icons of the card positions in the picker. */
const POSITION_ICONS = Object.freeze({
  top: "fa-solid fa-arrow-up", bottom: "fa-solid fa-arrow-down", center: "fa-solid fa-arrows-to-dot",
  left: "fa-solid fa-arrow-left", right: "fa-solid fa-arrow-right"
});
import { MAX_SHOWN_CARDS } from "../lib/cards.mjs";
import { dialogMatchesFilter, resolveDialog } from "../lib/dialogs.mjs";
import {
  DIALOGS_HOOK, deleteDialog, dialogCardsFromState, editDialog, getDialog, getDialogs, imageLabel, saveDialog,
  showDialog
} from "../dialogs.mjs";
import { DialogProperties, confirmDelete } from "./dialog-properties.mjs";
import { confirmLights } from "./stage-prompts.mjs";
import { HISTORY_HOOK, getHistory, restoreHistory } from "../card-history.mjs";

/** Card images shown on a dialog in the list; more are counted. */
const DIALOG_THUMBS = 4;

export class CardBrowser extends MediaBrowser {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-card-browser`,
    classes: ["card-browser"],
    window: {
      title: "STAGECRAFT.CardBrowser.Title",
      icon: "fa-solid fa-address-card"
    },
    position: {width: 760, height: 720},
    actions: {
      selectCard: CardBrowser.#onSelectCard,
      toggleSpeaking: CardBrowser.#onToggleSpeaking,
      setCardMarker: CardBrowser.#onSetCardMarker,
      setStageCardPosition: CardBrowser.#onSetStageCardPosition,
      hideAllCards: CardBrowser.#onHideAllCards,
      removeAllCards: CardBrowser.#onRemoveAllCards,
      toggleCastCard: CardBrowser.#onToggleCastCard,
      addHiddenSelection: CardBrowser.#onAddHiddenSelection,
      togglePlanning: CardBrowser.#onTogglePlanning,
      showDraft: CardBrowser.#onShowDraft,
      discardDraft: CardBrowser.#onDiscardDraft,
      showDialog: CardBrowser.#onShowDialog,
      saveAsDialog: CardBrowser.#onSaveAsDialog,
      saveDraftDialog: CardBrowser.#onSaveDraftDialog,
      toggleDialogs: CardBrowser.#onToggleDialogs,
      restoreHistory: CardBrowser.#onRestoreHistory,
      saveHistoryDialog: CardBrowser.#onSaveHistoryDialog
    }
  };

  /** @override */
  static PARTS = {
    header: {template: `modules/${MODULE_ID}/templates/browser/header.hbs`},
    filters: {template: `modules/${MODULE_ID}/templates/browser/filters.hbs`},
    selection: {template: `modules/${MODULE_ID}/templates/browser/selection.hbs`},
    dialogs: {template: `modules/${MODULE_ID}/templates/card-browser/dialogs.hbs`},
    shown: {template: `modules/${MODULE_ID}/templates/card-browser/shown.hbs`},
    grid: {template: `modules/${MODULE_ID}/templates/card-browser/grid.hbs`, scrollable: [""]}
  };

  /** @override */
  static KIND = "cards";

  /** @override */
  static I18N = "CardBrowser";

  /** Cards live in one flat folder: no folder scope. */
  static SCOPES = ["name", "variants", "tags"];

  /** @override */
  _prepareTiles(index, {selected}) {
    const records = new Map();
    const order = getTagOrder();
    const tiles = (index?.locations ?? []).map((card, i) => {
      const files = card.variants.flatMap(v => v.files);
      const all = mergeTagLists(files.map(f => getTags(f.path)));
      const {buttons: variants, records: variantRecords} = tileVariants(card);
      const path = variants[0].path;
      records.set(card.key, {key: card.key, name: card.name, variants: variantRecords, tags: all, folders: []});
      return {
        key: card.key,
        name: card.name,
        selected: selected.has(card.key),
        selectLabel: game.i18n.format("STAGECRAFT.Browser.SelectTile", {name: card.name}),
        speakingLabel: game.i18n.format("STAGECRAFT.CardBrowser.Speaking", {name: card.name}),
        tags: sortTagsForDisplay(all, order).map(tagLabel),
        hasOverlay: (variants.length > 1) || (all.length > 0),
        original: path,
        src: this._tileImage(path),
        variants,
        hasVariants: variants.length > 1,
        variantCount: game.i18n.format("STAGECRAFT.Browser.VariantCount", {count: variants.length}),
        deferred: i >= EAGER_TILES
      };
    });
    return {tiles, records};
  }

  /** @override */
  _browserHooks() {
    return [
      [CARDS_HOOK, () => {
        this.#markShown();
        this.render({parts: ["dialogs", "shown"]});
      }],
      [MARKER_HOOK, () => this.#markMarker()],
      [DRAFT_HOOK, () => {
        this.#markShown();
        this.render({parts: ["dialogs", "shown"]});
      }],
      [DIALOGS_HOOK, () => this.render({parts: ["dialogs", "shown"]})],
      [HISTORY_HOOK, () => this.render({parts: ["shown"]})],
      [DRAFT_MARKER_HOOK, () => this.#markMarker()],
      [CARD_LAYOUT_HOOK, () => this.#markPosition()],
      [STAGE_SCENE_HOOK, () => this.#markPosition()]
    ];
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const planning = isPlanning();
    const state = planning ? getDraft() : getShownCards();
    const names = new Map((getCardIndex()?.locations ?? []).map(l => [l.key, l.name]));
    const marker = planning ? getDraftMarker() : getCardMarker();
    // The saved dialog of the strip: the one shown, or in planning mode the one loaded into the draft.
    const shownDialog = getDialog(getShownCards().dialog);
    const linked = planning ? getDialog(state.dialog) : shownDialog;
    const label = game.i18n.localize(planning ? "STAGECRAFT.Draft.Label" : "STAGECRAFT.CardBrowser.Shown");
    const dialogCount = getDialogs().length;
    return Object.assign(context, {
      planning,
      stripLabel: linked ? game.i18n.format("STAGECRAFT.Dialogs.StripLabel", {label, name: linked.name}) : label,
      stripEmpty: !planning && !state.cards.length,
      anyShown: state.cards.some(c => !c.hidden),
      dialogCount,
      dialogsOpen: this.#dialogsOpen,
      dialogsLabel: game.i18n.format("STAGECRAFT.Dialogs.Toggle", {count: dialogCount}),
      dialogs: this.#dialogsOpen
        ? this.#dialogItems({planning, shown: shownDialog?.id, editing: planning ? linked?.id : null}) : [],
      draftDialog: planning && linked ? {
        hint: game.i18n.format("STAGECRAFT.Dialogs.SaveBackHint", {name: linked.name})
      } : null,
      saveAsLabel: game.i18n.localize(planning && linked ? "STAGECRAFT.Dialogs.SaveAsNew" : "STAGECRAFT.Dialogs.SaveAs"),
      ...this.#historyContext(planning, names),
      shownCards: state.cards.map(card => {
        const name = names.get(card.key) ?? card.key;
        return {
          key: card.key,
          name,
          thumb: this._tileImage(card.path) ?? card.path,
          hidden: Boolean(card.hidden),
          hint: game.i18n.format(card.hidden ? "STAGECRAFT.Cast.HiddenHint" : "STAGECRAFT.Cast.ShownHint", {name}),
          speaking: state.speaking === card.key,
          marked: String(marker === card.key),
          gapLabel: game.i18n.format("STAGECRAFT.CardBrowser.InsertBefore", {name})
        };
      }),
      endMarked: String(marker === null),
      positionPicker: {
        label: game.i18n.localize("STAGECRAFT.CardBrowser.Position"),
        options: CARD_POSITIONS.map(value => ({value, icon: POSITION_ICONS[value],
          label: game.i18n.localize(`STAGECRAFT.CardPosition.${value}`)})),
        defaultLabel: game.i18n.localize("STAGECRAFT.CardBrowser.PositionDefault")
      },
      endLabel: game.i18n.localize("STAGECRAFT.CardBrowser.InsertEnd")
    });
  }

  /** @override */
  _onRenderGrid() {
    this.#markShown();
  }

  /**
   * The history "Recently shown" for the strip's menu, newest first.
   * @param {boolean} planning
   * @param {Map<string, string>} names  Card names by key.
   */
  #historyContext(planning, names) {
    const entries = getHistory();
    const label = game.i18n.localize("STAGECRAFT.History.Label");
    const action = game.i18n.localize(planning ? "STAGECRAFT.History.LoadHint" : "STAGECRAFT.History.RestoreHint");
    return {
      historyLabel: label,
      historyHint: entries.length ? label : game.i18n.localize("STAGECRAFT.History.None"),
      history: entries.map((entry, index) => {
        const list = entry.cards.map(c => names.get(c.key) ?? c.key);
        const dialog = getDialog(entry.dialog);
        return {
          index,
          names: dialog ? dialog.name : list.join(", "),
          time: new Date(entry.at).toLocaleTimeString(game.i18n.lang, {hour: "2-digit", minute: "2-digit"}),
          thumbs: entry.cards.slice(0, DIALOG_THUMBS).map(c => ({src: this._tileImage(c.path), hidden: c.hidden})),
          more: Math.max(0, entry.cards.length - DIALOG_THUMBS),
          hint: `${action} – ${list.join(", ")}`,
          saveLabel: game.i18n.localize("STAGECRAFT.Dialogs.SaveAs")
        };
      })
    };
  }

  /**
   * The saved dialogs for the list, by name, with up to DIALOG_THUMBS card images.
   * @param {{planning: boolean, shown?: string|null, editing?: string|null}} state
   */
  #dialogItems({planning, shown, editing}) {
    const locations = new Map((getCardIndex()?.locations ?? []).map(l => [l.key, l]));
    return getDialogs().map(dialog => {
      const {cards} = resolveDialog(dialog, locations);
      const names = dialog.cards.map(c => imageLabel(c, "cards"));
      const parts = [game.i18n.localize(planning ? "STAGECRAFT.Dialogs.LoadHint" : "STAGECRAFT.Dialogs.ShowHint"),
        game.i18n.localize("STAGECRAFT.Dialogs.MenuHint"), names.join(", ")];
      if ( dialog.stage ) {
        parts.push(game.i18n.format("STAGECRAFT.Dialogs.StageOf", {stage: imageLabel(dialog.stage, "stages")}));
      }
      return {
        id: dialog.id,
        name: dialog.name,
        thumbs: cards.slice(0, DIALOG_THUMBS).map(c => ({src: this._tileImage(c.path), hidden: c.hidden})),
        more: Math.max(0, dialog.cards.length - DIALOG_THUMBS),
        current: dialog.id === shown,
        editing: dialog.id === editing,
        hasStage: Boolean(dialog.stage),
        hint: parts.join(" – ")
      };
    });
  }

  /**
   * Filter the dialog list like the tiles: tag chips and free text (name, tags, card names).
   * @override
   */
  _onFilterApplied(filter) {
    const list = this.element.querySelector(".card-dialogs");
    if ( !list ) return;
    const names = new Map((getCardIndex()?.locations ?? []).map(l => [l.key, l.name]));
    const cardName = key => names.get(key) ?? key;
    let shown = 0;
    const items = list.querySelectorAll(".card-dialog[data-id]");
    for ( const item of items ) {
      const dialog = getDialog(item.dataset.id);
      item.hidden = !dialog || !dialogMatchesFilter(dialog, filter, cardName);
      if ( !item.hidden ) shown++;
    }
    const none = list.querySelector(".card-dialogs-none");
    if ( none ) none.hidden = (shown > 0) || !items.length;
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._createContextMenu(() => this.#dialogContextOptions(), ".card-dialog", {
      fixed: true, hookName: "get{}DialogContextOptions", parentClassHooks: false
    });
    this._createContextMenu(() => this.#castContextOptions(), ".card-shown-card", {
      fixed: true, hookName: "get{}CastContextOptions", parentClassHooks: false
    });
    this.#bindStrip();
  }

  /** The cards the strip and the clicks work on: the draft in planning mode, else the cast the players see. */
  #working() {
    return getDraft() ?? getShownCards();
  }

  /** Run a change of the cast (or the draft) and report a failure. */
  async #run(fn) {
    try {
      return await fn();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * Put cards into the cast (or the draft) hidden, and say if some found no room.
   * @param {{key: string, path: string}[]} cards
   * @param {{before?: string|null}} [options]  Without `before`, the insertion marker.
   */
  async #addHidden(cards, options) {
    if ( !cards.length ) return;
    const left = await this.#run(() => isPlanning() ? addHiddenToDraft(cards, options) : addHiddenToCast(cards, options));
    if ( left ) ui.notifications.warn(game.i18n.format("STAGECRAFT.Cast.Full", {count: left, max: MAX_SHOWN_CARDS}));
  }

  /**
   * The image a card goes into the cast with: the one it has there already, else the one its tile shows.
   * @param {string} key
   * @returns {string|null}
   */
  #pathOf(key) {
    const present = this.#working().cards.find(c => c.key === key);
    if ( present ) return present.path;
    const tile = this.element.querySelector(`.stage-tile[data-key="${CSS.escape(key)}"] .stage-tile-preview`);
    if ( tile?.dataset.path ) return tile.dataset.path;
    return getCardIndex()?.locations.find(l => l.key === key)?.variants[0]?.preferred.path ?? null;
  }

  /**
   * Keys as cards with their image, in the order of the tiles; unknown keys are left out.
   * @param {string[]} keys
   */
  #cardsOf(keys) {
    const wanted = new Set(keys);
    const order = [...this.element.querySelectorAll(".stage-tile[data-key]")].map(t => t.dataset.key)
      .filter(k => wanted.has(k));
    for ( const key of keys ) if ( !order.includes(key) ) order.push(key);
    return order.map(key => ({key, path: this.#pathOf(key)})).filter(c => c.path);
  }

  /** Context menu of a card in the strip: show or hide it, speaker, remove it. */
  #castContextOptions() {
    const card = item => this.#working().cards.find(c => c.key === item.dataset.key);
    const speaking = item => this.#working().speaking === item.dataset.key;
    const setHidden = hidden => (event, item) => this.#run(() => isPlanning()
      ? setDraftCardHidden(item.dataset.key, hidden) : setShownCardHidden(item.dataset.key, hidden));
    const toggleSpeaker = (event, item) => this.#run(() => isPlanning()
      ? toggleDraftSpeaking(item.dataset.key) : toggleSpeakingCard(item.dataset.key));
    return [
      {label: "STAGECRAFT.Cast.Show", icon: "fa-solid fa-eye", visible: item => Boolean(card(item)?.hidden),
        onClick: setHidden(false)},
      {label: "STAGECRAFT.Cast.Hide", icon: "fa-solid fa-eye-slash",
        visible: item => Boolean(card(item)) && !card(item).hidden, onClick: setHidden(true)},
      {label: "STAGECRAFT.CardBrowser.SetSpeaker", icon: "fa-solid fa-comment-dots",
        visible: item => Boolean(card(item)) && !card(item).hidden && !speaking(item), onClick: toggleSpeaker},
      {label: "STAGECRAFT.CardBrowser.EndSpeaker", icon: "fa-solid fa-comment-slash",
        visible: item => speaking(item), onClick: toggleSpeaker},
      {label: "STAGECRAFT.Cast.Remove", icon: "fa-solid fa-xmark", visible: item => Boolean(card(item)),
        onClick: (event, item) => this.#run(() => isPlanning()
          ? removeDraftCard(item.dataset.key) : removeCastCard(item.dataset.key))}
    ];
  }

  /** Context menu of a saved dialog: edit in the draft, properties, delete. */
  #dialogContextOptions() {
    const id = item => item.dataset.id;
    const run = fn => async (event, item) => {
      try {
        await fn(id(item));
      } catch ( err ) {
        ui.notifications.error(err.message);
      }
    };
    return [
      {label: "STAGECRAFT.Dialogs.Edit", icon: "fa-solid fa-pen", onClick: run(editDialog)},
      {label: "STAGECRAFT.Dialogs.Properties", icon: "fa-solid fa-sliders",
        onClick: run(dialogId => DialogProperties.edit(dialogId))},
      {label: "STAGECRAFT.Dialogs.Delete", icon: "fa-solid fa-trash", onClick: run(async dialogId => {
        const dialog = getDialog(dialogId);
        if ( dialog && (await confirmDelete(dialog)) ) await deleteDialog(dialogId);
      })}
    ];
  }

  /** Whether the dialog list is open; closed on every opening of the browser. */
  #dialogsOpen = false;

  /** Focus the list's toggle after the next render of its part (the part re-render replaces the button). */
  #focusDialogsToggle = false;

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    this.#dialogsOpen = false;
    this.#focusDialogsToggle = false;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( options.parts.includes("header") ) this.#markPosition();
    if ( options.parts.includes("dialogs") && this.#focusDialogsToggle ) {
      this.#focusDialogsToggle = false;
      this.element.querySelector(".card-dialogs-toggle")?.focus();
    }
    if ( options.parts.includes("shown") && this.#focusCast ) {
      // The strip was rebuilt after a click on one of its cards: the focus goes back to that card.
      const key = this.#focusCast;
      this.#focusCast = null;
      this.element.querySelector(`.card-shown-card[data-key="${CSS.escape(key)}"]`)?.focus();
    }
  }

  /** Key of the strip card to focus after the strip's next render. */
  #focusCast = null;

  /**
   * What is being dragged: a card of the strip (to move it) or tiles of the grid (to put them into the cast hidden).
   * @type {{kind: "strip", key: string}|{kind: "tiles", cards: {key: string, path: string}[]}|null}
   */
  #drag = null;

  /**
   * Where a card dropped at this point of the strip goes: the key of the card it goes before, "" for the end, or
   * undefined outside a gap or card.
   * @param {DragEvent} event
   * @returns {string|undefined}
   */
  #dropBefore(event) {
    const gap = event.target.closest(".card-shown-gap");
    if ( gap ) return gap.querySelector("button")?.dataset.before;
    const card = event.target.closest(".card-shown-card");
    if ( !card ) return undefined;
    const rect = card.getBoundingClientRect();
    if ( event.clientX < rect.left + (rect.width / 2) ) return card.dataset.key;
    return card.nextElementSibling?.nextElementSibling?.dataset.key ?? "";
  }

  /**
   * Show where the dragged card or tiles would go: the gap gets the class "drop-target" (none while a strip card
   * would not move); tiles light up the whole strip too.
   * @param {string|undefined} before
   */
  #markDrop(before) {
    const strip = this.element.querySelector(".card-shown");
    if ( !strip ) return;
    strip.classList.toggle("drop-active", (this.#drag?.kind === "tiles") && (before !== undefined));
    const list = strip.querySelector(".card-shown-list");
    if ( !list ) return;
    let same = false;
    if ( this.#drag?.kind === "strip" ) {
      const cards = [...list.querySelectorAll(".card-shown-card")].map(c => c.dataset.key);
      const from = cards.indexOf(this.#drag.key);
      // Before itself or before its successor: the same place.
      same = (before === this.#drag.key) || (before === (cards[from + 1] ?? ""));
    }
    for ( const button of list.querySelectorAll(".card-shown-gap button") ) {
      button.classList.toggle("drop-target", !same && (before !== undefined) && (button.dataset.before === before));
    }
  }

  /**
   * Drag and drop and keys of the strip, bound once to the window (the strip is re-rendered, the window stays):
   * - a card of the strip dragged onto a gap or another card moves there;
   * - a tile dragged anywhere onto the strip joins the cast hidden there (at the end outside a gap or card); a
   *   selected tile brings the whole selection;
   * - Enter and Space on a card of the strip click it (show or hide).
   */
  #bindStrip() {
    const root = this.element;
    root.addEventListener("dragstart", event => {
      const card = event.target.closest?.(".card-shown-card");
      const tile = !card && event.target.closest?.(".stage-browser-grid .stage-tile[data-key]");
      if ( card ) {
        this.#drag = {kind: "strip", key: card.dataset.key};
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      }
      else if ( tile ) {
        this.#drag = {kind: "tiles", cards: this.#cardsOf(this._contextKeys(tile))};
        event.dataTransfer.effectAllowed = "copy";
      }
      else return;
      // An own type, so Foundry's drop handlers (canvas, sidebar) do not take it for one of theirs.
      event.dataTransfer.setData("application/x-stagecraft-card", card?.dataset.key ?? tile.dataset.key);
    });
    root.addEventListener("dragover", event => {
      if ( !this.#drag || !event.target.closest?.(".card-shown") ) return;
      let before = this.#dropBefore(event);
      if ( (before === undefined) && (this.#drag.kind === "tiles") ) before = "";
      this.#markDrop(before);
      if ( before === undefined ) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = (this.#drag.kind === "tiles") ? "copy" : "move";
    });
    root.addEventListener("dragleave", event => {
      const strip = event.target.closest?.(".card-shown");
      if ( strip && !strip.contains(event.relatedTarget) ) this.#markDrop(undefined);
    });
    root.addEventListener("drop", async event => {
      const drag = this.#drag;
      if ( !drag || !event.target.closest?.(".card-shown") ) return;
      let before = this.#dropBefore(event);
      if ( (before === undefined) && (drag.kind === "tiles") ) before = "";
      if ( before === undefined ) return;
      event.preventDefault();
      event.stopPropagation();
      this.#markDrop(undefined);
      if ( drag.kind === "tiles" ) return this.#addHidden(drag.cards, {before});
      await this.#run(() => isPlanning() ? moveDraftCard(drag.key, before || null)
        : moveShownCard(drag.key, before || null));
    });
    root.addEventListener("dragend", event => {
      this.#drag = null;
      event.target.closest?.(".card-shown-card")?.classList.remove("dragging");
      this.#markDrop(undefined);
    });
    root.addEventListener("keydown", event => {
      if ( !["Enter", " "].includes(event.key) || !event.target.matches?.(".card-shown-card") ) return;
      event.preventDefault();
      event.target.click();
    });
  }

  /**
   * The position picker: the position in force pressed, the reset only while the stage has its own position;
   * all disabled while no indexed stage is shown. The tooltip names the stage it applies to.
   */
  #markPosition() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const toggle = this.element.querySelector(".card-position-toggle");
    const menu = this.element.querySelector(".card-position-menu");
    if ( !toggle || !menu ) return;
    const key = currentStageLocation();
    const location = key ? getStageIndex()?.locations.find(l => l.key === key) : null;
    const position = currentCardPosition();
    const fallback = getSetting("cardPosition");
    const stage = location ? (getStageNames()[key] ?? location.name) : null;
    const label = game.i18n.localize(`STAGECRAFT.CardPosition.${position}`);
    // The button shows the current position; without a stage from the index there is nothing to set.
    toggle.disabled = !location;
    toggle.querySelector("[data-role=position-icon]").className = POSITION_ICONS[position] ?? POSITION_ICONS.top;
    toggle.dataset.tooltipText = location
      ? game.i18n.format("STAGECRAFT.CardBrowser.PositionFor", {position: label, stage})
      : game.i18n.localize("STAGECRAFT.CardBrowser.PositionNoStage");
    const title = menu.querySelector("[data-role=position-title]");
    if ( title && stage ) title.textContent = game.i18n.format("STAGECRAFT.CardBrowser.PositionOf", {stage});
    for ( const button of menu.querySelectorAll("[data-action=setStageCardPosition]") ) {
      button.setAttribute("aria-pressed", String(button.dataset.position === position));
      button.querySelector(".card-position-menu-default").hidden = button.dataset.position !== fallback;
    }
    if ( !location && menu.matches(":popover-open") ) menu.hidePopover();
  }

  /** @override */
  _tileContextOptions() {
    // In planning mode the menu works on the draft, like the clicks.
    const state = () => this.#working();
    const shown = tile => state().cards.some(c => (c.key === tile.dataset.key) && !c.hidden);
    const speaking = tile => state().speaking === tile.dataset.key;
    const toggle = async (event, tile) => {
      try {
        if ( isPlanning() ) await toggleDraftSpeaking(tile.dataset.key);
        else await toggleSpeakingCard(tile.dataset.key);
      } catch ( err ) {
        ui.notifications.error(err.message);
      }
    };
    const inCast = tile => state().cards.some(c => c.key === tile.dataset.key);
    return [
      {label: "STAGECRAFT.CardBrowser.SetSpeaker", icon: "fa-solid fa-comment-dots",
        visible: tile => shown(tile) && !speaking(tile), onClick: toggle},
      {label: "STAGECRAFT.CardBrowser.EndSpeaker", icon: "fa-solid fa-comment-slash",
        visible: tile => speaking(tile), onClick: toggle},
      // Like the clicks: the selection if the tile belongs to it.
      {label: "STAGECRAFT.Cast.AddHidden", icon: "fa-solid fa-eye-slash", visible: tile => !inCast(tile),
        onClick: (event, tile) => this.#addHidden(this.#cardsOf(this._contextKeys(tile)))},
      {label: "STAGECRAFT.Cast.Remove", icon: "fa-solid fa-xmark", visible: tile => inCast(tile),
        onClick: (event, tile) => this.#run(() => isPlanning()
          ? removeDraftCard(this._contextKeys(tile)) : removeCastCard(this._contextKeys(tile)))}
    ];
  }

  /** @override */
  _selectionActions() {
    return [{action: "addHiddenSelection", icon: "fa-solid fa-eye-slash", label: "STAGECRAFT.Cast.AddHidden"}];
  }

  /** @override */
  _headerToggles() {
    return [{setting: "collapseSidebarOnCards", icon: "fa-solid fa-sidebar-flip", label: "STAGECRAFT.Sidebar.Collapse",
      hint: "STAGECRAFT.Sidebar.CollapseOnCardsHint"}];
  }

  /** @override */
  _headerActions() {
    // "Plan" and "Hide all" are in the strip, next to the cards they act on.
    return [];
  }

  /**
   * Mark the cards the players see: class "current" on the tile (green ring); hidden in their cast: class "cast"
   * (faint ring); in planning mode the cards of the draft: class "drafted" (dashed blue ring). The cards the clicks
   * work on (the draft in planning mode, else the cast) are "working", hidden ones there also "covered" (an eye
   * instead of the speaking button); shown ones get the speaking button and state, `aria-current` on the image and
   * on their variant. "Hide all" only while cards are shown; "Plan" pressed in planning mode. DOM only, so a click
   * does not re-render the grid.
   */
  #markShown() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const live = getShownCards();
    const draft = getDraft();
    const state = draft ?? live;
    const visible = new Set(live.cards.filter(c => !c.hidden).map(c => c.key));
    const cast = new Set(live.cards.filter(c => c.hidden).map(c => c.key));
    const drafted = new Set(draft?.cards.map(c => c.key) ?? []);
    const working = new Map(state.cards.map(c => [c.key, c]));
    this.element.classList.toggle("planning", Boolean(draft));
    for ( const tile of this.element.querySelectorAll(".stage-tile[data-key]") ) {
      const card = working.get(tile.dataset.key);
      const path = (card && !card.hidden) ? card.path : undefined;
      tile.classList.toggle("current", visible.has(tile.dataset.key));
      tile.classList.toggle("cast", cast.has(tile.dataset.key));
      tile.classList.toggle("drafted", drafted.has(tile.dataset.key));
      tile.classList.toggle("working", Boolean(card));
      tile.classList.toggle("covered", Boolean(card?.hidden));
      tile.classList.toggle("speaking", (path !== undefined) && (state.speaking === tile.dataset.key));
      const preview = tile.querySelector(".stage-tile-preview");
      if ( path !== undefined ) preview?.setAttribute("aria-current", "true");
      else preview?.removeAttribute("aria-current");
      for ( const button of tile.querySelectorAll(".stage-tile-variants button") ) {
        if ( (path !== undefined) && (button.dataset.path === path) ) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      }
      tile.querySelector(".stage-tile-speaking")?.setAttribute("aria-pressed", String(state.speaking === tile.dataset.key));
    }
    const hideAll = this.element.querySelector("[data-action=hideAllCards]");
    if ( hideAll ) hideAll.disabled = !visible.size;
    const removeAll = this.element.querySelector("[data-action=removeAllCards]");
    if ( removeAll ) removeAll.disabled = !live.cards.length;
  }

  /** Move the marker in the "Shown" or "Draft" strip without re-rendering it, so the clicked gap keeps its focus. */
  #markMarker() {
    // Not `this.rendered`: that is false while any part re-renders, and these DOM updates must still run.
    if ( !this.element?.isConnected ) return;
    const marker = (isPlanning() ? getDraftMarker() : getCardMarker()) ?? "";
    for ( const button of this.element.querySelectorAll(".card-shown-gap button") ) {
      button.setAttribute("aria-pressed", String(button.dataset.before === marker));
    }
  }

  /**
   * Show the card of this tile or variant to the players, switch its variant, or hide it in the cast; in planning
   * mode the same in the draft.
   * @param {HTMLElement} target  The tile's image button (its shown variant) or a variant button.
   */
  async #toggle(target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    const path = target.dataset.path;
    if ( !key || !path ) return;
    try {
      const done = isPlanning() ? await toggleDraftCard({key, path}) : await toggleShownCard({key, path});
      if ( !done ) ui.notifications.warn(game.i18n.format("STAGECRAFT.CardBrowser.TooMany", {max: MAX_SHOWN_CARDS}));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * A click on a card: show it to the players or hide it (selection, tags and preview with modifier keys).
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onSelectCard(event, target) {
    if ( this._tagEditorClick(event, target) || this._variantPeekClick(event, target)
      || this._selectionClick(event, target) ) return;
    await this.#toggle(target);
  }

  /**
   * The speaking button on a shown card.
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onToggleSpeaking(event, target) {
    const key = target.closest(".stage-tile")?.dataset.key;
    if ( !key ) return;
    try {
      if ( isPlanning() ) await toggleDraftSpeaking(key);
      else await toggleSpeakingCard(key);
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * A gap in the "Shown" strip: the next card goes there.
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSetCardMarker(event, target) {
    if ( isPlanning() ) setDraftMarker(target.dataset.before || null);
    else setCardMarker(target.dataset.before || null);
  }

  /**
   * The position picker: where the cards stand on the stage now shown (saved for that location).
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onSetStageCardPosition(event, target) {
    const key = currentStageLocation();
    const position = target.dataset.position;
    if ( !key || !CARD_POSITIONS.includes(position) ) return;
    const menu = target.closest("[popover]");
    if ( menu ) this._closePopover(menu, event);
    try {
      // The default position removes the stage's own value, so the stage follows the world setting.
      await setCardPosition(key, (position === getSetting("cardPosition")) ? null : position);
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * "Hide all": every card of the cast is hidden; the cast stays.
   * @this {CardBrowser}
   */
  static async #onHideAllCards() {
    await this.#run(hideAllCards);
  }

  /**
   * "Remove all": the cast is emptied (the dialog ends; it goes into the history).
   * @this {CardBrowser}
   */
  static async #onRemoveAllCards() {
    await this.#run(removeAllCards);
  }

  /**
   * A card in the strip: show it if hidden, else hide it, at its place; in planning mode in the draft.
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onToggleCastCard(event, target) {
    const key = target.dataset.key;
    const card = this.#working().cards.find(c => c.key === key);
    if ( !card ) return;
    this.#focusCast = key;
    await this.#run(() => isPlanning() ? setDraftCardHidden(key, !card.hidden) : setShownCardHidden(key, !card.hidden));
  }

  /**
   * "Add hidden to the cast" in the selection bar: the selected cards, in the order of the tiles.
   * @this {CardBrowser}
   */
  static async #onAddHiddenSelection() {
    await this.#addHidden(this.#cardsOf(this._selectedKeys()));
  }

  /**
   * "Plan": start planning mode with a copy of the shown cards; again: leave it (the draft is discarded).
   * @this {CardBrowser}
   */
  static async #onTogglePlanning() {
    try {
      if ( isPlanning() ) await discardDraft();
      else await startDraft();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {CardBrowser} */
  static async #onShowDraft() {
    try {
      await showDraft();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {CardBrowser} */
  static async #onDiscardDraft() {
    try {
      await discardDraft();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * A dialog in the list: show it to the players (with its stage); in planning mode load it into the draft.
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onShowDialog(event, target) {
    const id = target.closest("[data-id]")?.dataset.id;
    if ( !id ) return;
    try {
      if ( isPlanning() ) await editDialog(id);
      else await showDialog(id, {beforeStageSwitch: confirmLights});
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * "Save as dialog" in the strip: the shown cards, or in planning mode the draft, as a new dialog (the window asks
   * for its name and further properties).
   * @this {CardBrowser}
   */
  static #onSaveAsDialog() {
    const planning = isPlanning();
    const state = planning ? getDraft() : getShownCards();
    if ( !state?.cards.length ) return;
    DialogProperties.create({...dialogCardsFromState(state), fromDraft: planning});
  }

  /**
   * "Save" in the draft strip: the draft back into the dialog it was loaded from.
   * @this {CardBrowser}
   */
  static async #onSaveDraftDialog() {
    const draft = getDraft();
    const dialog = getDialog(draft?.dialog);
    if ( !dialog || !draft.cards.length ) return;
    try {
      await saveDialog(dialogCardsFromState(draft), dialog.id);
      ui.notifications.info(game.i18n.format("STAGECRAFT.Dialogs.Saved", {name: dialog.name}));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * An entry of the history: show it again (in planning mode: load it into the draft).
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRestoreHistory(event, target) {
    const menu = target.closest("[popover]");
    if ( menu ) this._closePopover(menu, event);
    try {
      await restoreHistory(Number(target.dataset.index));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /**
   * An entry of the history as a new saved dialog: opens the properties window with its cards.
   * @this {CardBrowser}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onSaveHistoryDialog(event, target) {
    const entry = getHistory()[Number(target.dataset.index)];
    const menu = target.closest("[popover]");
    if ( menu ) this._closePopover(menu, event);
    if ( entry ) await DialogProperties.create(dialogCardsFromState(entry));
  }

  /**
   * Open or close the dialog list; the list is built only while open.
   * @this {CardBrowser}
   */
  static async #onToggleDialogs() {
    this.#dialogsOpen = !this.#dialogsOpen;
    this.#focusDialogsToggle = true;
    await this.render({parts: ["dialogs"]});
  }
}
