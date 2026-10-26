# Optimal Quest Guide

A port of the RuneLite Plugin Hub plugin
[Optimal Quest Guide](https://github.com/cesoun/optimal-quest-guide) by cesoun (Christopher
Oswald; BSD-2, see `LICENSE`), at its Hub commit `b801ca1`. Turn it on in the plugin list; it
is off on fresh installs. Its sidebar button is "Optimal Quest Guide".

## Using it

The panel lists the quests in the OSRS Wiki's
[optimal quest guide](https://oldschool.runescape.wiki/w/Optimal_quest_guide) order:

- Each quest's name is coloured by its state: not started, in progress or completed.
- Under the name are its skill, quest point and combat level requirements. Each level is
  coloured met, unmet, or unmet but boostable, against your real (unboosted) level.
- Completed quests are hidden unless "Show completed quests" is on.
- "Filter by met Requirements" also hides quests you don't have the levels for yet.
- The search bar filters by name. It searches the quests that are shown, or every quest if
  "Search completed quests" is on.
- Right-click a quest for **Open Wiki Guide**, which opens its wiki page in a new tab.

Before you log in, every quest shows, uncoloured.

## How it reads quests

The panel updates every game tick, as in the plugin, and redraws only when a quest state or a
level changed. Quest states come from RuneLite's `Quest.getState`. It runs the cache's
`quest_status_get` script (4029), the script the in-game quest list uses, so the states always
match the quest tab.

The quest list is the plugin's `quests.json`, unchanged. The plugin generates it from the wiki
with [osrs-wiki-parse](https://github.com/cesoun/osrs-wiki-parse). To update it, copy the newer
file over it. "Knight Waves Training Grounds" is in the guide but not in RuneLite's `Quest`
enum. As in the plugin, it never gets a state, so it shows only when "Show completed quests" is
on.

## Storage

Settings are in config group `optimal-quest-guide`, with the plugin's keys, so they match a
RuneLite profile. The enabled state is `runelite.guideplugin`.

## Differences from the plugin

- Filtering by met requirements shows a quest again as soon as you meet its requirements. The
  plugin hides it and leaves it hidden until you turn the filter off.
- The panel keeps updating while the search box has text. The plugin froze it.
- Long quest names wrap. In Swing they were cut off.
