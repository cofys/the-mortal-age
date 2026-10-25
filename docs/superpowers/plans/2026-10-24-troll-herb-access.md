# Troll Stronghold herb patch access

**Goal:** Enforce the published quest unlock and regular-goutweed restriction at the Troll Stronghold herb patch.

**Architecture:** Identify the existing cache-backed patch once, and apply the quest requirement through `quest:is-complete` before the existing generic patch-access hook. Refuse regular goutweed in the planting path before consuming any seed or tool input. Other patches retain their existing behavior.

Sources: [Herb patch](https://oldschool.runescape.wiki/w/Herb_patch) requires completion of My Arm's Big Adventure; [quest rewards](https://oldschool.runescape.wiki/w/My_Arm%27s_Big_Adventure#Rewards) explicitly exclude regular goutweed from this patch.

1. Add real registered-handler regressions for all three access routes, unanswered quest status, completed unlock, goutweed refusal, ordinary-patch planting and external restrictions. Observe failures before changing source.
2. Add the cache-backed patch selector and quest guard; add the crop-specific planting restriction.
3. Build and run focused/full tests, obtain independent review and publish this access fix separately.

Scope: this chat's isolated `fix/farming-troll-herb-access` branch from upstream main. No quest-module edits, generated data, live saves, deployment or other chats' work. Fixtures answer the existing quest query and stub scenery; they do not run the quest narrative or live rendering/save-relog.
