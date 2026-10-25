# Spirit tree planting limits

The planting check uses the old base-level 83/91/99 progression. [Spirit tree](https://oldschool.runescape.wiki/w/Spirit_tree#Farming) documents the 4 February 2026 change to one tree at83, two at88, three at93, four at96 and unlimited at99. These thresholds may be temporarily boosted.

1. Reproduce through the registered item-on-object handler using real Player/SkillManager/Inventory and cache-backed spirit patches. Cover exact and below-threshold levels, boosts, drained levels and failed-plant input preservation.
2. Use current Farming level for the existing limit check and replace its obsolete thresholds. Keep the separate level83 planting gate, inventory/tool checks and saved tree counting intact.
3. Build, run focused/full tests, obtain independent review and publish a separate upstream PR.

Scope: this chat's isolated branch `fix/farming-spirit-tree-limits`, directly from upstream main. No spirit-tree travel changes, POH storage changes, generated data, live saves, deployment or other chats' work. Tests capture the registered handler and stub scenery packets; live rendering and disk save/relog are not exercised.
