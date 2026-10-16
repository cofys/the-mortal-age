# F2P quest cameras

The camera audit covers all 23 F2P quests in [issue 600](https://github.com/RSPSApp/tsps/issues/600). It uses the original database captures and the revision 240 F2P archive already documented by each quest. Only sanitized camera facts are committed; recordings and account details stay local.

## Recorded coverage

| Quests | Camera coverage |
| --- | --- |
| Below Ice Mountain | Workout camera track, entrance/explosion, trap sequence, underground tour, Guardian wake/defeat and final door shots. |
| Demon Slayer | Aris's vision, Wally's shots and Delrith's summoning sequence. |
| Black Knights' Fortress | Cabbage sabotage scene. |
| Goblin Diplomacy | All three armour fittings. |
| Dragon Slayer I | Ship voyage, storm/fire, crash, beach and Elvarg introduction. |
| Misthalin Mystery | Sid, Tayten, Lacey, Mandy's kitchen, confrontation, reveal and rescue, including intermediate pans. |
| Romeo & Juliet | Juliet's room, crypt tour and optional Cadava drink. |
| The Restless Ghost | Coffin/skull departure and moving look target. |
| Imp Catcher | Bead ritual, including look-before-move packet order. |
| The Corsair Curse | Voyage, Gnocci's burial, Tock's fishing scene and cabin fire. |
| Cook's Assistant, Sheep Shearer, Shield of Arrav, Vampyre Slayer, The Ides of Milk, Doric's Quest, Ernest the Chicken, The Knight's Sword, Rune Mysteries, Pirate's Treasure, Prince Ali Rescue, Witch's Potion, X Marks the Spot | The supplied successful quest routes have no quest-directed move/look commands. Unrelated cameras elsewhere in those recordings are excluded. |

Per-quest details and regression commands remain in the existing evidence pages. Each shot follows the actual scene/dialogue trigger. Autonomous intervals use captured tick gaps; the player's time spent reading a continued dialogue is not replayed as a fixed delay.

## Shared client/server support

`sendCameraMoveTo(x, y, height, { rate, rate2, heightRelative })` and `sendCameraLookAt(...)` preserve the captured constant and proportional rates. Existing boolean callers retain their previous packet format and behavior. Exact-rate packets carry signed heights and independent relative-height histories for movement and looking. The model fields follow [RSProx's camera definitions](https://github.com/blurite/rsprox/tree/master/protocol/src/main/kotlin/net/rsprox/protocol/game/outgoing/model/camera).

The client advances each axis in integer fine units every 20 ms, adding the constant rate to the truncated proportional distance term and clamping at the destination. A second rate of at least 100 snaps immediately. Look angles are recomputed from the moving camera every client cycle, with shortest-path yaw, independent pitch rates and the camera pitch lock. This follows the official client updates retained in [InvDefinition](https://github.com/open-osrs/runelite/blob/master/runescape-client/src/main/java/InvDefinition.java) and [KeyHandler](https://github.com/open-osrs/runelite/blob/master/runescape-client/src/main/java/KeyHandler.java).

`sendCameraUnlock` preserves the pitch-limit state. Reset cancels unfinished movement and clears look/shake overrides. `sendCameraTranslate` rebases an active camera and its targets across our private-scene coordinate offset without restarting its pan: Elvarg's recorded return occurs at +16 ticks, while the camera remains active until +20. Both WebGL and WebGPU advance the same camera implementation and share the camera-shake state/render perturbations. Shake changes the rendered view without overwriting the underlying pan targets. Camera terrain heights use integer bilinear interpolation; cold instance entries load the target X/Z first and resolve height when terrain is ready, avoiding a permanent zero-ground fallback.

## Verification and boundaries

Client regressions cover encoder/decoder round trips, signed and relative heights, zero/asymmetric rates, exact 20 ms steps, frame-rate independence, pitch easing/unlock, yaw wrapping, moving look targets, no overshoot, reset cancellation and private-scene rebasing. The WebGPU viewport test calls the actual render loop to verify a pan advances with player-follow disabled. Quest regressions assert recorded shot order, parameters, relative timing and interrupted-scene cleanup.

Final integration checks passed: server build, 832 server regressions, quest-runtime smoke, client typecheck, all 14 CI-selected client test files, five focused camera/render test files and four terrain/map regressions. Native MCP runs exercised Sid and Mandy’s timed pans, Tock’s automatic ship view, Wally’s vision and Delrith’s summon/release. A real WebGPU client was inspected at Sid’s opening shot, during the barrel pan and at its destination.

This audit establishes the recorded camera tracks. Unrecorded quest branches still need evidence, and a complete visual comparison of every cinematic against an OSRS recording remains separate from packet/state regressions. Other scene limitations, such as actor choreography, journal prose and temporary HUD mounts, remain documented on their quest pages.
