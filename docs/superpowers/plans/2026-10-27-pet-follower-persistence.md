# Active follower persistence plan

**Goal:** Preserve an active follower across actual graceful shutdown saves without needing a spare inventory/bank slot, and restore exactly one follower on login.

**Evidence:** Real gameUpdate restart and independent real shutdown→PlayerSave→fresh-login reproduction lose the physical pet representation while pets:last/ownership survive. Server.gracefulShutdown emits shutdown hooks then World.savePlayers without player logout. Existing login requires an inventory/bank item. A shutdown-only forced pickup is fragile when storage is full and mutates the running world if shutdown is cancelled.

**Design choice:** Persist an explicit active follower item key in Pets, set when summoned/replaced/morphed and cleared when converted to an item or released/lost. Logout remembers the descriptor and despawns the runtime NPC without creating a temporary inventory item. Login restores that descriptor without consuming any already-existing duplicate item. Retain the old pets:last plus physical-item migration for old saves. This also makes an ordinary active-follower autosave self-contained. Ownership alone must never summon a lost/reclaimed pet.

**Scope/constraints:** Generic Pets lifecycle only; no raid/dust/Claude/client/generated-data/live changes. Keep variants/cat state in their existing owners. Existing death policy is unchanged; all existing release/loss paths must clear the descriptor. No inference for already-damaged old profiles. Inline planning/implementation authorized by Curt.

1. Real World-registered Player/NPC shutdown snapshot/fresh login RED, plus active autosave, full inventory+bank, picked-up pet, existing duplicate item, repeated login and explicit logout/relog.
2. Add persistent active descriptor to existing Pets lifecycle transitions and retain legacy physical restoration. Trace every current/last clear/replace and variant mutation.
3. Build, real lifecycle/foundation tests, full suite; independent reviewer chooses adversarial real transfer/release/loss scenario and tests exact source fingerprints.
4. Actual isolated server gameUpdate restart followed by actual client login/follower rendering; repeat shutdown and verify no duplicate or new inventory consumption. Full storage and variants covered with real objects.
5. Separate ready PR after Codex review; stop only owned client/server/debugger/helpers, clear slot and release claim. Do not imply that every remaining Pets feature is complete.
