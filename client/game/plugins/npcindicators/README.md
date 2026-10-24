# NPC Indicators

A port of RuneLite 1.13.3's NPC Indicators. Turn it on in the plugin list; it is off on fresh
installs.

## Choosing NPCs

- **By name:** "NPCs to highlight" takes a comma-separated list. Names match whole and ignore
  case; `*` matches anything, so `gob*` matches Goblin.
- **By tag:** hold **Shift** and right-click an NPC. Above its Examine option you get:
  - **Tag** / **Un-tag**: highlights that one NPC. Tags last until the plugin is turned off
    or the client closes, as in RuneLite.
  - **Tag-All** / **Un-tag-All**: adds the NPC's name to the list, or removes it.
  - For a highlighted NPC, **Tag color** (colours in use, then red, green, blue, yellow,
    magenta, Pick color, Reset) and **Tag style** (Hull, Tile, True tile, South-west tile,
    South-west true tile, Outline, Reset). These apply to every NPC with that id.

## What it draws

In the **Render style** section, any mix of: hull, tile (where the NPC is drawn), true tile
(its server tile), the south-west tile of either, and the model outline. Each is a border in
the highlight colour filled with the fill colour; the outline uses the border width. A tag
style replaces these for that NPC. Highlights draw over the scene and under interfaces.

Also, optionally: names above NPCs, names on the minimap (highlighted NPCs always get a
minimap dot), menu entries recoloured by name, level or both, and a separate menu colour for
dead NPCs. Dead NPCs and pets are ignored by default.

## Respawn timers

With "Show respawn timer" on, highlighted NPCs that die within 15 tiles of you are counted
down on the tile they respawn on, once a respawn has been seen there. Times are learnt from
what you watch: the shortest seen, up to 500 ticks.

## Storage

Config group `npcindicators`, with RuneLite's keys: the settings, `highlightcolor_<npcId>` and
`tagstyle_<npcId>`.

## Differences from RuneLite

- **Pick color** uses the browser's colour picker.
- The outline uses the client's model outline pass; "Outline feather" is accepted but the
  outline's softness is that pass's own.
- RuneLite's online runtime lists of special-case NPCs for death detection are not used; its
  built-in lists are.
- NPCs aboard boats (world entities) are not highlighted yet.
