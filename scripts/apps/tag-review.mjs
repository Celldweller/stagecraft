/**
 * "Review tags" window (GM only): tag suggestions from names and folders, and orphaned tags.
 * Opened from the notice in the stage browser after a rescan, or from the module settings.
 *
 * - Suggestions: one row per tag with a checkbox; the file list opens on demand and lets single files be left out.
 *   Nothing is written until "Apply checked". "Dismiss" remembers a tag so it is never suggested again.
 * - Orphans: tags at paths the index no longer has. With a unique new place they can move there (checked by
 *   default); the rest can be removed, one by one or all at once.
 * - Checkbox state lives in this instance and is applied to the DOM directly, so ticking keeps the focus.
 * - Paths and tags reach the DOM through escaped Handlebars output `{{ }}` or `textContent` only.
 */
import { MODULE_ID } from "../constants.mjs";
import { getTagMap, updateTags, TAGS_HOOK } from "../tag-store.mjs";
import { DISMISSED_HOOK, clearDismissed, dismissSuggestions, getDismissed, getTagReview } from "../tag-review.mjs";
import { applySuggestions, planOrphanMoves, planOrphanRemoval } from "../lib/tag-review.mjs";
import { parseStagePath } from "../lib/filenames.mjs";
import { tagKind } from "../lib/tags.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Rows of an orphan list shown at most; the rest is counted (and still included in "all" actions). */
const MAX_ROWS = 200;

const keyOf = tag => tag.toLocaleLowerCase("en");

/** @param {string} tag */
function labelOf(tag) {
  return {tag, kind: tagKind(tag)};
}

/** @param {string} path */
function fileName(path) {
  return parseStagePath(path).file;
}

export class TagReview extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-tag-review`,
    classes: [MODULE_ID, "tag-review"],
    tag: "section",
    window: {
      title: "STAGECRAFT.TagReview.Title",
      icon: "fa-solid fa-list-check",
      resizable: true
    },
    position: {width: 640, height: 640},
    actions: {
      pickAll: TagReview.#onPickAll,
      pickNone: TagReview.#onPickNone,
      applySuggestions: TagReview.#onApplySuggestions,
      dismissSuggestion: TagReview.#onDismiss,
      clearDismissed: TagReview.#onClearDismissed,
      applyMoves: TagReview.#onApplyMoves,
      removeOrphan: TagReview.#onRemoveOrphan,
      removeAllOrphans: TagReview.#onRemoveAllOrphans
    }
  };

  /** @override */
  static PARTS = {
    body: {template: `modules/${MODULE_ID}/templates/tag-review.hbs`, scrollable: [""]}
  };

  /** Open the single window, or bring it to the front. */
  static open() {
    const existing = foundry.applications.instances.get(TagReview.DEFAULT_OPTIONS.id);
    if ( existing ) return existing.render({force: true});
    return new TagReview().render({force: true});
  }

  /** @type {Map<string, Set<string>>}  Checked files per suggested tag (by tag key). */
  #chosen = new Map();

  /** Tag keys whose file list is open. */
  #open = new Set();

  /** Orphan moves the GM unticked (by old path); all others are applied. */
  #skippedMoves = new Set();

  /** @type {import("../lib/tag-review.mjs").PendingSuggestion[]}  The suggestions the window shows. */
  #suggestions = [];

  /** @type {Array<[string, number]>} */
  #hookIds = [];

  #renderSoon = foundry.utils.debounce(() => {
    if ( this.rendered ) this.render();
  }, 100);

  /** Settings menus create a new instance on every click; reuse an open window instead. */
  async render(options, _options) {
    const existing = foundry.applications.instances.get(this.id);
    if ( existing && (existing !== this) && existing.rendered ) return existing.render(options, _options);
    return super.render(options, _options);
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const review = getTagReview();
    this.#suggestions = review?.suggestions ?? [];
    this.#pruneChoices();
    const cap = list => ({shown: list.slice(0, MAX_ROWS), more: Math.max(list.length - MAX_ROWS, 0)});
    const moves = review?.moves ?? [];
    const lost = review?.lost ?? [];
    return Object.assign(context, {
      hasIndex: Boolean(review),
      incomplete: review?.incomplete
        ? game.i18n.localize(`STAGECRAFT.TagReview.Incomplete${(review.incomplete === "cards") ? "Cards" : ""}`)
        : null,
      suggestions: this.#suggestions.map((s, i) => ({
        index: i,
        key: keyOf(s.tag),
        tag: s.tag,
        kind: tagKind(s.tag),
        open: this.#open.has(keyOf(s.tag)),
        filesLabel: game.i18n.format("STAGECRAFT.TagReview.Files", {count: s.paths.length}),
        dismissLabel: game.i18n.format("STAGECRAFT.TagReview.DismissTag", {tag: s.tag})
      })),
      dismissedCount: getDismissed().length,
      moves: cap(moves.map(m => ({
        from: m.from, to: m.to, tags: m.tags.map(labelOf), checked: !this.#skippedMoves.has(m.from)
      }))),
      moveCount: moves.length,
      lost: cap(lost.map(l => ({
        path: l.path, tags: l.tags.map(labelOf),
        reason: game.i18n.localize(`STAGECRAFT.TagReview.Reason.${l.reason}`),
        removeLabel: game.i18n.format("STAGECRAFT.TagReview.RemoveOrphan", {file: fileName(l.path)})
      }))),
      lostCount: lost.length,
      orphanCount: moves.length + lost.length,
      hasOrphans: (moves.length + lost.length) > 0
    });
  }

  /** Drop choices for tags and files that are no longer suggested (applied, dismissed or rescanned). */
  #pruneChoices() {
    const current = new Map(this.#suggestions.map(s => [keyOf(s.tag), new Set(s.paths)]));
    for ( const [key, files] of this.#chosen ) {
      const paths = current.get(key);
      if ( !paths ) {
        this.#chosen.delete(key);
        continue;
      }
      for ( const path of files ) if ( !paths.has(path) ) files.delete(path);
      if ( !files.size ) this.#chosen.delete(key);
    }
    for ( const key of this.#open ) if ( !current.has(key) ) this.#open.delete(key);
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hookIds = [TAGS_HOOK, DISMISSED_HOOK, `${MODULE_ID}.stageIndexUpdated`, `${MODULE_ID}.cardIndexUpdated`]
      .map(hook => [hook, Hooks.on(hook, () => this.#renderSoon())]);
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    for ( const box of root.querySelectorAll("input[data-suggestion]") ) {
      box.addEventListener("change", () => this.#onTagToggle(Number(box.dataset.suggestion), box.checked));
    }
    for ( const details of root.querySelectorAll("details[data-suggestion]") ) {
      const i = Number(details.dataset.suggestion);
      if ( details.open ) this.#fillFiles(details, i);
      details.addEventListener("toggle", () => {
        const key = keyOf(this.#suggestions[i].tag);
        if ( details.open ) {
          this.#open.add(key);
          this.#fillFiles(details, i);
        }
        else this.#open.delete(key);
      });
    }
    for ( const box of root.querySelectorAll("input[data-move]") ) {
      box.addEventListener("change", () => {
        if ( box.checked ) this.#skippedMoves.delete(box.dataset.move);
        else this.#skippedMoves.add(box.dataset.move);
        this.#syncMoves();
      });
    }
    this.#syncSuggestions();
    this.#syncMoves();
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    for ( const [hook, id] of this.#hookIds ) Hooks.off(hook, id);
    this.#hookIds = [];
  }

  /**
   * Build the file checkboxes of one suggestion when its list opens. Built with DOM properties, never HTML strings.
   * @param {HTMLDetailsElement} details
   * @param {number} i
   */
  #fillFiles(details, i) {
    const list = details.querySelector(".tag-review-files");
    if ( !list || list.childElementCount ) return;
    const suggestion = this.#suggestions[i];
    const chosen = this.#chosen.get(keyOf(suggestion.tag));
    const items = suggestion.paths.map((path, j) => {
      const li = document.createElement("li");
      const box = document.createElement("input");
      Object.assign(box, {type: "checkbox", id: `stagecraft-review-file-${i}-${j}`, checked: Boolean(chosen?.has(path))});
      box.dataset.path = path;
      box.addEventListener("change", () => this.#onFileToggle(i, path, box.checked));
      const label = document.createElement("label");
      label.htmlFor = box.id;
      label.textContent = fileName(path);
      label.dataset.tooltipText = path;
      li.append(box, label);
      return li;
    });
    list.replaceChildren(...items);
  }

  /** @param {number} i @param {boolean} checked */
  #onTagToggle(i, checked) {
    const suggestion = this.#suggestions[i];
    if ( !suggestion ) return;
    const key = keyOf(suggestion.tag);
    if ( checked ) this.#chosen.set(key, new Set(suggestion.paths));
    else this.#chosen.delete(key);
    this.#syncSuggestions();
  }

  /** @param {number} i @param {string} path @param {boolean} checked */
  #onFileToggle(i, path, checked) {
    const key = keyOf(this.#suggestions[i].tag);
    const files = this.#chosen.get(key) ?? new Set();
    if ( checked ) files.add(path);
    else files.delete(path);
    if ( files.size ) this.#chosen.set(key, files);
    else this.#chosen.delete(key);
    this.#syncSuggestions();
  }

  /** Mirror the choices into the checkboxes (tag: checked, mixed or empty) and the apply button. */
  #syncSuggestions() {
    const root = this.element;
    let tags = 0;
    let files = 0;
    this.#suggestions.forEach((suggestion, i) => {
      const chosen = this.#chosen.get(keyOf(suggestion.tag));
      const n = chosen?.size ?? 0;
      if ( n ) {
        tags++;
        files += n;
      }
      const box = root.querySelector(`input[data-suggestion="${i}"]`);
      if ( box ) {
        box.checked = n === suggestion.paths.length;
        box.indeterminate = (n > 0) && (n < suggestion.paths.length);
      }
      for ( const fileBox of root.querySelectorAll(`details[data-suggestion="${i}"] input[data-path]`) ) {
        fileBox.checked = Boolean(chosen?.has(fileBox.dataset.path));
      }
    });
    const button = root.querySelector("[data-action=applySuggestions]");
    if ( button ) button.disabled = !tags;
    const summary = root.querySelector("[data-role=chosen]");
    if ( summary ) summary.textContent = game.i18n.format("STAGECRAFT.TagReview.Chosen", {tags, files});
  }

  /** Enable the move button only while at least one move is ticked. */
  #syncMoves() {
    const button = this.element.querySelector("[data-action=applyMoves]");
    if ( !button ) return;
    const moves = getTagReview()?.moves ?? [];
    button.disabled = !moves.some(m => !this.#skippedMoves.has(m.from));
  }

  /** Write changes, report errors; true on success. */
  async #write(changes) {
    if ( !Object.keys(changes).length ) return false;
    try {
      await updateTags(changes);
      return true;
    } catch ( err ) {
      ui.notifications.error(err.message);
      return false;
    }
  }

  /** @this {TagReview} */
  static #onPickAll() {
    for ( const s of this.#suggestions ) this.#chosen.set(keyOf(s.tag), new Set(s.paths));
    this.#syncSuggestions();
  }

  /** @this {TagReview} */
  static #onPickNone() {
    this.#chosen.clear();
    this.#syncSuggestions();
  }

  /** @this {TagReview} */
  static async #onApplySuggestions() {
    const picks = this.#suggestions
      .map(s => ({tag: s.tag, paths: [...(this.#chosen.get(keyOf(s.tag)) ?? [])]}))
      .filter(p => p.paths.length);
    const changes = applySuggestions(getTagMap(), picks);
    const count = Object.keys(changes).length;
    if ( !(await this.#write(changes)) ) return;
    this.#chosen.clear();
    ui.notifications.info(game.i18n.format("STAGECRAFT.TagReview.Applied", {count}));
  }

  /** @this {TagReview} */
  static async #onDismiss(event, target) {
    const suggestion = this.#suggestions[Number(target.dataset.index)];
    if ( !suggestion ) return;
    try {
      await dismissSuggestions([suggestion.tag]);
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {TagReview} */
  static async #onClearDismissed() {
    try {
      await clearDismissed();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {TagReview} */
  static async #onApplyMoves() {
    const moves = (getTagReview()?.moves ?? []).filter(m => !this.#skippedMoves.has(m.from));
    if ( !(await this.#write(planOrphanMoves(getTagMap(), moves))) ) return;
    ui.notifications.info(game.i18n.format("STAGECRAFT.TagReview.Moved", {count: moves.length}));
  }

  /** @this {TagReview} */
  static async #onRemoveOrphan(event, target) {
    const path = target.dataset.path;
    if ( !(getTagReview()?.lost ?? []).some(l => l.path === path) ) return;
    await this.#write(planOrphanRemoval([path]));
  }

  /** @this {TagReview} */
  static async #onRemoveAllOrphans() {
    const lost = getTagReview()?.lost ?? [];
    if ( !lost.length ) return;
    const confirmed = await DialogV2.confirm({
      window: {title: "STAGECRAFT.TagReview.RemoveAllTitle"},
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("STAGECRAFT.TagReview.RemoveAllConfirm", {count: lost.length}))}</p>`
    });
    if ( !confirmed ) return;
    if ( !(await this.#write(planOrphanRemoval(lost.map(l => l.path)))) ) return;
    ui.notifications.info(game.i18n.format("STAGECRAFT.TagReview.Removed", {count: lost.length}));
  }
}
