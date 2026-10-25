# Tile Packs

A port of the RuneLite Plugin Hub plugin [Tile Packs](https://github.com/TrevorMDev/tile-packs)
by TrevorMDev (BSD-2, see `LICENSE`), at its Hub commit `8091ee8`. Turn it on in the plugin
list; it is off on fresh installs.

## Using it

The plugin adds a **Tile Packs** button to the sidebar (unless "Hide on toolbar" is on). The
panel lists every pack:

- **Add tiles** / **Remove tiles** turns a pack's tiles on or off.
- The eye hides a pack from the list without turning it off. The two eyes at the top show the
  packs that are shown, hidden, or both.
- Copy puts the pack's tiles on the clipboard, as ground marker JSON.
- The YouTube, Discord or help icon opens where the pack came from.
- Custom packs are added at the bottom from a name and ground marker JSON (RuneLite's export
  format), and can be deleted.

## Storage

As in the plugin, so the keys match a RuneLite profile:

- Settings in config group `tilepacks`.
- Pack state in group `tilePacks`:
  - `packs`: the enabled pack ids
  - `pack_<id>`: a bundled pack's visibility, or a whole custom pack
  - `customId`: the last custom id; custom packs start at 10000
  - `showVisible` / `showInvisible`: the list filters
  - `tilePacksVersion`: the plugin's v1 settings are migrated

The packs are the plugin's `tilePacks.jsonc`, unchanged, in `client/public/tilepacks/`. To update
them, copy the newer file over it.

## What it draws

- Each enabled pack's tiles in the loaded area, on your plane and within 32 tiles.
- Inside instances they are drawn wherever their real-world tile was copied to.
- Each tile is outlined in its colour (or the override colour), filled black at the fill
  opacity, with its label if labels are on.
- With "Draw tiles on minimap", each tile is also outlined on the minimap.

## Differences from the plugin

- The panel's icons are redrawn as SVGs; the plugin's are Flaticon images.
- Error messages show in the panel instead of pop-up dialogs, and deleting asks with the
  browser's confirm.
- The pack file is fetched from `public/` the first time the plugin starts.
- A tile with no colour draws yellow, Ground Markers' default.
