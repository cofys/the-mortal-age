# Lletya fruit-tree patch access

The Wiki Unlockable content and Fruit tree patch pages require starting Mourning's End Part I before using Lletya's patch. The existing Farming handler currently accepts use with no quest check.

1. Reproduce locked object/item/spell routes before state or supplies change, using the canonical cache patch at 2346,3161.
2. Query the existing `quest:is-started` event for `mournings_end_part_i`, fail closed, and preserve external restrictions and all other fruit-tree patches. QuestRuntime treats completed quests as started too.
3. Verify unlocked sapling planting with a spade, unanswered query handling, unrelated patches and external denial. Build, run the full server suite and request independent review before a separate PR from upstream main.

Sources: https://oldschool.runescape.wiki/w/Unlockable_content and https://oldschool.runescape.wiki/w/Fruit_tree_patch . No quest files or generated data change.
