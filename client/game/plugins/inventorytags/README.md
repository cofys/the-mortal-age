# Inventory Tags

A port of RuneLite 1.13.3's Inventory Tags plugin. Turn it on in the plugin list; it is off
on fresh installs.

## Tagging

Hold **Shift** and right-click an item to get an **Inventory tag** submenu, just above Cancel:

- one **Color** entry for each colour already used by a tagged item you carry or wear,
  except the item's own colour;
- **Pick**, which opens the browser's colour picker;
- **Reset**, shown when the item is tagged, which removes the tag.

A tag belongs to the item, not the slot, so every copy of the item is tagged. Noted items
and bank placeholders share their real item's tag.

Items can be tagged in the inventory, worn equipment and the inventory-like side panels:
equipment stats, bank and shared bank side, deposit box, shop, Grand Exchange offers and
price checker, seed vault, trade, POH costumes, raids storage and gravestones. The bank's
own item grid is not included, as in RuneLite.

## Display

The **Tag display mode** section has four settings, with RuneLite's defaults:

| Setting      | Default | Effect                                             |
|--------------|---------|----------------------------------------------------|
| Outline      | on      | Traces the item sprite in the tag colour           |
| Underline    | off     | Draws a line just below the item                   |
| Fill         | off     | Fills the item's shape in the tag colour           |
| Fill opacity | 50      | Alpha of the fill, 0 to 255                        |

## Storage

Tags are saved in config group `inventorytags`, one key per item: `tag_<itemId>` holding
`{"color":"#rrggbb"}`, the same shape as RuneLite's `Tag`.

## Differences from RuneLite

- **Pick** uses the browser's native colour picker instead of RuneLite's colour chooser.
- Plugins now receive the right-click menus of items in any interface, not just the main
  inventory. Menu Swapper ignores those menus, so its behaviour is unchanged.
