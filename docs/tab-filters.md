# Prayer and spellbook filters

The filter button on the Prayer tab ("Prayer Filters") and the Magic tab ("Spell Filters") opens a
menu of checkboxes. `server/plugins/interface/TabFilters.plugin.js` handles both menus.

## How the menus work

The cache scripts build each menu and draw every row's checkbox from one varbit. The row number is the
`if_button` slot.

| Row | Prayer (`prayerbook:filtermenu`, 541:42; script 3156) | Spellbook (`magic_spellbook:filtermenu`, 218:206; script 2603) |
| ---: | --- | --- |
| 0 | `prayer_filter_blocklowtier` (6574) "Show lower tiers of tiered prayers" | `magic_filter_blockcombat` (6605) "Show Combat spells" |
| 1 | `prayer_filter_allowcombinedtier` (6575) "Show tiered prayers even if multi-skill prayers are available" | `magic_filter_blockteleport` (6609) "Show Teleport spells" |
| 2 | `prayer_filter_blockhealing` (6576) "Show Rapid Healing prayers" | `magic_filter_blockutility` (6606) "Show Utility spells" |
| 3 | `prayer_filter_blocklacklevel` (6577) "Show prayers you lack the Prayer level to activate" | `magic_filter_blocklacklevel` (6607) "Show spells you lack the Magic level to cast" |
| 4 | `prayer_filter_blocklocked` (6578) "Show prayers you lack the requirements to activate" | `magic_filter_blocklackrunes` (6608) "Show spells you lack the runes to cast" |
| 5 | | `magic_filter_blocklocked` (12137) "Show spells you lack the requirements to cast" |
| 6 | | `magic_spellbook_blockresizing` (6548) "Enable icon resizing" |

The client never sets these varbits itself. The server flips them, and the tab's scripts redraw the list.

## From rsprox captures

- **Clicking a row** flips only that row's varbit, 0 → 1 or 1 → 0. There is no message or interface packet.
  Spellbook rows were captured in recordings 3657, 3724 and 3792 (rev 235). The prayer row (slot 0) was
  captured in recording 2843 (rev 230).
- **The rows' events** come as part of the login's tab setup. Right after `if_opensub` of each tab, the server
  sends `if_setevents` op1 on `prayerbook:filtermenu` slots 0-4 and on `magic_spellbook:filtermenu` slots 0-6.
  These are entries in `gameframeFlagEntries` (`ClientProtocol.ts`). `sendTabInterface` re-sends them whenever
  it mounts the prayer or magic tab again (spellbook switch, quick-prayer setup), because the client drops a
  closed interface's flags.
- **A new account** starts with `magic_filter_blocklacklevel` = 1: the tutorial says the list "is currently
  filtered to only show the spells you have the Magic level for". The varbit goes back to 0 on the tick
  `tutorial` (varp 281) becomes 1000. Every tutorial capture shows this pattern, and the captured endings are
  skips. Tutorial Island emits `tutorial:started` and `tutorial:completed`, and TabFilters sets and clears the
  filter on them.

## Saving

Each menu is saved as a bitmask by row, in `tab-filters:prayer` and `tab-filters:magic`. On login, the rows
that are set are sent again.
