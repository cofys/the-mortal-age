# Tile Indicators

A port of RuneLite 1.13.3's Tile Indicators. It is off by default, as in RuneLite. The files
keep the plugin's earlier name, Tile Markers.

## What it draws

Over the scene and under interfaces, in this order:

- **Hovered tile:** the tile under the mouse, as "Walk here" picks it. Off by default, and its default border is fully transparent, as in RuneLite.
- **Destination tile:** where you are walking to. On by default, grey.
- **True tile:** the tile the server has you on, moving or standing still. Off by default, cyan.

Each has its own on/off, border colour, fill colour (both with alpha; fills default to black at
alpha 50) and border width, in config group `tileindicators` with RuneLite's keys and
sections. Nothing is drawn during cutscenes.

## Earlier settings

The plugin used to be "Tile Markers", drawn by the renderers as 1px lines in the scene, with
four settings in group `tilemarkers`. Saved values move once to the new keys:
- show destination → highlight destination;
- show true tile → highlight true tile;
- the colours, as opaque colours;
- a saved on/off moves too.

Anything never changed takes RuneLite's defaults, so the plugin starts off.

## Differences from RuneLite

- The tile is its four corners projected at the ground's height (as Ground Markers draws), in place of RuneLite's canvas tile polygon.
- Borders use the client's polyline, so RuneLite's stroke joins are approximated.
