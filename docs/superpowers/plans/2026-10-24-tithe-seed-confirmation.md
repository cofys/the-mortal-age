# Tithe seed confirmation validation

The seed table checks level and other-tier fruit when choosing a crop, but its delayed quantity callback rechecks only other-tier seeds. A boost can expire or a different fruit can enter the inventory before final confirmation.

Source: [Tithe Farm requirements](https://oldschool.runescape.wiki/w/Tithe_Farm#Requirements): boosts may meet the level requirements when taking seeds and planting; only one tier can be used at a time. The limit is 10,000 seeds.

1. Reproduce through both real seed-table menu callbacks with real Player/SkillManager/Inventory. Cover all three tier levels, boost decay, maintained boosts, changed inventory, cap/repeats, distance and capacity.
2. Recheck current Farming level and the same different-tier seed/fruit restriction immediately before granting the seeds.
3. Build, run focused/full tests, obtain independent review and publish a separate upstream PR.

Scope: isolated branch `fix/farming-tithe-seed-confirmation` directly from upstream main. No Tithe scoring, reward, planting or generated data changes. No live saves, deployment or other chats' work. Menu callbacks are captured in fixtures; live rendering and disk save/relog are not exercised.
