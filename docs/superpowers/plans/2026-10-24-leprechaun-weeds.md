# Leprechaun weeds noting

The harvested-produce eligibility check excludes weeds because they are raked rather than listed as a crop's produce. The Wiki explicitly records weeds noting support since 28 May 2015.

Source: [Tool Leprechaun](https://oldschool.runescape.wiki/w/Tool_Leprechaun). Resolve weeds and notes from the cache, preserving the existing noting path and exceptions.

1. Reproduce using the real item-on-NPC handler and inventory. Cover all weeds, a full bag, Falador's cabbage exception, already-noted input and unrelated produce/log eligibility.
2. Include weeds alongside willow branches in the existing eligibility check. No new override layer or generated data edits.
3. Build, run focused and full server tests, obtain independent review and publish a separate PR from upstream main.

Scope: this chat's isolated `fix/farming-leprechaun-weeds` branch. The noting-capacity fix is in separate PR #909. No live saves, deployment or other chats' work. Fixtures do not exercise live NPC dialogue rendering or save/relog.
