# Explorer's ring free alchemy

Finish the user-requested ring feature, then audit the Pets tracker. Inline planning and
implementation are already authorized. Own worktree only; preserve Claude and live game.

Cache241 lumbridge_alchemy483 replaces inventory tab3: low1, high2, close4, items7,
charges8. Native choice lumbridge_alchemy_high5398, used count lumbridge_free_alchs4554.
Persist choice; DailyRing retains its shared30/day and login-only midnight replenishment.
Inventory/worn Alchemy opens this panel. Low requires21Magic; High55 and ring4. All
spellbooks can use dedicated free casts, without runes or XP. Item-on-ring warns unless
the native alchemy_warning_forinventory_disabled setting is on. Ring cannot alch itself.
Normal spellbook casts use a complete rune payment first (including substitutes); only
insufficient complete payment falls back to held/worn eligible ring charges. Partial
rune supplies stay untouched. No failed or queued/stale action spends a charge.

Reuse existing core alchemy level/zone/policy/confirmation/cooldown/effects pipeline through
a generic api.core.castAlchemy entry. Generic alchemy-payment event exposes source,
complete-rune availability, XP/book/tab overrides and validate/commit callbacks. All
ring logic stays in Alchemy.DiaryRewards.js. Queue retains exact item identity/source;
revalidate player registration/life/status, held exact ring and native panel ownership.
Confirm callbacks revalidate. Dedicated casts preflight coin capacity after exact-slot
removal. Trade/death/logout, removed ring and replaced/closed panel cannot cast.

Wiki Explorer's rings source requirements/noXP/rune preference/item-use behavior. Native
layout/scripts1460/1462/1464 are cache evidence. RSProx has no indexed lumbridge_alchemy
actions; do not claim recorded interface order. Existing low/high effects use alchemy.md.

Real Player/Inventory/PacketSender/ClientConnection tests cover tiers/levels/books, noXP,
30 cap, rune preference/partial supplies, cooldown, staleness, confirmation, metadata,
coin caps and save/relog. Build, focused/full tests, Codex review/re-review, own-server
walkthrough and stopped services precede a ready PR. Pets items get separate PRs afterward.
