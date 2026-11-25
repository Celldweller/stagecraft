/**
 * "Export / import tags" window (GM only), opened from the module settings.
 *
 * - Export: all stored tags as JSON (format `stagecraft-tags`, see lib/tags.mjs), downloaded as a file.
 * - Import: the file is read in the browser, checked against the fixed schema, matched to the stage and card index
 *   (exact path, then unique file name) and shown as a preview. Only "Apply" writes, in one setting update.
 * - Paths and tags reach the DOM through escaped Handlebars output `{{ }}` only.
 */
import { MODULE_ID } from "../constants.mjs";
import { allIndexedEntries, getStageIndex } from "../media-index.mjs";
import { getTagMap, updateTags } from "../tag-store.mjs";
import { buildTagExport, matchImportEntries, planTagImport, validateTagImport } from "../lib/tags.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The files an import can be matched to: stages and cards together. A stage index is required;
 * the card index is used when it is loaded.
 * @returns {{entries: import("../lib/filenames.mjs").StageEntry[]}|null}
 */
function knownFiles() {
  return getStageIndex() ? {entries: allIndexedEntries()} : null;
}

/** Largest import file accepted; an export of 20 000 files with a few tags each stays well below. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** Rows of a preview list shown at most; the rest is counted. */
const MAX_PREVIEW_ROWS = 200;

export class TagTransferConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-tag-transfer`,
    classes: [MODULE_ID, "tag-transfer"],
    tag: "section",
    window: {
      title: "STAGECRAFT.TagTransfer.Title",
      icon: "fa-solid fa-file-export",
      resizable: true
    },
    position: {width: 640},
    actions: {
      exportTags: TagTransferConfig.#onExport,
      applyImport: TagTransferConfig.#onApply,
      discardImport: TagTransferConfig.#onDiscard
    }
  };

  /** @override */
  static PARTS = {
    body: {template: `modules/${MODULE_ID}/templates/tag-transfer.hbs`, scrollable: [""]}
  };

  /**
   * The parsed import, kept while the preview is open.
   * @type {{fileName: string, entries: import("../lib/tags.mjs").ImportEntry[],
   *         errors: {key: string|null, error: string}[]}|null}
   */
  #import = null;

  /** @type {"replace"|"merge"} */
  #mode = "replace";

  /** Whole-file error of the last chosen file, as a localized message. */
  #fileError = null;

  /** Settings menus create a new instance on every click; reuse an open window instead. */
  async render(options, _options) {
    const existing = foundry.applications.instances.get(this.id);
    if ( existing && (existing !== this) && existing.rendered ) return existing.render(options, _options);
    return super.render(options, _options);
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const index = knownFiles();
    const tagMap = getTagMap();
    const taggedFiles = Object.keys(tagMap).length;
    const preview = (this.#import && index) ? this.#preview(index, tagMap) : null;
    return Object.assign(context, {
      taggedFiles,
      hasIndex: Boolean(index),
      mode: this.#mode,
      fileError: this.#fileError,
      preview
    });
  }

  /** Match the parsed import to the index and describe the changes. */
  #preview(index, tagMap) {
    const {matched, unmatched} = matchImportEntries(this.#import.entries, index.entries);
    const plan = planTagImport(tagMap, matched, this.#mode);
    const names = new Map(index.entries.map(e => [e.path, e.file]));
    const cap = list => ({shown: list.slice(0, MAX_PREVIEW_ROWS), more: Math.max(list.length - MAX_PREVIEW_ROWS, 0)});
    return {
      fileName: this.#import.fileName,
      entryCount: this.#import.entries.length,
      changedCount: plan.rows.length,
      unchanged: plan.unchanged,
      unmatchedCount: unmatched.length,
      errorCount: this.#import.errors.length,
      changes: cap(plan.rows.map(row => ({
        path: row.path, file: names.get(row.path) ?? row.path, added: row.added, removed: row.removed
      }))),
      unmatched: cap(unmatched.map(u => ({
        key: u.key, reason: game.i18n.localize(`STAGECRAFT.TagTransfer.Reason.${u.reason}`)
      }))),
      errors: cap(this.#import.errors.map(e => ({
        key: e.key ?? "", error: game.i18n.localize(`STAGECRAFT.TagTransfer.Error.${e.error}`)
      }))),
      canApply: plan.rows.length > 0,
      changeSet: plan.changes
    };
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.querySelector("input[name=importFile]")?.addEventListener("change", event => {
      const file = event.currentTarget.files?.[0];
      if ( file ) this.#readFile(file);
    });
    for ( const radio of this.element.querySelectorAll("input[name=importMode]") ) {
      radio.addEventListener("change", () => {
        if ( !radio.checked ) return;
        this.#mode = (radio.value === "merge") ? "merge" : "replace";
        this.render();
      });
    }
  }

  /**
   * Read and check a chosen file. Nothing is written here.
   * @param {File} file
   */
  async #readFile(file) {
    this.#import = null;
    this.#fileError = null;
    try {
      if ( file.size > MAX_IMPORT_BYTES ) throw new Error("TooLarge");
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error("NotJson");
      }
      const result = validateTagImport(data);
      if ( !result.ok ) throw new Error(result.errors[0]?.error ?? "NotAnObject");
      this.#import = {fileName: file.name, entries: result.entries, errors: result.errors};
    } catch ( err ) {
      const key = `STAGECRAFT.TagTransfer.Error.${err.message}`;
      this.#fileError = game.i18n.has(key) ? game.i18n.localize(key) : err.message;
    }
    this.render();
  }

  /** @this {TagTransferConfig} */
  static #onExport() {
    const data = buildTagExport(getTagMap());
    const date = new Date().toISOString().slice(0, 10);
    const name = `stagecraft-tags-${game.world.id}-${date}.json`;
    foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", name);
  }

  /** @this {TagTransferConfig} */
  static async #onApply() {
    const index = knownFiles();
    if ( !this.#import || !index ) return;
    // Recomputed against the current tags, in case they changed while the preview was open.
    const {changeSet} = this.#preview(index, getTagMap());
    const count = Object.keys(changeSet).length;
    if ( !count ) return;
    try {
      await updateTags(changeSet);
    } catch ( err ) {
      ui.notifications.error(err.message);
      return;
    }
    ui.notifications.info(game.i18n.format("STAGECRAFT.TagTransfer.Applied", {count}));
    this.#import = null;
    this.render();
  }

  /** @this {TagTransferConfig} */
  static #onDiscard() {
    this.#import = null;
    this.#fileError = null;
    this.render();
  }
}
