# Object Markers

A port of RuneLite 1.13.3's Object Markers (its Object Indicators plugin). Turn it on in the
plugin list; it is off on fresh installs.

## Marking

Hold **Shift** and right-click an object. Above its Examine option:

- **Mark object** / **Unmark object**.
- On a marked object, **Mark border color** (colours in use, then red, green, blue, yellow,
  magenta, and Pick color), **Mark fill color** (the same at a light alpha, Pick color, Reset)
  and **Mark style** (toggle Hull, Outline, Clickbox or Tile, or Reset to the global styles).

Marks are kept per region in config group `objectindicators` as `region_<regionId>`, in
RuneLite's format. Inside instances they are stored by the real-world tile the instance was
copied from, so a mark applies wherever that tile appears. A door or gate keeps its mark: it
shows while the object is in the marked form. A multi-form object shows only while its current
form has the marked name.

## What it draws

In the **Render style** section, any mix of hull, model outline, clickbox and tile, in the
marker (border) colour with the fill colour, and a border width. An object's own style, if
set, replaces these. Marks draw over the scene and under interfaces, on your current plane.

## Differences from RuneLite

- **Clickbox:** the client has no clickbox, so it is the model's bounding box seen on screen
  (the outline of its eight corners), which is how RuneLite builds clickboxes for most objects.
- **Pick color** uses the browser's colour picker; the colour keeps the alpha it had.
- The outline uses the client's model outline pass; "Outline feather" is accepted but the
  outline's softness is that pass's own.
