# Native Call follower

The equipment tab's cache button387:7 (`wornitems:call_follower`, op1) now calls the owned active pet. It does not retrieve banked/lost pets or award a new pet. Other buttons remain untouched.

## Sources and limits

- Pinned cache241 dump6e5033af: `interface/wornitems.if3`, layer call_follower, transmitop1, op1 Call follower; component symbol387:7. The active cache resolves the same name/ID.
- RSProx229/2785: `You do not have a follower.` at tick0. 232/3213: `Your follower is already close enough.` and `Please finish what you're doing before calling your follower.` at tick0 in separate attempts. 239/4288: follower_npc changes index at+1. All are normal-world attempts; no special-world samples used.
- [Wiki Call follower](https://oldschool.runescape.wiki/w/Call_follower): non-interrupting actions/dialogues; at least5 tiles away or an unwalkable tile affecting the path. Players/NPCs do not count as static obstruction. [Pet](https://oldschool.runescape.wiki/w/Pet) confirms the control and general catch-up behaviour.

The Wiki's non-interruption takes precedence over interpreting the captured busy refusal as blanket busy(). Death, placement, teleport, forced movement and trade/duel status refuse; banking, shop, price-check and ordinary dialogue/action state do not themselves refuse. Exact official refusal state in the single busy recording is not established.

Distance is same-plane/private-context Chebyshev distance:4 can refuse,5 recalls. Static obstruction uses the existing RegionManager.canMovestart direct clipping sweep, not a full alternate-route search. Destination uses reachable unblocked adjacent tiles (static collision only), falling back to the player's tile if no adjacent tile is available. Exact official destination selection distribution and all species' timing are unverified. Replacement follows the existing follower helper; the single captured index replacement supports it, not an exhaustive tick-order claim.

Automatic catch-up/door traversal is separate from this explicit button. Dog/Bloodhound clue digging is a separate, still-missing integration with the actively claimed Treasure Trails work; this PR does not claim that behaviour or completion of all Pets. Hidden or prohibited followers cannot be exposed through this control.

## Native path and state owners

The cache transmits a widget_action. NetworkBuilder first emits the existing generic player:widget-action policy event. Call.Pets claims only this exact component; unsupported operations are consumed. This placement is necessary: the later generic widget fallback can answer an unrelated current dialogue even when an interface hook handled a click. No networking/core change is needed.

Call validates the actual current NPC, registered state, owner, pet definition, visibility and pending removal, then uses the area summon policy and actual static RegionManager clipping. The existing Pets.replaceFollowerNpc gains only an optional destination parameter; cat-stage callers retain their default original location. The helper queues the old NPC removal, creates the same current NPC ID with the owner/follow target/area, publishes current/last/active item and follower varps447/448. Ownership, inventory and cat attributes are not rewritten by Call. Cat growth tasks resolve the player's current follower every tick, rather than retaining the replaced NPC.

Player movement, combat, dialogue, interface and tasks are not reset. No new persistence key or delayed task is introduced. PlayerSave/fresh login uses the unchanged active-item restoration. Native stale old-NPC clicks continue to be rejected by the current-follower identity guard in Pets.

## Checks

New native suite initially reproduced7 failures/2 unchanged guard passes. It uses real Player/NPC/Inventory/ClientConnection/World/collision/private areas/PlayerSave and actual plugin startup; only transport/messages/config capture is stubbed. Cases cover no follower,4/5 boundary, duplicate call, actual wall clipping, NPC occupancy, non-interruption of an actual OptionDialogue/walk queue/player CountdownTask, hidden/stale/foreign/removal-queued NPCs, invalid operations, death/teleport/placement/trading, private context/plane, full inventory, exact Lil' Xarp physical form, kitten clock and fresh login.

Independent review found that an initial blanket status guard also blocked a real Bank.open path. A retained native bank regression failed before the correction, then passed unchanged after limiting refusal to trade/duel. Native Price Checker is also verified to remain open. Final authored suite10/10; combined follower/recovery/persistence/pet foundations71/71.

Independent Codex review:73 shipped cases and4 reviewer-selected actual-system checks pass on the final frozen source. Real reciprocal Trading.requestTrade refuses safely, closeTrade then Bank.open permits recall without closing the bank, actual ShopDefinitionLoader/ShopManager.open permits recall without closing the shop, actual scheduled kitten growth advances after replacement, and real MaxHouse/House.releaseHouse→public recall preserves the pet. A first reviewer shop setup failed before Call because it omitted the real shop-definition loader; the corrected fixture uses that loader and passes. No game state owner/container was mocked. Reviewer harness SHA256030C97F6B243160BB54AFBBD1242A498AA3893CC6A24881670D3CE5ED6D444B9.

Reviewed basefa7a65eaa46e761afc1e40f78a12a46159776b30. SHA256 Pets.plugin.js07A3963D40F2172F2AC9A8C984A74E17FC0F4ADCDAF9FE408D70568472F16482; Call.Pets.jsEBC3908105A24D8DB86AD086979A2566EE3C6DE60CFF7DEB364E90F59A829838; call-follower.test.cjsA24D9B742F0F9B7108E3681421F79A972EF867C6866F645095688E8E87A260B8. Build and diff checks pass. The initial full run was stopped when review required a source correction; only the final frozen run counts.

Actual rendering client, own slot7: browser equipment button produced the no-follower response; native Drop established one owned Olmlet, button produced already-close. A race against ordinary following only verified refusal, not success. Deterministic success used admin teleport into Lumbridge church behind its real closed entrance; browser Call recalled NPC7520 next to the player, index1203→1205, varp447492831923→492831925, varp44820851, inventory empty. A real Father Aereck Talk-to dialogue stayed on the identical line after browser Call. Seeding owner location/pet item is disclosed; successful action was native browser input. Screenshots/state retained locally.

The full suite emits existing AdventurePaths fixture warnings from Hunter/WarpedSceptre null-core hooks: that test omits server startup. An exact-base Pets loader reproduction (base source SHA2568C0DC35FFA31124BE6EBC60E11B1561D4BED2E0324CFAF7C89AC63E9F7904064, loaded:true in the test process) passes1/1 with the same warnings; critical pet tests correctly emit startup and have no hook errors. No unrelated fixture repair is included.

Own server/client/browser stopped,3107/43707/49807 closed, own slot7 cleared/backed up. Claude and live checkout untouched. Full-suite final total is recorded in the PR after the run completes.

Final full suite: node --test --test-concurrency=4 tests/,9428/9428, no failures/skips/cancellations, exit0; frozen product/test hashes unchanged.

## Review repair: open cat menu after NPC replacement (2026-10-27)

Review comment6446879285 reproduced a real lifetime gap: Call preserves the Interact prompt but its callbacks captured the removed NPC. Native Shoo could clear ownership while leaving the recalled cat alive; Chase also retained the removed target. Three regression cases failed before the repair (10 passes), retained in the local RED log.

Interact now captures the logical cat-care session, resolves the actual current owned registered cat when each choice executes, and rejects pending removal or a different session. Stroke, Chase, Guess age and Shoo share this guard. Recall and natural growth keep the session, while hunger runaway/death/release invalidate it; a new reward cannot be affected by the old prompt. No new state, cache data or core/client change.

Path: native NPCInteract -> Pets.openCatInteract -> actual MultiChatboxPrompt219 callback -> current follower/session guard -> existing care/chase/shoo services -> World removal and current/active/cat state + follower varps. MultiChatboxPrompt consumes the callback before invoking it. Real reward acquisition, hunger runaway, growth and save/load are exercised rather than simulated replacement objects.

Frozen Pets SHA256DDA2DA27C01A9BAE38160F1E783D451C43C582682B6E721E7F5ADF6CB0D81072; test87C152D0D4856CD0D0F351E5160D14C89A2862CC6D1C765270012A95F5478A73. TypeScript build passed after upstream merge2affe6fc03a5a0247ae2318329ea1b4e04099588. Focused71/71; full9505/9505, no failures/skips/cancellations. Independent Codex review86 foundations + independently chosen1 lifecycle test: native Interact -> Call -> natural growth -> Call -> Stroke -> PlayerSave/fresh login -> Shoo and repeated stale choice. No findings in inspected paths.

Actual rendering client: disposable kitten dropped via native inventory action; Interact opened through QA MCP. Controlled fixture held the actual cat's movement six tiles away using the isolated server inspector. Native equipment Call replaced NPC1203 with1204, kept Interact open and published varps447=366412980/448=1555. Native Shoo removed the recalled cat; observe returned no cats, both varps=-1, and 'You shoo your pet away.' Screenshots/state retained locally. Fixture placement is not evidence for official destination RNG/timing.

Own server/client/tab/helper stopped; fresh query confirms3107/43707/49807/9229 closed; own slot7 cleared. No live or Claude changes.
