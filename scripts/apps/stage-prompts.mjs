/**
 * Questions before a stage switch, shared by the stage browser and the dialogs of the card browser (a dialog with a
 * stage switches it too).
 */
import { MODULE_ID } from "../constants.mjs";
import { currentEntry, getStageScene, getStageSrc } from "../stage-scene.mjs";
import { getLightPresets, hasUnsavedPreset, presetKey, savePreset } from "../light-presets.mjs";

const { DialogV2 } = foundry.applications.api;

/** Save the lights and walls on the stage for the variant on show and say what happened. */
export async function saveStagePreset() {
  const entry = currentEntry();
  const had = Boolean(entry && getLightPresets()[presetKey(entry)]);
  const {lights, walls} = await savePreset(getStageScene(), entry);
  const message = (lights || walls) ? "Saved" : (had ? "Removed" : "Nothing");
  ui.notifications.info(game.i18n.format(`STAGECRAFT.Lights.${message}`, {lights, walls, file: entry.file}));
}

/**
 * Before a switch: if the lights and walls on the stage are not saved, ask whether to save them, drop them or
 * stay.
 * @param {string} path  The image to switch to.
 * @returns {Promise<boolean>}  Whether to switch.
 */
export async function confirmLights(path) {
  const scene = getStageScene();
  if ( !scene || (getStageSrc(scene) === path) ) return true;
  const entry = currentEntry();
  if ( !hasUnsavedPreset(scene, entry) ) return true;
  const saved = entry && getLightPresets()[presetKey(entry)];
  const text = !entry ? game.i18n.localize("STAGECRAFT.Lights.WarnUnindexed")
    : game.i18n.format(saved ? "STAGECRAFT.Lights.WarnChanged" : "STAGECRAFT.Lights.WarnNew",
      {file: entry.file});
  const buttons = [
    ...(entry ? [{action: "save", label: "STAGECRAFT.Lights.SaveAndSwitch", icon: "fa-solid fa-lightbulb",
      default: true}] : []),
    {action: "discard", label: "STAGECRAFT.Lights.DiscardAndSwitch", icon: "fa-solid fa-trash", default: !entry},
    {action: "cancel", label: "STAGECRAFT.Lights.Cancel", icon: "fa-solid fa-xmark"}
  ];
  const choice = await DialogV2.wait({
    window: {title: "STAGECRAFT.Lights.WarnTitle", icon: "fa-solid fa-lightbulb"},
    classes: [MODULE_ID, "stage-lights-dialog"],
    position: {width: 460},
    content: `<p>${foundry.utils.escapeHTML(text)}</p>`,
    buttons,
    rejectClose: false
  });
  if ( choice === "save" ) {
    await saveStagePreset();
    return true;
  }
  return choice === "discard";
}
