/**
 * Tag editor (GM only) for one or more locations of the stage browser, or cards of the card browser.
 *
 * - Scope: all variants of the selected locations, each with all its file formats; variants can be unchecked.
 *   Cards have no variants, so the variant choice does not show for them.
 * - The window collects differences (add / remove) and writes only those on "Save" (see lib/tag-edit.mjs),
 *   so tags the GM did not touch stay as they are, also when they changed elsewhere in the meantime.
 * - Tags reach the DOM through escaped Handlebars output `{{ }}` only.
 */
import { MODULE_ID } from "../constants.mjs";
import { indexOf } from "../media-index.mjs";
import { getKnownTags, getTagMap, getTagOrder, updateTags, TAGS_HOOK } from "../tag-store.mjs";
import { applyTagEdit, summarizeTags } from "../lib/tag-edit.mjs";
import { normalizeTag, splitTag, tagKind } from "../lib/tags.mjs";
import { SuggestionList } from "./suggestion-list.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const keyOf = text => text.toLocaleLowerCase("en");

/** Variant key: "" for the base variant, otherwise the label in lower case. */
const variantKey = variant => (variant === null ? "" : keyOf(variant));

export class TagEditor extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * @param {{locationKeys: string[], kind?: "stages"|"cards"}} options
   */
  constructor({locationKeys, kind="stages", ...options} = {}) {
    super(options);
    this.#locationKeys = [...new Set(locationKeys ?? [])];
    this.#kind = (kind === "cards") ? "cards" : "stages";
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-tag-editor`,
    classes: [MODULE_ID, "tag-editor"],
    tag: "form",
    window: {
      icon: "fa-solid fa-tags",
      resizable: true,
      contentClasses: ["standard-form"]
    },
    position: {width: 480},
    form: {
      handler: TagEditor.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      addTag: TagEditor.#onAddTag,
      toggleRemove: TagEditor.#onToggleRemove,
      applyToAll: TagEditor.#onApplyToAll
    }
  };

  /** @override */
  static PARTS = {
    body: {template: `modules/${MODULE_ID}/templates/tag-editor.hbs`},
    footer: {template: "templates/generic/form-footer.hbs"}
  };

  /**
   * Open the editor for some locations or cards. An open editor is replaced, since its selection is outdated.
   * @param {string[]} locationKeys
   * @param {{kind?: "stages"|"cards"}} [options]
   */
  static async open(locationKeys, {kind="stages"} = {}) {
    const existing = foundry.applications.instances.get(TagEditor.DEFAULT_OPTIONS.id);
    if ( existing ) await existing.close();
    return new TagEditor({locationKeys, kind}).render({force: true});
  }

  /** @type {string[]} */
  #locationKeys;

  /** @type {"stages"|"cards"} */
  #kind;

  /** Unchecked variant keys. */
  #excluded = new Set();

  /** Tags to add, key → spelling, in entry order. */
  #added = new Map();

  /** Keys of tags to remove. */
  #removed = new Set();

  /** Focus the tag input after the next render (after adding a tag). */
  #focusInput = false;

  /** @type {number|null} */
  #hookId = null;

  /** @type {{tag: string, count: number}[]}  Known tags not yet added, for the suggestion list. */
  #known = [];

  /** @override */
  get title() {
    const locations = this.#locations();
    if ( locations.length === 1 ) return game.i18n.format("STAGECRAFT.Tags.TitleOne", {name: locations[0].name});
    const key = (this.#kind === "cards") ? "STAGECRAFT.Tags.TitleManyCards" : "STAGECRAFT.Tags.TitleMany";
    return game.i18n.format(key, {count: locations.length});
  }

  /** Selected locations (or cards) that still exist in the index. */
  #locations() {
    const keys = new Set(this.#locationKeys);
    return (indexOf(this.#kind).get()?.locations ?? []).filter(l => keys.has(l.key));
  }

  /** @returns {import("../lib/tag-edit.mjs").EditTarget[]} */
  #targets() {
    return this.#locations().map(location => ({
      key: location.key,
      files: location.variants
        .filter(v => !this.#excluded.has(variantKey(v.variant)))
        .flatMap(v => v.files.map(f => f.path))
    }));
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const locations = this.#locations();
    const baseLabel = game.i18n.localize("STAGECRAFT.Browser.BaseVariant");

    // Variants across the selection, with the number of locations that have them.
    /** @type {Map<string, {key: string, label: string, count: number}>} */
    const variants = new Map();
    for ( const location of locations ) {
      for ( const v of location.variants ) {
        const key = variantKey(v.variant);
        const entry = variants.get(key) ?? {key, label: v.variant ?? baseLabel, count: 0};
        entry.count++;
        variants.set(key, entry);
      }
    }

    const targets = this.#targets();
    const summary = summarizeTags(targets, getTagMap(), getTagOrder());
    const total = targets.filter(t => t.files.length).length;
    const shown = new Set(summary.map(s => keyOf(s.tag)));
    const tags = [
      ...summary.map(s => {
        const key = keyOf(s.tag);
        return {
          ...this.#tagDisplay(s.tag),
          count: s.count,
          total,
          partial: s.partial && !this.#added.has(key),
          removed: this.#removed.has(key),
          added: this.#added.has(key)
        };
      }),
      ...[...this.#added].filter(([key]) => !shown.has(key)).map(([, tag]) => ({
        ...this.#tagDisplay(tag), count: 0, total, partial: false, removed: false, added: true, isNew: true
      }))
    ];

    return Object.assign(context, {
      locationCount: locations.length,
      total,
      variants: [...variants.values()].map(v => ({...v, checked: !this.#excluded.has(v.key)})),
      showVariants: variants.size > 1,
      tags,
      known: (this.#known = getKnownTags().filter(k => !this.#added.has(keyOf(k.tag)))).length,
      buttons: [{type: "submit", icon: "fa-solid fa-floppy-disk", label: "STAGECRAFT.Tags.Save"}]
    });
  }

  /** @param {string} tag */
  #tagDisplay(tag) {
    return {tag, kind: tagKind(tag)};
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Another GM or the import changed tags: show the current state, keep the pending edit.
    this.#hookId = Hooks.on(TAGS_HOOK, () => this.render());
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const input = this.element.querySelector("input[name=newTag]");
    const list = this.element.querySelector(".stagecraft-suggestions");
    // The known tags as suggestions: Enter or a click adds the tag; Enter alone adds what was typed.
    if ( input && list ) new SuggestionList({
      input, list,
      items: () => this.#known.map(k => ({value: k.tag, label: k.tag, alt: splitTag(k.tag).value, rank: k.count,
        note: String(k.count), kind: tagKind(k.tag)})),
      onPick: item => {
        input.value = item.value;
        this.#addFromInput();
      },
      onEnter: () => this.#addFromInput()
    });
    for ( const box of this.element.querySelectorAll("input[name=variant]") ) {
      box.addEventListener("change", () => {
        if ( box.checked ) this.#excluded.delete(box.value);
        else this.#excluded.add(box.value);
        this.render();
      });
    }
    if ( this.#focusInput ) {
      this.#focusInput = false;
      input?.focus();
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if ( this.#hookId !== null ) Hooks.off(TAGS_HOOK, this.#hookId);
    this.#hookId = null;
  }

  /** Add the tag(s) typed into the input; commas separate several. */
  #addFromInput() {
    if ( !this.#takeInput() ) return;
    this.#focusInput = true;
    this.render();
  }

  /**
   * Move the tags typed into the input to the pending additions and clear the input.
   * @returns {boolean}  Whether a tag was taken.
   */
  #takeInput() {
    const input = this.element.querySelector("input[name=newTag]");
    if ( !input ) return false;
    const tags = input.value.split(",").map(normalizeTag).filter(Boolean);
    input.value = "";
    for ( const tag of tags ) {
      const key = keyOf(tag);
      this.#removed.delete(key);
      if ( !this.#added.has(key) ) this.#added.set(key, tag);
    }
    return tags.length > 0;
  }

  /** @this {TagEditor} */
  static #onAddTag() {
    this.#addFromInput();
  }

  /**
   * Mark a tag for removal, or take the mark back. A tag added in this window is simply dropped.
   * @this {TagEditor}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleRemove(event, target) {
    const key = keyOf(target.dataset.tag ?? "");
    if ( !key ) return;
    if ( this.#added.has(key) ) this.#added.delete(key);
    else if ( this.#removed.has(key) ) this.#removed.delete(key);
    else this.#removed.add(key);
    this.render();
  }

  /**
   * Give a tag that only part of the selection carries to all of it.
   * @this {TagEditor}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onApplyToAll(event, target) {
    const tag = normalizeTag(target.dataset.tag);
    if ( !tag ) return;
    this.#removed.delete(keyOf(tag));
    this.#added.set(keyOf(tag), tag);
    this.render();
  }

  /**
   * Write the differences and close.
   * @this {TagEditor}
   */
  static async #onSubmit() {
    // A tag still in the input (picked or typed, but not added yet) is saved too.
    this.#takeInput();
    const remove = [...this.#removed];
    const add = [...this.#added.values()];
    const changes = applyTagEdit(getTagMap(), this.#targets(), {add, remove});
    const count = Object.keys(changes).length;
    if ( count ) {
      try {
        await updateTags(changes);
      } catch ( err ) {
        ui.notifications.error(err.message);
        return;
      }
      ui.notifications.info(game.i18n.format("STAGECRAFT.Tags.Saved", {count}));
    }
    await this.close();
  }
}
