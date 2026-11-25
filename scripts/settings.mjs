/**
 * Stagecraft settings.
 * World-scoped settings are shared and only GMs may change them by default.
 * The index cache is client-scoped (the GM's browser), so players never load it.
 */
import { MODULE_ID } from "./constants.mjs";
import { compileVariantPattern, parseVariantSetting, DEFAULT_VARIANT_TEMPLATE } from "./lib/filenames.mjs";
import { DEFAULT_SCOPES } from "./lib/filter.mjs";
import { FIT_MODES } from "./lib/view-lock.mjs";
import { DEFAULT_STAGE_TRANSITION, STAGE_TRANSITIONS } from "./lib/stage-transitions.mjs";
import { DEFAULT_TAG_ORDER } from "./lib/tags.mjs";
import {
  CARDS_ON_STAGE_SWITCH, CARD_POSITIONS, CARD_SIZE, CARD_TRANSITIONS, DEFAULT_CARDS_ON_STAGE_SWITCH,
  DEFAULT_CARD_POSITION, DEFAULT_CARD_TRANSITION
} from "./lib/cards.mjs";

/** Setting keys. */
export const SETTINGS = Object.freeze({
  stageSource: "stageSource",
  stageRoot: "stageRoot",
  variantPattern: "variantPattern",
  stageScene: "stageScene",
  stageFit: "stageFit",
  stageTransition: "stageTransition",
  stageNames: "stageNames",
  stageColors: "stageColors",
  stageIndexCache: "stageIndexCache",
  cardSource: "cardSource",
  cardRoot: "cardRoot",
  cardIndexCache: "cardIndexCache",
  shownCards: "shownCards",
  cardDraft: "cardDraft",
  cardHistory: "cardHistory",
  cardSize: "cardSize",
  cardTransition: "cardTransition",
  cardPosition: "cardPosition",
  cardPositions: "cardPositions",
  cardsOnStageSwitch: "cardsOnStageSwitch",
  collapseSidebarOnStage: "collapseSidebarOnStage",
  collapseSidebarOnCards: "collapseSidebarOnCards",
  lightPresets: "lightPresets",
  dialogs: "dialogs",
  thumbSource: "thumbSource",
  thumbRoot: "thumbRoot",
  thumbGeneration: "thumbGeneration",
  tags: "tags",
  tagOrder: "tagOrder",
  pinnedFilters: "pinnedFilters",
  dismissedSuggestions: "dismissedSuggestions",
  searchScopes: "searchScopes"
});

/** File sources offered for the stage folder. "forgevtt" is The Forge's Asset Library. */
const SOURCES = ["data", "forgevtt", "public", "s3"];

/** Sources the thumbnail cache can be written to. "public" (core data) is read-only; "auto" picks one at runtime. */
const THUMB_SOURCES = ["auto", "data", "forgevtt", "s3"];

/**
 * Register all settings. Call during the `init` hook.
 * @param {object} callbacks
 * @param {() => void} callbacks.onStageConfigChange  Called when the stage source or folder change.
 * @param {() => void} callbacks.onVariantPatternChange  Called when the variant pattern (stages and cards) changes.
 * @param {() => void} callbacks.onThumbConfigChange  Called when the thumbnail cache location or generation changes.
 * @param {() => void} callbacks.onTagsChange         Called when the stored tags or their display order change
 *   (on every client).
 * @param {() => void} callbacks.onPinnedChange       Called when the pinned filter chips change.
 * @param {() => void} callbacks.onDismissedChange    Called when the list of dismissed tag suggestions changes.
 * @param {() => void} callbacks.onStageSceneChange   Called when another scene is chosen as stage scene.
 * @param {() => void} callbacks.onStageNamesChange   Called when the stage names change.
 * @param {() => void} callbacks.onStageFitChange     Called when the fit of the stage image changes.
 * @param {() => void} callbacks.onStageColorsChange  Called when the bar colour overrides change.
 * @param {() => void} callbacks.onCardConfigChange   Called when the card source or folder change.
 * @param {() => void} callbacks.onShownCardsChange   Called when the cards shown to the players change (all clients).
 * @param {() => void} callbacks.onCardLayoutChange   Called when size, transition or position of the shown cards
 *   change (all clients).
 * @param {() => void} callbacks.onLightPresetsChange  Called when the light presets change.
 * @param {() => void} callbacks.onCardDraftChange   Called when the GM's draft of the planning mode changes.
 * @param {() => void} callbacks.onCollapseSidebarChange  Called when a "collapse the sidebar" checkbox changes.
 * @param {() => void} callbacks.onDialogsChange      Called when the saved dialogs change.
 * @param {() => void} callbacks.onCardHistoryChange  Called when the GM's history "Recently shown" changes.
 */
export function registerSettings({onStageConfigChange, onVariantPatternChange, onThumbConfigChange, onTagsChange, onPinnedChange,
  onDismissedChange, onStageSceneChange, onStageNamesChange, onStageFitChange, onStageColorsChange,
  onCardConfigChange, onShownCardsChange, onCardLayoutChange, onLightPresetsChange, onCardDraftChange,
  onCollapseSidebarChange, onDialogsChange, onCardHistoryChange}) {
  const {fields} = foundry.data;

  game.settings.register(MODULE_ID, SETTINGS.stageSource, {
    name: "STAGECRAFT.Settings.StageSource.Name",
    hint: "STAGECRAFT.Settings.StageSource.Hint",
    scope: "world",
    config: true,
    type: String,
    // A function, so the labels are localized when the form renders (translations are not loaded at init).
    choices: () => Object.fromEntries(SOURCES.map(s => [s, game.i18n.localize(`STAGECRAFT.Settings.StageSource.${s}`)])),
    default: "data",
    onChange: onStageConfigChange
  });

  game.settings.register(MODULE_ID, SETTINGS.stageRoot, {
    name: "STAGECRAFT.Settings.StageRoot.Name",
    hint: "STAGECRAFT.Settings.StageRoot.Hint",
    scope: "world",
    config: true,
    type: String,
    filePicker: "folder",
    default: "",
    onChange: onStageConfigChange
  });

  game.settings.register(MODULE_ID, SETTINGS.cardSource, {
    name: "STAGECRAFT.Settings.CardSource.Name",
    hint: "STAGECRAFT.Settings.CardSource.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(SOURCES.map(s => [s, game.i18n.localize(`STAGECRAFT.Settings.StageSource.${s}`)])),
    default: "data",
    onChange: onCardConfigChange
  });

  game.settings.register(MODULE_ID, SETTINGS.cardRoot, {
    name: "STAGECRAFT.Settings.CardRoot.Name",
    hint: "STAGECRAFT.Settings.CardRoot.Hint",
    scope: "world",
    config: true,
    type: String,
    filePicker: "folder",
    default: "",
    onChange: onCardConfigChange
  });

  game.settings.register(MODULE_ID, SETTINGS.variantPattern, {
    name: "STAGECRAFT.Settings.VariantPattern.Name",
    hint: "STAGECRAFT.Settings.VariantPattern.Hint",
    scope: "world",
    config: true,
    type: new fields.StringField({
      required: true,
      blank: false,
      trim: true,
      initial: DEFAULT_VARIANT_TEMPLATE,
      validate: value => compileVariantPattern(parseVariantSetting(value)).ok,
      validationError: "is not a valid variant pattern"
    }),
    default: DEFAULT_VARIANT_TEMPLATE,
    onChange: onVariantPatternChange
  });

  // Id of the scene that shows the stages; chosen or created in the "Stage scene" window.
  game.settings.register(MODULE_ID, SETTINGS.stageScene, {
    scope: "world",
    config: false,
    type: String,
    default: "",
    onChange: onStageSceneChange
  });

  // How the stage image fits the players' screen (view lock): fill it, or show the whole image.
  game.settings.register(MODULE_ID, SETTINGS.stageFit, {
    name: "STAGECRAFT.Settings.StageFit.Name",
    hint: "STAGECRAFT.Settings.StageFit.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(FIT_MODES.map(m => [m, game.i18n.localize(`STAGECRAFT.Settings.StageFit.${m}`)])),
    default: "cover",
    onChange: onStageFitChange
  });

  // How the previous stage leaves on a switch, for players and the GM in the player view (stage-hold.mjs).
  game.settings.register(MODULE_ID, SETTINGS.stageTransition, {
    name: "STAGECRAFT.Settings.StageTransition.Name",
    hint: "STAGECRAFT.Settings.StageTransition.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(STAGE_TRANSITIONS.map(t => [t,
      game.i18n.localize(`STAGECRAFT.Settings.StageTransition.${t}`)])),
    default: DEFAULT_STAGE_TRANSITION
  });

  // Cards shown to the players: {cards: [{key, path}], speaking}. World scope, so every client (also a player who
  // connects later) gets it and only GMs write it; validated on read (see lib/cards.mjs).
  game.settings.register(MODULE_ID, SETTINGS.shownCards, {
    scope: "world",
    config: false,
    type: Object,
    default: {cards: [], speaking: null},
    onChange: onShownCardsChange
  });

  // Collapse the sidebar with a stage switch, and before the first cards (checkboxes in the browsers, see
  // sidebar-collapse.mjs). World scope, so every player's client knows them.
  for ( const key of [SETTINGS.collapseSidebarOnStage, SETTINGS.collapseSidebarOnCards] ) {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: Boolean,
      default: false,
      onChange: onCollapseSidebarChange
    });
  }

  // The GM's draft in planning mode: {world, cards, speaking}, or {} outside it. Client scope, so the players never
  // receive it; validated on read (see card-draft.mjs).
  game.settings.register(MODULE_ID, SETTINGS.cardDraft, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: onCardDraftChange
  });

  // History "Recently shown" (card-history.mjs): only in the GM's browser, like the draft; carries its world's id.
  game.settings.register(MODULE_ID, SETTINGS.cardHistory, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
    onChange: onCardHistoryChange
  });

  // Height of a shown card as a share of the window height, in percent.
  game.settings.register(MODULE_ID, SETTINGS.cardSize, {
    name: "STAGECRAFT.Settings.CardSize.Name",
    hint: "STAGECRAFT.Settings.CardSize.Hint",
    scope: "world",
    config: true,
    type: new fields.NumberField({required: true, nullable: false, integer: true, min: CARD_SIZE.min,
      max: CARD_SIZE.max, step: CARD_SIZE.step, initial: CARD_SIZE.initial}),
    default: CARD_SIZE.initial,
    onChange: onCardLayoutChange
  });

  // How a card appears and leaves (see lib/cards.mjs and the card layer in styles/stagecraft.css).
  game.settings.register(MODULE_ID, SETTINGS.cardTransition, {
    name: "STAGECRAFT.Settings.CardTransition.Name",
    hint: "STAGECRAFT.Settings.CardTransition.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(CARD_TRANSITIONS.map(t => [t,
      game.i18n.localize(`STAGECRAFT.Settings.CardTransition.${t}`)])),
    default: DEFAULT_CARD_TRANSITION,
    onChange: onCardLayoutChange
  });

  // Where the cards stand on stages without a position of their own.
  game.settings.register(MODULE_ID, SETTINGS.cardPosition, {
    name: "STAGECRAFT.Settings.CardPosition.Name",
    hint: "STAGECRAFT.Settings.CardPosition.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(CARD_POSITIONS.map(p => [p, game.i18n.localize(`STAGECRAFT.CardPosition.${p}`)])),
    default: DEFAULT_CARD_POSITION,
    onChange: onCardLayoutChange
  });

  // What happens to the shown cards on a stage switch: they stay, the dialog ends, or the stage browser asks.
  game.settings.register(MODULE_ID, SETTINGS.cardsOnStageSwitch, {
    name: "STAGECRAFT.Settings.CardsOnStageSwitch.Name",
    hint: "STAGECRAFT.Settings.CardsOnStageSwitch.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(CARDS_ON_STAGE_SWITCH.map(c => [c,
      game.i18n.localize(`STAGECRAFT.Settings.CardsOnStageSwitch.${c}`)])),
    default: DEFAULT_CARDS_ON_STAGE_SWITCH
  });

  // Location key → card position, set per stage in its settings dialog. Validated on read (see lib/cards.mjs).
  game.settings.register(MODULE_ID, SETTINGS.cardPositions, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: onCardLayoutChange
  });

  // Location key → stage name, shown to players as the scene's navigation name. Validated on read.
  game.settings.register(MODULE_ID, SETTINGS.stageNames, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: onStageNamesChange
  });

  // Variant key → bar colour ("#rrggbb") overriding the automatic one. Validated on read.
  game.settings.register(MODULE_ID, SETTINGS.stageColors, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: onStageColorsChange
  });

  // Variant key → the lights of that stage variant, relative to the image (scripts/lib/lights.mjs).
  // Validated on read. Players get it too (world setting), but only the GM uses it.
  game.settings.register(MODULE_ID, SETTINGS.lightPresets, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: onLightPresetsChange
  });

  // Saved dialogs (lib/dialogs.mjs). A world setting like the rest: Foundry hands GM data such as secret
  // journals to every client too and only hides it.
  game.settings.register(MODULE_ID, SETTINGS.dialogs, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: onDialogsChange
  });

  game.settings.register(MODULE_ID, SETTINGS.thumbSource, {
    name: "STAGECRAFT.Settings.ThumbSource.Name",
    hint: "STAGECRAFT.Settings.ThumbSource.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: () => Object.fromEntries(THUMB_SOURCES.map(s => [s, game.i18n.localize(`STAGECRAFT.Settings.ThumbSource.${s}`)])),
    default: "auto",
    onChange: onThumbConfigChange
  });

  game.settings.register(MODULE_ID, SETTINGS.thumbRoot, {
    name: "STAGECRAFT.Settings.ThumbRoot.Name",
    hint: "STAGECRAFT.Settings.ThumbRoot.Hint",
    scope: "world",
    config: true,
    type: String,
    filePicker: "folder",
    default: "",
    onChange: onThumbConfigChange
  });

  // Subfolder number of the thumbnail cache; "regenerate all" moves to the next one (files cannot be deleted).
  game.settings.register(MODULE_ID, SETTINGS.thumbGeneration, {
    scope: "world",
    config: false,
    type: Number,
    default: 1,
    onChange: onThumbConfigChange
  });

  // Path → tags for stages and cards. World scope, so only GMs write it; validated on read (see tag-store.mjs).
  game.settings.register(MODULE_ID, SETTINGS.tags, {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: onTagsChange
  });

  // Display order of the tag prefixes on tiles and in the tag editor, comma-separated (see lib/tags.mjs).
  game.settings.register(MODULE_ID, SETTINGS.tagOrder, {
    name: "STAGECRAFT.Settings.TagOrder.Name",
    hint: "STAGECRAFT.Settings.TagOrder.Hint",
    scope: "world",
    config: true,
    type: new fields.StringField({required: true, blank: true, trim: true, initial: DEFAULT_TAG_ORDER}),
    default: DEFAULT_TAG_ORDER,
    onChange: onTagsChange
  });

  // Filter chips set whenever a browser opens, per browser: {stages: Chip[], cards: Chip[]} (see lib/filter.mjs).
  game.settings.register(MODULE_ID, SETTINGS.pinnedFilters, {
    scope: "world",
    config: false,
    type: Object,
    default: {stages: [], cards: []},
    onChange: onPinnedChange
  });

  // Tag suggestions the GM dismissed; never suggested again. Tag names only (see lib/tag-review.mjs).
  game.settings.register(MODULE_ID, SETTINGS.dismissedSuggestions, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: onDismissedChange
  });

  // Where the free text searches; per GM browser, like a view preference.
  game.settings.register(MODULE_ID, SETTINGS.searchScopes, {
    scope: "client",
    config: false,
    type: Object,
    default: {...DEFAULT_SCOPES}
  });

  // Cached lists of stage and card paths, stored in this browser only. Validated on load (see lib/index-cache.mjs).
  for ( const key of [SETTINGS.stageIndexCache, SETTINGS.cardIndexCache] ) {
    game.settings.register(MODULE_ID, key, {
      scope: "client",
      config: false,
      type: Object,
      default: null
    });
  }
}

/**
 * Read a Stagecraft setting.
 * @param {keyof typeof SETTINGS} key
 * @returns {unknown}
 */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, SETTINGS[key]);
}

/**
 * Write a Stagecraft setting.
 * @param {keyof typeof SETTINGS} key
 * @param {unknown} value
 * @returns {Promise<unknown>}
 */
export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, SETTINGS[key], value);
}
