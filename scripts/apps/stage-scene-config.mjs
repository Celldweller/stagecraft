/**
 * "Stage scene" window (GM only), opened from the module settings: choose the scene that shows the stages,
 * or create a new one. Stagecraft never creates it on its own.
 *
 * Scene names reach the DOM through escaped Handlebars output `{{ }}` only.
 */
import { MODULE_ID } from "../constants.mjs";
import { setSetting } from "../settings.mjs";
import {
  STAGE_SCENE_HOOK, createStageScene, getLockViewConflicts, getStageScene, isLockViewActive, resetLockView
} from "../stage-scene.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class StageSceneConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-stage-scene`,
    classes: [MODULE_ID, "stage-scene-config"],
    tag: "form",
    window: {
      title: "STAGECRAFT.StageScene.Title",
      icon: "fa-solid fa-panorama"
    },
    position: {width: 480},
    form: {
      handler: StageSceneConfig.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      createScene: StageSceneConfig.#onCreate,
      resetLockView: StageSceneConfig.#onResetLockView
    }
  };

  /** @override */
  static PARTS = {
    body: {template: `modules/${MODULE_ID}/templates/stage-scene-config.hbs`}
  };

  /** Open the single window, or bring it to the front. */
  static open() {
    const existing = foundry.applications.instances.get(StageSceneConfig.DEFAULT_OPTIONS.id);
    if ( existing ) return existing.render({force: true});
    return new StageSceneConfig().render({force: true});
  }

  /** @type {number|null} */
  #hookId = null;

  /** Settings menus create a new instance on every click; reuse an open window instead. */
  async render(options, _options) {
    const existing = foundry.applications.instances.get(this.id);
    if ( existing && (existing !== this) && existing.rendered ) return existing.render(options, _options);
    return super.render(options, _options);
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const current = getStageScene();
    const scenes = game.scenes.contents
      .map(scene => ({id: scene.id, name: scene.name, selected: scene.id === current?.id}))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang, {sensitivity: "base"}));
    return Object.assign(context, {
      current: current ? {name: current.name, active: current.active} : null,
      scenes,
      lockView: isLockViewActive() ? {
        conflicts: getLockViewConflicts(current).map(key => game.i18n.localize(`STAGECRAFT.LockView.Conflict.${key}`))
      } : null
    });
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.#hookId = Hooks.on(STAGE_SCENE_HOOK, () => this.render());
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if ( this.#hookId !== null ) Hooks.off(STAGE_SCENE_HOOK, this.#hookId);
    this.#hookId = null;
  }

  /**
   * Save the chosen scene. Only ids of existing scenes (or none) are stored.
   * @this {StageSceneConfig}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {foundry.applications.ux.FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    const id = String(formData.object.stageScene ?? "");
    if ( id && !game.scenes.has(id) ) return;
    await setSetting("stageScene", id);
    ui.notifications.info(game.i18n.localize("STAGECRAFT.StageScene.Saved"));
  }

  /** @this {StageSceneConfig} */
  static async #onResetLockView() {
    const scene = getStageScene();
    if ( !scene ) return;
    const confirmed = await DialogV2.confirm({
      window: {title: "STAGECRAFT.LockView.ResetTitle"},
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("STAGECRAFT.LockView.ResetConfirm", {name: scene.name}))}</p>`
    });
    if ( !confirmed ) return;
    try {
      await resetLockView();
      ui.notifications.info(game.i18n.localize("STAGECRAFT.LockView.ResetDone"));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }

  /** @this {StageSceneConfig} */
  static async #onCreate() {
    try {
      const scene = await createStageScene();
      ui.notifications.info(game.i18n.format("STAGECRAFT.StageScene.Created", {name: scene.name}));
    } catch ( err ) {
      ui.notifications.error(err.message);
    }
  }
}
