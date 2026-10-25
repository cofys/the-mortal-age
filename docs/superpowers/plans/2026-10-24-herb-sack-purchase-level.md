# Herb sack purchase level

Gricoller checks current Herblore when selling herb sacks. The Wiki explicitly marks the level-58 purchase requirement as not boostable, so a player with base 57 can currently buy one after boosting.

Source: [Herb sack](https://oldschool.runescape.wiki/w/Herb_sack). Use the existing base-level API for this purchase requirement.

1. Reproduce the reward callback using real Player/SkillManager/Inventory with boosted and drained levels. Cover exact point cost, insufficient points, full inventory, a boost applied after menu opening and walking away.
2. Change only the herb-sack purchase check from current level to max/base level. Keep the inventory, point, persistence and collection-log transaction unchanged.
3. Build, run focused and full tests, obtain independent review and publish a separate PR from upstream main.

Scope: this chat's isolated `fix/farming-herb-sack-purchase-level` branch. This does not change herb-sack use, Slayer shops, other rewards, generated data, live saves or other chats' work. Fixtures capture the reward menu and outgoing events; live rendering and persistence roundtrip are not tested.
