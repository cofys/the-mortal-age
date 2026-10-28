# Automatic recovery from static follower obstructions

Pets stranded by static collision now catch up beside their owner and continue following. This is independent of the native Call follower button in PR#1437; no button press, new item or new NPC is needed.

## Evidence and boundaries

[Wiki Pet](https://oldschool.runescape.wiki/w/Pet) states that pets stuck and/or far away teleport close and continue. Pinned cache241 (dump6e5033af) and the actual server cache/map establish the NPC identities and Lumbridge church collision used in the reproductions. The cache does not establish gameplay timing. No available recording establishes exact automatic delay, destination distribution or animation; those remain unverified. This implementation recovers on a genuine no-progress following exit, rather than introducing a guessed timer. Existing15-tile/plane/private-context catch-up remains unchanged.

Before the fix, actual NPC.process cycles strand an owned pet at3248,3210 while its owner is3245,3210: route success=true, alternative=true and no further checkpoints. PathFinder therefore does not emitPathBlocked. A separate real blocked edge at the church also exposes the stationary-adjacent early return, which bypasses pathfinding entirely. Neither static case is player/NPC occupancy, and clear walking already works.

## Path map and shared change

Native pet Drop or existing active-item login → real owned NPC/current pointer/follow target → normal World/NPC.process → MovementQueue.processFollowing/mobility gate → static adjacency, destination and actual PathFinder outcome → generic movement:follow-blocked → CatchUp.Pets guard → SAME NPC.moveTo/legal adjacent tile → unchanged following/ownership/form/cat clock and ordinary NPC placement update.

The sole core change is an additive generic event at three existing no-progress exits: blocked-adjacent, no-destination and empty-route. A clear stationary adjacent follower still returns without routing; normal routes still walk; ordinary NPC/player followers have no new recovery policy. The event runs after movement mobility permits following. It does not alter shared route success/alternative flags or emit a false general pathfinding failure.

Pet policy lives in a named CatchUp.Pets subunit. It checks the registered visible pet, exact current owner/follow target/current pointer, removal queue, owner life/placement/teleport, actual mobility, same private context/plane and summon-area policy. Static clipping chooses an unblocked reachable cardinal neighbour; a clear owner tile is the fallback when no neighbour is available. If even that tile is solid, no move occurs. Occupying actors do not qualify as static obstruction. No player queue, interface, dialogue, task, inventory, active item or saved cat attribute is reset. No new polling hook, timer, persistent key or arbitrary wait is added.

Existing distance/context teleport policy, boat/deck integration, species-specific movement speeds, pet transcripts and dog/Bloodhound clue digging are outside this fix. The active Claude Treasure Trails claim is untouched. This is not completion of the entire Pets tracker.

## Verification

- Baseline real-process reproductions:3 failures/2 unchanged normal/refusal passes. Maintained final suite7/7; combined real movement/reach/follower/pet foundations79/79. Game state owners and paths are real; transport is stubbed. Covered actual cache church geometry, blocked adjacency, normal walking/idle/NPC occupancy, frozen/non-pet/foreign/current-pointer/hidden refusal, no legal neighbour, prohibited private area, exact Lil' Xarp form/kitten clock, real dialogue/walk/player countdown task, PlayerSave/fresh login with no physical duplicate.
- A first expanded private-area fixture lacked boundaries. Actual AreaManager correctly left it and invoked the pre-existing cross-context helper. Corrected it with a real bounded PrivateArea and Area.enter for both actors; the failing assertions remain and pass. The premature full run was discarded; the final frozen run is the accepted result.
- Independent Codex review:44/44, build/diff checks clear and no findings in inspected final paths. Reviewer chose real FREEZE/STUN TimerRepository expiry, real Bank and reciprocal Trade preservation, and a bounded private area with both owner and neighbours solid (must not move). Movement/freeze/persistence/pathfinder foundations also ran. The reviewer corrected an analogous unbounded-area setup before final acceptance; no gameplay object/transfer was mocked. Harness SHA25607BB9BD9D17583B7EBF18D208EC2870D2367A2D08F920021E4F85E1879E7D987.
- Frozen base5664a958a. SHA256: Pets35BB3F411F404F232FB9B500A489627D9C269BF725F6994D4722CB689700BD82; CatchUp516614C6FFEED49041C6EB14F370602C0131CC53DBB2BEDEEE6504098C9C023A; MovementQueueA41D4804DDE301022B49727C8CB0AA5533E1957765C7A3B93076EFB1AECBC4DE; test0EB55550955F2EE2656FB7D1D8E5B791E9AB7F491C50C13EDF27A3A30F9D209E.
- Final TypeScript build passed; full suite9457/9457, zero failures/skips/cancellations. Product/test source stayed frozen during final validation/review.

## Actual rendering/update evidence

Own slot7 disposable autopet account: one item20851 seeded, native Drop creates ownership, normal logout then browser login restores it. Owner position was seeded across the church obstacles within the pre-existing15-tile catch-up range. An early22-tick observation caught the still-approaching partial route, not its final blocked state; it is not counted as a failed or successful recovery.

To capture the actual transition, a temporary loopback inspector attached only to the verified own server/cwd. A logging wrapper called the original emitCustomEvent unchanged and retained only the disposable pet's generic event. The same NPC528 was seeded outside at3244,3217; normal real server cycles walked it to3248,3210. At server cycle978, empty-route emitted with owner3245,3210, and the unchanged dispatcher/Pets handler moved that SAME NPC to3244,3210. It continued following autopet; queue0, route/alternative false afterwards. Follower varps447/448 and item identity remained unchanged; inventory stayed empty. The wrapper was restored immediately and removed. No code/state-owner mock, forced successful path, new follower or button action was used. The inspector placement is explicit test setup, not evidence of a player crossing the closed wall naturally. The browser visibly rendered the recovered follower; screenshot and actual event/state retained locally.

The complete suite emits existing AdventurePaths fixture startup warnings (Hunter/WarpedSceptre null context). A baseline loader compiled both changed product units from exact base in memory and reproduced1/1 passing selected login test with the same warnings (both loaded:true); critical pet suites emit real startup and have no hook errors. Base source SHA256 Pets8C0DC35FFA31124BE6EBC60E11B1561D4BED2E0324CFAF7C89AC63E9F7904064 and MovementQueueCC6ED245A05F52971F00592CC9435ED3E98C3247CC93BEB8938048C453C20A5D. No unrelated fixture repair included.

Own server/client/browser and temporary inspector stopped;3107/43707/49807/9229 closed. Own slot7 reservation cleared/backed up. Claude and live checkout unchanged.
