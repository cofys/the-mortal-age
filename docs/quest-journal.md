# Quest journal

What the quest list's "Read journal" opens, from rsprox captures of live OSRS (revisions 224-239)
and the rev 241 cache.

## A quest not started: the overview (782)

Live OSRS opens `questjournal_overview` (782) for a quest the player has not started, not the
journal. The server sends:

1. `varp latest_quest_journal` (3679): the quest's row in the cache quest table (dbtable 0).
2. `if_opensub toplevel:floater -> questjournal_overview` (overlay).
3. `if_settext questjournal_overview:title "<col=7f0000><quest name></col>"`.
4. `if_setevents questjournal_overview:content_inner` slot 1, op 1 ("Show on Map").
5. `script questjournal_overview_setup` (6821) with `[quest row, start sentence,
   universe, content_inner, content_outer, scrollbar, inner, container, scroll, combat level]`.
   The component order is the one rev 235-237 captures send. The last argument is the player's
   combat level, stored in varc 52.

The setup script builds the rest from the quest's cache row: "I can start this quest by "
(or "miniquest"), then the start sentence, then "Show on Map", Difficulty, Length,
Storyline, Release Year, Requirements and Recommendations, coloured against the player's
stats. The only text the server sends is the start sentence, which it gets from:

- `server/plugins/quests/data/quest-start-text.json`, filled by `yarn sync:quest-start-text`
  from the OSRS Wiki's journal transcripts (`Transcript:<quest>/Journal`), plus the sentences
  live captures recorded for quests with no transcript. The Wiki and capture texts are the same
  for every quest that has both;
- otherwise, the quest's own not-started journal line, `I can start this quest by ...`.

"Show on Map" (content_inner slot 1) opens the world map and runs `script3331
[worldmap:map_noclick, startcoord, mapelement]` from the quest's row.

## A quest started or complete: the journal (119)

`questjournal` (119) with `qj_lines`, `quest_journal_reset` (5240), the title, a line per
`questjournal:qj<n>` and script 2523 `[0, line count]`. In the cache, every line widget's text
is black, so live OSRS colours each line itself: navy `<col=000080>` text, with names and places
in `<col=800000>` and then back to `<col=000080>`. Finished steps are `<str>`, and the
completion line is `<col=ff0000>QUEST COMPLETE!`. The runtime adds the navy to each line, so
quest journals write plain text with `<col=800000>...</col>` highlights.
