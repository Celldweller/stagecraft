# Stagecraft

A Foundry VTT module for scenes told with pictures: **stages** (mood images as the background of one stage scene) and **cards** (NPC portraits shown to the players as a layer above it).

## Features

**Stages**
- One fixed stage scene. Switching a stage replaces its background image and size; no scene per image, no actors.
- Reads a folder of images, subfolders included. Locations and variants come from the file names (`Harbor (Night).webp` is the variant “Night” of “Harbor”), without any setup per image.
- Stage browser with search, tags and filters; tags can be edited for many images at once.
- Transitions between stages (cross-fade, dip to black, wipes, iris) and a view lock: players see the stage fitted to their screen and cannot pan or zoom.
- Light presets: lights and walls saved per stage variant and restored on every switch.

**Cards**
- NPC portraits (2:3) as an HTML layer, visible while a client views the stage scene.
- A cast of up to 12 cards, each shown or hidden. The players see the shown cards in the order of the cast; a speaker is highlighted and the others are dimmed.
- Card browser with search and tags, drag and drop into the cast, several entrance animations.
- Planning mode: prepare the next cards as a draft the players do not see, then show it in one step.
- Saved dialogs (cards, speaker and optionally a stage) shown with one click, and a history of the last five casts.

## Requirements

- Foundry VTT v14 (14.370 or later).
- No dependency on a game system; tested with D&D 5e.

## Installation

In Foundry, go to *Add-on Modules → Install Module* and paste this manifest URL:

```
https://github.com/Celldweller/stagecraft/releases/latest/download/module.json
```

## Getting started

1. Enable Stagecraft in your world.
2. In *Game Settings → Configure Settings → Stagecraft*:
   - choose or create the **stage scene**,
   - set the **stage folder** and the **card folder** (on The Forge, choose “The Forge Asset Library” as the source).
3. Open the **stage browser** or the **card browser** from the token controls. Choose *Rescan* in the window menu (⋮) to read the folder.
4. Click a stage to show it, click a card to add it to the cast.

Keybindings for *End Dialog*, *End speaker* and *Show draft* can be set under *Configure Controls*.

## Macros

The API is available as `game.modules.get("stagecraft").api`. Calls that change something are reserved for the GM.

```js
// End the dialog: empty the cast
await game.modules.get("stagecraft").api.cards.removeAll();

// Show a saved dialog, with its stage if it has one
await game.modules.get("stagecraft").api.dialogs.show("Pilgrims at the well");
```

## License

[MIT](LICENSE)
