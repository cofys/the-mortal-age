# Belladonna hand protection

The Farming backlog explicitly lists precise nightshade restrictions. The existing item-name regex lets Mime gloves harvest safely and rejects Regen bracelet. Both were reproduced with real in-memory Player/Inventory/Equipment through the Farming object interaction hook; rendering and object-action decoding were doubled. Existing offline-growth and timing checks pass; this change does not replace their formulas.

Source: [Belladonna](https://oldschool.runescape.wiki/w/Belladonna#Gloves) lists protective handwear, explicitly excludes decorative Mime gloves and specifies 2 damage with a poison hitsplat instead of harvesting when unprotected. [Warm gloves](https://oldschool.runescape.wiki/w/Warm_gloves) also explicitly do not protect. Cache inspection found no shared protection flag: safe Leather gloves expose only combat-stat params; Regen bracelet and the nonlisted Tormented bracelet share only their hands-slot param. Use the published protective families, resolving all matching unnoted/nonplaceholder hands-slot variants from the cache. Unknown families are not inferred safe from their names or stats.

1. Write and observe failing real-Player harvest regressions: safe non-glove handwear, unsafe decorative gloves, empty/inventory-only gloves, slot correctness, queued 2-damage green hit, unchanged plant/XP/produce on failure and inventory failure on safe harvest.
2. Keep the content rules in authored Farming data, not generated item definitions. Resolve names and hand-slot IDs from the cache on initialization. Replace the regex with membership of the actual worn hands item; queue a one-off green hit on failure without applying a poison status.
3. Run new harvest regressions, existing Farming state/hook checks and relevant damage tests; build, obtain independent review, commit/push one review-ready PR. Do not deploy or touch account saves, main or Claude's client/clue/NPC Indicator files.

Branch fix/belladonna-hand-protection in the idle Codex tsps-pr856-merge checkout starts at upstream e7ff37b6129abd2c205c44f069ce631e771ea6ec; the separate reclaim branch/PR is preserved.
