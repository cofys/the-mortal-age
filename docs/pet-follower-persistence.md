# Persisting an active follower

## Problem and design

A real isolated `gameUpdate 3s` restart lost the active Olmlet. Shutdown runs `PluginManager.emitServerShutdown` followed by `World.savePlayers`, without player logout. The old snapshot had ownership and `pets:last`, but no physical pet item; login required that item. An independent real shutdown/snapshot/fresh-login test reproduced it.

`pets:active-item` now explicitly records the follower separate from physical inventory/bank copies. Summoning, morphing and cat replacement set it; successful pickup, release, cat run-away/shoo/death clear it. Logout despawns the runtime NPC and preserves the descriptor without adding a temporary item. Login restores one follower from it and leaves separately held duplicate items intact. Old `pets:last` plus physical-item saves still migrate through the old path.

This representation also makes a completed active-follower autosave self-contained, and avoids storage capacity as a logout prerequisite. It does not infer an active pet from ownership, repair already-damaged old profiles, change death/reclaim rules or add pet forms. A lost owned pet remains for Probita. The profile representation is a server implementation choice, not a claim about Jagex's internal storage.

## Production path / state owners

- Native item Drop → inventory action → public item-drop policy → `Pets.drop`: real NPC registration/current pointer, active descriptor and existing ownership/collection service. The caller consumes the physical item after the accepted action.
- Native Pick-up → NPC dispatcher → `Pets.pickup`: physical item delivery first, then active descriptor cleared before ownership persistence. A full inventory retains the active follower and descriptor.
- Native Metamorphosis → shared gate → stored family variant plus active/last item IDs. Cat stage replacement carries its existing growth state and records the new item ID.
- Quest handoff uses public `pets:release`; menagerie uses physical pickup/items. Source audit found no external direct writers of current/last state. Release and cat loss paths clear the active descriptor.
- `SaveEvents` → persistence request/snapshot, or graceful `Server` shutdown → `World.savePlayers` → actual `PlayerSave.fromPlayer` includes the registered persistent attribute. Existing variant/cat data retain their state owners.
- Native network login applies `PlayerSave` before emitting player-login hooks; Pets checks current follower first, restores the explicit active descriptor without consuming inventory, then falls back to the legacy physical-item representation when no descriptor exists. Repeated login hooks do not create another follower.

## Evidence and verification

- [OSRS Wiki Pet](https://oldschool.runescape.wiki/w/Pet): single active follower, ownership/delivery and recovery behaviour. No drop rate/menu/dialogue change. Exact restart storage internals are not externally specified; this repairs an observed TSPS persistence failure.
- Matching local cache241, pinned6e5033af6215963581a51b348f452320ff18f0f6: Olmlet item20851/follower7520, real cached Pick-up operation. No relevant indexed pet recording for restart state.
- Real Player/Inventory/Bank/NPC/ClientConnection, startup hooks and PlayerSave tests: active autosave, separate main-drop duplicate, full backpack/full real bank, native pickup, repeated login, explicit logout, legacy migration, release and actual shutdown hooks with a World-registered player. Only network output captured; no fake containers/ownership/transfer/persistence.
- Initial implementation regression run:7 failures/1 pass. The native pickup fixture initially sent the wrong assumed operation; it now derives Pick-up from the actual cached actions. New8/8 and existing Pets32/32 pass on the corrected real path.
- Final full suite9,157/9,157, no skips; focused new8+Pets32+puppies9 =49/49. One old puppy assertion expected the temporary logout item; it now requires zero inventory items plus the saved active marker, retaining pickup/drop/relogin checks. Independent reviewer re-ran that9/9 suite.
- Independent Codex reviewer traced current/last/active transitions and deferred/coalesced persistence snapshots, requested the explicit null persistence default, then passed5/5 extra real scenarios: kitten growth→save→native Shoo; actual cat-owner death; cross-item Rift morph→restore→native pickup→real Bank transfer→save; first legacy native Drop; and no follower inferred from ownership alone. Pets foundations32/32, no hook errors. No remaining findings in inspected paths.
- Two actual isolated gameUpdate shutdowns followed by actual browser logins restored one registered/rendered Olmlet7520 with zero pet inventory items. The real SQLite shutdown snapshot contains active20851/last20851/owned20851. Final-source screenshot retained locally. No forced process-kill timing or every possible crash boundary is claimed.
- Exact reviewed base1a5b6df83130be3147c4626d98b7589731b050d8; production diff SHA2560D1AC8E10AC92A6412CCD2E9F220F3ADACBAE18CA3BD3F9C7B599F977B4DA292; combined tracked diff with puppy regressionFA08DD0F30D05DC285D92FD95DFB9A9129CEF919D94E0115BE67669927EA0AF7; new test056C9A6F20BC446871BC092F4419E9303A3C69189B6D4C74250257D57FAFE371.
