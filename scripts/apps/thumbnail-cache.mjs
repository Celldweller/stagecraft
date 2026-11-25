/**
 * "Preview cache" window (GM only), opened from the module settings: status of the thumbnail cache,
 * create missing thumbnails, recreate all in a new subfolder, list orphaned files and unused old subfolders.
 *
 * Paths reach the DOM through escaped Handlebars output `{{ }}` only.
 */
import { MODULE_ID } from "../constants.mjs";
import {
  THUMBNAILS_HOOK, createMissingThumbnails, getThumbnailReport, listOldThumbnailFolders, loadThumbnails,
  regenerateThumbnails
} from "../thumbnails.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** How long the copy confirmation stays visible. */
const COPY_FEEDBACK_MS = 2000;

export class ThumbnailCacheConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-thumbnail-cache`,
    classes: [MODULE_ID, "thumbnail-cache"],
    tag: "section",
    window: {
      title: "STAGECRAFT.ThumbCache.Title",
      icon: "fa-solid fa-images",
      resizable: true
    },
    position: {width: 560},
    actions: {
      createMissing: ThumbnailCacheConfig.#onCreateMissing,
      regenerate: ThumbnailCacheConfig.#onRegenerate,
      copyList: ThumbnailCacheConfig.#onCopyList
    }
  };

  /** @override */
  static PARTS = {
    body: {template: `modules/${MODULE_ID}/templates/thumbnail-cache.hbs`}
  };

  /** Earlier generation folders; read on open and after "recreate all". */
  #oldFolders = [];

  /** Open state of the <details> lists, kept across re-renders. */
  #open = new Set();

  /** @type {number|null} */
  #hookId = null;

  /** Re-render at most every 100 ms while thumbnails are being created. */
  #renderSoon = foundry.utils.debounce(() => {
    if ( this.rendered ) this.render();
  }, 100);

  /** @type {WeakMap<HTMLElement, number>} */
  #copyTimers = new WeakMap();

  /**
   * Settings menus create a new instance on every click; reuse an open window instead of opening a second one.
   * @inheritDoc
   */
  async render(options, _options) {
    const existing = foundry.applications.instances.get(this.id);
    if ( existing && (existing !== this) && existing.rendered ) return existing.render(options, _options);
    return super.render(options, _options);
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const report = getThumbnailReport();
    const {status} = report;
    return Object.assign(context, {
      ...report,
      loaded: status.loaded,
      running: status.running,
      progressValue: status.done + status.failed,
      progressMax: Math.max(status.total, 1),
      canCreate: report.hasIndex && status.loaded && !status.running && (report.missing > 0),
      canRegenerate: report.hasIndex && status.loaded && !status.running,
      orphanedText: report.orphaned.join("\n"),
      failedText: report.failed.join("\n"),
      oldFolders: this.#oldFolders,
      oldFoldersText: this.#oldFolders.join("\n"),
      open: Object.fromEntries([...this.#open].map(key => [key, true]))
    });
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hookId = Hooks.on(THUMBNAILS_HOOK, () => this.#renderSoon());
    loadThumbnails().catch(err => console.error(`${MODULE_ID} | Thumbnail cache could not be read:`, err));
    this.#refreshOldFolders();
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const details of this.element.querySelectorAll("details[data-list]") ) {
      details.addEventListener("toggle", () => {
        if ( details.open ) this.#open.add(details.dataset.list);
        else this.#open.delete(details.dataset.list);
      });
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if ( this.#hookId !== null ) Hooks.off(THUMBNAILS_HOOK, this.#hookId);
    this.#hookId = null;
  }

  async #refreshOldFolders() {
    this.#oldFolders = await listOldThumbnailFolders();
    if ( this.rendered ) this.render();
  }

  /** @this {ThumbnailCacheConfig} */
  static async #onCreateMissing() {
    try {
      await createMissingThumbnails();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {ThumbnailCacheConfig} */
  static async #onRegenerate() {
    const {originals, store, generation} = getThumbnailReport();
    const confirmed = await DialogV2.confirm({
      window: {title: "STAGECRAFT.ThumbCache.RegenerateTitle"},
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("STAGECRAFT.ThumbCache.RegenerateConfirm", {
        count: originals, folder: store.folder, next: generation + 1
      }))}</p>`
    });
    if ( !confirmed ) return;
    try {
      await regenerateThumbnails();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
    await this.#refreshOldFolders();
  }

  /**
   * Copy the text of a list (its read-only textarea) to the clipboard and report the outcome next to the button.
   * @this {ThumbnailCacheConfig}
   * @param {PointerEvent} event
   * @param {HTMLElement} button
   */
  static async #onCopyList(event, button) {
    const field = button.closest("details")?.querySelector("textarea");
    const feedback = button.nextElementSibling;
    if ( !field || !feedback ) return;
    let ok = true;
    try {
      await navigator.clipboard.writeText(field.value);
    } catch {
      ok = false; // No secure context or permission denied.
    }
    clearTimeout(this.#copyTimers.get(button));
    feedback.textContent = game.i18n.localize(ok ? "STAGECRAFT.ThumbCache.Copied" : "STAGECRAFT.ThumbCache.CopyFailed");
    this.#copyTimers.set(button, setTimeout(() => {
      feedback.textContent = "";
    }, COPY_FEEDBACK_MS));
  }
}
