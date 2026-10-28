# Pet interaction details

Standalone scope from main faf4f9883, independent of pending form metadata PRs.

1. Reproduce cache-name loss through native Probita recovery and synth delay loss through native follower pickup with real players, containers, startup hooks and outbound packets.
2. Resolve the generic display name from the physical item's existing ItemDefinition. Preserve the previous fallback when definitions are unavailable. Give generic pet pickup its own delayed Sound; do not change shared Sound.PICK_UP_ITEM or transfer/task timing. Puppies already send delay20.
3. Check refused/full/foreign/duplicate actions, real Bank deposit/withdraw, PlayerSave/fresh login and existing pet foundations. Trace native NPC action → NetworkBuilder/interaction dispatch → Pets.pickup → real Inventory and ownership attributes → PacketSender/encodeSound. Recovery runs native Probita Check → Recovery.open → native widget selection/confirm → inventory capacity and PIN checks → physical item/name → persistence save.
4. Independent Codex review must challenge an assumption through the real shared systems on the exact frozen source, then run the full suite and own-slot client/server checks. Publish one ready PR and stop own helpers/clear own reservation.

Evidence: pinned cache241 dump6e5033af (synth2582, verzikpet item22473, item display names); RSProx229/2783 and239/4288 both show pickup2582 delay20. Exact transfer+1 was captured only once; this change does not assert or alter that timing. Applying the existing generic pickup sound consistently to pets is an implementation choice; those two captures are Lil' Zik, not proof for every species.

No generated definitions, live game, other worktree or Claude changes.
