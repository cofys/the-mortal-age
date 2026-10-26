# Bank Tags

A port of RuneLite's core Bank Tags plugin (`net.runelite.client.plugins.banktags`, BSD-2) at
RuneLite 1.13.3 (`9821e4d4e8`). It's on by default, as in RuneLite. Its config group (`banktags`)
and keys are RuneLite's:
- `item_<id>`
- `tagtabs`
- `icon_<tag>`
- `layout_<tag>`
- `hidden_<tag>`
- `useTabs`, `rememberTab`, `removeTabSeparators`, `preventTagTabDrags`

## How it hooks into the bank

The bank is the cache's interface 12, run by the client's script VM.

**RuneLite's patched bank scripts.** RuneLite adds its callbacks by replacing four bank scripts
with patched copies:
- `bankmain_build`
- `bankmain_filteritem`
- the layout trigger
- the search input

The copies are in `rs/cs2/runelite/bankScripts.ts`, unchanged. `rs/cs2/runeliteScripts.ts`
assembles one in place of the cache's script only when that script's SHA-256 matches RuneLite's
`.hash` for it. That is RuneLite's own check. The installed cache, `osrs-241`, matches all four.
With the plugin off, every callback leaves the stack as the unpatched script would.

**Client support added for the port:**

| Feature | RuneLite name | Where |
|---|---|---|
| Hook before a script runs | `ScriptPreFired` | `rs/cs2/Cs2Vm.ts` |
| Scroll-wheel and drag-complete listeners | JavaScriptCallback | `widgets/custom/dynamicWidgets.ts` |
| Per-cycle drag event that can cancel a drop | `WidgetDrag` | `game/widgets/` |
| Custom images for sprite ids | `SpriteManager.addSpriteOverrides` | `widgets/gl/spriteOverrides.ts` |
| Chatbox item search | `ChatboxItemSearch` | `runelite/client/game/chatbox/` |
| Item variation map | `ItemVariationMapping` | `runelite/client/game/` |

The `ScriptPreFired` hook now runs while the invoked script's arguments are still on the stack.

**Plugin menus.** Bank menus now reach plugins' `transformMenuEntries`. This is for the deposit
buttons and the tag tabs, as RuneLite's `MenuEntryAdded` does.

## What's ported

- **Tagging:**
  - "Edit-tags" on bank items.
  - Variation tags: a tag ending in `*` covers every variation of the item.
  - Dragging an item onto a tab tags it with that tab.
  - "Tag-inventory" and "Tag-equipment" on the deposit buttons.
- **Searching:**
  - `tag:` searches, and plain searches that also match tags, with RuneLite's prompt text.
  - A Grand Exchange search for `tag:<name>` lists the tag's tradeable items.
- **Tag tabs:**
  - Tabs down the bank's left side, with the up and down arrows and the new-tab button.
  - Tab options: new, import, rename (or merge), delete, export, change icon, reorder by drag.
  - The "tag tab tab", which lists every tab as an item.
  - The last open tab is remembered.
  - The sprites are RuneLite's, in `public/runelite/banktags/`.
- **Layouts:**
  - "Enable layout" on a tab. Its items can then be arranged freely by drag, with swap or insert
    following the bank's mode.
  - Items missing from the bank show as placeholders.
  - "Duplicate-item" and "Remove-layout" on placeholders.
  - "Auto layout: Default", which places worn gear, the inventory, the rune pouch and the quiver.
  - A withdraw from a laid-out slot goes to the item's real bank slot.
- **API for other plugins:**
  - `BankTagsService`: `openBankTag`, `closeBankTag`, the active tag and layout, and the option
    flags.
  - `TagManager`: tags, custom `BankTag`s and hidden tags.
  - `LayoutManager`: layouts and `registerAutoLayout`.

## Not ported, and why

| RuneLite | Reason |
|---|---|
| Potion storage (`PotionStorage`): layouts matching potions in it, and dose withdraws | The offline server has no potion storage. |
| Shared (group) storage tag searches | No group storage offline. |
| Developer mode showing hidden tags | There's no developer mode. |

## A client limitation it works around

This client keeps widget ops 1–10 only (`CC_SETOP`). The bank's own script sets "Examine" as op 11,
so bank items have no Examine. RuneLite puts its item options just above Examine. Here they go
where Examine would be: last, above "Cancel" (`bankMenus.ts`).
