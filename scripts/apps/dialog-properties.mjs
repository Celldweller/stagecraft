/**
 * "Dialog properties" window (GM only): name, stage and tags of a saved dialog. It also saves a
 * new dialog from the shown cards or the draft; the cards themselves are changed in the draft (card-draft.mjs).
 *
 * - Tags work like the tag editor: the chosen ones as a list with ✕, below an input with suggestions
 *   (suggestion-list.mjs).
 * - The window is rendered in parts, so adding a tag re-renders only that part and keeps what was typed elsewhere
 *   (name, stage). Tags live in the window until "Save".
 * - One window per dialog, and one for a new dialog. Names reach the DOM through escaped Handlebars output only.
 */
import { MODULE_ID } from "../constants.mjs";
import { normalizeTag, normalizeTagList, splitTag, tagKind } from "../lib/tags.mjs";
import { MAX_DIALOG_NAME } from "../lib/dialogs.mjs";
import {
  DIALOGS_HOOK, currentStageImage, deleteDialog, getDialog, getDialogs, imageLabel, saveDialog
} from "../dialogs.mjs";
import { getCardIndex } from "../media-index.mjs";
import { getTileImage } from "../thumbnails.mjs";
import { getKnownTags } from "../tag-store.mjs";
import { getDraft, setDraftDialog } from "../card-draft.mjs";
import { SuggestionList } from "./suggestion-list.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const keyOf = text => text.toLocaleLowerCase("en");

/**
 * @typedef {object} NewDialog  The cards of a dialog not saved yet.
 * @property {import("../lib/dialogs.mjs").DialogImage[]} cards
 * @property {string|null} speaker
 * @property {boolean} [fromDraft]  Link the draft to the new dialog once it is saved.
 */

export class DialogProperties extends HandlebarsApplicationMixin(ApplicationV2) {

  /**
   * @param {{dialogId?: string|null, create?: NewDialog|null}} config
   * @param {object} [options]
   */
  constructor({dialogId=null, create=null}={}, options={}) {
    super({...options, id: `${MODULE_ID}-dialog-${dialogId ?? "new"}`});
    this.#dialogId = dialogId;
    this.#create = create;
    const dialog = getDialog(dialogId);
    this.#tags = [...(dialog?.tags ?? [])];
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "dialog-properties"],
    tag: "form",
    window: {
      title: "STAGECRAFT.Dialogs.Properties",
      icon: "fa-solid fa-comments"
    },
    position: {width: 460},
    form: {
      handler: DialogProperties.#onSubmit,
      closeOnSubmit: true
    },
    actions: {
      deleteDialog: DialogProperties.#onDelete,
      addTag: DialogProperties.#onAddTag,
      removeTag: DialogProperties.#onRemoveTag
    }
  };

  /** @override */
  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/dialog-properties/main.hbs`},
    tags: {template: `modules/${MODULE_ID}/templates/dialog-properties/tags.hbs`},
    footer: {template: `modules/${MODULE_ID}/templates/dialog-properties/footer.hbs`}
  };

  /**
   * Open the window of a saved dialog, or bring it to the front.
   * @param {string} id
   */
  static edit(id) {
    // A window still closing (just saved) renders again once it is closed: Foundry queues both.
    const existing = foundry.applications.instances.get(`${MODULE_ID}-dialog-${id}`);
    if ( existing ) return existing.render({force: true});
    return new DialogProperties({dialogId: id}).render({force: true});
  }

  /**
   * Open the window for a new dialog with these cards (replacing an open one for another new dialog).
   * @param {NewDialog} create
   */
  static async create(create) {
    await foundry.applications.instances.get(`${MODULE_ID}-dialog-new`)?.close();
    return new DialogProperties({create}).render({force: true});
  }

  /** @type {string|null} */
  #dialogId;

  /** @type {NewDialog|null} */
  #create;

  /** @type {string[]}  Tags chosen in this window. */
  #tags;

  /** @type {"tags"|null}  Input to focus after the next render of its part. */
  #focus = null;

  /** @type {number|null} */
  #hookId = null;

  /** @override */
  get title() {
    const dialog = getDialog(this.#dialogId);
    return dialog ? game.i18n.format("STAGECRAFT.Dialogs.PropertiesOf", {name: dialog.name})
      : game.i18n.localize("STAGECRAFT.Dialogs.New");
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const dialog = getDialog(this.#dialogId);
    const cards = dialog?.cards ?? this.#create?.cards ?? [];
    const speaker = dialog ? dialog.speaker : (this.#create?.speaker ?? null);
    const locations = new Map((getCardIndex()?.locations ?? []).map(l => [l.key, l]));
    const current = currentStageImage();
    const saved = dialog?.stage ?? null;
    const same = (a, b) => Boolean(a && b) && (a.location === b.location)
      && ((a.variant ?? "").toLocaleLowerCase("en") === (b.variant ?? "").toLocaleLowerCase("en"));
    const stages = [{value: "none", label: game.i18n.localize("STAGECRAFT.Dialogs.StageNone"), checked: !saved}];
    if ( saved ) stages.push({value: "saved", label: imageLabel(saved, "stages"), checked: true});
    if ( current && !same(current, saved) ) {
      stages.push({value: "current", checked: false,
        label: game.i18n.format("STAGECRAFT.Dialogs.StageCurrent", {stage: imageLabel(current, "stages")})});
    }
    return Object.assign(context, {
      idPrefix: this.id,
      isNew: !dialog,
      name: dialog?.name ?? "",
      maxName: MAX_DIALOG_NAME,
      cards: cards.map(card => {
        const location = locations.get(card.location);
        const variant = location?.variants.find(v => (v.variant ?? "").toLocaleLowerCase("en")
          === (card.variant ?? "").toLocaleLowerCase("en"));
        const label = imageLabel(card, "cards");
        return {label, speaking: card.location === speaker, hidden: Boolean(card.hidden),
          src: variant ? getTileImage(variant.preferred.path) : null, missing: !variant};
      }),
      stages,
      tags: this.#tags.map(tag => ({tag, kind: tagKind(tag),
        removeLabel: game.i18n.format("STAGECRAFT.Dialogs.RemoveTag", {tag})})),
      submitLabel: game.i18n.localize(dialog ? "STAGECRAFT.Dialogs.SaveChanges" : "STAGECRAFT.Dialogs.Create")
    });
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hookId = Hooks.on(DIALOGS_HOOK, () => {
      // A dialog deleted elsewhere: nothing left to edit. Other changes reach the tag suggestions on their own.
      if ( this.#dialogId && !getDialog(this.#dialogId) ) this.close();
    });
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( options.parts.includes("tags") ) this.#bindTagInput();
    if ( this.#focus && options.parts.includes(this.#focus) ) {
      this.element.querySelector(`[data-suggest="${this.#focus}"]`)?.focus();
      this.#focus = null;
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if ( this.#hookId !== null ) Hooks.off(DIALOGS_HOOK, this.#hookId);
    this.#hookId = null;
  }

  /* -------------------------------------------- */
  /*  Tags                                        */
  /* -------------------------------------------- */

  /** Tags of the stages and cards and of the dialogs, with how often they are used; without the chosen ones. */
  #knownTags() {
    const counts = new Map(getKnownTags().map(k => [k.tag, k.count]));
    for ( const dialog of getDialogs() ) {
      for ( const tag of dialog.tags ) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const chosen = new Set(this.#tags.map(keyOf));
    // The same tag in other spellings counts once, under the first spelling met.
    const merged = new Map();
    for ( const [tag, count] of counts ) {
      if ( chosen.has(keyOf(tag)) ) continue;
      const entry = merged.get(keyOf(tag)) ?? {tag, count: 0};
      entry.count += count;
      merged.set(keyOf(tag), entry);
    }
    return [...merged.values()];
  }

  #bindTagInput() {
    const input = this.element.querySelector("[data-suggest=tags]");
    const list = this.element.querySelector(`#${this.id}-tag-suggestions`);
    if ( !input || !list ) return;
    new SuggestionList({
      input, list,
      items: () => this.#knownTags().map(k => ({value: k.tag, label: k.tag, alt: splitTag(k.tag).value,
        rank: k.count, note: String(k.count), kind: tagKind(k.tag)})),
      onPick: item => {
        input.value = item.value;
        this.#addTags();
      },
      onEnter: () => this.#addTags()
    });
  }

  /** Move the tags typed into the input (commas separate several) to the chosen ones. */
  #takeTags() {
    const input = this.element.querySelector("[data-suggest=tags]");
    if ( !input ) return;
    const typed = input.value.split(",").map(normalizeTag).filter(Boolean);
    input.value = "";
    this.#tags = normalizeTagList([...this.#tags, ...typed]);
  }

  #addTags() {
    this.#takeTags();
    this.#focus = "tags";
    this.render({parts: ["tags"]});
  }

  /** @this {DialogProperties} */
  static #onAddTag() {
    this.#addTags();
  }

  /**
   * @this {DialogProperties}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onRemoveTag(event, target) {
    this.#tags.splice(Number(target.dataset.index), 1);
    this.render({parts: ["tags"]});
  }

  /* -------------------------------------------- */
  /*  Save and delete                             */
  /* -------------------------------------------- */

  /**
   * Save the properties, or the new dialog.
   * @this {DialogProperties}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {foundry.applications.ux.FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const dialog = getDialog(this.#dialogId);
    const choice = String(data.stage ?? "none");
    const stage = (choice === "current") ? currentStageImage() : (choice === "saved") ? (dialog?.stage ?? null) : null;
    // A tag still in the input (typed, but not added yet) is saved too.
    this.#takeTags();
    const changes = {name: String(data.name ?? ""), stage, tags: [...this.#tags]};
    // An error (e.g. no name) keeps the window open with what was entered; Foundry shows it as a notification.
    if ( dialog ) await saveDialog(changes, dialog.id);
    else {
      const id = await saveDialog({...changes, cards: this.#create?.cards ?? [], speaker: this.#create?.speaker});
      if ( this.#create?.fromDraft && getDraft() ) await setDraftDialog(id);
    }
    ui.notifications.info(game.i18n.format("STAGECRAFT.Dialogs.Saved", {name: changes.name.trim()}));
  }

  /** @this {DialogProperties} */
  static async #onDelete() {
    const dialog = getDialog(this.#dialogId);
    if ( !dialog ) return;
    if ( !(await confirmDelete(dialog)) ) return;
    try {
      await deleteDialog(dialog.id);
      await this.close();
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }
}

/**
 * Ask before deleting a dialog.
 * @param {import("../lib/dialogs.mjs").SavedDialog} dialog
 * @returns {Promise<boolean>}
 */
export function confirmDelete(dialog) {
  return DialogV2.confirm({
    window: {title: "STAGECRAFT.Dialogs.DeleteTitle", icon: "fa-solid fa-trash"},
    classes: [MODULE_ID],
    content: `<p>${foundry.utils.escapeHTML(game.i18n.format("STAGECRAFT.Dialogs.DeleteConfirm", {name: dialog.name}))}</p>`,
    rejectClose: false
  });
}
