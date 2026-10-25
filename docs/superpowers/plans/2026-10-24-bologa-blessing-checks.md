# Bologa blessing checks implementation plan

**Goal:** Accept real equipped Zamorak items and refuse conflicting god equipment before taking Bologa's one-time payment.

**Architecture:** A Farming-owned helper reads cache god-affiliation parameters and an explicit, source-attributed family list for Bandos, Armadyl and Zaros (which lack those cache flags). Tithe keeps dialogue and reward ownership; no core/God Wars/client or generated-data edits.

**Additional reproduced defect:** `Data.itemId("Coins")` resolves the non-stackable quest item 617 rather than currency 995. Use the cache's existing `ItemIdentifiers.COINS` for this transaction and verify with real inventory currency.

**Sources:** OSRS Wiki Bologa, Transcript:Bologa, Bologa's blessing, and God Wars Dungeon's god-related equipment table. Cache revision 241 validates item parameters 40=Saradomin, 41=Zamorak, 42=Guthix, wear slots and real variants. Cache equipment tags include mixed-affiliation Staff of Light/Balance; neither counts as exclusively Zamorakian.

**Isolation:** Reuse this chat's isolated checkout on new branch `fix/bologa-blessing-checks` from upstream `106b6f141`. Redwood PR #903 stays on its existing branch. No live-world deployment, other chat/worktree changes, save replacement, client build or generated JSON changes.

## Steps

- [x] Verify source requirements, inspect the current payment callback and audit cache god tags.
- [x] Run baseline Farming model and Belladonna tests (6 passed) and server build.
- [x] Add regressions through the real Bologa dialogue/payment handler: valid name-independent equipment, wrong god, mixed gods, dual-affiliation items, empty slots, notes/placeholders/wrong slots, inventory-only items, late equipment changes, distance/level/coin checks, repeat payment and reward access.
- [x] Observe regressions fail before implementation (three initial transaction failures; additional Sanguine Torva regression failed before adding its verified family).
- [x] Replace the name regex with cache-backed outfit validation. Keep 50 Prayer, 75,000 coins, one-time unlock and 20 blessings per reward point. Request persistence after the successful transaction.
- [x] Verify source-backed conflicting-god families, approved cosmetic variants and neutral items; update Farming docs with exact source/coverage and limitations.
- [x] Run focused checks and full server suite and independently review the diff.
- [ ] Push only this fix and open a separate ready PR.

## Review focus

- Outfit and payment are checked at confirmation, not only at menu creation.
- An item aligned to Zamorak and another god must be refused.
- Empty slots and carried/banked or display-only items do not count as equipped devotion.
- Repeated/stale confirmations cannot consume coins twice or mutate detached saved state.
- Unknown new item families are not inferred from name fragments or prayer bonuses.

## Scope ruling

The Wiki item page mentions 65 Cooking, but Bologa's own article and exact dialogue transcript gate the unlock on 50 Prayer, equipment and payment only. This equipment-focused PR preserves the current Prayer requirement and does not introduce a Cooking unlock gate or change grape yields/use mechanics.

## Validation

Cache audit found 112 wearable Zamorak-tagged definitions, including four dual-affiliation variants. Real item parameters, wear slots and currency were inspected from revision 241. Supplemental foreign-god names come from the Wiki equipment table plus Torva/ancient sceptre upgrade pages; unknown future families require source verification.

Forced TypeScript rebuild passed. Focused Bologa/Farming/Belladonna run passed 19/19. The full upstream-based server suite passed 4931/4931, zero failures (concurrency 4, outside the sandbox to avoid previously confirmed localhost/temp-file restrictions). Independent reviewer found no actionable bugs and reran all 18 Bologa/Belladonna tests successfully.

Tests drive the real Tithe handler and inventory/equipment transaction; menu presentation and persistence requests are mocked. Live dialogue rendering and a persistence round trip are not claimed. No live game or other chat work was modified.
