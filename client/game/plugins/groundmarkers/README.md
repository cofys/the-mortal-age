# Ground Markers

A port of RuneLite 1.13.3's Ground Markers. It is on by default, as in RuneLite.

## Marking

Hold **Shift** and right-click a tile. Just above "Walk here":

- **Mark Tile** / **Unmark Tile**: marks it in the tile colour from the settings.
- On a marked tile:
  - **Label Tile** asks for a label in the chatbox; an empty label removes it.
  - **Color Tile** gives the other colours in use, **Pick**, and **Reset all**. Reset all is offered when the region has more than one marked tile, and asks first.

Marks are kept per region in config group `groundMarker` as `region_<regionId>`, in RuneLite's
JSON (`regionId`, `regionX`, `regionY`, `z`, `color`, `label`). Inside instances they are
stored by the real-world tile the instance was copied from, so a mark shows wherever that tile
appears.

## Sharing

Right-click the world map orb:
- **Export Ground Markers** copies the loaded area's marks to the clipboard.
- **Import Ground Markers** adds marks from the clipboard, after asking. It skips tiles that are already marked.
- **Clear Ground Markers** removes the loaded area's marks, after asking.

The JSON is RuneLite's, so markers move between RuneLite and this client both ways. Turn
"Show import/export/clear options" off to remove these options.

## What it draws

- Each marked tile on your plane within 32 tiles: the outline in its colour, at the border width, filled black at the fill opacity, with its label.
- With "Draw tiles on minimap", a 1px outline on the minimap too.

## Differences from RuneLite

- **Pick** uses the browser's colour picker, which has no alpha slider; the tile keeps its alpha.
- Import needs the browser's permission to read the clipboard. Without it, the plugin says "Unable to read system clipboard.", as RuneLite does when the clipboard can't be read.
