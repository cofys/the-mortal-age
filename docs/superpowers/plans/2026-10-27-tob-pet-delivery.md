# Lil' Zik delivery implementation plan

**Goal:** Deliver the existing normal-mode pet roll through the shared Pets service when
looting, including follower/backpack/Probita ownership and replay-safe chest removal.
**Architecture:** Minimal reward-unit change in Rewards.TheatreOfBlood.js and canonical
LilZik follower row in Pets.plugin.js (8337, not POH8336). No RNG/rates,
raid combat, core, generated definitions, clues or Leagues edits.

## Production path and assumptions to verify

Native object_option → ObjectActionPacketListener → Shared.onObject/useChest → real
RaidState raidOf/member/RewardsRoom.openChest → persisted tob:loot → openLoot/take →
Inventory/Bank.add. Current path never invokes npc-drops:roll, so Pets.awardPet never
records pets.owned, follower state or collection log. Pets' award path itself records
ownership and handles full bag + follower via Probita; reward=true bypasses ordinary
summon restrictions (canSummonPetHere), so the actual raid PrivateArea needs no override.

Wiki Lil'_zik says receipt happens when looting the monumental chest and follows the
normal follower/backpack/full-and-followed reclaim rules. Cache item22473 / named LIL_ZIK;
RewardsRoom uses each member's chest slot. Local capture index has no verzikpet/olmpet
recordings/actions. Local osrs-dumps6e5033af241 +active cache confirm itemverzikpet22473,
normal NPCverzik_pet8337 versusPOH8336; tob_chests23 withbank6/inventory8/discard10/items12,
closed treasury33086/open32994/lobby41437. Wiki supplies delivery behaviour; no exact recorded timing claim.

At first valid own-chest open, consume pending pet loot through npc-drops:roll before
the deferred chest animation/UI. The same pending-pet logic must protect saved outside
Rewards Chest access and transfer paths. Only rows the shared service consumes leave
the chest; if Pets is disabled preserve existing item fallback. Persist after loot
removal. Normal loot, rates, contribution formula and reward-interface layout stay as-is.

- [x] Reproduce via real Party/Raid/PrivateArea/RewardsRoom with all plugins/startup, native
  object and reward clicks, controlled existing pet RNG; no fake raid/player/container.
- [x] Test actual common Pets award/duplicate/collection/persistence services, normal chest
  and saved outside claim, full bag+follower, replay/foreign chest, and real Bank transfers.
- [x] Implement minimal shared-service delivery; keep ordinary non-pet chest/Bank-all working.
- [x] Build/focused/full and own native MCP walkthrough; stop owned services/clear slot.
- [x] Independent reviewer traces unchanged shared state owners and chooses/runs an extra
  adversarial scenario. Record HEAD, tracked diff/new source hashes/build and limits.
- [ ] Fix findings; push a separate ready PR and release the coordination claim.

User authorizes inline planning/implementation. CoX's similar source stays a separate
audit/follow-up, not bundled here. Existing process update is local documentation only.
