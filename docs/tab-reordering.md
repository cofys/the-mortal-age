# Spell and prayer reordering

Two client plugin hub entries, ported from RuneLite: **Spellbook** (RuneLite's Spellbook plugin)
and **Prayer** (the reordering part of RuneLite's Prayer plugin). Both are on by default. The live
game has nothing like this: the server is never involved, and orders are kept in the browser.

## Using it

1. Right-click the Magic or Prayer tab's stone and pick **Enable spell reordering** /
   **Enable prayer reordering**. The chatbox says it's enabled, and the tab gets a red tint.
2. **Drag a spell** onto another to move it there: the spells in between shift by one.
   **Drag a prayer** onto another to swap the two.
3. Right-click a spell or prayer for **Hide**. While reordering, hidden ones stay in the list, faded,
   with **Unhide**.
4. Pick **Disable … reordering** on the stone. Hidden spells and prayers are left out of the tab.

The orders and hidden entries are per spellbook (and per Lunar/Arceuus sublist) and per prayer book.
The quick-prayer setup uses the prayer order but still lists hidden prayers. **Reset** in the plugin
hub forgets the plugin's orders and hidden entries. Each uses RuneLite's config keys:

| Plugin | Group | Keys |
| --- | --- | --- |
| Spellbook | `spellbook` | `spell_pos_book_<enum>_<spell obj>`, `spell_hidden_book_<enum>_<spell obj>` |
| Prayer | `prayer` | `prayer_order_book_<book>` (comma-separated prayer ids), `prayer_hidden_book_<book>_<id>` |

## How it works

`client/game/plugins/tabreorder/`. `BookReorderPlugin` holds what both share (the stone option, the
tint, drag and Hide), and `tabReorder.ts` holds the ordering rules.

- **Sort callbacks.** The cache's tab scripts build a list of the entries that pass the tab's filters,
  sort it, then lay it out. `rs/cs2/sortCallbacks.ts` inserts a `runelite_callback` after each sort
  as the scripts load, the same hook RuneLite patches into `magic_spellbook_redraw` ("spellbookSort").
  The plugin reorders the list and drops hidden entries, and the cache's own layout does the rest.
  The filters, icon resizing and grid spacing all still apply.

  | Script | Sort | Event |
  | --- | --- | --- |
  | `magic_spellbook_redraw` (2611) | `magic_spellbook_sort` (2621) | `spellbookSort` |
  | `prayer_redraw` (547) | `prayer_quicksort` (465) | `prayerSort` |
  | `quickprayer_init` (466) | `prayer_quicksort` (465) | `quickPrayerSort` |

  The callback runs with the list's enum and length on the int stack and the array on the object
  stack. A plugin gets it as `ClientPlugin.onScriptCallback`. The block is appended to the script and
  the sort's `invoke` jumps to it, so the script's other jumps don't move. If a cache update changes
  the code around a sort, the patch is skipped with a console warning and the tab keeps its cache order.
- **Dragging** sets RuneLite's `DRAG` and `DRAG_ON` widget flags on each entry while reordering is on.
  The drop reaches the plugin as `ClientPlugin.onWidgetDragComplete`, and the drag isn't sent to the
  server.
- **Hide** is op 6 on spells (`magic_spellbook_modifyops` uses ops 1-5 and 10) and op 4 on prayers,
  as in RuneLite. `prayer_updatebutton` clears a prayer's ops, so the plugin adds it back after that
  script and after `prayer_redraw`.
- **The stone option** is op 10 on `toplevel:stone5/6`, `toplevel_osrs_stretch:stone5/6` and
  `toplevel_pre_eoc:stone5/6`. The plugin consumes it before it reaches the server.

## Differences from RuneLite

- A hidden prayer leaves no gap: prayers close up as they do for the cache's prayer filters. RuneLite
  places each prayer itself, so hidden prayers leave empty slots.
- The quick-prayer setup is laid out by its cache script in the new order, rather than moved
  afterwards.
